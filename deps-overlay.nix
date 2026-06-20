# Per-package cross fixes for the wasm32 dependency closure. Each entry documents
# WHY. Correct cross-compilation handling, NOT stubs or shortcuts.
#
# SCOPING: an overlay applies to BOTH the cross (wasm) set AND buildPackages
# (native). We must only touch the wasm builds — overriding native zlib/openssl
# (depended on by half of nixpkgs) forces the whole native build toolchain to
# rebuild from source instead of substituting. So every override is guarded by
# `prev.stdenv.hostPlatform.isWasm`, true only in the wasm cross set.
#
# STATIC is handled at the PLATFORM level, not here: the crossSystem sets
# `isStatic = true` (see wasm-cross.nix), so nixpkgs applies `makeStatic`
# (--disable-shared / -DBUILD_SHARED_LIBS=OFF / -Ddefault_library=static
# everywhere) AND packages read `hostPlatform.isStatic` for their own static
# logic (zlib `shared=!isStatic`, openssl `static`, sqlite `--disable-tcl`, zstd
# `static`, llhttp `LLHTTP_BUILD_*_LIBS`, …). We only want the .a archives:
# linking a CLI against a separate wasm .so hits wasm-ld's general-dynamic TLS
# path → musl's non-TLS `__musl_tp`. So the entries below are only the
# NON-static, per-package cross fixes that isStatic can't express.
{ kernelHeaders, muslWasm }:
final: prev:
let
  isWasm = prev.stdenv.hostPlatform.isWasm or false;
  # Apply f only in the wasm cross set; leave native packages untouched (cached).
  whenWasm = f: p: if isWasm then f p else p;

  # Patch compiler-rt (and compiler-rt-no-libc — busybox's clangNoLibcxx stdenv
  # uses targetLlvmPackages.compiler-rt-no-libc via overrideScope's `self`, so
  # both attrs must be fixed) inside any llvmPackages scope: replace the rejected
  # `wasm32-unknown-linux-musl` triple with the canonical `wasm32-unknown-unknown`
  # clang accepts, and add the builtins→libgcc.a alias the gcc-compat runtime needs.
  # `overrideScope` lets internal refs (clangNoLibcxx, clangUseLLVM, …) pick up the
  # fixed derivations without a second round of overriding.
  fixCompilerRt = lp: lp.overrideScope (lf: lprev:
    let
      fixCR = drv: drv.overrideAttrs (o: {
        cmakeFlags = builtins.map
          (f: builtins.replaceStrings [ "wasm32-unknown-linux-musl" ] [ "wasm32-unknown-unknown" ] f)
          (o.cmakeFlags or [ ])
          # Disable CRT (crtbegin/crtend): wasm32 doesn't support the
          # .init_fini-array CRT approach (crtbegin.c: "#error not implemented").
          # We only need the builtins archive (libclang_rt.builtins-wasm32.a),
          # not the startup objects — those are irrelevant for dylink wasm modules.
          ++ [ "-DCOMPILER_RT_BUILD_CRT=OFF" ];
        # NOTE: we REPLACE (not append) upstream postInstall. Safe because the
        # only variant built on wasm is compiler-rt-no-libc (haveLibc=false →
        # withAtomics=false, and CRT=OFF means there are no crt objects to
        # symlink), so upstream's atomics/crt postInstall blocks are inert here.
        # If a libc-bearing variant ever builds, switch back to appending.
        postInstall = ''
          ln -s $out/lib/*/libclang_rt.builtins-*.a $out/lib/libgcc.a 2>/dev/null || true
        '';
      });
    in {
      # Redundant on wasm (nixpkgs aliases compiler-rt = compiler-rt-no-libc, which
      # we fix below), but kept for any direct consumer that references compiler-rt.
      compiler-rt        = fixCR lprev.compiler-rt;
      # On wasm nixpkgs aliases compiler-rt = compiler-rt-no-libc; clangNoLibcxx
      # (= clangWithLibcAndBasicRt) uses targetLlvmPackages.compiler-rt-no-libc,
      # which resolves to `self` (selfTargetTarget == {}) inside overrideScope, so
      # fixing this attr propagates into every clang-wrapper that references it.
      compiler-rt-no-libc = fixCR lprev.compiler-rt-no-libc;
    });
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
  # no wasm support) and we don't need a guest grep for these build-time scripts.
  gnugrep = whenWasm (_: final.buildPackages.gnugrep) prev.gnugrep;
  runtimeShellPackage = if isWasm then final.buildPackages.bashNonInteractive else prev.runtimeShellPackage;
  runtimeShell =
    if isWasm
    then "${final.buildPackages.bashNonInteractive}${final.buildPackages.bashNonInteractive.shellPath}"
    else prev.runtimeShell;

  # --- per-package NON-static cross fixes -------------------------------------

  # openssl: undo the wrapper's forced -D_GNU_SOURCE. openssl's o_str.c picks the
  # GNU strerror_r prototype (returns char*) when _GNU_SOURCE is defined, but musl
  # ALWAYS provides POSIX strerror_r (returns int) → the GNU branch assigns
  # int→char* and clang errors (-Wint-conversion). -U lets openssl take its POSIX
  # branch on musl. (static linking comes from isStatic.)
  openssl = whenWasm
    (p: p.overrideAttrs (o: {
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + " -U_GNU_SOURCE";
      };
    }))
    prev.openssl;

  # --- libffi: replace the emscripten-JS wasm backend with a raw one ----------
  # libffi 3.5 auto-selects src/wasm/ffi.c for any wasm32 host, but that file is
  # written entirely in EM_JS — it implements ffi_call/closures as JavaScript the
  # *emscripten* runtime executes, and unconditionally #include's
  # <emscripten/emscripten.h>. Our non-emscripten wasm guest has no JS host, so it
  # neither compiles nor could work. libffi's own ffitarget.h already defines the
  # non-emscripten ABI (FFI_WASM32, "raw") and picks it as FFI_DEFAULT_ABI when
  # __EMSCRIPTEN__ is unset — it just never implemented it. We drop in that
  # implementation: ffi_call dispatched through statically-typed call_indirect
  # trampolines (the only way to make an indirect call on wasm). wasm requires
  # each indirect call's signature to be statically known, so the set of callable
  # signatures is enumerated at BUILD time by patches/libffi/gen-trampolines.py
  # (run in postPatch below, emitting src/wasm/wasm-ffi-trampolines.inc which
  # ffi.c #include's). The generator covers all-i32 argument lists up to K=24
  # plus up to MAX_NON_I32 (=2) by-value f32/f64/i64 arguments per call within
  # K=10 — so the backend now handles int/pointer C ABIs AND the common float/
  # double/long-long-by-value cases (cairo/pango doubles, libwayland's i32/ptr
  # dispatch) with scalar returns. It still fails LOUD ("argument signature
  # outside generated bounds") past those (K, M) bounds, and on what the raw wasm
  # ABI genuinely can't express (struct args, varargs, closures) — never a silent
  # mis-call. See patches/libffi/wasm32-raw-ffi.c for the full rationale.
  libffi = whenWasm
    (p: p.overrideAttrs (o: {
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ final.buildPackages.python3 ];
      postPatch = (o.postPatch or "") + ''
        cp ${./patches/libffi/wasm32-raw-ffi.c} src/wasm/ffi.c
        python3 ${./patches/libffi/gen-trampolines.py} > src/wasm/wasm-ffi-trampolines.inc
      '';
    }))
    prev.libffi;

  # --- harfbuzz: glib-free for the M2 text stack ------------------------------
  # nixpkgs harfbuzz enables the glib integration (hb-glib) by default, which would
  # drag the entire glib cross-build into the M2 text layer. M2 only needs core
  # harfbuzz shaping (hb_shape over an hb_ft_font), which is glib-independent — so
  # disable glib here. glib + pango (which DO need glib) are M3. isWasm-guarded so
  # native harfbuzz is untouched.
  harfbuzz = whenWasm
    (p: (p.override { glib = null; }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Dglib=disabled" "-Dgobject=disabled" "-Dtests=disabled" "-Ddocs=disabled" ];
      # nixpkgs harfbuzz has a `devdoc` output populated by gtk-doc; with docs
      # disabled that dir is never created → the builder errors out on the missing
      # output. Drop devdoc — we only need the lib + headers.
      outputs = [ "out" "dev" ];
    }))
    prev.harfbuzz;

  # --- glib: cross-build for the GTK stack (M3a) ------------------------------
  # nixpkgs glib drags libselinux/libsepol, util-linux (libmount) and
  # libsysprof-capture — none cross-compile to NOMMU wasm and none are needed for a
  # GTK app. Disable them + tests/man/dtrace. gio's loadable modules build INTO
  # libgio on the static build (the NOMMU guest can't dlopen). The build-time
  # codegen tools (glib-genmarshal/compile-schemas/…) come from native
  # buildPackages via meson cross. libffi is the M1 raw backend (gobject's generic
  # marshaller → ffi_call). isWasm-guarded so native glib is untouched.
  # NOTE: this nixpkgs' glib has no `selinuxSupport`/`mountSupport` toggles — the
  # un-crossable deps are added as raw buildInputs (libselinux + util-linuxMinimal
  # on isLinux, libsysprof-capture on !isFreeBSD). `libselinux`/`libsysprof-capture`
  # can be nulled via package args, but `util-linuxMinimal` is guarded by an
  # `isLinux -> util-linuxMinimal != null` assert (our wasm host IS isLinux), so we
  # keep it at its default to pass the assert and instead REMOVE it (and libselinux
  # / libsysprof-capture, defensively) from the realised buildInputs in
  # overrideAttrs. The meson `-D…=disabled` flags are the load-bearing fix that
  # stops glib from compiling/linking against any of them. `-Ddocumentation=false`
  # drops the unconditional gi-docgen doc build (a native-only doc toolchain).
  # We also drop the TARGET `gnum4` (a glib buildInput only so glib installs m4
  # macros "for other apps to use" on the guest) — m4 doesn't cross-compile to
  # wasm (gnulib's stackvma.c stack-overflow probe has no wasm code path) and the
  # static NOMMU guest never consumes glib's m4 macros. The native build-time m4
  # (under nativeBuildInputs, from buildPackages) is untouched.
  glib = whenWasm
    (p: (p.override {
      libselinux = null;
      libsysprof-capture = null;
    }).overrideAttrs (o:
      let
        dropMount = builtins.filter
          (i: !builtins.elem (i.pname or "")
            [ "util-linux-minimal" "util-linux" "libselinux" "libsysprof-capture" "gnum4" "m4" ]);
      in
      {
        buildInputs = dropMount (o.buildInputs or [ ]);
        propagatedBuildInputs = dropMount (o.propagatedBuildInputs or [ ]);
        # With `-Ddocumentation=false` the `devdoc` output (gtk-doc/gi-docgen HTML)
        # is never produced → the builder errors on the missing output. Drop it; the
        # guest only needs the libs + headers (same pattern as the harfbuzz override).
        outputs = builtins.filter (x: x != "devdoc") (o.outputs or [ "out" ]);
        mesonFlags = (o.mesonFlags or [ ]) ++ [
          "-Dselinux=disabled"
          "-Dlibmount=disabled"
          "-Dsysprof=disabled"
          "-Dman-pages=disabled"
          "-Ddtrace=disabled"
          "-Ddocumentation=false"
          "-Dtests=false"
          "-Dnls=enabled"
        ];
      }))
    prev.glib;

  # boost: strip the b2 `architecture=`/`binary-format=` target metadata —
  # nixpkgs derives them from the platform (cpu.family="wasm", execFormat="wasm"),
  # but Boost.Build rejects "wasm" ("not a known value of feature <architecture>").
  # They're only metadata; the compile targets wasm via clang regardless. Strip
  # them from the (already-interpolated) b2 phases. (static comes from isStatic.)
  boost = whenWasm
    (p: p.overrideAttrs (o: {
      buildPhase = builtins.replaceStrings
        [ "architecture=wasm " "binary-format=wasm " ] [ "" "" ]
        o.buildPhase;
      installPhase = builtins.replaceStrings
        [ "architecture=wasm " "binary-format=wasm " ] [ "" "" ]
        o.installPhase;
    }))
    prev.boost;

  # sqlite: keep a STATICALLY-linked CLI shell (sqlite3) — useful, and it links
  # fine because __musl_tp only trips on separate-.so links, not fully-static ones
  # (same model as nix.wasm). isStatic already gives --disable-tcl + --disable-
  # shared; --static-cli-shell forces the CLI to link libsqlite3.a.
  sqlite = whenWasm
    (p: p.overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [ "--static-cli-shell" ];
      # WAL journaling needs a shared-memory `-shm` file (mmap) the wasm/NOMMU
      # guest fs can't provide → Nix's store DB writes fail with SQLITE_IOERR
      # ("disk I/O error" on the first store op). Disable WAL + threadsafe
      # mutexing (single-threaded guest) + load-extension — the proven config
      # for this target's filesystem.
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "")
          + " -DSQLITE_OMIT_WAL -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION";
      };
    }))
    prev.sqlite;

  # curl: trim to what Nix's binary-cache client needs (HTTP/HTTPS via openssl).
  # Drop HTTP/2-3 (nghttp2/ngtcp2), c-ares, gss/ldap/brotli/idn, zstd, psl
  # (libpsl→libidn2) and scp (libssh2) — each pulls extra wasm cross-builds we
  # don't need. (static comes from isStatic.)
  curl = whenWasm
    (p: p.override {
      http2Support = false;
      http3Support = false;
      c-aresSupport = false;
      gssSupport = false;
      ldapSupport = false;
      brotliSupport = false;
      idnSupport = false;
      zstdSupport = false;
      pslSupport = false;
      scpSupport = false;
    })
    prev.curl;

  # libgit2 without ssh (drops libssh2) and without the tests/CLI executables —
  # libgit2_tests links llhttp's static lib whose api.c references consumer
  # callbacks (wasm_on_*) undefined at exe-link time; we only need libgit2.a.
  libgit2 = whenWasm
    (p: (p.override { libssh2 = null; }).overrideAttrs (o: {
      cmakeFlags = (o.cmakeFlags or [ ]) ++ [
        "-DUSE_SSH=OFF"
        "-DBUILD_TESTS=OFF"
        "-DBUILD_CLI=OFF"
      ];
    }))
    prev.libgit2;

  # libarchive without acl/xattr: those pull `acl`→`attr`, and attr's source uses
  # `.symver` symbol-versioning inline asm, which the wasm clang rejects. Nix only
  # READS archives; ACLs/xattrs are meaningless on the wasm/NOMMU guest. Null the
  # inputs so configure can't pick them up from the sysroot either.
  libarchive = whenWasm
    (p: (p.override { acl = null; attr = null; }).overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-acl" "--disable-xattr" ];
    }))
    prev.libarchive;

  # llhttp: disable its standalone-wasm JS-host glue. llhttp's api.c has a
  # `#if defined(__wasm__)` block (wasm_settings + extern wasm_on_* callbacks +
  # llhttp_alloc/free) meant for llhttp's OWN wasm npm package, where a JS host
  # supplies `wasm_on_*`. When llhttp is embedded as a C library (libgit2 drives
  # it via llhttp_init + its own settings struct), that block is dead/wrong code
  # whose `wasm_on_*` externs are left undefined → env imports the guest can't
  # satisfy → instantiate LinkError. Skip the block (#if 0): real llhttp,
  # libgit2's normal callback path, no JS-host externs.
  llhttp = whenWasm
    (p: p.overrideAttrs (o: {
      postPatch = (o.postPatch or "") + ''
        substituteInPlace src/api.c --replace-fail '#if defined(__wasm__)' '#if 0'
      '';
    }))
    prev.llhttp;

  # zlib errno fix: zlib 1.3.2 gates `#include <errno.h>` behind NO_STRERROR;
  # errno.h IS in the sysroot and the gz code uses errno regardless → force-
  # include it. (static comes from isStatic: zlib `shared = !isStatic`.)
  zlib = whenWasm
    (p: p.overrideAttrs (o: {
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + " -include errno.h";
      };
    }))
    prev.zlib;

  # --- cairo: image + freetype + fontconfig backends for the M2 text stack ----
  # M2: cairo cross-built to wasm32 with the image surface (pixman+zlib) AND the
  # freetype + fontconfig font backends — required for the text rendering stack
  # (harfbuzz → pango → GTK3). weston-flowers (image-surface-only client) still
  # builds unchanged; the font backends are strictly additive.
  # Still OFF (glib-free / no X):
  #   - x11Support: drags libxext/libxrender/libxcb (X11 surfaces). Off.
  #   - gobjectSupport (glib): glib won't cross cleanly and the C API doesn't
  #     need the gobject wrapper. Off.
  #   - gtk_doc=true is set UNCONDITIONALLY in nixpkgs (needs gtk-doc/docbook,
  #     a native doc toolchain that's pointless here) → force -Dgtk_doc=false.
  #   - libpng: the PNG image-surface helper. Not needed; disable.
  #   - lzo: cairo-script surface compression; not needed. Off.
  # Result: libcairo.a with CAIRO_HAS_IMAGE_SURFACE + CAIRO_HAS_FT_FONT +
  # CAIRO_HAS_FC_FONT; cairo.pc Requires lists freetype2 + fontconfig.
  cairo = whenWasm
    (p: (p.override {
      x11Support = false;
      gobjectSupport = false;
      # Null the optional inputs so meson's auto-detection can't pick them up
      # from the sysroot even with the feature flags off.
      # freetype + fontconfig are intentionally left as real cross deps (M2).
      libpng = null;
      glib = null;
      libxext = null;
      libxrender = null;
      libxcb = null;
      lzo = null;
      gtk-doc = null;
      docbook_xsl = null;
    }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dgtk_doc=false"
        "-Dxcb=disabled"
        "-Dxlib=disabled"
        "-Dglib=disabled"
        "-Dtests=disabled"
        "-Dfreetype=enabled"
        "-Dfontconfig=enabled"
        "-Dpng=disabled"
        "-Dzlib=enabled"
        # lzo backs the cairo-script surface's compression; not needed here,
        # and we nulled the input above.
        "-Dlzo=disabled"
      ];
      # nixpkgs' postInstall rewrites cairo.pc to add freetype include dirs;
      # freetype is now a real input so let the default postInstall run.
      # devdoc output is empty without gtk-doc; keep only out + dev.
      outputs = [ "out" "dev" ];
    }))
    prev.cairo;

  # --- kernel UAPI headers: use OUR wasm headers, not stock Linux ------------
  # The cross stdenv/musl pull nixpkgs' stock linuxHeaders (linux-6.18.7) and run
  # `make ARCH=wasm32 headers_install`, which fails — stock Linux has no wasm
  # arch. Point the whole cross set at our joelseverin-wasm UAPI headers. One
  # platform fix that unblocks every package, not just nix.wasm.
  linuxHeaders = whenWasm
    (p: kernelHeaders.overrideAttrs (_: { version = p.version or "wasm-7.0"; }))
    prev.linuxHeaders;
  linuxHeadersCross = final.linuxHeaders;

  # --- cross musl: use OUR nix-built musl, not nixpkgs' ----------------------
  # nixpkgs' cross musl (musl-wasm32) is built during the libc bootstrap by the
  # DEFAULT cross cc-wrapper, which embeds an llvmPackages compiler-rt compiled
  # with the rejected `wasm32-unknown-linux-musl` triple — a stage reached by
  # neither `overlays` nor `crossOverlays`, so it can't be fixed in place and
  # fails to build, cascading to everything (pulled transitively via `libiconv`).
  # It is NOT the stdenv's libc (that's our sysroot), only musl-iconv's build
  # input. Point it at OUR musl (already built correctly by our own toolchain),
  # wrapped to nixpkgs musl's out/dev shape + passthru.linuxHeaders.
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
  # (libgcc.a); a few deps (curl/libarchive/boost) link it. nixpkgs builds it
  # with -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-linux-musl, which clang
  # rejects ("unknown target triple"). `fixCompilerRt` (defined above in the
  # `let`) overrides both `compiler-rt` and `compiler-rt-no-libc` inside the
  # llvm scope via `overrideScope`, so that:
  #   • direct consumers (curl/libarchive/boost) via `compiler-rt`/`libgcc.a`
  #   • stdenv-level consumers (busybox's `clangNoLibcxx` stdenv) via
  #     `compiler-rt-no-libc` (= targetLlvmPackages.compiler-rt-no-libc → self
  #     inside overrideScope when selfTargetTarget == {})
  # all pick up the canonical wasm triple. `llvmPackages` aliases `_21` here,
  # so point it at the override. isWasm-guarded: native packages are untouched.
  llvmPackages_21 = if isWasm then fixCompilerRt prev.llvmPackages_21 else prev.llvmPackages_21;
  llvmPackages    = if isWasm then fixCompilerRt prev.llvmPackages_21 else prev.llvmPackages;

  # --- busybox: redirect its internal stdenv override to our replaceCrossStdenv -
  # nixpkgs' all-packages.nix overrides busybox's stdenv when
  # `stdenv.targetPlatform.useLLVM` (= true for wasm):
  #   stdenv = overrideCC stdenv buildPackages.llvmPackages.clangNoLibcxx
  # `buildPackages.llvmPackages.clangNoLibcxx` is the native-LLVM cross-compiler
  # wrapper for wasm32-unknown-linux-musl — it does NOT carry our
  # `--target=wasm32-unknown-unknown` cc-flag, so clang rejects the triple when
  # busybox actually compiles. Fix: use `final.stdenv` directly (which IS our
  # replaceCrossStdenv with the correct wasm triple). The original override's
  # purpose (avoid dynamic libunwind in a static binary) is moot on wasm32:
  # our wasm cc-wrapper never pulls libunwind, and wasm links are always fully
  # static (isStatic = true), so the workaround is a no-op here.
  busybox = whenWasm
    (p: p.override { stdenv = final.stdenv; })
    prev.busybox;
}
