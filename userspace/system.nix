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
        ] ++ toolchain);  # nix, clang+wasm-ld, cc, make — the in-guest toolchain, on PATH from the closure
        environment.defaultPackages = lib.mkForce [ ];
        environment.variables.TERM = "xterm-256color";
        # Link ncurses' terminfo DB into the profile and point ncurses at it, so
        # curses apps (sl, …) find xterm-256color. system.path's default
        # pathsToLink does NOT include /share/terminfo, so add it explicitly.
        environment.pathsToLink = [ "/share/terminfo" ];
        environment.variables.TERMINFO_DIRS = "/run/current-system/sw/share/terminfo";

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
        environment.etc."profile".text = ''
          export PATH=/root/.nix-profile/bin:/run/current-system/sw/bin:/bin:/sbin
          export WAYLAND_DISPLAY=wayland-0
          export XDG_RUNTIME_DIR=/tmp
          [ -r /etc/set-environment ] && . /etc/set-environment
        '';

        nix.enable = true;
        nix.settings.experimental-features = [ "nix-command" "flakes" ];
        nix.settings.substituters = lib.mkForce [ "file:///nix-cache" ];
        nix.settings.require-sigs = false;
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
