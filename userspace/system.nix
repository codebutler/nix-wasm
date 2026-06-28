# Curated NixOS-module evaluation for the wasm32 NOMMU guest (spec Approach B).
# Reuses real NixOS module code (etc, system-path, nix, shells/system env,
# users-groups) to GENERATE config, with a stub module absorbing the
# systemd/initrd/activation options those modules write into. No systemd/perl.
#
# Pin coupling: the module path list and the stub option set are specific to the
# pinned nixpkgs rev (which modules declare/read which options moves between
# releases — e.g. nix.enable/nix.package live in the systemd-pulling
# nix-daemon.nix here, so we re-declare them below). Revisit both on a bump.
{ nixpkgs, cross, busybox, toolchain ? [ ], nixPackage ? cross.nix }:
let
  lib = cross.lib;
  modulesPath = nixpkgs + "/nixos/modules";
  result = lib.evalModules {
    specialArgs = { inherit lib; modulesPath = modulesPath; };
    modules = [
      (modulesPath + "/misc/assertions.nix")
      (modulesPath + "/misc/ids.nix")
      (modulesPath + "/system/build.nix")
      (modulesPath + "/system/etc/etc.nix")
      (modulesPath + "/config/system-path.nix")
      (modulesPath + "/config/users-groups.nix")
      (modulesPath + "/config/nix.nix")
      (modulesPath + "/config/shells-environment.nix")
      (modulesPath + "/config/system-environment.nix")

      # Stub: declare the options the curated modules write into but whose
      # DEFINING modules (systemd, initrd, activation) we deliberately exclude.
      # NOT inert — several DEFAULTS are load-bearing: sysusers.enable=false +
      # userborn.enable=false select the static passwd/group branch in
      # users-groups.nix (the behaviour we want, spec §3.2), and wrapperDir must
      # equal upstream's default because system-environment.nix puts it on PATH.
      # Caveat: the `types.attrs`/list stubs (systemd.services, initrd.systemd.*)
      # silently ABSORB writes (no submodule checking) — by design, but it means
      # a future nixpkgs bump that needs one of these honoured fails SILENTLY,
      # not loudly. Only a brand-new (undeclared) option errors at eval. Revisit
      # the stub set on a nixpkgs bump.
      ({ lib, ... }: {
        options.boot.initrd.systemd.enable = lib.mkOption { type = lib.types.bool; default = false; };
        options.boot.initrd.systemd.users = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.boot.initrd.systemd.groups = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.boot.initrd.systemd.contents = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.boot.initrd.systemd.storePaths = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
        options.systemd.services = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.systemd.tmpfiles.rules = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
        options.systemd.tmpfiles.settings = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.system.activationScripts = lib.mkOption { type = lib.types.attrs; default = { }; };
        options.systemd.sysusers.enable = lib.mkOption { type = lib.types.bool; default = false; };
        options.services.userborn.enable = lib.mkOption { type = lib.types.bool; default = false; };
        options.security.wrapperDir = lib.mkOption { type = lib.types.path; default = "/run/wrappers/bin"; };
      })

      ({ config, lib, ... }: {
        options.nix.enable = lib.mkOption { type = lib.types.bool; default = true; };
        options.nix.package = lib.mkOption { type = lib.types.package; default = nixPackage; };
        config = {
          _module.args.pkgs = cross;
          _module.args.utils = import (modulesPath + "/../lib/utils.nix") {
            inherit lib config; pkgs = cross;
          };
        };
      })

      # Our config: a minimal NOMMU profile. Guest shell is busybox ash; bash is
      # native in this repo (deps-overlay maps it to buildPackages) so it is NOT
      # a guest binary and must not go in the profile.
      ({ lib, pkgs, ... }: let
        # The guest supports exactly ONE terminal (Ghostty/xterm-256color), and
        # terminfo entries are self-contained (use= refs are resolved into each
        # entry at compile time), so we ship ONLY that entry instead of ncurses'
        # full ~1876-entry DB. Not a stub — the complete, real xterm-256color
        # description; just scoped to what the guest can be. Shrinks the system
        # closure (and its 9p mount) from ~4200 entries to a handful.
        terminfoMin = pkgs.runCommand "terminfo-xterm-256color" { } ''
          mkdir -p $out/share/terminfo/x
          cp ${pkgs.ncurses}/share/terminfo/x/xterm-256color $out/share/terminfo/x/
        '';
        # DejaVu Sans + a minimal fonts.conf + a fontconfig cache built at build
        # time; keyed to the build path so fontconfig rescans once on first FcInit.
        guestFonts = import ./fonts.nix { inherit pkgs; };
        # Compiled GSettings schemas (org.gtk.Settings.*) + hicolor icon theme +
        # the Adwaita Xcursor theme. GTK aborts without the compiled schemas;
        # schemas are compiled with the NATIVE glib-compile-schemas
        # (pkgs.buildPackages.glib). See gtk-assets.nix.
        gtkAssets = import ./gtk-assets.nix { inherit pkgs cross; };
        # autologin: getty's `-l` execs this instead of /bin/login (single-user
        # guest, passwordless root). Shipped as a PROFILE package so it resolves
        # at /run/current-system/sw/bin/autologin (no FHS copy). Shebang /bin/sh
        # = the busybox sh baked in the initramfs (persists run-in-place).
        autologin = pkgs.writeTextFile {
          name = "autologin";
          executable = true;
          destination = "/bin/autologin";
          text = ''
            #!/bin/sh
            exec /run/current-system/sw/bin/login -f root
          '';
        };
      in {
        environment.systemPackages = lib.mkForce ([
          busybox         # patched wasm busybox: init, hush (guest shell), coreutils + getty/login/syslogd applets
          terminfoMin     # terminfo for the one supported terminal
          autologin       # /run/current-system/sw/bin/autologin (inittab references it)
          guestFonts      # DejaVu Sans + fonts.conf + prebuilt fc-cache (M2 text stack)
          gtkAssets       # compiled GSettings schemas + hicolor icon + Adwaita cursor theme (M3b)
          cross.galculator  # M4: GTK3 calculator. In systemPackages (not just the
                            # initramfs extraBins) so its store path — and thus its
                            # $out/share/galculator/ui/*.ui, loaded at runtime from the
                            # hardcoded PACKAGE_UI_DIR — enters the served /nix closure.
        ] ++ toolchain);  # nix, clang+wasm-ld, cc, make — the in-guest toolchain, on PATH from the closure
        environment.defaultPackages = lib.mkForce [ ];
        environment.variables.TERM = "xterm-256color";
        # NIX_PATH for the in-guest `nixpkgs` channel (userspace/wasm-nixpkgs-channel.nix):
        # the channel's default.nix reaches nixpkgs via `<nixpkgs>`, which resolves
        # to this pinned source store path and is substituted on demand from the
        # nix-cache the first time a nixpkgs attribute is evaluated. Baking the exact
        # store path (not a channel symlink) makes `nix-env -iA nixpkgs.<pkg>`
        # reproducible against the host-published wasm outputs. Flows to the shell
        # via /etc/set-environment → /etc/profile like the vars below.
        environment.variables.NIX_PATH = "nixpkgs=${nixpkgs}";
        # UTF-8 locale: musl has C.UTF-8 built in (no glibcLocales / i18n.* stack,
        # which would pull the wrong libc). This is what busybox ash's
        # CHECK_UNICODE_IN_ENV reads to turn on width-aware line editing. Flows the
        # NixOS-native way: the shells-environment module renders it into
        # /etc/set-environment, which /etc/profile sources below.
        environment.variables.LANG = "C.UTF-8";
        # Link ncurses' terminfo DB into the profile and point ncurses at it, so
        # curses apps (sl, …) find xterm-256color. system.path's default
        # pathsToLink does NOT include /share/terminfo, so add it explicitly.
        # Also link /share/fonts so DejaVu lands at
        # /run/current-system/sw/share/fonts (the guest path in fonts.conf).
        # /share/terminfo + /share/fonts are M2; /share/glib-2.0/schemas and
        # /share/icons are M3b (GTK GSettings schemas + hicolor icon + Adwaita
        # cursor theme).
        environment.pathsToLink = [
          "/share/terminfo"
          "/share/fonts"
          "/share/glib-2.0/schemas"
          "/share/icons"
          "/share/galculator"   # M4: galculator .ui files (profile symlink; the
                                # binary loads them from its own store path directly)
        ];
        environment.variables.TERMINFO_DIRS = "/run/current-system/sw/share/terminfo";
        # fontconfig: point at the baked-in conf + cache so FcInit resolves
        # "DejaVu Sans" without a runtime rescan.
        environment.etc."fonts/fonts.conf".source = "${guestFonts}/etc/fonts/fonts.conf";
        environment.variables.FONTCONFIG_FILE = "/etc/fonts/fonts.conf";
        environment.variables.FONTCONFIG_PATH = "/etc/fonts";
        # GTK GSettings: point at the compiled schemas in the system profile so
        # GLib finds org.gtk.Settings.* without a runtime rescan or XDG lookup.
        environment.variables.GSETTINGS_SCHEMA_DIR = "/run/current-system/sw/share/glib-2.0/schemas";
        # XDG_DATA_DIRS: icons + schemas live under the system profile's share/.
        environment.variables.XDG_DATA_DIRS = "/run/current-system/sw/share";
        # Cursor theme: GDK/libwayland-cursor search XCURSOR_PATH for the named
        # theme's cursors/ dir. The guest's default search path (/usr/share/icons,
        # …) is empty, so without this every cursor request fails with
        # "Gdk-Message: Unable to load <name> from the cursor theme". Point it at
        # the Adwaita Xcursor theme baked into gtk-assets (share/icons, already in
        # pathsToLink). XCURSOR_SIZE=24 matches Sommelier's XCURSOR_SIZE_BASE.
        environment.variables.XCURSOR_PATH = "/run/current-system/sw/share/icons";
        environment.variables.XCURSOR_THEME = "Adwaita";
        environment.variables.XCURSOR_SIZE = "24";

        users.mutableUsers = false;
        users.users.root = {
          uid = 0;
          # single-user guest: passwordless autologin (Task 4 emits empty pw field)
          shell = "/bin/sh";   # busybox ash, linked by the bootstrap
        };

        # /etc/profile: busybox ash sources it as a login shell. PATH order:
        # the nix user profile (nix-env -iA'd pkgs run by name), the system
        # profile (busybox + the folded toolchain: nix/clang/wasm-ld/cc/make —
        # NO MORE /opt/bin side-mount; the toolchain is just Nix packages here),
        # then the baked initramfs /bin,/sbin. Then source set-environment
        # (TERM, TERMINFO_DIRS) which ash does not auto-source.
        # A colored prompt lives here (not environment.interactiveShellInit): that
        # NixOS option is rendered into the module-generated /etc/profile, but we
        # override /etc/profile with this custom text, so it would never be sourced.
        # busybox ash's FANCY_PROMPT interprets \u\h\w\$ + \[\]-bracketed zero-width
        # color escapes. Root's \$ renders as '#'.
        environment.etc."profile".text = ''
          export PATH=/root/.nix-profile/bin:/run/current-system/sw/bin:/bin:/sbin
          export WAYLAND_DISPLAY=wayland-0
          export XDG_RUNTIME_DIR=/tmp
          [ -r /etc/set-environment ] && . /etc/set-environment
          PS1='\[\033[1;32m\]\u@\h\[\033[0m\]:\[\033[1;34m\]\w\[\033[0m\]\$ '
        '';

        nix.enable = true;
        nix.settings.experimental-features = [ "nix-command" "flakes" ];
        nix.settings.substituters = lib.mkForce [ "file:///nix-cache" ];
        nix.settings.require-sigs = lib.mkForce false;
        # Force `substitute` ON explicitly (codebutler/nix-wasm#1). The NEW nix CLI
        # (`nix profile`, `nix build`, …) probes for Internet in src/nix/main.cc and,
        # finding none on the network-less guest, sets `useSubstitutes = false`
        # UNLESS it was explicitly overridden — silently disabling ALL substitution.
        # Our only substituter is `file:///nix-cache`, which needs no network, so that
        # default is wrong here: it makes `nix profile install` fail with "no
        # substituter that can build it" (and made `nix profile` look like it was
        # building derivers — it was actually just unable to substitute the cached
        # output). `nix-env -iA` is a separate entry point that skips that probe, so
        # it is not affected by THIS knob (it has its own gap — see
        # always-allow-substitutes below). Setting it here marks it `overridden`
        # so the offline path leaves it alone.
        nix.settings.substitute = true;
        # Substitute even derivations marked `allowSubstitutes = false`
        # (codebutler/nix-wasm#1 follow-up). nixpkgs' TRIVIAL builders —
        # `runCommand` / `writeShellScriptBin` / `writeText`, which is what
        # `guest-cc` / `guest-cxx` are — set `allowSubstitutes = false` +
        # `preferLocalBuild = true`: on a normal machine rebuilding a tiny wrapper
        # locally is cheaper than a network round-trip. But the wasm guest CANNOT
        # build ANYTHING (no fork/exec builder; the deriver's `system` is the x86_64/
        # aarch64 BUILD host, not wasm32) — so `nix-env -iA guest-cc` (which realises
        # the deriver, i.e. a `Built{drvPath}`, and honours `allowSubstitutes`) tried
        # to BUILD the output and died with "platform mismatch … Required: aarch64-
        # linux, Current: wasm32-linux", even though the prebuilt output IS in the
        # cache. (`nix profile install <outPath>` sidestepped it only because an
        # Opaque store-path install never consults `allowSubstitutes`.) This knob
        # makes Nix ignore that attribute and substitute the cached output — the only
        # correct behaviour for a build-incapable guest — so `nix-env -iA guest-cc`
        # and `nix-env -iA guest-clang-wasm32` install from the cache like any other
        # package (fixes the `wrapperless-cc-e2e` install path).
        nix.settings.always-allow-substitutes = true;
        nix.settings.sandbox = false;
        # Single-user guest: build/realize as the calling user (root). Empty
        # build-users-group disables build-user isolation — otherwise nix aborts
        # with "build users group 'nixbld' has no members" (there are none, and
        # NOMMU can't sandbox anyway).
        nix.settings.build-users-group = "";
        # wasm has no seccomp; nix's default syscall filter aborts the build
        # without this ("seccomp is not supported on this platform").
        nix.settings.filter-syscalls = false;
      })
    ];
  };
in
{ config = result.config; }
