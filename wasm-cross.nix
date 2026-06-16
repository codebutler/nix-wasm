# The wasm32-linux-musl crossSystem: a real nixpkgs cross package set whose
# stdenv targets the guest ABI, with our clang-21 cc-wrapper plugged in via the
# supported config.replaceCrossStdenv seam. nixpkgs' own package definitions
# then cross-compile (cross.zlib, cross.curl, …) with no per-package rewriting.
#
# Built entirely on the nix-built toolchain (Tasks 3-7): `sysroot` (musl + kernel
# headers) and `compilerRt` (builtins) come in as store paths — no ~/lwbuild, no
# tarball. clang/bintools are stock llvmPackages_21.
#
# The filtered wasm-ld drops ELF-only linker flags individual nixpkgs derivations
# inject (--undefined-version, --version-script, -soname, --build-id, …) which
# wasm-ld rejects; wired in via clang -B$out/bin (clang's wasm driver ignores
# --ld-path). These flags are no-ops on wasm, so dropping them is correct.
{ nixpkgs, localSystem ? "aarch64-linux", sysroot, compilerRt, libcxx ? null, overlays ? [ ] }:
let
  native = import nixpkgs { system = localSystem; };

  mkWasmCC = pkgs:
    let
      llvm = native.llvmPackages_21;
      libcWasm = sysroot;
      # Our nix-built libc++/libc++abi/libunwind. Tag isLLVM so cc-wrapper emits
      # the libc++ C++ flags (-cxx-isystem .../c++/v1, -stdlib=libc++) and wires
      # the lib search path — without this, cross C++ (boost, and cmake's CXX
      # compiler check in C deps like llhttp) fails with "unable to find -lc++".
      libcxxWasm = if libcxx != null then libcxx // { isLLVM = true; } else null;

      resourceDir = native.runCommand "wasm-clang-resource" { } ''
        mkdir -p $out/include $out/lib/wasm32-unknown-unknown
        cp -a ${native.lib.getLib llvm.clang-unwrapped}/lib/clang/*/include/. $out/include/
        cp ${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a \
           $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
      '';

      # Kernel host-import names the dylink link allows undefined (imports).
      allowUndefined = native.writeText "wasm-allow-undefined.txt" ''
        __wasm_abort
        __cpp_exception
        logAPIs
        __dlsym_time64
        __cxa_thread_atexit_impl
        __wasm_syscall_0
        __wasm_syscall_1
        __wasm_syscall_2
        __wasm_syscall_3
        __wasm_syscall_4
        __wasm_syscall_5
        __wasm_syscall_6
      '';

      filteredLd = native.writeShellScriptBin "wasm-ld" ''
        args=(); skip=
        for a in "$@"; do
          if [ -n "$skip" ]; then skip=; continue; fi
          case "$a" in
            --undefined-version|--no-undefined-version) continue;;
            --version-script=*|--dynamic-list=*|-soname=*|--soname=*) continue;;
            --version-script|--dynamic-list|-soname|--soname) skip=1; continue;;
            --build-id|--build-id=*|--eh-frame-hdr|--hash-style=*) continue;;
            --compress-debug-sections=*) continue;;
            --compress-debug-sections) skip=1; continue;;
            --warn-shared-textrel|-z) skip=1; continue;;
            -z*) continue;;
          esac
          args+=("$a")
        done
        exec ${llvm.bintools-unwrapped}/bin/wasm-ld "''${args[@]}"
      '';

      # nixpkgs' bintools-wrapper only symlinks tools it finds under the TARGET
      # PREFIX (`wasm32-unknown-linux-musl-ar`, …), but stock LLVM binutils ship
      # them UNPREFIXED (`ar`, `ranlib`, `nm`, …). So the wrapper ends up with no
      # ar/ranlib/nm (and only a strip wrapper pointing at a nonexistent prefixed
      # strip). That leaves $AR/$RANLIB empty in every build → "stripDirs: Ranlib
      # command is empty", tzdata's "ar: command not found", brotli's static-
      # archive link failure. The LLVM tools are target-agnostic, so add the
      # target-prefixed symlinks (incl. a working strip) ourselves. One platform
      # fix, shared across the whole cross set.
      wasmBintools = (pkgs.wrapBintoolsWith {
        bintools = llvm.bintools-unwrapped;
        libc = libcWasm;
        sharedLibraryLoader = null;
      }).overrideAttrs (o: {
        postFixup = (o.postFixup or "") + ''
          for t in ar ranlib nm objcopy objdump size strings as readelf \
                   addr2line c++filt dwp strip; do
            if [ -e ${llvm.bintools-unwrapped}/bin/$t ]; then
              ln -sf ${llvm.bintools-unwrapped}/bin/$t \
                "$out/bin/wasm32-unknown-linux-musl-$t"
            fi
          done
        '';
      });
    in
    pkgs.wrapCCWith {
      cc = llvm.clang-unwrapped;
      bintools = wasmBintools;
      libc = libcWasm;
      libcxx = libcxxWasm;
      extraBuildCommands = ''
        ln -sf ${filteredLd}/bin/wasm-ld $out/bin/wasm-ld
        cat >> $out/nix-support/cc-cflags <<EOF
         --target=wasm32-unknown-unknown -D__linux__ -D_GNU_SOURCE -D_LARGEFILE64_SOURCE -fPIC -matomics -mbulk-memory -resource-dir=${resourceDir} -B$out/bin -Wno-error=implicit-function-declaration -Wno-error=implicit-int -Wno-error=unused-command-line-argument
        EOF
        cat >> $out/nix-support/cc-ldflags <<EOF
         -shared -Bsymbolic --no-entry --export-all --import-memory --shared-memory --max-memory=4294967296 --import-table --no-merge-data-segments --export-if-defined=__set_tls_base --export-if-defined=__libc_handle_signal --allow-undefined-file=${allowUndefined}
        EOF
      '';
    };
in
import nixpkgs {
  inherit overlays;
  localSystem = { system = localSystem; };
  crossSystem = {
    config = "wasm32-unknown-linux-musl";
    libc = "musl";
    useLLVM = true;
    # NB: we deliberately do NOT set hasSharedLibraries=false — it makes
    # stdenv.hostPlatform.extensions.sharedLibrary missing, which sqlite (and
    # others) read unconditionally in configureFlags → eval abort. Shared-lib
    # handling is instead: musl ships a crt1-reactor.o so `.so` links succeed,
    # and the few packages whose CLI links against its own `.so` (TLS model
    # mismatch on wasm) get a per-dep `enableShared = false` in deps-overlay.nix.
  };
  config = {
    allowUnsupportedSystem = true;
    replaceCrossStdenv = { buildPackages, baseStdenv }:
      let
        adapters = buildPackages.stdenvAdapters;
        ccStdenv = adapters.overrideCC baseStdenv (mkWasmCC buildPackages);
        salt = builtins.replaceStrings [ "-" ] [ "_" ] "wasm32-unknown-linux-musl";
      in
      # Static-library handling is done per-build-system in deps-overlay.nix
      # (--disable-shared / -DBUILD_SHARED_LIBS=OFF / link=static), NOT via
      # stdenvAdapters.makeStaticLibraries — that adapter doesn't compose with
      # this custom replaceCrossStdenv (its dontAddStaticConfigureFlags resolves
      # to null → eval error). We disable .so so packages don't link their own
      # tools against a wasm .so (general-dynamic TLS trips wasm-ld on musl's
      # __musl_tp); we only need the .a archives.
      adapters.addAttrsToDerivation {
        NIX_NO_SELF_RPATH = "1";
        "NIX_DONT_SET_RPATH_${salt}" = "1";
      } ccStdenv;
  };
}
