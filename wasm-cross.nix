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

      # The dylink link's allow-list of host-provided imports — the shared
      # single source of truth (toolchain/wasm-host-imports.nix), so the
      # crossSystem cc-wrapper, guest-clang, guest-cxx and nix.wasm all enforce
      # the SAME no-undef contract (#52). Passed to wasm-ld via
      # --allow-undefined-file (NOT a blanket --allow-undefined): a stray
      # fork/exec/system reference then fails the link loudly.
      allowUndefined = import ./toolchain/wasm-host-imports.nix { pkgs = native; };

      filteredLd = native.writeShellScriptBin "wasm-ld" ''
        args=(); skip=; has_r=
        for a in "$@"; do
          case "$a" in -r) has_r=1;; esac
        done
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
            # -r (partial/relocatable link) is incompatible with --shared-memory:
            # busybox uses -r to produce built-in.o; wasm-ld rejects the combo.
            # Drop --shared-memory when -r is present (it's harmless for partial
            # links — the final dylink module still gets --shared-memory via its
            # own link step).
            --shared-memory) if [ -n "$has_r" ]; then continue; fi;;
            # GNU ld archive-group flags: wasm-ld doesn't implement them
            # (they're no-ops in lld anyway — it doesn't need group ordering).
            --start-group|--end-group) continue;;
            # GNU ld-only diagnostic flags that wasm-ld rejects.
            --warn-common) continue;;
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
      # -fvisibility=hidden -fvisibility-inlines-hidden (in cc-cflags below) is a
      # SHARED fix for C++ stream-class vtable env-imports — do NOT "clean it up".
      # Background: every guest binary is a self-contained `-shared` dylink module
      # (one wasm module; nothing is preempted across modules at runtime — the host
      # provides only the documented allow-list imports). But wasm-ld's
      # shouldImport() (lld/wasm/Writer.cpp) has a path that, in `--shared` mode,
      # turns ANY symbol that is *weakly defined* AND *not hidden* into BOTH an
      # `env.*` import and an export ("so it can be overridden by another module"):
      #     if (ctx.arg.shared && sym->isWeak() && !sym->isUndefined()
      #         && !sym->isHidden()) return true;  // import it
      # C++ vague/COMDAT-linkage symbols (template-instantiated virtual destructors
      # + their vtables/thunks) are weak. libc++ itself is built -fvisibility=hidden,
      # so its copies are hidden — but when an APP TU instantiates e.g.
      # std::basic_stringstream<char> (sommelier's logging holds a stringstream),
      # the app's own instantiation has DEFAULT visibility and the merged symbol
      # is non-hidden → wasm-ld imports the destructor as `env._ZNSt3__1...D1Ev`,
      # and the module fails to instantiate (no host function of that name).
      # `-Wl,-u,<sym>` does NOT help (the symbol IS defined — it's a weak-PIC
      # preemption, not an undefined-symbol problem); `-Wl,-Bsymbolic` does NOT
      # help either (it only gates requiresGOTAccess(), not this import path).
      # Compiling guest TUs with hidden default visibility makes those app-side
      # vague-linkage instantiations hidden → shouldImport()'s `!isHidden()` gate
      # is false → no env import, the in-module definition is used. It is SAFE for
      # our model: `--export-all` (in cc-ldflags) still exports every symbol
      # (export count is unchanged — verified: _start/main/__set_tls_base/
      # __libc_handle_signal/__wasm_apply_data_relocs/malloc all still exported),
      # so the host↔guest export contract is untouched; hidden visibility only
      # changes cross-MODULE dynamic preemption, which our single-module dylink
      # binaries never use. This is the corollary-1 SHARED fix: it benefits every
      # guest C++ binary (nix.wasm, GTK apps, sommelier), not a per-app rewrite.
      extraBuildCommands = ''
        ln -sf ${filteredLd}/bin/wasm-ld $out/bin/wasm-ld
        cat >> $out/nix-support/cc-cflags <<EOF
         --target=wasm32-unknown-unknown -D__linux__ -D_GNU_SOURCE -D_LARGEFILE64_SOURCE -fPIC -matomics -mbulk-memory -resource-dir=${resourceDir} -B$out/bin -Wno-error=implicit-function-declaration -Wno-error=implicit-int -Wno-error=unused-command-line-argument -fvisibility=hidden -fvisibility-inlines-hidden
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
    # isStatic = true makes the whole wasm set build static: packages read
    # `hostPlatform.isStatic` (zlib `shared=!isStatic`, openssl `static`, sqlite
    # `--disable-tcl`+static CLI, …) AND nixpkgs applies makeStatic (=
    # makeStaticLibraries adding --disable-shared/-DBUILD_SHARED_LIBS=OFF/
    # -Ddefault_library=static everywhere). We want static .a only — packages
    # that link their own CLI against a wasm .so hit wasm-ld's general-dynamic
    # TLS path → musl's non-TLS `__musl_tp`. (makeStatic also adds
    # makeStaticBinaries' `-static`, a harmless no-op on wasm — our final modules
    # are -shared dylink, set in the cc-wrapper's cc-ldflags, which wins.)
    #
    # hasSharedLibraries = true is FORCED back on: isStatic would otherwise drop
    # `extensions.sharedLibrary`, which sqlite et al. read unconditionally in
    # configureFlags → eval abort.
    isStatic = true;
    hasSharedLibraries = true;
  };
  config = {
    allowUnsupportedSystem = true;
    replaceCrossStdenv = { buildPackages, baseStdenv }:
      let
        adapters = buildPackages.stdenvAdapters;
        ccStdenv = adapters.overrideCC baseStdenv (mkWasmCC buildPackages);
        salt = builtins.replaceStrings [ "-" ] [ "_" ] "wasm32-unknown-linux-musl";
      in
      adapters.addAttrsToDerivation {
        NIX_NO_SELF_RPATH = "1";
        "NIX_DONT_SET_RPATH_${salt}" = "1";
      } ccStdenv;
  };
}
