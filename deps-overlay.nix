# Per-package cross fixes for the wasm32 dependency closure. Each entry
# documents WHY. Correct cross-compilation handling (the ncurses-style
# precedent), NOT stubs or shortcuts.
#
# SCOPING: an overlay is applied to BOTH the cross (wasm) set AND buildPackages
# (native). We must only touch the wasm builds — overriding native zlib/openssl
# (depended on by half of nixpkgs) forces the whole native build toolchain
# (coreutils, python, …) to rebuild from source instead of substituting from
# cache. So every override is guarded by `prev.stdenv.hostPlatform.isWasm`,
# which is true only in the wasm cross set.
#
# Dominant theme: STATIC-ONLY. A package that builds a wasm .so and links its own
# CLI/tools against it hits wasm-ld's general-dynamic TLS path, which trips on
# musl's bootstrap __musl_tp ("relocation R_WASM_MEMORY_ADDR_TLS_SLEB against
# non-TLS symbol"). We only need the .a archives, so disable shared everywhere.
{ kernelHeaders, muslWasm }:
final: prev:
let
  isWasm = prev.stdenv.hostPlatform.isWasm or false;
  # Apply f only in the wasm cross set; leave native packages untouched (cached).
  whenWasm = f: p: if isWasm then f p else p;

  # Generic static flags — each build system ignores the ones that aren't its
  # own (cmake ignores configureFlags, autotools ignores cmakeFlags, …).
  noShared = whenWasm (p: p.overrideAttrs (o: {
    configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-shared" "--enable-static" ];
    cmakeFlags = (o.cmakeFlags or [ ]) ++ [ "-DBUILD_SHARED_LIBS=OFF" ];
    mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Ddefault_library=static" ];
  }));
