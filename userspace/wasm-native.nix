# wasm-native.nix — a nixpkgs package set modeled with the wasm32 Linux guest as
# both build and host platform. Its stdenv runs wholly inside the MMU guest over
# a bootstrap closure cross-built on the publish host.
{
  nixpkgs,
  cross,
  seedBash,
  seedMake,
  bootstrapBusybox,
  nativeCC,
  seedTools ? [ ],
  seedPackages ? { },
  overlays ? [ ],
}:
let
  wasmPlatform = cross.lib.systems.elaborate {
    config = "wasm32-unknown-linux-musl";
    system = "wasm32-linux";
    libc = "musl";
    useLLVM = true;
    isStatic = true;
    hasSharedLibraries = true;
  };

  # Re-tie the already-working generic cross stdenv around a native wasm platform
  # and replace every executable in its bootstrap path with a guest module. GNU
  # Bash is mandatory because generic/setup.sh is Bash. Seed tools provide the
  # GNU coreutils/find/patch/tar behavior setup.sh and source builders require;
  # BusyBox supplies the remaining sed/grep/awk/compression suite, seedMake is
  # cross-built GNU Make, and nativeCC wraps guest clang + LLVM bintools.
  seedStdenv = cross.stdenv.override {
    name = "wasm-native-stdenv";
    buildPlatform = wasmPlatform;
    hostPlatform = wasmPlatform;
    targetPlatform = wasmPlatform;
    shell = "${seedBash}/bin/bash";
    initialPath = seedTools ++ [ bootstrapBusybox seedMake seedBash nativeCC ];
    cc = nativeCC;
    # The cross stdenv's final stage carries host patchelf/autotools hooks and a
    # disallowed reference to its old bootstrap-tools closure. Neither belongs
    # in the first native guest derivation; generic source-only setup hooks and
    # the guest compiler remain available through the normal stdenv defaults.
    extraNativeBuildInputs = [ ];
    extraBuildInputs = [ ];
    disallowedRequisites = [ ];
    preHook = ''
      # wasm outputs are neither ELF nor Mach-O. LLVM already emits the final
      # dylink module, so the generic ELF strip/patchelf fixups do not apply.
      export dontStrip=1
      export dontPatchELF=1
      export NIX_NO_SELF_RPATH=1
      export CONFIG_SHELL=${seedBash}/bin/bash
      export SHELL=${seedBash}/bin/bash
      # Native autotools normally relies on config.guess because build == host.
      # uname reports the guest machine as "wasm", which upstream config.guess
      # cannot identify, so retain the explicit flags used by the cross seed.
      export configureFlags="--build=${wasmPlatform.config} --host=${wasmPlatform.config} ''${configureFlags-}"
      export AR=ar RANLIB=ranlib NM=nm STRIP=strip OBJCOPY=objcopy LD=wasm-ld
    '';
  };

  # Native pkgs.fetchurl cannot bootstrap its own curl before the first source
  # exists. Keep the full nixpkgs fetchurl/fetchzip interface, but seed it with
  # the already cross-built guest curl. Fetch derivations therefore run in the
  # guest and work for direct URLs, mirrors, and fetchFromGitHub without a cycle.
  seedFetchOverlay = final: _prev: {
    fetchurl = final.lib.makeOverridable (import "${nixpkgs}/pkgs/build-support/fetchurl") {
      inherit (final) lib;
      stdenvNoCC = final.stdenvNoCC;
      buildPackages = final;
      curl = cross.curlMinimal;
      cacert = cross.cacert;
      inherit (cross.config) hashedMirrors rewriteURL;
    };
  };
  # M3 decision: reuse ABI-identical host-crossed outputs for foundational
  # libraries and build tools already proven by the cross package set. This
  # keeps wget's first native build honest (wget itself is compiled in-guest)
  # without spending hours rebuilding Perl/OpenSSL/gettext before reaching it.
  seedPackageOverlay = final: _prev:
    let
      # Cross outputs carry __spliced alternatives for their original host
      # evaluation. If retained, nativeBuildInputs silently select the host ELF
      # alternative. Pin every splice role back to the guest-target derivation.
      # Foundational seed tools such as coreutils are also exposed here so hooks
      # can reuse the same guest module instead of recursively rebuilding the
      # bootstrap toolchain inside the memory-constrained guest.
      unsplice = p:
        let
          guest = removeAttrs p [ "__spliced" ] // {
            __spliced = final.lib.genAttrs
              [ "buildBuild" "buildHost" "buildTarget" "hostHost" "hostTarget" ]
              (_: guest);
          };
        in guest;
      seeded = builtins.mapAttrs (_: unsplice) seedPackages;
    in
    seeded
    // (if seeded ? perl then {
      # wget takes perlPackages.perl rather than the top-level perl argument.
      perlPackages = _prev.perlPackages // { perl = seeded.perl; };
    } else { });
in
import nixpkgs {
  localSystem = wasmPlatform;
  overlays = overlays ++ [ seedPackageOverlay seedFetchOverlay ];
  # nixpkgs 9ae611a's custom-stdenv dispatcher drops the required
  # `crossOverlays` argument when it recursively selects the vanilla stages.
  # Spell out the same one-stage replacement here until that upstream wiring
  # is fixed; config.replaceStdenv remains the source of the replacement.
  stdenvStages =
    {
      lib,
      localSystem,
      crossSystem,
      config,
      overlays,
      crossOverlays,
    }:
    let
      bootStages = import "${nixpkgs}/pkgs/stdenv" {
        inherit
          lib
          localSystem
          crossSystem
          overlays
          crossOverlays
          ;
        config = removeAttrs config [ "replaceStdenv" ];
      };
    in
    bootStages
    ++ [
      (vanillaPackages: {
        inherit config overlays;
        stdenv = config.replaceStdenv { pkgs = vanillaPackages; };
      })
    ];
  config = {
    allowUnsupportedSystem = true;
    replaceStdenv = { pkgs }: seedStdenv;
  };
}
