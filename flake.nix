{
  description = "wasm32-linux-musl NOMMU toolchain + Nix, built with Nix (#139/#141)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };

      # ---- wasm32-linux-musl NOMMU toolchain, built from stock LLVM 21 -------
      # Build order: compiler-rt has no musl dep, so it comes first; musl links
      # against it.
      compilerRt = import ./toolchain/compiler-rt.nix { inherit pkgs; };
      musl = import ./toolchain/musl.nix { inherit pkgs compilerRt; };
      kernelHeaders = import ./toolchain/kernel-headers.nix { inherit pkgs; };
      libcxx = import ./toolchain/libcxx.nix { inherit pkgs musl kernelHeaders compilerRt; };
      sysroot = import ./toolchain/sysroot.nix { inherit pkgs musl kernelHeaders; };

      # ---- kernel-only patched lld: stock LLVM-21 lld + the joelseverin
      # wasm-ld GNU linker-script patch, rebased onto 21. Scoped here (not a
      # global overlay) so the shared cached toolchain is untouched.
      patchedLld = import ./toolchain/patched-lld.nix { inherit pkgs; };

      # ---- kernel cc/ld toolchain: stock clang-21 + the patched wasm-ld,
      # carrying pc's fake-llvm argv rewrites. Consumed only by kernel.nix.
      kernelCC = import ./toolchain/kernel-cc.nix { inherit pkgs patchedLld; };

      # ---- the wasm guest kernel: vmlinux.wasm, built from pinned source with
      # stock clang-21 + the patched wasm-ld. New exec ABI (039e5f3e); does not
      # boot yet (runtime forward-port pending).
      kernel = import ./kernel.nix {
        inherit pkgs kernelCC;
        kernelSrc = import ./toolchain/kernel-src.nix { inherit pkgs; };
      };

      # ---- the wasm32-linux-musl cross package set (cross.zlib, cross.curl…) --
      cross = import ./wasm-cross.nix {
        inherit nixpkgs sysroot compilerRt libcxx;
        overlays = [ (import ./deps-overlay.nix { inherit kernelHeaders; muslWasm = musl; }) ];
      };

      # ---- curated NixOS-module eval -> guest /etc (Approach B) --------------
      wasmSystem = import ./userspace/system.nix { inherit nixpkgs cross; };
      wasmPasswd = import ./userspace/passwd.nix {
        lib = cross.lib; pkgs = cross; config = wasmSystem.config;
      };

      # ---- PID 1: busybox init + generated inittab --------------------------
      wasmInit = import ./userspace/init.nix { lib = cross.lib; pkgs = cross; };

      # ---- assembled guest system closure (boot layout) ---------------------
      wasmToplevel = import ./userspace/toplevel.nix {
        pkgs = cross;
        etc = wasmSystem.config.system.build.etc;
        systemPath = wasmSystem.config.system.path;
        passwd = wasmPasswd.passwd;
        group = wasmPasswd.group;
        init = wasmInit;
      };

      # ---- Nix 2.34.7 itself, cross-compiled to wasm ------------------------
      nixSrc = pkgs.fetchFromGitHub {
        owner = "NixOS";
        repo = "nix";
        rev = "2.34.7";
        hash = "sha256-uj5KNW8Vdm60FCUxD2KsrCVH/WwoemvczWmmrb3Gvlo=";
      };
      nixWasm = import ./nix-wasm.nix {
        inherit pkgs cross sysroot kernelHeaders libcxx compilerRt nixSrc;
      };
    in
    {
      packages.${system} = {
        # Sanity anchor: the stock-LLVM-21 pin the whole plan rests on.
        llvmCheck = pkgs.writeText "llvm-version" pkgs.llvmPackages_21.clang.version;

        inherit compilerRt musl kernelHeaders libcxx sysroot;

        # Kernel-only patched lld with wasm-ld GNU linker-script support.
        patched-lld = patchedLld;

        # Kernel cc/ld wrapper toolchain (fake-llvm equivalent) for inspection.
        kernel-cc = kernelCC;

        # The wasm guest kernel: $out/vmlinux.wasm (new exec ABI; boot pending).
        kernel = kernel;

        # Smoke test for the cc-wrapper over the nix-built sysroot.
        crossZlib = cross.zlib;

        # Nix itself, cross-compiled → $out/bin/nix (the wasm binary).
        nix-wasm = nixWasm;

        # Curated NixOS-module eval -> guest /etc.
        userspace-etc = wasmSystem.config.system.build.etc;

        # Guest system profile (/run/current-system/sw): busybox + ncurses/terminfo.
        userspace-path = wasmSystem.config.system.path;

        # PID 1: busybox init binary is Task 7; this emits inittab + autologin.
        wasm-init = wasmInit;

        # Assembled guest system closure: $out/{etc,sw,init} in boot layout.
        wasm-system = wasmToplevel;

        # Static passwd/group files for the wasm guest.
        userspace-passwd = pkgs.runCommand "userspace-passwd" { } ''
          mkdir -p $out
          cp ${wasmPasswd.passwd} $out/passwd
          cp ${wasmPasswd.group} $out/group
        '';
      }
      # Nix's C dependency closure, each cross-built to wasm. Exposed as
      # `dep-<name>` so `nix build -k .#dep-…` surfaces every failure at once.
      // builtins.listToAttrs (map (n: { name = "dep-${n}"; value = cross.${n}; }) [
        "bzip2"
        "xz"
        "sqlite"
        "openssl"
        "curl"
        "libgit2"
        "brotli"
        "libarchive"
        "editline"
        "libsodium"
        "boost"
        "nlohmann_json"
        "libblake3"
        "busybox"
        "ncurses" # userspace targets (Nix-built guest), exposed for build/testing
      ]);
    };
}