in
{
  # --- runtimeShell leak: use the native shell, not a cross (wasm) bash -------
  # runtimeShell = "${runtimeShellPackage}${shellPath}" and runtimeShellPackage =
  # bashNonInteractive. In the cross set that resolves to a wasm bash, so helper
  # scripts (zstdgrep, *-config, makeWrapper shebangs) drag in a cross-built bash
  # — which fails to build (and is pointless: these scripts run on the BUILD host,
  # or aren't used by nix.wasm at all). Point the shell machinery at the native
  # bash. A guest shell, when needed, is a separate user package.
  bash = whenWasm (_: final.buildPackages.bash) prev.bash;
  bashNonInteractive = whenWasm (_: final.buildPackages.bashNonInteractive) prev.bashNonInteractive;
  # gnugrep gets cross-built for wasm because zstd's zstdgrep wrapper script
  # substitutes a grep path; the wasm build fails (gnulib's sigsegv/stackvma has
  # no wasm support) and we don't need a guest grep for these build-time helper
  # scripts. Use the native grep.
  gnugrep = whenWasm (_: final.buildPackages.gnugrep) prev.gnugrep;
  runtimeShellPackage = if isWasm then final.buildPackages.bashNonInteractive else prev.runtimeShellPackage;
  runtimeShell =
    if isWasm
    then "${final.buildPackages.bashNonInteractive}${final.buildPackages.bashNonInteractive.shellPath}"
    else prev.runtimeShell;

  # --- static-only via the derivation's own arg (custom build systems) -------
  bzip2 = whenWasm (p: p.override { enableShared = false; }) prev.bzip2;
  # openssl: static, and undo the wrapper's forced -D_GNU_SOURCE. openssl's
  # o_str.c picks the GNU strerror_r prototype (returns char*) when _GNU_SOURCE
  # is defined, but musl ALWAYS provides the POSIX strerror_r (returns int) — so
  # the GNU branch assigns int→char* and clang errors (-Wint-conversion). -U lets
  # openssl take its correct POSIX branch on musl. (-U follows the wrapper's -D in
  # NIX_CFLAGS_COMPILE, so it wins.)
  openssl = whenWasm
    (p: (p.override { static = true; }).overrideAttrs (o: {
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + " -U_GNU_SOURCE";
      };
    }))
    prev.openssl;
  # boost: static, and strip the b2 `architecture=`/`binary-format=` target
  # metadata — nixpkgs derives them from the platform (cpu.family="wasm",
  # execFormat="wasm"), but Boost.Build rejects "wasm" ("not a known value of
  # feature <architecture>"). They're only metadata; the compile targets wasm via
  # clang regardless. Strip them from the (already-interpolated) b2 phases.
  boost = whenWasm
    (p: (p.override { enableShared = false; enableStatic = true; }).overrideAttrs (o: {
      buildPhase = builtins.replaceStrings
        [ "architecture=wasm " "binary-format=wasm " ] [ "" "" ]
        o.buildPhase;
      installPhase = builtins.replaceStrings
        [ "architecture=wasm " "binary-format=wasm " ] [ "" "" ]
        o.installPhase;
    }))
    prev.boost;

  # --- static-only via generic build-system flags ----------------------------
  xz = noShared prev.xz;
  # sqlite: static lib + a STATICALLY-linked CLI shell (sqlite3), which is useful
  # to keep. __musl_tp only trips when linking against a separate .so (cross-
  # module general-dynamic TLS); a fully-static program (incl. stdio) links fine
  # — same model as nix.wasm. --static-cli-shell links sqlite3 against libsqlite3.a
  # instead of the .so. Drop tcl (tclsqlite3 would link a wasm tcl .so → __musl_tp,
  # and we don't need the Tcl binding). Filter nixpkgs' --with-tcl so no wasm tcl
  # is pulled at all.
  sqlite = whenWasm
    (p: (noShared p).overrideAttrs (o: {
      configureFlags =
        (builtins.filter (f: !(prev.lib.hasPrefix "--with-tcl" f)) (o.configureFlags or [ ]))
        ++ [ "--disable-tcl" "--static-cli-shell" ];
    }))
    prev.sqlite;
  # Trim curl to what Nix's binary-cache client needs (HTTP/HTTPS via openssl).
  # nixpkgs enables HTTP/3 by default, which pulls ngtcp2/nghttp3 (extra wasm
  # cross-builds we don't need); also drop gss/ldap/brotli. Feature override +
  # static, both guarded to the wasm set so native curl is untouched.
  curl = whenWasm
    (p: (p.override {
      http2Support = false; # nghttp2
      http3Support = false; # ngtcp2/nghttp3
      c-aresSupport = false; # c-ares
      gssSupport = false;
      ldapSupport = false;
      brotliSupport = false;
      idnSupport = false;
      zstdSupport = false;
      pslSupport = false; # drops libpsl → libidn2/libunistring (IDN public-suffix)
      scpSupport = false; # drops libssh2 (scp/sftp); Nix's cache client is HTTP(S)
    }).overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-shared" "--enable-static" ];
    }))
    prev.curl;
  # libgit2 without ssh (drops libssh2 + its transitive openssl/zlib link path).
  # libgit2 without ssh (drops libssh2) and without the tests/CLI executables —
  # libgit2_tests links llhttp's static lib whose api.c references consumer
  # callbacks (wasm_on_*) undefined at exe-link time; we only need libgit2.a.
  libgit2 = whenWasm
    (p: (p.override { libssh2 = null; }).overrideAttrs (o: {
      cmakeFlags = (o.cmakeFlags or [ ]) ++ [
        "-DBUILD_SHARED_LIBS=OFF"
        "-DUSE_SSH=OFF"
        "-DBUILD_TESTS=OFF"
        "-DBUILD_CLI=OFF"
      ];
    }))
    prev.libgit2;
  # libarchive without acl/xattr: those pull `acl`→`attr`, and attr's source
  # uses `.symver` symbol-versioning inline asm, which the wasm clang rejects
  # ("unknown directive"). Nix only uses libarchive to READ archives; ACLs and
  # extended attributes are meaningless on the wasm/NOMMU guest. Disabling them
  # drops the whole acl/attr subtree. (autotools: --disable-acl/--disable-xattr;
  # null the inputs so configure can't pick them up from the sysroot either.)
  # zstd: static. `static = true` sets BUILD_SHARED=OFF and PROGRAMS_LINK_SHARED
  # =OFF, so the zstd/zstd-frugal CLIs link libzstd.a statically (no .so → no
  # __musl_tp; same model as the sqlite shell) — keeping the useful CLI and its
  # man pages. (Disabling programs instead left an empty `man` output → "failed
  # to produce output path".)
  zstd = whenWasm (p: p.override { static = true; }) prev.zstd;
  libarchive = whenWasm
    (p: (p.override { acl = null; attr = null; }).overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [
        "--disable-shared"
        "--enable-static"
        "--disable-acl"
        "--disable-xattr"
      ];
    }))
    prev.libarchive;
  editline = noShared prev.editline;
  libsodium = noShared prev.libsodium;
  brotli = noShared prev.brotli;
  libblake3 = noShared prev.libblake3;
  # Transitive deps of the curl/libgit2 closure that otherwise build a .so and
  # link their CLI/programs against it → __musl_tp (see zlib). Static-only so any
  # programs they build link the .a directly (which links fine on wasm).
  pcre2 = noShared prev.pcre2;
  libxml2 = noShared prev.libxml2;
  libidn2 = noShared prev.libidn2;
  # llhttp ignores the generic BUILD_SHARED_LIBS; it gates its shared/static
  # targets on its OWN LLHTTP_BUILD_*_LIBS vars (keyed off isStatic). The shared
  # target (libllhttp.so) references consumer-provided callbacks (wasm_on_*) that
  # are undefined at lib-link time. Build only the static lib.
  llhttp = whenWasm
    (p: p.overrideAttrs (o: {
      cmakeFlags = (o.cmakeFlags or [ ]) ++ [
        "-DLLHTTP_BUILD_SHARED_LIBS=OFF"
        "-DLLHTTP_BUILD_STATIC_LIBS=ON"
      ];
    }))
    prev.llhttp;

  # --- kernel UAPI headers: use OUR wasm headers, not stock Linux ------------
  # The cross stdenv/musl pull nixpkgs' stock linuxHeaders (linux-6.18.7) and run
  # `make ARCH=wasm32 headers_install`, which fails — stock Linux has no wasm
  # arch. Point the whole cross set at our joelseverin-wasm UAPI headers
  # (kernel-headers.nix). One platform fix that unblocks every package, not just
  # nix.wasm. We wrap to match linuxHeaders' shape ($out/include) + carry a
  # version so consumers that read .version don't break.
  linuxHeaders = whenWasm
    (p: kernelHeaders.overrideAttrs (_: { version = p.version or "wasm-7.0"; }))
    prev.linuxHeaders;
  linuxHeadersCross = final.linuxHeaders;

  # --- cross musl: use OUR nix-built musl, not nixpkgs' --------------------------
  # nixpkgs' cross musl (musl-wasm32) is built during the libc bootstrap by the
  # DEFAULT cross cc-wrapper, which embeds an llvmPackages compiler-rt compiled
  # with the rejected `wasm32-unknown-linux-musl` triple — a stage reached by
  # neither `overlays` nor `crossOverlays`, so it can't be fixed in place and
  # fails to build, cascading to everything (it's pulled transitively via
  # `libiconv` = musl-iconv). It is NOT the stdenv's libc (that's our sysroot),
  # only musl-iconv's build input. Point it at OUR musl (toolchain/musl.nix,
  # already built correctly by our own toolchain), wrapped to nixpkgs musl's
  # out/dev shape + passthru.linuxHeaders. Eliminates the broken bootstrap musl
  # and its compiler-rt entirely. (libiconv follows, below.)
  musl = whenWasm
    (p: final.runCommandLocal "musl-${p.version or "1.2.5"}"
      {
        pname = "musl";
        version = p.version or "1.2.5";
        passthru = { linuxHeaders = final.linuxHeaders; };
        outputs = [ "out" "dev" ];
      } ''
      mkdir -p $out/lib $dev/include
      cp -a ${muslWasm}/lib/. $out/lib/
      cp -a ${muslWasm}/include/. $dev/include/
    '')
    prev.musl;

  # --- nixpkgs cross compiler-rt: fix the triple clang rejects ---------------
  # useLLVM=true pulls the cross compiler-rt for the gcc-compat runtime
  # (libgcc.a); a few deps (curl/libarchive/boost) link it. The compiler-rt that
  # actually gets built is `llvmPackages_21.compiler-rt` (there is NO top-level
  # `compiler-rt` attr in this set — a plain `compiler-rt = …` override is dead
  # code). nixpkgs builds it with -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-linux-
  # musl, which clang rejects ("unknown target triple"). Override it INSIDE the
  # llvm scope (overrideScope, so internal refs pick it up) to the canonical wasm
  # triple our own compiler-rt.nix uses, plus the builtins→libgcc.a alias the
  # runtime needs. `llvmPackages` aliases `_21` here, so point it at the override.
  llvmPackages_21 =
    if isWasm then
      prev.llvmPackages_21.overrideScope (lf: lp: {
        compiler-rt = lp.compiler-rt.overrideAttrs (o: {
          cmakeFlags = builtins.map
            (f: builtins.replaceStrings [ "wasm32-unknown-linux-musl" ] [ "wasm32-unknown-unknown" ] f)
            (o.cmakeFlags or [ ]);
          postInstall = (o.postInstall or "") + ''
            ln -s $out/lib/*/libclang_rt.builtins-*.a $out/lib/libgcc.a 2>/dev/null || true
          '';
        });
      })
    else prev.llvmPackages_21;
  llvmPackages = if isWasm then final.llvmPackages_21 else prev.llvmPackages;

  # --- zlib: static-only + errno fix (wasm only) -----------------------------
  # static-only: zlib otherwise builds libz.so AND shared example programs
  # (minigzipsh/examplesh) that link against it; on wasm the -shared link pulls
  # musl libc.a TLS functions and trips wasm-ld on __musl_tp (the general-dynamic
  # TLS issue the whole static-only strategy avoids). `shared = false` makes
  # zlib's buggy ./configure build only libz.a (and drops splitStaticOutput).
  # errno fix: zlib 1.3.2 gates `#include <errno.h>` behind NO_STRERROR; errno.h
  # IS in the sysroot and the gz code uses errno regardless, so force-include it.
  zlib = whenWasm
    (p: (p.override { shared = false; }).overrideAttrs (o: {
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + " -include errno.h";
      };
    }))
    prev.zlib;
}
