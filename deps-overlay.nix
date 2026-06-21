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
  # Khronos EGL + KHR API headers (header-only, no provider). libepoxy built with
  # `-Degl=yes` (needed so GTK3's wayland backend's unconditional
  # `#include <epoxy/egl.h>` resolves) generates a dispatch header that
  # `#include "EGL/eglplatform.h"`, which in turn pulls `KHR/khrplatform.h`. The
  # canonical source of those is the Khronos EGL-Registry; nixpkgs only ships them
  # via libglvnd/mesa, neither of which cross-builds to wasm (libglvnd needs
  # shared libs; mesa is a GL provider we don't want). These are pure API headers
  # (typedefs + entry-point decls), no code — exactly what epoxy's compile-time
  # dispatch generation needs. The wayland-platform branch of eglplatform.h pulls
  # `wayland-egl-backend.h`, already provided by the `wayland` cross dep. Pinned
  # by commit hash for reproducibility.
  khronosEglHeaders = prev.stdenvNoCC.mkDerivation {
    pname = "khronos-egl-headers";
    version = "2024-12-unstable-3d7796b";
    src = prev.fetchFromGitHub {
      owner = "KhronosGroup";
      repo = "EGL-Registry";
      rev = "3d7796b3721d93976b6bfe536aa97bbc4bce8667";
      hash = "sha256-csSV8Yp0p0UIrodbX5793uO5iZMjQfy+0D2wPif2+Fw=";
    };
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/include/EGL $out/include/KHR
      cp api/EGL/egl.h api/EGL/eglext.h api/EGL/eglplatform.h $out/include/EGL/
      cp api/KHR/khrplatform.h $out/include/KHR/
    '';
  };

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

  # pkg-config 0.29.2 bundles an old glib (~2.40 era) via --with-internal-glib.
  # That bundled glib's gspawn.c, gtestutils.c, and gbacktrace.c reference fork().
  # The nixpkgs `pkg-config` attr is a thin wrapper; the actual compiled package is
  # `pkg-config-unwrapped`. Override that so the patch applies to the C compilation.
  # (pkg-config is a build tool consumed by meson/autoconf cross probes; it never
  # spawns subprocesses at runtime — the fork path is dead code here.)
  "pkg-config-unwrapped" = whenWasm
    (p: p.overrideAttrs (o: {
      patches = (o.patches or [ ]) ++ [
        ./patches/pkg-config/0001-bundled-glib-no-fork-wasm-nommu.patch
      ];
    }))
    prev."pkg-config-unwrapped";

  # openssl: undo the wrapper's forced -D_GNU_SOURCE. openssl's o_str.c picks the
  # GNU strerror_r prototype (returns char*) when _GNU_SOURCE is defined, but musl
  # ALWAYS provides POSIX strerror_r (returns int) → the GNU branch assigns
  # int→char* and clang errors (-Wint-conversion). -U lets openssl take its POSIX
  # branch on musl. (static linking comes from isStatic.)
  #
  # `no-apps`: clean-NOMMU spawn contract — the `openssl` CLI binary (apps/openssl)
  # is the ONLY openssl artifact that calls fork() (speed.c parallel benchmark
  # workers + apps/http_server.c); libssl/libcrypto do NOT. wasm musl ships no
  # fork() (return-twice is unimplementable on the NOMMU clone-with-fn model), so
  # apps/openssl fails to LINK ("undefined symbol: fork"). The cross-compiled wasm
  # openssl CLI would never run on the host and the guest only consumes the
  # libraries (curl/libgit2 → nix.wasm), so skip building it. Wasm-guarded → native
  # openssl still builds its CLI.
  #
  # With `no-apps` there is no `$out/bin/openssl`, so nixpkgs' stock `postInstall`
  # (which `mv $out/bin → $bin/bin` then `makeWrapper $bin/bin/openssl … c_rehash`)
  # dies wrapping the absent CLI. Replace it with a CLI-free postInstall: drop the
  # static `.a` only if shared libs exist (they don't here), provide an empty $bin,
  # split $dev, and prune the perl-dependent etc/ssl/misc + empty cert dirs — i.e.
  # the same library-only result minus every openssl-CLI step.
  openssl = whenWasm
    (p: p.overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [ "no-apps" ];
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + " -U_GNU_SOURCE";
      };
      postInstall = ''
        if [ -n "$(echo $out/lib/*.so $out/lib/*.dylib $out/lib/*.dll 2>/dev/null)" ]; then
          rm -f "$out/lib/"*.a
        fi
        etc=$out
        mkdir -p $bin
        # no-apps → no $out/bin (no openssl CLI, no c_rehash wrapper to make)
        mkdir $dev
        mv $out/include $dev/
        rm -rf $etc/etc/ssl/misc
        rmdir $etc/etc/ssl/{certs,private} 2>/dev/null || true
      '';
    }))
    prev.openssl;

  # pcre2: clean-NOMMU spawn contract — the `pcre2grep` CLI tool calls fork() for
  # its `--exec`/callout-fork feature (pcre2grep.c, guarded by
  # SUPPORT_PCRE2GREP_CALLOUT_FORK). The libpcre2 LIBRARY (the only thing libgit2 →
  # nix.wasm consumes) does NOT. wasm musl ships no fork(), so pcre2grep fails to
  # LINK ("undefined symbol: fork"). `--disable-pcre2grep-callout-fork` drops the
  # fork-based callout from pcre2grep — the tool still builds (and is unused on the
  # guest), the library is unaffected. Wasm-guarded → native pcre2 keeps the
  # feature.
  pcre2 = whenWasm
    (p: p.overrideAttrs (o: {
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-pcre2grep-callout-fork" ];
    }))
    prev.pcre2;

  # ncurses: clean-NOMMU spawn contract — ncurses' default `make all` descends into
  # its `test/` directory and builds the demo programs (ditto.c is a multi-terminal
  # demo that calls fork(); several others do too). Those demos are NEVER installed
  # (the install targets are install.{libs,progs,includes,data,man} — none touch
  # test/) and never run on the guest. They only linked on the old runtime-abort-stub
  # model because `fork` was a linkable symbol that SIGILL'd at runtime; with the
  # symbol removed from musl they fail at LINK ("undefined symbol: fork"). Build only
  # the targets that are actually installed (`libs progs` → libncursesw + tic/tput/…),
  # so the unused fork-using demos are not built. The library and programs the guest
  # consumes (terminfo via tic, libncursesw) are unaffected. Wasm-guarded → native
  # ncurses still builds its full `all` (test demos included).
  ncurses = whenWasm
    (p: p.overrideAttrs (o: {
      buildFlags = (o.buildFlags or [ ]) ++ [ "libs" "progs" ];
    }))
    prev.ncurses;

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
        # wasm NOMMU has no fork/vfork.  Force glib's existing posix_spawn path
        # (GNOME/glib MR !95, !1968) to be the ONLY spawn mechanism.  The patch:
        #   - forces POSIX_SPAWN_AVAILABLE on __wasm__
        #   - extends do_posix_spawn() with working_directory + close_descriptors
        #   - handles the fork-fallback conditions (intermediate_child, search_path_from_envp)
        #     via the extended posix_spawn call; child_setup fails loudly
        #   - retries ENOEXEC scripts via posix_spawn("/bin/sh", argv...)
        #   - compiles out the entire fork()/exec() block so no fork symbol is emitted
        #   - compiles out g_test_trap_fork()'s fork body (deprecated, never used on guest)
        patches = (o.patches or [ ]) ++ [
          ./patches/glib/0001-posix-spawn-only-wasm-nommu.patch
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

  # --- libjpeg-turbo: no SIMD (and skip the broken simdcoverage target) -------
  # gdk-pixbuf's built-in JPEG loader (and libtiff/libwebp downstream) need
  # libjpeg. wasm32 has no SIMD asm backend, so libjpeg-turbo's simd/CMakeLists
  # hits its `simd_fail` no-SIMD branch — which is meant to fall back to the
  # portable C path. But that branch does `set(WITH_SIMD 0 PARENT_SCOPE)`, which
  # does NOT update WITH_SIMD in simd/CMakeLists' own scope, so the later
  # `if(WITH_SIMD AND ENABLE_STATIC) add_executable(simdcoverage ...)` guard
  # still sees WITH_SIMD=1 and adds the `simdcoverage` coverage *test* executable
  # — which references all the `jsimd_can_*` entry points that the no-SIMD build
  # never compiles → wasm-ld "undefined symbol" and the whole build fails at 97%
  # (the actual libjpeg.a / libturbojpeg.a already linked fine before it). We set
  # `-DWITH_SIMD=0` explicitly so the no-SIMD C path is taken cleanly and the
  # simdcoverage target is never added. `doInstallCheck = false`: the test suite
  # runs target (wasm) binaries, which can't execute on the aarch64 build host.
  # isWasm-guarded so native libjpeg-turbo (SIMD) is untouched.
  libjpeg = whenWasm
    (p: p.overrideAttrs (o: {
      cmakeFlags = (o.cmakeFlags or [ ]) ++ [ "-DWITH_SIMD=0" ];
      doInstallCheck = false;
    }))
    prev.libjpeg;

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

  # --- pixman: disable tests (test code references fork, not in library itself) --
  # pixman's meson.build builds tests/fence-image-self-test which calls fork().
  # The library itself has no fork reference; only the test binary does.
  # Disable tests so the cross build doesn't attempt to link them.
  pixman = whenWasm
    (p: p.overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Dtests=disabled" ];
    }))
    prev.pixman;

  # --- wayland: disable tests (test runner calls fork; library itself is clean) --
  # wayland 1.25.0 tests/test-runner.c calls fork() to isolate each test process.
  # The wayland libraries (libwayland-client, -server, -util) have no fork reference.
  # withTests=false passes -Dtests=false to meson, skipping the test executables.
  wayland = whenWasm
    (p: p.override { withTests = false; })
    prev.wayland;

  # --- libxkbcommon: disable tests (test binaries call fork; library is clean) ---
  # libxkbcommon 1.13.1 test/ binaries call fork() to isolate each test. meson
  # builds them unconditionally as part of ninja all (no -Dtests option exists).
  # Use postPatch with python to remove all test() / benchmark() / executable()
  # calls whose target names start with "test-" or "bench-" and their associated
  # libxkbcommon_test_internal / fuzz- executables.  Leave has_merge_modes_tests
  # defined (used by summary()) but set to false so the condition is vacuous.
  # The library itself (libxkbcommon.a / libxkbregistry.a) has no fork references.
  libxkbcommon = whenWasm
    (p: p.overrideAttrs (o: {
      postPatch = (o.postPatch or "") + ''
        # Remove test+bench stanzas from meson.build: lines from
        # 'm_dep = cc.find_library' through the blank line just before
        # '# Documentation.', replacing with has_merge_modes_tests=false
        # (that variable is referenced by the summary() block that follows).
        # Tests call fork() which is absent in wasm NOMMU musl.
        sed -n '1p' meson.build > /dev/null  # sanity check sed works
        start_line=$(grep -n "^m_dep = cc\.find_library" meson.build | head -1 | cut -d: -f1)
        end_line=$(grep -n "^# Documentation\." meson.build | head -1 | cut -d: -f1)
        end_line=$((end_line - 1))
        sed -i "$((start_line)),$((end_line))d" meson.build
        sed -i "$((start_line - 1))a\\# wasm: test/bench disabled (fork absent in NOMMU musl)\nhas_merge_modes_tests = false\n" meson.build
      '';
    }))
    prev.libxkbcommon;

  # --- cairo: image + freetype + fontconfig backends for the M2 text stack ----
  # M2: cairo cross-built to wasm32 with the image surface (pixman+zlib) AND the
  # freetype + fontconfig font backends — required for the text rendering stack
  # (harfbuzz → pango → GTK3). weston-flowers (image-surface-only client) still
  # builds unchanged; the font backends are strictly additive.
  # ON (M3b update): gobjectSupport — GTK3 hard-requires `cairo-gobject` (cairo's
  # GObject type wrappers); meson aborts "Dependency cairo-gobject not found"
  # without it. M2 had it OFF ("glib won't cross cleanly") but M3a cross-built
  # glib, so the wrapper now builds. Enabling it adds libcairo-gobject.a +
  # cairo-gobject.pc; glib is a real cross input again.
  # Still OFF (no X):
  #   - x11Support: drags libxext/libxrender/libxcb (X11 surfaces). Off.
  #   - gtk_doc=true is set UNCONDITIONALLY in nixpkgs (needs gtk-doc/docbook,
  #     a native doc toolchain that's pointless here) → force -Dgtk_doc=false.
  #   - libpng: the PNG image-surface helper. Not needed; disable.
  #   - lzo: cairo-script surface compression; not needed. Off.
  # Result: libcairo.a + libcairo-gobject.a with CAIRO_HAS_IMAGE_SURFACE +
  # CAIRO_HAS_FT_FONT + CAIRO_HAS_FC_FONT; cairo.pc Requires lists freetype2 +
  # fontconfig; cairo-gobject.pc present for GTK3.
  cairo = whenWasm
    (p: (p.override {
      x11Support = false;
      gobjectSupport = true;
      # Null the optional inputs so meson's auto-detection can't pick them up
      # from the sysroot even with the feature flags off.
      # freetype + fontconfig + glib (gobjectSupport) are real cross deps.
      libpng = null;
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
        "-Dglib=enabled"
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

  # --- libepoxy: GL + EGL dispatch, but NO GLX/X11 provider (M3b) -------------
  # GTK3 hard-links libepoxy even on the cairo software-render path, and its GL
  # entry points are resolved lazily (epoxy builds the dispatch table on first
  # GL call) — NEVER called when GTK renders through cairo. But GTK's WAYLAND
  # backend `#include <epoxy/egl.h>` UNCONDITIONALLY (gdkdisplay-wayland.h), so
  # epoxy MUST be built with EGL support or that header is absent → gtk3 fails to
  # compile. nixpkgs ties egl+glx+x11 together under one `x11Support` arg, so we
  # can't use the arg alone: we need egl=yes but glx/x11=no.
  #
  # `x11Support = false` first drops the libGL (libglvnd → libx11/libxext) and
  # libx11 propagated inputs and gives `-Degl=no -Dglx=no -Dx11=false`. We then
  # APPEND to mesonFlags to flip ONLY egl back on: `-Degl=yes` (append, not replace,
  # so makeStatic's `-Ddefault_library=static` survives — see the inline note below).
  # epoxy's EGL dispatch is self-contained — it generates the EGL entry-point
  # tables from its bundled Khronos registry (no external libEGL needed at build
  # time, resolved lazily at runtime exactly like GL), so `epoxy/egl.h` is emitted
  # and GTK compiles, with NO X11/GLX/libGL in the closure. isWasm-guarded.
  # The Khronos EGL/KHR headers are added as a buildInput (so epoxy's own
  # `EGL/eglplatform.h` include resolves) AND propagated (so every downstream
  # consumer that `#include <epoxy/egl.h>` — i.e. GTK3's wayland backend — also
  # gets `EGL/eglplatform.h` + `KHR/khrplatform.h` on its include path).
  # `-DEGL_NO_PLATFORM_SPECIFIC_TYPES`: eglplatform.h selects EGLNativeWindowType /
  # EGLNativePixmapType / EGLNativeDisplayType by platform macro (USE_X11,
  # WL_EGL_PLATFORM, __unix__, …). Our wasm `-unknown` triple matches NONE, so
  # those types are left undefined and epoxy's generated egl dispatch won't
  # compile. EGL_NO_PLATFORM_SPECIFIC_TYPES forces the portable `void *` typedefs
  # — correct here since GTK renders through cairo and NEVER calls EGL/GL, so the
  # concrete native-window type is immaterial; it only has to be defined and
  # consistent. The SAME define is added to gtk3 below (GTK re-evaluates
  # eglplatform.h when it `#include <epoxy/egl.h>`, so both TUs must agree).
  libepoxy = whenWasm
    (p: (p.override { x11Support = false; }).overrideAttrs (o: {
      # APPEND (don't replace) — the makeStatic platform adapter injects
      # `-Ddefault_library=static` into the ORIGINAL mesonFlags; replacing them
      # would drop it and epoxy would emit a `.so` (then linking GTK against
      # libepoxy.so hits the wasm `__musl_tp` general-dynamic-TLS reloc).
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Degl=yes"
        "-Dglx=no"
        "-Dx11=false"
        "-Dtests=false"
      ];
      buildInputs = (o.buildInputs or [ ]) ++ [ khronosEglHeaders ];
      propagatedBuildInputs = (o.propagatedBuildInputs or [ ]) ++ [ khronosEglHeaders ];
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "")
          + " -DEGL_NO_PLATFORM_SPECIFIC_TYPES";
      };
    }))
    prev.libepoxy;

  # --- at-spi2-core / atk: ATK API only, no AT-SPI D-Bus bridge (M3b) ---------
  # GTK3 links the ATK accessibility *API* (libatk-1.0), but the AT-SPI2 D-Bus
  # bridge (atspi/registryd/atk-adaptor/the bus launcher) is a runtime a11y
  # service we don't need and can't bring up: it pulls dbus, X11 (libXtst/libXi/
  # libXfixes), audit, and gsettings-desktop-schemas — none of which we want in
  # the NOMMU wasm closure (and dbus is a runtime daemon, meaningless on the
  # single-process guest). at-spi2-core 2.60 ships an `atk_only` build mode that
  # compiles ONLY `subdir('atk')` (libatk-1.0, deps = glib+gobject — both already
  # cross-built in M3a) and skips the dbus dep, the x11 deps, every atspi/bus/
  # adaptor subdir, and the introspection/docs (see at-spi2-core meson.build:
  # `if not get_option('atk_only')` guards all of them). That gives GTK exactly
  # the libatk-1.0 API it links, with NO dbus/X11 in the closure. We drop the
  # now-unused buildInputs (libx11/libxtst/libxi/libxext — libxml2 is KEPT: meson
  # requires libxml-2.0 unconditionally even in atk_only mode), the dbus +
  # gsettings propagated inputs, and the dbus-daemon/bus-launcher mesonFlags +
  # postFixup (the at-spi-bus-launcher binary isn't built in atk_only mode, so
  # wrapping it would fail). It's marked "(UNSUPPORTED)" upstream only because a
  # full desktop wants the bridge — for a GTK app rendered without a11y it's the
  # correct, minimal ATK. isWasm-guarded so native at-spi2-core is untouched.
  at-spi2-core = whenWasm
    (p: (p.override {
      dbus = null;
      libx11 = null;
      libxtst = null;
      libxi = null;
      libxext = null;
      gsettings-desktop-schemas = null;
    }).overrideAttrs (o:
      let
        # libxml2 is NOT dropped: at-spi2-core's top-level meson.build requires
        # libxml-2.0 (+ gmodule-2.0, part of glib) UNCONDITIONALLY — even in
        # atk_only mode (the `if not atk_only` guard only wraps dbus/dlopen, not
        # the libxml/gmodule deps). The libatk-1.0 lib itself links only
        # glib+gobject, but meson still needs libxml2 present to configure.
        drop = builtins.filter
          (i: !builtins.elem (i.pname or "")
            [ "dbus" "libX11" "libXtst" "libXi" "libXext"
              "gsettings-desktop-schemas" "systemd-minimal-libs" "systemd" ]);
      in
      {
        buildInputs = drop (o.buildInputs or [ ]);
        propagatedBuildInputs = drop (o.propagatedBuildInputs or [ ]);
        # We REPLACE nixpkgs' mesonFlags (they hard-code dbus_daemon/dbus_broker
        # paths + the gtk2_atk_adaptor toggle, all meaningless in atk_only mode).
        # But the static-library build comes from `-Ddefault_library=static`,
        # which the makeStatic platform adapter injects into the ORIGINAL
        # mesonFlags — so we must re-add it here, else `library()` in atk/
        # meson.build emits a `.so` (default_both_libraries) instead of
        # libatk-1.0.a. (Same default_library/default_both_libraries pair the
        # other static meson packages get.)
        mesonFlags = [
          "-Datk_only=true"
          "-Dintrospection=disabled"
          "-Dx11=disabled"
          "-Ddocs=false"
          "-Ddefault_library=static"
          "-Ddefault_both_libraries=static"
        ];
        # atk_only doesn't build the bus launcher; nixpkgs' postFixup wraps it.
        postFixup = "";
      }))
    prev.at-spi2-core;

  # --- gtk3: the toolkit itself, WAYLAND-ONLY (M3b Task 2) --------------------
  # The heaviest single build of the GTK effort. nixpkgs' gtk3 defaults turn on
  # X11 + CUPS printing + Xinerama + Tracker search + introspection because the
  # wasm32 hostPlatform is `isLinux`. A dry-run confirmed those defaults drag
  # libx11 (x11 backend), cups + avahi (the CUPS print backend), and the GIR
  # toolchain into the closure — none of which exist or are wanted on the NOMMU
  # wasm guest, which renders through the cairo software surface to a single
  # Wayland frame (no X, no print server, no D-Bus a11y bridge). We flip every
  # one off at the ROOT and keep ONLY the wayland backend. Every disabled feature
  # is one galculator never touches (a calculator has no print dialog, no X11
  # display, no introspection consumer). isWasm-guarded so native gtk3 is stock.
  #
  # override args (the `?`-defaulted feature toggles, all defaulting to `isLinux`
  # = true on wasm, so we must explicitly pass false):
  #   x11Support=false      -> drops the x11 gdk backend + ALL the libx* / libice /
  #                            libsm propagated inputs and the gdk-x11 .pc files.
  #                            Also flips the `(libepoxy.override { inherit x11Support; })`
  #                            buildInput to the no-GL/no-X epoxy (matches our
  #                            libepoxy override).
  #   cupsSupport=false     -> drops the cups propagatedBuildInput (cups → avahi).
  #   xineramaSupport=false -> drops libxinerama (an X-only multi-monitor ext).
  #   trackerSupport=false  -> drops tinysparql (the Tracker3 filechooser search;
  #                            a desktop-search daemon, meaningless on the guest).
  #   withIntrospection=false / compileSchemas=false -> no GIR / no schema compile
  #                            (both already default off on cross since the wasm
  #                            host can't be emulated, but we pin them for clarity
  #                            and to keep the GIR toolchain out of nativeBuildInputs).
  # waylandSupport stays true (its default). We additionally NULL the x11/cups
  # inputs so meson's pkg-config auto-detection can't pick them up from a stray
  # sysroot entry even with the feature flags off (same defensive nulling cairo
  # and at-spi2-core use).
  #
  # mesonFlags: the package's own mesonFlags are derived from the toggles above,
  # but several optional features have NO override arg and default ON via
  # meson_options.txt auto-detection — we must name them explicitly:
  #   -Dwayland_backend=true -Dx11_backend=false -Dbroadway_backend=false
  #   -Dxinerama=no            (combo, not boolean — the X Xinerama ext)
  #   -Dprint_backends=        (empty = NO print backends. GTK's print backends are
  #                            ALL dlopen `shared_module()` .so plugins — the NOMMU
  #                            static guest can't dlopen, and linking a wasm `.so`
  #                            hits the `__musl_tp` general-dynamic-TLS reloc. GTK
  #                            normally forces the `file` backend on unix, so we
  #                            patch out that mandatory-`file` error in postPatch
  #                            (below). The GtkPrintOperation *API* is still compiled
  #                            INTO libgtk-3.a; only the runtime backend modules are
  #                            dropped — fine: a calculator never prints, and the
  #                            modules would be un-loadable dlopen objects anyway.)
  #   -Dcolord=no              (combo; colord is a CUPS-printing colour-management dep)
  #   -Dcloudproviders=false -Dtracker3=false -Dprofiler=false
  #   -Dintrospection=false -Dgtk_doc=false -Dman=false
  #   -Ddemos=false -Dexamples=false -Dtests=false -Dinstalled_tests=false
  #   -Dbuiltin_immodules=all  -> compile EVERY input module (incl. "simple")
  #                               straight INTO libgtk-3.a instead of as dlopen-ed
  #                               .so modules. The static NOMMU guest can't dlopen,
  #                               so built-in is mandatory; "all" is the safe
  #                               superset (the simple/ime modules are tiny C).
  gtk3 = whenWasm
    (p: (p.override {
      x11Support = false;
      cupsSupport = false;
      xineramaSupport = false;
      trackerSupport = false;
      withIntrospection = false;
      compileSchemas = false;
      # Null the now-unused X11/CUPS inputs so meson can't auto-detect them.
      cups = null;
      # libGL (libglvnd) is a waylandSupport-propagated RUNTIME dep, but it
      # propagates libx11 + libxext + xorgproto — the ONLY remaining X11 leak in
      # the wayland-only closure. GTK's wayland backend never `dependency('gl')`s
      # libGL directly: it gets GL *dispatch* from epoxy (already linked) and the
      # `wayland-egl` interface from the `wayland` package (libwayland-egl), not
      # from libglvnd. GL is never actually called on the cairo software-render
      # guest. So nulling libGL is correct and removes libx11/libxext entirely.
      libGL = null;
      libxrender = null;
      libxrandr = null;
      libxi = null;
      libxinerama = null;
      libxfixes = null;
      libxdamage = null;
      libxcursor = null;
      libxcomposite = null;
      libsm = null;
      libice = null;
      tinysparql = null;
    }).overrideAttrs (o: {
      # Match libepoxy's EGL platform-type choice (see the libepoxy override):
      # GTK re-parses eglplatform.h via `#include <epoxy/egl.h>` in the wayland
      # backend, so it needs the same `void *` EGLNative*Type typedefs.
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "")
          + " -DEGL_NO_PLATFORM_SPECIFIC_TYPES";
      };
      # Neutralise GTK's "the 'file' print backend must be enabled" hard error so
      # `-Dprint_backends=` (empty) builds ZERO dlopen print modules (see the
      # print_backends comment above). Appended to nixpkgs' own postPatch.
      postPatch = (o.postPatch or "") + ''
        substituteInPlace modules/printbackends/meson.build \
          --replace-fail "error('\'file\' print backed needs to be enabled')" \
            "message('file print backend disabled (no dlopen on the static wasm guest)')"
      '';
      # Drop nixpkgs' postFixup: it `wrapProgram`s the gtk3-demo / widget-factory
      # binaries with XDG_DATA_DIRS, but those are wasm32 modules (the gtk-demo
      # subdir still installs its binary even with -Ddemos=false) — not host
      # executables, so wrapProgram aborts "not an executable file". The demos are
      # irrelevant to the library deliverable and can't run on the build host.
      postFixup = "";
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dwayland_backend=true"
        "-Dx11_backend=false"
        "-Dbroadway_backend=false"
        "-Dxinerama=no"
        "-Dprint_backends="
        "-Dcolord=no"
        "-Dcloudproviders=false"
        "-Dtracker3=false"
        "-Dprofiler=false"
        "-Dintrospection=false"
        "-Dgtk_doc=false"
        "-Dman=false"
        "-Ddemos=false"
        "-Dexamples=false"
        "-Dtests=false"
        "-Dinstalled_tests=false"
        "-Dbuiltin_immodules=all"
      ];
    }))
    prev.gtk3;

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

  # --- graphite2: fix the broken cmake-generated .la file for static builds ---
  # graphite2 uses cmake which emits a libtool .la file with `old_library=''`
  # (empty) and `library_names=libgraphite2.so ...`. On a static-only build
  # (isStatic=true) only libgraphite2.a is produced; the .so name in .la makes
  # downstream libtool-based builds (galculator autotools) try to link
  # libgraphite2.so → "no such file". Fix: rewrite .la to reference the .a.
  graphite2 = whenWasm
    (p: p.overrideAttrs (o: {
      postInstall = (o.postInstall or "") + ''
        la=$out/lib/libgraphite2.la
        if [ -f "$la" ]; then
          # Fix cmake-generated .la for static-only build: clear library_names
          # (no .so built) and set old_library to the actual .a archive.
          sed -i \
            -e "s|^old_library=.*|old_library='libgraphite2.a'|" \
            -e "s|^library_names=.*|library_names=|" \
            -e "s|^dlname=.*|dlname=|" \
            "$la"
        fi
      '';
    }))
    prev.graphite2;

  # --- galculator: the headline GTK3 app (M4) ---------------------------------
  # galculator is gobject/GTK → its binary has the same C function-pointer casts
  # every GTK binary does (e.g. GObject class_init), which strict wasm call_indirect
  # rejects. Apply the binaryen --fpcast-emu post-link pass (the shared seam, see
  # userspace/fpcast-emu.nix + the M3a/M3b learnings) to the installed binary. GTK is
  # C (no -fwasm-exceptions) so the base feature set suffices. isWasm-guarded so
  # native galculator is untouched.
  galculator = whenWasm
    (p: p.overrideAttrs (o: {
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ final.buildPackages.binaryen ];
      # M4 proof: a --selftest source patch that loads the real .ui files from
      # PACKAGE_UI_DIR via gtk_builder_add_from_file (display-free, so it runs in
      # the compositor-less node harness) and asserts GtkWindow "main_window"
      # (main_frame.ui) + GtkToggleButton "button_7" (basic_buttons_gtk3.ui) exist
      # in the parsed widget tree, printing `GALCULATOR-SELFTEST: ... OK`. Appended
      # to nixpkgs' own galculator patches (fno-common/gettext-0.25/C23) — reuses
      # the upstream recipe rather than forking it. The click-to-42 acceptance is a
      # MANUAL browser check (docs/superpowers/notes/m4-galculator-visual.md).
      patches = (o.patches or [ ]) ++ [ ./patches/galculator/0001-add-selftest.patch ];
      # `autopoint` (inside autoreconfHook) decompresses archive.dir.tar.xz with
      # a bare `xz` shell call. With strictDeps=false (galculator requires it for
      # the AM_GLIB_GNU_GETTEXT m4 macro) the cross buildInputs leak into PATH, so
      # the wasm32 xz binary (non-executable on the aarch64 build host) shadows
      # any native xz. Fix: prepend a tiny native-xz shim to PATH in preAutoreconf
      # so autopoint's bare `xz` call always finds the native host binary — without
      # adding buildPackages.xz as a dep (which would leak liblzma into cross links).
      preAutoreconf = (o.preAutoreconf or "") + ''
        mkdir -p "$TMPDIR/native-xz-bin"
        ln -sf ${final.buildPackages.xz}/bin/xz "$TMPDIR/native-xz-bin/xz"
        export PATH="$TMPDIR/native-xz-bin:$PATH"
      '';
      postFixup = (o.postFixup or "") + ''
        if [ -f "$out/bin/galculator" ]; then
          wasm-opt \
            --enable-threads --enable-bulk-memory --enable-mutable-globals \
            --enable-nontrapping-float-to-int --enable-sign-ext \
            --enable-reference-types --enable-multivalue \
            -pa max-func-params@128 --fpcast-emu \
            "$out/bin/galculator" -o "$out/bin/galculator.fpcast"
          mv "$out/bin/galculator.fpcast" "$out/bin/galculator"
          chmod +x "$out/bin/galculator"
        fi
      '';
    }))
    prev.galculator;

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
