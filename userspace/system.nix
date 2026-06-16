# Curated NixOS-module evaluation for the wasm32 NOMMU guest (spec Approach B).
# Reuses real NixOS module code (etc, system-path, nix, shells/system env,
# users-groups) to GENERATE config, with a stub module absorbing the
# systemd/initrd/activation options those modules write into. No systemd/perl.
#
# Pin coupling: the module path list and the stub option set are specific to the
# pinned nixpkgs rev (which modules declare/read which options moves between
# releases — e.g. nix.enable/nix.package live in the systemd-pulling
# nix-daemon.nix here, so we re-declare them below). Revisit both on a bump.
{ nixpkgs, cross }:
let
  lib = cross.lib;
  modulesPath = nixpkgs + "/nixos/modules";
  result = lib.evalModules {
    specialArgs = { inherit lib; modulesPath = modulesPath; };
    modules = [
      (modulesPath + "/misc/assertions.nix")
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
        options.nix.package = lib.mkOption { type = lib.types.package; default = cross.nix; };
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
      ({ lib, pkgs, ... }: {
        environment.systemPackages = lib.mkForce [
          pkgs.busybox    # init, ash (the guest shell), coreutils applets
          pkgs.ncurses    # terminfo (xterm-256color)
        ];
        environment.defaultPackages = lib.mkForce [ ];
        environment.variables.TERM = "xterm-256color";

        users.mutableUsers = false;
        users.users.root = {
          uid = 0;
          # single-user guest: passwordless autologin (Task 4 emits empty pw field)
          shell = "/bin/sh";   # busybox ash, linked by the bootstrap
        };

        nix.enable = true;
        nix.settings.experimental-features = [ "nix-command" "flakes" ];
        nix.settings.substituters = lib.mkForce [ "file:///nix-cache" ];
        nix.settings.require-sigs = false;
        nix.settings.sandbox = false;
      })
    ];
  };
in
{ config = result.config; }
