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

  # gobject/GTK fpcast-emu seam; its `hook` rides gtk3's propagation (below).
  fpcast = import ./userspace/fpcast-emu.nix { cross = final; };

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

  # --- alsa-lib: the guest ALSA userspace (issue #145 guest audio) ------------
  # Cross-builds against the virtio-snd sound card (kernel patch 0027 +
  # runtime/virtio/snd-device.js). Static like everything else (platform flag);
  # three wasm-specific adjustments:
  # - `--without-versioned`: symbol versioning is implemented with `.symver`
  #   asm directives, which the wasm backend has no encoding for (same
  #   wasm-can't-do-native-asm class as libffi/fpcast/__unmapself). A static
  #   build doesn't need versioned symbols anyway.
  # - drop the ucm/topology postInstall symlinks: pure data for hardware use
  #   cases (Use Case Manager profiles, DSP topologies) that don't exist on the
  #   virtio-snd guest — they'd only inflate the served closure.
  # - the static build resolves its built-in plugins (hw, plug, …) through
  #   alsa-lib's own no-PIC snd_dlsym list (upstream-supported static linking),
  #   NOT dlopen — nothing to do, just why no dlopen accommodation is needed.
  # The runtime config (share/alsa/alsa.conf) rides $out and is referenced by
  # the compiled-in datadir store path, so on a nix:true boot ALSA config
  # resolves with no env vars, like a real NixOS; the busybox-only boot smoke
  # copies it into the initramfs (initramfs.nix extraShare) and points
  # ALSA_CONFIG_DIR/ALSA_CONFIG_PATH at it.
  # - the no-versioning alias fallback still emits `.weak`/`.set` module asm —
  #   patches/alsa-lib/0001 expresses the alias as a C weak-alias attribute on
  #   wasm instead (clang lowers it to a proper weak wasm symbol).
  # - the fork() holdouts are compiled out per the process-model rule (fork is
  #   removed from musl, so they fail to LINK — loud, exactly as designed):
  #   the direct plugin family (dmix/dshare/dsnoop, pcm_direct.c forks its
  #   mixing server) + the shm/share plugins (drop them and aserver — the shm
  #   server binary — is not built either), ladspa (runtime dlopen of external
  #   plugin .so's), and UCM (ucm_exec.c forks — hardware use-case profiles
  #   that don't exist on virtio-snd). Everything an app actually uses on this
  #   guest (hw + the plug conversion layer, softvol, ioplug/extplug, …) stays.
  alsa-lib = whenWasm
    (p: p.overrideAttrs (o: {
      patches = (o.patches or [ ]) ++ [ ./patches/alsa-lib/0001-wasm-c-alias-instead-of-asm-symver.patch ];
      configureFlags = (o.configureFlags or [ ]) ++ [
        "--without-versioned"
        "--disable-ucm"
        "--with-pcm-plugins=copy,linear,route,mulaw,alaw,adpcm,rate,plug,multi,file,null,empty,meter,hooks,lfloat,asym,iec958,softvol,extplug,ioplug,mmap_emul"
      ];
      postInstall = "";
    }))
    prev.alsa-lib;

  # --- libcanberra: XDG event sounds over the ALSA backend (issue #145) -------
  # The GNOME games (iagno, four-in-a-row) play their event sounds through
  # ca_gtk_play_for_widget (libcanberra-gtk3). Cross it with:
  # - gtkSupport = "gtk3" against OUR wayland-only gtk3 (nixpkgs points the
  #   flavor at gtk3-x11) + patches/libcanberra/0001: canberra-gtk.c and the
  #   gtk module read X11-only window metadata (_NET_WM_DESKTOP/_XEMBED_INFO)
  #   through unconditional gdkx.h includes — guard them behind
  #   GDK_WINDOWING_X11 with faithful "not available" fallbacks (the metadata
  #   only decorates the sound-event proplist).
  # - `--with-builtin=alsa`: the default backend loader is ltdl dlopen-per-
  #   driver; the builtin flavor compiles the ALSA driver INTO libcanberra
  #   (the upstream-supported static path — same posture as gio modules /
  #   gdk-pixbuf loaders on this guest). pulse/gstreamer/oss are off (no such
  #   daemons on the guest); libtool(ltdl)/libcap/systemd drop out with it.
  # - the sound files themselves decode through libvorbisfile (cross
  #   libvorbis/libogg — stock nixpkgs recipes, no override needed).
  libcanberra = whenWasm
    (p: (p.override {
      gtkSupport = "gtk3";
      gtk3-x11 = final.gtk3;
      libpulseaudio = null;
      gst_all_1 = { gstreamer = null; gst-plugins-base = null; };
      libcap = null;
      withSystemd = false;
      libtool = null;
    }).overrideAttrs (o: {
      patches = (o.patches or [ ]) ++ [ ./patches/libcanberra/0001-wayland-only-gtk.patch ];
      buildInputs = builtins.filter (d: d != null) (o.buildInputs or [ ]);
      configureFlags = (o.configureFlags or [ ]) ++ [
        "--with-builtin=alsa"
        "--disable-pulse"
        "--disable-gstreamer"
        "--disable-lynx"
      ];
      # The SHIPPED configure hard-errors without libltdl even though a
      # --with-builtin=<driver> build never uses it (ltdl only backs the dso
      # loader) — an upstream bug for builtin builds. Drop the bail-out from
      # the generated configure (we don't autoreconf), asserted like the
      # games' canberra seds so a tarball change fails loudly.
      postPatch = (o.postPatch or "") + ''
        grep -c 'Unable to find libltdl' configure >/dev/null || (echo "ltdl sed anchor missing" >&2; exit 1)
        sed -i 's|as_fn_error $? "Unable to find libltdl." "$LINENO" 5|: # builtin-driver build: ltdl unused (wasm)|' configure
        if grep -q 'as_fn_error $? "Unable to find libltdl."' configure; then echo "ltdl sed incomplete" >&2; exit 1; fi
      '';
      # nixpkgs' postInstall rewrites -lltdl in the .la files; the builtin-alsa
      # build never links ltdl (and libtool is nulled above). Instead: the
      # static build produces no module .so, so the install-exec-hook's
      # libcanberra-gtk-module.so → libcanberra-gtk3-module.so compat symlink
      # dangles (noBrokenSymlinks fails the build) — and the GTK-modules dir is
      # meaningless on this guest anyway (NOMMU/static: GTK can't load modules).
      # Drop the whole modules dir.
      postInstall = ''
        rm -rf $out/lib/gtk-3.0

        # Static-only consumers resolve the FULL link line from the .pc (there
        # is no .so carrying DT_NEEDED), but upstream's libcanberra.pc omits
        # the decoder/backend deps entirely (they're baked into the ELF .so
        # normally) and libcanberra-gtk3.pc hardcodes -lX11 (wayland-only GTK
        # here). Publish the real static chain via Requires and drop -lX11.
        pc=''${!outputDev}/lib/pkgconfig/libcanberra.pc
        grep -q '^Requires:$' "$pc" || (echo "libcanberra.pc Requires anchor missing" >&2; exit 1)
        sed -i 's/^Requires:$/Requires: vorbisfile alsa/' "$pc"
        pcg=''${!outputDev}/lib/pkgconfig/libcanberra-gtk3.pc
        grep -q -- '-lX11' "$pcg" || (echo "libcanberra-gtk3.pc -lX11 anchor missing" >&2; exit 1)
        sed -i 's/ -lX11//' "$pcg"
      '';
    }))
    prev.libcanberra;

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

  # --- gdk-pixbuf: build librsvg's SVG loader in as a BUILT-IN loader ----------
  # This guest's gdk-pixbuf is all-builtin — no loaders.cache, no runtime
  # loadable modules (verified: the static .a carries _gdk_pixbuf__png_fill_vtable
  # etc. and there is no loaders dir) — so the ONLY way to teach it SVG is to
  # compile librsvg's io-svg.c in alongside png/jpeg. Without it, apps that load
  # .svg through gdk-pixbuf (gnome-mines' HUD icons, four-in-a-row's tileset,
  # tali's dice) get a blank / "Unable to load image" (nix-wasm#146).
  #
  # `gdk-pixbuf-base` is the plain upstream cross build. librsvg builds against
  # it (userspace/librsvg.nix), which BREAKS the cycle: the svg gdk-pixbuf below
  # compiles io-svg.c and links librsvg, so it depends on librsvg, which must NOT
  # depend back on the svg gdk-pixbuf. base ≠ svg, no cycle.
  gdk-pixbuf-base = prev.gdk-pixbuf;

  # The svg-loader gdk-pixbuf — what gtk3 and every app actually use. base +
  # the vendored io-svg.c (patches/gdk-pixbuf/) + a librsvg dep. Built with
  # -Dbuiltin_loaders=all so the patch's `svg` loaders entry is compiled in.
  gdk-pixbuf = whenWasm
    (p: p.overrideAttrs (o: {
      patches = (o.patches or [ ]) ++ [ ./patches/gdk-pixbuf/0001-builtin-svg-loader.patch ];
      postPatch = (o.postPatch or "") + ''
        cp ${./patches/gdk-pixbuf/io-svg.c} gdk-pixbuf/io-svg.c
      '';
      # The patch gates the built-in svg loader on
      #   librsvg_dep = dependency('librsvg-2.0', required: false)
      # so librsvg-2.0.pc must not merely be on the path but fully RESOLVABLE by
      # pkg-config at configure time — else librsvg_dep.found() is false, the svg
      # loader is silently skipped (no -DINCLUDE_svg, no static lib), and the
      # build still succeeds with NO svg support. librsvg-2.0.pc's Requires were
      # promoted for static linking (userspace/librsvg.nix) to
      #   glib-2.0 gio-2.0 cairo pangocairo pangoft2 libcroco-0.6 libxml-2.0
      # none of which are gdk-pixbuf-base inputs, so `pkg-config --exists
      # librsvg-2.0` fails unless we put every provider on the path too. Mirror
      # librsvg's own buildInputs (minus gdk-pixbuf-base) so the whole Requires
      # chain resolves. Verified on the browser rig: without these, four-in-a-row
      # throws "Unable to load image … tileset.svg" and tali's dice are blank.
      buildInputs = (o.buildInputs or [ ]) ++ [
        final.librsvg
        final.cairo
        final.pango
        final.libcroco
        final.libxml2
        final.freetype
        final.fontconfig
        final.pixman
        final.libpng
        final.zlib
      ];
      mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Dbuiltin_loaders=all" ];
      # Now that io-svg.c.o is in libgdk_pixbuf-2.0.a, gdk-pixbuf HARD-depends on
      # librsvg's whole static chain at link time — and the .pc has to thread a
      # very fine needle to express that:
      #
      #  * NOT as a Requires. meson auto-added librsvg-2.0 to Requires.private,
      #    which poisons every consumer's pkg-config RESOLUTION: to merely FIND
      #    gdk-pixbuf-2.0 they'd have to resolve librsvg-2.0's chain (libcroco/
      #    cairo/pango/libxml2), and gtk3/galculator don't carry libcroco — so
      #    `dependency('gdk-pixbuf-2.0')` reports "found: NO", gtk3 falls back to
      #    a disabled subproject wrap, and the build dies. So strip it.
      #  * BUT the link flags must stay, or every consumer that statically links
      #    libgdk_pixbuf-2.0.a (gtk3's own tools, galculator, gcalctool, the
      #    games) underlinks io-svg.c.o's rsvg_* (wasm-ld: undefined symbol
      #    rsvg_handle_new …). The games list librsvg in their buildInputs so
      #    THEY resolve, but gtk3's internal tools don't — hence the gtk3 build
      #    failing here.
      #
      # Thread it: strip librsvg-2.0 from Requires (fixes resolution), then fold
      # librsvg's FULL static link closure into Libs as raw flags (fixes linking,
      # no pkg-config lookup for consumers). Computed with pkg-config HERE, where
      # librsvg-2.0 IS resolvable (it + its chain are our buildInputs).
      postInstall = (o.postInstall or "") + ''
        pc="$out/lib/pkgconfig/gdk-pixbuf-2.0.pc"
        grep -q 'librsvg-2.0' "$pc" || (echo "gdk-pixbuf-2.0.pc no longer names librsvg-2.0 — did the loader stop linking it? re-check the strip" >&2; exit 1)
        # 1) Capture librsvg's full static link flags BEFORE stripping the .pc,
        #    using pkg-config (librsvg-2.0 resolves here). --static pulls the whole
        #    Requires chain's libs (-lrsvg-2 -lcroco-0.6 -lxml2 …) so no consumer
        #    underlinks. $PKG_CONFIG is set by the pkg-config setup hook (cross
        #    wrapper); fall back to the plain name.
        rsvg_libs=$(''${PKG_CONFIG:-pkg-config} --static --libs librsvg-2.0)
        test -n "$rsvg_libs" || (echo "pkg-config produced no librsvg-2.0 libs — cannot fold into gdk-pixbuf-2.0.pc" >&2; exit 1)
        echo "$rsvg_libs" | grep -q -- '-lrsvg-2' || (echo "librsvg static libs missing -lrsvg-2: $rsvg_libs" >&2; exit 1)
        # 2) Drop the librsvg-2.0 token (+ optional version) from any Requires
        #    line, then tidy the comma artifacts (doubled/leading/trailing).
        sed -i -E 's/librsvg-2\.0[[:space:]]*(>=[[:space:]]*[0-9.]+)?//g' "$pc"
        sed -i -E '/^Requires(\.private)?:/ { s/,[[:space:]]*,/, /g; s/:[[:space:]]*,[[:space:]]*/: /; s/[[:space:]]*,[[:space:]]*$//; }' "$pc"
        if grep -q 'librsvg-2.0' "$pc"; then echo "failed to strip librsvg-2.0 from gdk-pixbuf-2.0.pc" >&2; exit 1; fi
        # 3) Fold librsvg's static libs onto the Libs line (after -lgdk_pixbuf-2.0
        #    so static-link order stays correct). Public Libs, not Libs.private:
        #    the gtk3-tool link that failed did not pull Libs.private.
        sed -i -E "/^Libs:/ s#\$# $rsvg_libs#" "$pc"
        grep -q -- '-lrsvg-2' "$pc" || (echo "failed to fold librsvg libs into gdk-pixbuf-2.0.pc Libs" >&2; exit 1)
      '';
    }))
    prev.gdk-pixbuf;

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
        start_line=$(grep -n "^m_dep = cc\.find_library" meson.build | head -1 | cut -d: -f1)
        end_line=$(grep -n "^# Documentation\." meson.build | head -1 | cut -d: -f1)
        end_line=$((end_line - 1))
        sed -i "$((start_line)),$((end_line))d" meson.build
        sed -i "$((start_line - 1))a\\# wasm: test/bench disabled (fork absent in NOMMU musl)\nhas_merge_modes_tests = false\n" meson.build
      '';
    }))
    prev.libxkbcommon;

  # --- minigbm: abort-stub libgbm.a + gbm.h shim for Sommelier (link-only) ----
  # Sommelier links libgbm but NEVER calls it on the wl_shm/virtwl path:
  # ctx->gbm stays null and every gbm call site is guarded by that check.
  # We need libgbm.a + gbm.h only to satisfy the linker.
  #
  # minigbm (chromiumos's small-C gbm, what Sommelier targets) is NOT in the
  # pinned nixpkgs (9ae611a). Mesa's libgbm IS in nixpkgs but is the full GL
  # stack and must not be used. Fallback: a 3-file shim (gbm.h + gbm-shim.c
  # + default.nix) in userspace/libgbm-shim/ — all symbols abort() so any
  # accidental call fails loud rather than silently.
  #
  # isWasm-guarded: native packages never see this attr (it shadows nothing —
  # minigbm is absent from this nixpkgs pin — but the guard keeps the overlay
  # scoped to the wasm cross set, consistent with every other entry here).
  minigbm = if isWasm
    then final.callPackage ./userspace/libgbm-shim { }
    else prev.minigbm or (throw "minigbm: only available in the wasm cross set");

  # --- libdrm: link-only for Sommelier; dmabuf path is dead at runtime ----------
  # Sommelier links libdrm for the GPU/dmabuf path, but that path is never taken
  # on the wl_shm/virtwl route we use.  We need only the core ioctl wrappers
  # (libdrm.a + xf86drm.h + libdrm/drm_fourcc.h) to satisfy the linker.
  # All GPU-driver backends (intel/amdgpu/radeon/nouveau/vmwgfx) are disabled:
  # they pull GPU-specific kernel uAPIs we don't have and tests call fork().
  # -Dman-pages=disabled: man-pages need xsltproc, absent in the cross sandbox.
  # -Dvalgrind=disabled:  valgrind headers not available in the wasm sysroot.
  libdrm = whenWasm
    (p: p.overrideAttrs (o: {
      # Drop the `bin` output — it only carries test binaries and man-pages,
      # both of which we disable below.  An empty declared output causes the
      # Nix builder to error ("failed to produce output path for output 'bin'").
      outputs = [ "out" "dev" ];
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dintel=disabled"
        "-Damdgpu=disabled"
        "-Dradeon=disabled"
        "-Dnouveau=disabled"
        "-Dvmwgfx=disabled"
        "-Dman-pages=disabled"
        "-Dvalgrind=disabled"
        "-Dtests=false"
      ];
      doCheck = false;
    }))
    prev.libdrm;

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
  #   - gtk_doc=true is set UNCONDITIONALLY in nixpkgs (needs gtk-doc/docbook,
  #     a native doc toolchain that's pointless here) → force -Dgtk_doc=false.
  #   - lzo: cairo-script surface compression; not needed. Off.
  # ON (GNOME-games update): png — librsvg 2.40 (the games' SVG renderer)
  # hard-requires cairo-png.pc (its configure checks `cairo-png`), and
  # rsvg-convert writes PNG through it. Cross libpng rides on zlib; strictly
  # additive to everything downstream.
  # ON (M-X4, XChat/X11 epic): x11Support — the xlib SURFACE backend, for
  # GTK2's gdk-x11 backend (gdk/x11/gdkdrawable-x11.c draws through a
  # `cairo_xlib_surface_create` surface; there is no other rendering path for
  # GTK2-on-X11). Strictly additive, same posture as the M2 freetype/
  # fontconfig enable and the GNOME-games png enable: nothing already built
  # (weston-flowers, the M2 text stack, GTK3) touches x11Support, so flipping
  # it on cannot regress them — weston-flowers (image-surface-only client)
  # is the regression gate. cairo's own package.nix ties `x11Support` to BOTH
  # the `-Dxlib` mesonEnable AND the libxext/libxrender propagatedBuildInputs
  # (both already cross-built — M-X0's X11 client closure), so no buildInputs
  # work is needed here beyond un-nulling them. `xcbSupport` (cairo's own arg,
  # defaults to `x11Support`) is pinned back to `false`: GTK2 only ever wants
  # the plain Xlib surface (`cairo_xlib_surface_create`), never the xlib-xcb
  # hybrid, so there is no reason to grow the runtime closure with cairo's
  # XCB-render surface — scope this milestone to what GTK2 actually needs.
  # Result: libcairo.a + libcairo-gobject.a with CAIRO_HAS_IMAGE_SURFACE +
  # CAIRO_HAS_FT_FONT + CAIRO_HAS_FC_FONT + CAIRO_HAS_XLIB_SURFACE; cairo.pc
  # Requires lists freetype2 + fontconfig + x11/xext/xrender;
  # cairo-gobject.pc present for GTK3.
  cairo = whenWasm
    (p: (p.override {
      x11Support = true;
      xcbSupport = false;
      gobjectSupport = true;
      # libxcb stays nulled — xcbSupport=false means cairo's own package.nix
      # never references it (`optionals xcbSupport [ libxcb ]` is empty), so
      # this is defensive-only, same posture as before. libxext/libxrender
      # are NO LONGER nulled: x11Support=true means cairo's own
      # propagatedBuildInputs now wants them, and they're real cross deps
      # (M-X0's X11 client closure) — meson's auto-detection picking them up
      # is exactly the point now, not something to guard against.
      libxcb = null;
      lzo = null;
      gtk-doc = null;
      docbook_xsl = null;
    }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dgtk_doc=false"
        "-Dglib=enabled"
        "-Dtests=disabled"
        "-Dfreetype=enabled"
        "-Dfontconfig=enabled"
        "-Dpng=enabled"
        "-Dzlib=enabled"
        # lzo backs the cairo-script surface's compression; not needed here,
        # and we nulled the input above.
        "-Dlzo=disabled"
        # -Dxlib/-Dxcb are NOT repeated here — cairo's own package.nix already
        # emits them deterministically from the `x11Support`/`xcbSupport` args
        # above (`lib.mesonEnable "xlib" x11Support` / `"xcb" xcbSupport`), so
        # duplicating the same `-D` here would be redundant at best and a
        # meson double-definition footgun at worst.
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
      # Auto-fpcast every gtk3 consumer: the hook rides propagation, so a GTK
      # app needs no fpcast line. Opt out with `dontFpcastEmu` (fpcast-emu.nix).
      propagatedNativeBuildInputs = (o.propagatedNativeBuildInputs or [ ]) ++ [
        fpcast.hook
      ];
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

  # --- GTK2 cross-build, X11 backend (M-X4, XChat/X11 epic) -------------------
  # gtk+-2.24.33: the toolkit XChat (M-X5) needs. Unlike GTK3 (wayland-only,
  # meson), GTK2 is autotools and X11 is its ONLY real backend — nixpkgs'
  # `gdktarget` arg already defaults to "x11" on every non-Darwin host
  # (ours included), so no override is needed there; passed explicitly below
  # for clarity anyway.
  #
  # OFF:
  #   - cupsSupport (nixpkgs default: true on Linux!) — printing needs a
  #     cross-built cups, which nothing else in this closure wants and which
  #     this milestone has no use for (XChat has no print feature either).
  #   - xineramaSupport (nixpkgs default: true on Linux!) — the Xinerama
  #     multi-monitor extension; not in the M-X0 client closure and not
  #     needed for a single Xvfb screen.
  #   - introspection — GTK2's autotools GOBJECT_INTROSPECTION_CHECK m4 macro
  #     (unlike GTK3's meson `-Dintrospection=`) has no isWasm-aware
  #     auto-disable: its default is `--enable-introspection=auto`, which
  #     probes `gobject-introspection-1.0.pc` on the TARGET pkg-config path.
  #     We don't cross-build gobject-introspection as a target lib, so this
  #     would likely auto-disable anyway — but relying on that is exactly the
  #     kind of implicit auto-detection this codebase avoids (the M2/M3a
  #     entries in CLAUDE.md are full of "be explicit, don't trust auto").
  #     `--disable-introspection` makes it explicit. The nativeBuildInputs
  #     `gobject-introspection` entry is SUPPOSED to be upstream's NATIVE
  #     (buildPackages) copy of `g-ir-scanner` via nixpkgs' usual splicing —
  #     but it doesn't splice correctly here: `nix eval` shows it resolving
  #     to `gobject-introspection-wrapped`, a WASM (hostPlatform.system =
  #     "wasm32-linux") derivation, which then cascades into cross-building
  #     python3 (for its own build) → util-linux-minimal (python's `_uuid`
  #     module) → a hard `undefined symbol: fork` link failure (the exact
  #     libsm/util-linux-minimal class documented above). Even if it built,
  #     using it at build time to introspect the freshly-cross-compiled (wasm)
  #     shared object on the x86_64 build host is impossible regardless (it
  #     would have to dlopen a wasm .so on a non-wasm host) — so it's dropped
  #     from nativeBuildInputs entirely, not just disabled via configure. Match
  #     by substring (not exact name) since the mis-spliced variant carries the
  #     "-wrapped" suffix, not the bare package name.
  #   - devdoc/demo output — matches the M-X4 design's "no docs/devdoc
  #     outputs" call (same posture as gtk3/cairo above): outputs trimmed to
  #     out+dev, and the demo data dir (which nixpkgs' postInstall normally
  #     moveToOutputs into devdoc) is just deleted instead of installed.
  #
  # fpcast-emu: gtk2 is exactly as gobject-heavy as gtk3 (same class of
  # indirect-call arity mismatch documented in CLAUDE.md's "gobject class_init
  # trap" entry) — ride the SAME shared hook via propagatedNativeBuildInputs
  # so every gtk2 CONSUMER (gtk2-hello) auto-fpcasts its own $out/bin
  # executables with no per-package line, exactly like gtk3's consumers.
  #
  # Everything gtk2 propagates (atk, cairo, gdk-pixbuf, glib, pango, plus on
  # Linux libxcomposite/libxcursor/libxi/libxrandr/libxrender) is ALREADY
  # cross-built: atk/cairo/gdk-pixbuf/glib/pango by M2/M3a/M3b, the five X11
  # libs by M-X0. So — unlike gtk3, which needed x11Support=false + a pile of
  # nulled inputs to steer AWAY from X11 — gtk2 needs no buildInputs surgery
  # at all: its own package.nix's Linux-default propagatedBuildInputs are
  # already exactly the right set for an X11-backed build in this closure.
  gtk2 = whenWasm
    (p: (p.override {
      gdktarget = "x11";
      cupsSupport = false;
      xineramaSupport = false;
    }).overrideAttrs (o: {
      propagatedNativeBuildInputs = (o.propagatedNativeBuildInputs or [ ]) ++ [
        fpcast.hook
      ];
      nativeBuildInputs = builtins.filter
        (i: !(final.lib.hasInfix "gobject-introspection" (i.pname or i.name or "")))
        (o.nativeBuildInputs or [ ]);
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-introspection" ];
      # gtk+-2.24.33 is 2010s-era C: it hits clang's newer-than-gcc default
      # ERRORS (not warnings) for `-Wincompatible-function-pointer-types` /
      # `-Wimplicit-int` in a few spots. nixpkgs already carries the fix for
      # this EXACT class — `patches/2.0-clang.patch`
      # ("Fixes an incompatible function pointer conversion and implicit int
      # errors with clang 16") plus a `NIX_CFLAGS_COMPILE` downgrade to
      # warnings — but both are gated to `stdenv.hostPlatform.isDarwin` /
      # `stdenv.cc.isGNU`, because historically only the Darwin build used
      # clang. Our wasm cross stdenv is ALSO clang, so we hit the identical
      # class nixpkgs already decided is safe to patch/downgrade — just on a
      # host they never gated for. Re-apply the same fix, generalized to any
      # clang host instead of Darwin specifically:
      #   - source patch: vendor nixpkgs' own `2.0-clang.patch` verbatim
      #     (patches/gtk2/0001-clang-incompatible-function-pointer.patch) —
      #     it fixes the one REAL bug (gtkscale.c's GCompareFunc cast, found
      #     by attempting the build) that clang's stricter default rejects.
      #   - NIX_CFLAGS_COMPILE downgrade: our build compiles gdk/x11/*.c —
      #     the X11 backend nixpkgs' darwin+quartz build never touches — so
      #     the single upstream patch may not cover every instance in that
      #     tree; downgrade the same two warning classes nixpkgs' own (isGNU-
      #     only) env override already treats as non-fatal, as a defensive
      #     backstop, not a blanket -Wno-error.
      patches = (o.patches or [ ]) ++ [
        ./patches/gtk2/0001-clang-incompatible-function-pointer.patch
      ];
      # perf/testperf (a `noinst_PROGRAMS` benchmark harness, never installed)
      # is unconditionally in the top-level Makefile.in's `SRC_SUBDIRS` and
      # `make all` builds it. It links the FULL gtk+gdk libs a second time via
      # its own copy of the marshaller sources (perf/marshalers.c duplicates
      # gtk/gtkmarshalers.c's generated `_gtk_marshal_*` symbols) — invisible
      # on nixpkgs' normal SHARED-lib native build (the .so already resolves
      # those symbols, so the archive member with the duplicate is never
      # pulled in), but our all-static build extracts BOTH the direct
      # marshalers.o and the .a's gtkmarshalers.o member, and wasm-ld (unlike
      # a shared-lib link) errors loudly on the true duplicate definition —
      # the same "static is a platform flag" class of static-only breakage
      # documented at the top of this file. `perf` is a benchmark tool we
      # categorically don't need (the "don't build an unused CLI" process-
      # model rule); drop it from `SRC_SUBDIRS` in the pre-generated
      # Makefile.in (this tarball ships without re-running autoreconf, so
      # Makefile.in — not Makefile.am — is what `./configure` actually reads).
      postPatch = (o.postPatch or "") + ''
        substituteInPlace Makefile.in \
          --replace-fail 'SRC_SUBDIRS = gdk gtk modules demos tests perf' \
                         'SRC_SUBDIRS = gdk gtk modules demos tests'
      '';
      env = (o.env or { }) // {
        NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "") + toString [
          " -Wno-error=implicit-int"
          " -Wno-error=incompatible-pointer-types"
          " -Wno-error=incompatible-function-pointer-types"
        ];
      };
      outputs = [ "out" "dev" ];
      postInstall = ''
        moveToOutput bin/gtk-update-icon-cache "$out"
        rm -rf $out/share/gtk-2.0/demo
      '';
    }))
    prev.gtk2;

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
      dontFpcastEmu = true; # does its own dynsym+fpcast in postFixup (below)
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [
        final.buildPackages.binaryen
        final.buildPackages.python3 # dynsym-inject (below)
      ];
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
          # dynsym-inject BEFORE fpcast (#126 Track C / #130, userspace/dynsym.nix):
          # every exported function gets an elem slot + a cb.dynsym map entry, so
          # the later fpcast pass thunks them and the runtime loader's dlsym can
          # resolve GtkBuilder's .ui signal-handler names to canonical-thunk table
          # indices — gtk_builder_connect_signals(NULL) works through the REAL
          # GModule/dlopen(NULL)/dlsym path, no add_callback_symbol registry.
          python3 ${./scripts/wasm-dynsym-inject.py} \
            "$out/bin/galculator" "$out/bin/galculator.dynsym"
          mv "$out/bin/galculator.dynsym" "$out/bin/galculator"
          wasm-opt \
            --enable-threads --enable-bulk-memory --enable-mutable-globals \
            --enable-nontrapping-float-to-int --enable-sign-ext \
            --enable-reference-types --enable-multivalue \
            -pa max-func-params@128 --fpcast-emu \
            "$out/bin/galculator" -o "$out/bin/galculator.fpcast"
          mv "$out/bin/galculator.fpcast" "$out/bin/galculator"
          chmod +x "$out/bin/galculator"
        fi
        # Cut the DEAD propagated-build-input chain (issue #43). galculator's
        # $out/nix-support/propagated-build-inputs records gtk+3-dev, which itself
        # propagates pango-dev → libxft-dev → the whole X11 + glibc-locale `-dev`
        # closure. galculator is a LEAF app — nothing is ever built against it — so
        # that propagation metadata is pure dead weight, yet Nix's reference scanner
        # follows it and drags ~15k `-dev`/X11/glibc-locale store paths into the
        # served store (base.squashfs ballooned ~26MB→345MB). Dropping nix-support is
        # safe and removes that whole subtree (→ ~28MB base.squashfs / X11+locale gone).
        #
        # We do NOT strip the binary's OWN store references with remove-references-to:
        # several look "dead" for a static binary but are real RUNTIME DATA deps that
        # ride the served closure for ALL GTK wayland apps — notably
        # **xkeyboard-config** (libxkbcommon loads `…/etc/X11/xkb` at startup to build
        # the XKB keymap; gdk treats a keymap failure as FATAL, so stripping it killed
        # gtk3-widget-factory with "Failed to create XKB keymap"). The remaining
        # gtk3/glib/gdk-pixbuf data in the closure is the legitimate cost of shipping
        # a GTK app, not bloat — the catastrophic part was the -dev tree above.
        rm -rf "$out/nix-support"
      '';
    }))
    prev.galculator;

  # --- gcalctool: the classic GNOME calculator (6.6.2, the last pre-rename ----
  # release — pure C + GTK3). NOT an override: nixpkgs dropped gcalctool long
  # ago, so this is a from-scratch derivation over the GNOME release tarball
  # (userspace/gcalctool.nix). Lives in the overlay (not a flake let-binding)
  # so system.nix / gtk-assets.nix / flake.nix all reach it as cross.gcalctool,
  # exactly like galculator. First app to USE the Track C GModule/dlopen
  # capability (#130): its .ui button panels autoconnect via
  # gtk_builder_connect_signals. isWasm-guarded like everything here (there is
  # no prev.gcalctool to fall back to — the native attr stays null and, by
  # laziness, is never evaluated).
  gcalctool =
    if isWasm then
      import ./userspace/gcalctool.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.gcalctool or null;

  # gcolor3 needs no override: stock nixpkgs, cross-compiled by the shared fixes
  # and auto-fpcast'd via gtk3. Deliberately absent here.

  # --- GNOME games tier (issue: browser desktop games) ------------------------
  # librsvg 2.40 (last all-C release; nixpkgs' is Rust) + libcroco (its CSS
  # engine; dropped from nixpkgs in 2021) are from-scratch pins — the shared
  # SVG-rendering enabler every GNOME game draws its pieces with. The games
  # themselves are autotools-era picks whose dist tarballs ship Vala-generated
  # C (mahjongg) or are hand-written C (five-or-more). All isWasm-guarded; no
  # native fallback exists for the pins (null, never evaluated).
  libcroco =
    if isWasm then
      import ./userspace/libcroco.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.libcroco or null;
  librsvg =
    if isWasm then
      import ./userspace/librsvg.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.librsvg;
  gnome-mahjongg =
    if isWasm then
      import ./userspace/gnome-mahjongg.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.gnome-mahjongg;
  five-or-more =
    if isWasm then
      import ./userspace/five-or-more.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.five-or-more or null;
  iagno =
    if isWasm then
      import ./userspace/iagno.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.iagno or null;
  four-in-a-row =
    if isWasm then
      import ./userspace/four-in-a-row.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.four-in-a-row or null;
  tali =
    if isWasm then
      import ./userspace/tali.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.tali or null;
  gnome-mines =
    if isWasm then
      import ./userspace/gnome-mines.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.gnome-mines or null;

  # --- l3afpad: GTK3 leafpad fork — the first real GTK3 productivity app ------
  # (#122). Pure C, every signal wired with g_signal_connect / GtkActionEntry
  # tables (no GtkBuilder autoconnect → no GModule, the gtk3-demo posture).
  # nixpkgs dropped it before our pin (no by-name/l3 shard at 9ae611a), so a
  # from-scratch derivation (userspace/l3afpad.nix), isWasm-guarded like
  # gcalctool — no native fallback exists (null, never evaluated).
  l3afpad =
    if isWasm then
      import ./userspace/l3afpad.nix {
        cross = final;
        pkgs = final.buildPackages;
      }
    else
      prev.l3afpad or null;

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

  # --- libxcb closure (link-only for Sommelier) ----------------------------------
  # Sommelier links libxcb + the composite/shape/xfixes extension libs but NEVER
  # executes them — all xcb calls are on the Xwayland path, which is never enabled
  # (no -X / --x-display on the wasm guest; Xwayland is not built). We only need
  # the static .a archives + headers to satisfy the linker.
  #
  # libxau + libxdmcp are pure autotools C with no tests; they cross-build cleanly
  # after dropping unused doc/man outputs. libxcb drives Python codegen (xcb-proto's
  # xcbgen module + python3) to emit the extension C sources at build time — those
  # tools MUST be native (buildPackages), not wasm32. With strictDeps=true, moving
  # xcb-proto to nativeBuildInputs and pulling xcbgen from buildPackages.xcb-proto
  # is the correct cross fix. Docs/man are dropped (no doc toolchain in the cross
  # closure; the .a + headers are all Sommelier needs). isWasm-guarded throughout —
  # the native packages are stock nixpkgs (cached).

  # libxau: no tests, "out"+"dev" only. No changes needed beyond the isWasm guard;
  # override is a no-op except to confirm the attr composes with our stdenv.
  libxau = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxau;

  # libxdmcp: has a "doc" output (xmlto → xorg-docs build chain). Drop it — the
  # host-side doc toolchain does not cross to wasm32, and we only need the .a + .h.
  libxdmcp = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "doc") (o.outputs or [ "out" "dev" "doc" ]);
      doCheck = false;
    }))
    prev.libxdmcp;

  # libxcb: xcb-proto is pure Python XML codegen that runs on the BUILD host.
  # With strictDeps=true it must be in nativeBuildInputs (wasm32 Python can't run).
  # Pull the native xcb-proto from buildPackages; also pull python3 from there (it
  # already is in the upstream nativeBuildInputs, but xcb-proto carries xcbgen as a
  # Python package so the native python3 must see it on PYTHONPATH — buildPackages
  # handles that automatically). Drop "man"+"doc" outputs (no man-page or doc tools
  # in the cross closure; Sommelier only needs .a + headers).
  libxcb = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = [ "out" "dev" ];
      # xcb-proto in the upstream buildInputs provides xcbgen for the native Python
      # codegen step. Move it to nativeBuildInputs so the build host's Python finds
      # the xcbgen module. Remove it from buildInputs (wasm32 xcb-proto has no
      # runtime presence — it is a pure-Python package; keeping it in buildInputs
      # pulls it into the cross env where it is unused and can cause configure noise).
      nativeBuildInputs = (o.nativeBuildInputs or [ ])
        ++ [ final.buildPackages.xcb-proto ];
      buildInputs = builtins.filter
        (i: (i.pname or i.name or "") != "xcb-proto")
        (o.buildInputs or [ ]);
      doCheck = false;
    }))
    prev.libxcb;

  # --- X11 client runtime closure (M-X0, XChat/X11 epic) --------------------------
  # Promoting libxcb from "link-only for Sommelier" to a REAL runtime dependency:
  # the ten client-side X libraries XChat/GTK2/Xlib apps need at runtime, not just
  # to satisfy a linker. All are plain autotools C over libxcb/libx11 and already
  # cross-build cleanly in nixpkgs — each `package.nix` already conditions its
  # `--enable-malloc0returnsnull` / `xorg_cv_malloc0_returns_null` autoconf hint on
  # `stdenv.hostPlatform != stdenv.buildPlatform` (the AC_RUN_IFELSE check that
  # can't run under cross), so no configure-flag work is needed here — this is
  # PURELY the output-trimming + doCheck class of fix, same shape as the libxcb
  # closure above. None of these run a test suite (no doCheck ever set true
  # upstream); `doCheck = false` is added defensively for symmetry with the rest
  # of this file, not because a suite was observed to run.
  #
  # libX11 is the one exception to "trim outputs": its `share/X11/locale` i18n
  # tables (XLC_LOCALE / Compose data) are loaded from `$out` at RUNTIME by every
  # Xlib client (the exact "galculator ICONDIR" lesson — CLAUDE.md's M4 entry) and
  # must ride the served /nix closure untouched, so `$out` is left completely
  # alone; only the "man" output (needs the xorg doc toolchain, never built here)
  # is dropped.

  # libX11: the big one. Only the "man" output needs dropping — "out" (incl. the
  # runtime-loaded share/X11/locale tree) and "dev" build and install cleanly.
  # Native `makekeys`/`mkks`-class codegen tools are already covered by upstream's
  # own `depsBuildBuild = [ buildPackages.stdenv.cc ]` — no override needed there.
  libx11 = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "man") (o.outputs or [ "out" "dev" "man" ]);
      doCheck = false;
    }))
    prev.libx11;

  # libxext: drop "man"+"doc" (xorg doc toolchain, not in the cross closure).
  libxext = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "man" && x != "doc") (o.outputs or [ "out" "dev" "man" "doc" ]);
      doCheck = false;
    }))
    prev.libxext;

  # libxrender: drop "doc".
  libxrender = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "doc") (o.outputs or [ "out" "dev" "doc" ]);
      doCheck = false;
    }))
    prev.libxrender;

  # libxrandr: already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxrandr = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxrandr;

  # libxcursor: already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxcursor = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxcursor;

  # libxfixes: already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxfixes = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxfixes;

  # libxdamage: already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxdamage = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxdamage;

  # libxcomposite: already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxcomposite = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxcomposite;

  # libxi: drop "man"+"doc". Upstream already sets `xorg_cv_malloc0_returns_null=no`
  # on cross (a different spelling of the same AC_RUN_IFELSE dodge libx11/libxext use).
  libxi = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "man" && x != "doc") (o.outputs or [ "out" "dev" "man" "doc" ]);
      doCheck = false;
    }))
    prev.libxi;

  # libxft: already "out"+"dev" only upstream; doCheck guard for symmetry. Its
  # fontconfig/freetype deps already cross-build (M2 text stack).
  libxft = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxft;

  # xkbcomp: Xvfb Popen()-spawns this at runtime to compile the XKB keymap
  # (M-X1), so it rides the served closure via xorg-server's
  # -Dxkb_bin_dir=${xkbcomp}/bin store-path reference. Like galculator's
  # nix-support lesson (CLAUDE.md): xkbcomp is a LEAF binary here (nothing
  # builds against it), so its propagated-build-inputs metadata
  # (libx11-dev/libxkbfile-dev, ~5.5MB) is pure served-closure bloat.
  xkbcomp = whenWasm
    (p: p.overrideAttrs (o: {
      # nix-support/propagated-build-inputs is written during fixupPhase (see
      # galculator's postFixup above) — postInstall runs too early to catch it.
      postFixup = (o.postFixup or "") + ''
        rm -rf $out/nix-support
      '';
    }))
    prev.xkbcomp;

  # --- xorg-server (Xvfb) — M-X1, XChat/X11 epic ----------------------------
  # Cross-build xorg-server 21.1.23, configured DOWN to Xvfb only. PRIME
  # DIRECTIVE corollary 1: override nixpkgs' own `xorg-server` recipe (the
  # galculator/l3afpad posture) rather than a from-scratch userspace/xserver.nix
  # derivation — the meson build cross-compiles cleanly once mesonFlags and
  # buildInputs are trimmed to what an Xvfb-only, no-GL, no-DRI, no-udev/dbus/
  # systemd, no secure-rpc build actually needs; nothing here is xorg-server-
  # specific integration a from-scratch recipe would do any differently.
  #
  # Off (per the design plan, M-X1): the Xorg/Xnest/XWin/XQuartz DDXes (and
  # Xwayland, which isn't even this source package — see xwayland.nix, M-X3),
  # glamor/GL/GLX, DRI1/2/3 (+ libdrm/libgbm — dropped from buildInputs
  # entirely: `dependency('libdrm', required: false)` means the DRI logic
  # degrades to "not available" with no build-time requirement at all once
  # dri1/2/3 are individually forced false), udev/hal/systemd-logind (+ the
  # dbus it would otherwise require), XDMCP + secure-rpc (libtirpc), libunwind,
  # XSELinux (avoids libselinux/libaudit), docs (avoids the xmlto/xsltproc/
  # xorg-sgml-doctools doc toolchain, uncrossed and unneeded).
  # On: Xvfb, XKB (xkbcomp + xkeyboard-config — both already cross-build with
  # NO override, verified directly). MIT-SHM stays COMPILED: musl links
  # shmget()/shmat() fine (it's libc API, not a kernel feature check at build
  # time), and the guest kernel has no SysV IPC — shmget() returns ENOSYS at
  # RUNTIME and MIT-SHM clients fall back to core-protocol PutImage per the
  # X11 protocol spec (correct, just slower). Not worth fighting at build
  # time; revisit via memfd/ramfs if paint speed ever matters (per the plan).
  # xcsecurity is left at meson's own default (false) — plan calls it
  # optional either way, so there's no reason to grow the surface.
  #
  # sha1 is forced to `libcrypto` (our cross openssl, already built for the
  # Cachix-over-uplink HTTPS trust-anchors work — see CLAUDE.md): musl has
  # none of meson's other SHA1 providers (no BSD libmd SHA1Init, no
  # CommonCrypto/CryptoAPI, no libsha1/libnettle/libgcrypt in the cross
  # closure), so leaving it on "auto" would fail the probe loop outright.
  #
  # patches/xserver/0001: os/utils.c's System()/Popen()/Fopen() fork()+exec —
  # ported to posix_spawn (docs/process-model.md handling rule 2: "a real
  # spawn API in a library we need → port it to posix_spawn"; same shape as
  # patches/sommelier/0001-posix-spawn.patch's pipe + posix_spawn_file_actions
  # approach). This is load-bearing, not cosmetic: Xvfb spawns `xkbcomp`
  # through Popen() to compile the XKB keymap on every startup.
  # patches/xserver/0002: test/meson.build's `simple-xinit` helper (used only
  # by `meson test`/piglit, never by `ninja`/`ninja install`) also calls
  # fork() and — unlike the real per-DDX unit-test block further down the same
  # file, which is correctly gated `if build_xorg` — is built UNCONDITIONALLY
  # by meson's default target on every non-Windows host. Handling rule 1
  # ("it's an unused CLI/tool → don't build it"), applied as a small patch
  # since upstream gives no configure knob for it (unlike the ncurses/openssl/
  # pcre2 cases, which already had one).
  # patches/xserver/0003: dix/stubmain.c's `int main(int, char**, char**)` —
  # a REAL wasm-ABI bug, found only by attempting the link. clang's wasm
  # target canonicalizes exactly two `main` signatures to the symbol names
  # our musl crt1.o actually calls — `main(void)` → `__main_void`,
  # `main(int, char**)` → `__main_argc_argv` (crt1.o's own `main` is a WEAK
  # stub forwarding to `__main_argc_argv`). The xserver's default DDX-main
  # uses the POSIX/glibc 3-arg extension `main(int, char**, char**)` for
  # envp, which clang does NOT canonicalize — it stays compiled under the
  # literal name `main`, so crt1.o's `__main_argc_argv` reference is left
  # dangling and the link fails ("undefined symbol: main"). Fix: drop to the
  # canonical 2-arg form and read envp off the POSIX-mandated `environ`
  # global (musl always maintains it) — a portable substitute for the 3-arg
  # extension, not a wasm-only workaround. Confirmed by isolating a single
  # extracted .o + a minimal repro before touching the patch (see the M-X1
  # session notes) — worth a fork-first check should XWayland (M-X3) ever
  # need its own DDX main with the same 3-arg shape.
  #
  # xkb_output_dir: nixpkgs points this at $out/share/X11/xkb/compiled, which
  # is WRONG on this guest — the server WRITES freshly-compiled keymaps there
  # at RUNTIME (not build time), and $out is a read-only store path served
  # off the squashfs. Point it at a guest-writable path instead: /tmp, the
  # same ramfs CLAUDE.md's "/dev/shm MUST be mounted" entry already documents
  # as mandatory for NOMMU MAP_SHARED (ramfs, not tmpfs/shmem — CONFIG_SHMEM
  # is gated off behind MMU on this kernel).
  xorg-server = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = [ "out" ]; # no "dev": nothing in this closure links against Xvfb
      doCheck = false;
      # fpcast-emu (the shared gobject/GTK seam, userspace/fpcast-emu.nix):
      # boot-verified against a real guest (M-X1 session record, xvfb-smoke.mjs)
      # that Xvfb FAULTS during device init —
      # "RuntimeError: null function or function signature mismatch" in
      # InitPtrFeedbackClassDeviceStruct → InitPointerDeviceStruct →
      # CorePointerProc → ActivateDevice → InitCoreDevices → dix_main. DIX's
      # device-feedback tables (dix/devices.c) store/call ctrl procs
      # (PtrCtrlProcPtr et al.) through a canonical prototype that individual
      # feedback implementations don't all match byte-for-byte — the same
      # wasm strict-call_indirect arity-mismatch class glib's gobject
      # class_init cast hits (CLAUDE.md's M3a/M3b entries), just via plain C
      # function-pointer tables instead of gobject vtables. xorg-server isn't
      # a gtk3 consumer, so it doesn't ride gtk3's propagated auto-fpcast
      # hook — apply the pass explicitly, same shape as librsvg's explicit
      # non-gtk3-gobject line. No dynsym-inject: Xvfb resolves nothing by
      # name (unlike galculator's GtkBuilder .ui signal lookup), so the raw
      # canonicalizing pass alone is the fix.
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ fpcast.binaryen ];
      # Keep the native (buildPackages) meson/ninja/pkg-config from upstream —
      # they're already correctly split via strictDeps; only the buildInputs
      # (target-side, cross-built) and mesonFlags need trimming.
      buildInputs = [
        final.xorgproto
        final.xtrans
        final.libxau
        final.libxdmcp
        final.libxcb
        final.libx11
        final.libxext
        final.libxfixes
        final.libxkbfile
        final.libxfont_2
        final.font-util
        final.pixman
        final.zlib
        final.openssl
      ];
      propagatedBuildInputs = [ ];
      patches = (o.patches or [ ]) ++ [
        ./patches/xserver/0001-popen-posix-spawn.patch
        ./patches/xserver/0002-skip-simple-xinit-fork.patch
        ./patches/xserver/0003-stubmain-wasm-abi.patch
      ];
      mesonFlags = [
        "-Dxorg=false"
        "-Dxephyr=false"
        "-Dxnest=false"
        "-Dxwin=false"
        "-Dxquartz=false"
        "-Dxvfb=true"
        "-Dglamor=false"
        "-Dglx=false"
        "-Ddri1=false"
        "-Ddri2=false"
        "-Ddri3=false"
        "-Ddrm=false"
        "-Dudev=false"
        "-Dudev_kms=false"
        "-Dhal=false"
        "-Dsystemd_logind=false"
        "-Dxselinux=false"
        "-Ddocs=false"
        "-Ddevel-docs=false"
        "-Dxdmcp=false"
        "-Dxdm-auth-1=false"
        "-Dsecure-rpc=false"
        "-Dlibunwind=false"
        "-Ddtrace=false"
        "-Dsha1=libcrypto"
        "-Dlog_dir=/var/log"
        "-Ddefault_font_path="
        "-Dxkb_bin_dir=${final.xkbcomp}/bin"
        "-Dxkb_dir=${final.xkeyboard-config}/share/X11/xkb"
        "-Dxkb_output_dir=/tmp"
      ];
      postInstall = (o.postInstall or "") + ''
        rm -rf $out/share/man
      '';
      postFixup = (o.postFixup or "") + ''
        if [ -f "$out/bin/Xvfb" ]; then
          ${fpcast.binaryen}/bin/wasm-opt \
            --enable-threads --enable-bulk-memory --enable-mutable-globals \
            --enable-nontrapping-float-to-int --enable-sign-ext \
            --enable-reference-types --enable-multivalue \
            -pa max-func-params@128 --fpcast-emu \
            "$out/bin/Xvfb" -o "$out/bin/Xvfb.fpcast"
          mv "$out/bin/Xvfb.fpcast" "$out/bin/Xvfb"
          chmod +x "$out/bin/Xvfb"
        fi
      '';
    }))
    prev.xorg-server;

  # --- xeyes / xwd / xdpyinfo client apps (M-X2, XChat/X11 epic) ------------
  # First real X11 clients against the cross-built Xvfb (M-X1): xeyes (Xlib +
  # Xt/Xmu — a real toolkit consumer, not just libxcb like x11-probe), xwd
  # (root-window dump — the pixel-proof source for the smoke), and xdpyinfo
  # (server-info query). All three are plain autotools/meson C over libs that
  # already cross; none forks/popens/systems (checked against upstream source
  # before writing this) so none needs a process-model accommodation.
  #
  # New runtime libs this pulls in (beyond M-X0's ten): xeyes needs the
  # classic Xt/Xmu toolkit pair, which drags libSM + libICE (Xt's
  # PKG_CHECK_MODULES(XT, sm ice x11 xproto kbproto) is unconditional — Xt
  # links ICE/SM support whether or not a session manager is ever present at
  # runtime; the guest never sets SESSION_MANAGER so that code path is simply
  # unreached, but it still has to LINK). xdpyinfo needs libXtst (its one
  # *required* extra dep beyond the M-X0 closure — see the buildInputs
  # trimming note below for the ones it does NOT need).

  # libice: pure autotools C, no tests, no libuuid/system deps of its own.
  libice = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "doc") (o.outputs or [ "out" "dev" "doc" ]);
      doCheck = false;
    }))
    prev.libice;

  # libsm: `--without-libuuid` + DROP libuuid from buildInputs — upstream's
  # uuid support (AC_ARG_WITH(libuuid, …)) is a client-ID *generation
  # strategy*, not a hard functional need: with it off, sm_genid.c falls
  # through to its TCPCONN fallback (gethostname + getaddrinfo + a static
  # counter — plain libc, no fork/system; verified against the vendored
  # sm_genid.c before writing this override). nixpkgs' package.nix lists
  # `libuuid` (= util-linux-minimal's output) in buildInputs unconditionally,
  # and Nix realizes every buildInput regardless of whether configure ends up
  # using it — so the configure flag ALONE is not enough, util-linux-minimal
  # still gets built as an input and it does NOT cross (confirmed by
  # attempting it: `sys-utils/switch_root.o: undefined symbol: fork` — a real
  # fork() call site in an unrelated CLI bundled in the same derivation,
  # exactly the "don't build an unused CLI" process-model rule,
  # docs/process-model.md). Drop libuuid from buildInputs entirely so it's
  # never realized; this is the SAME "don't cross something we don't
  # actually need" call this milestone made for libXaw/xinerama/xpresent/
  # xxf86dga/xxf86vm, not a workaround for a build failure we're trying to
  # route around.
  libsm = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "doc") (o.outputs or [ "out" "dev" "doc" ]);
      buildInputs = builtins.filter
        (i: (i.pname or i.name or "") != "util-linux-minimal")
        (o.buildInputs or [ ]);
      # `overrideAttrs` merges onto the ALREADY-PROCESSED final attrs of
      # `prev.libsm` — so `propagatedBuildInputs` here already carries
      # nixpkgs' multiple-outputs `_multioutPropagateDev` auto-propagation
      # (it adds every "dev"-output-having buildInput, baked in when
      # `prev.libsm` was first built with libuuid still present). Filtering
      # `buildInputs` alone does NOT retroactively re-run that hook, so
      # util-linux-minimal-dev survives in propagatedBuildInputs unless
      # filtered here too (confirmed by attempting the build with only the
      # buildInputs filter: util-linux-minimal was still realized as a
      # propagated dep and failed the same `undefined symbol: fork`).
      propagatedBuildInputs = builtins.filter
        (i: (i.pname or i.name or "") != "util-linux-minimal")
        (o.propagatedBuildInputs or [ ]);
      configureFlags = (o.configureFlags or [ ]) ++ [ "--without-libuuid" ];
      doCheck = false;
    }))
    prev.libsm;

  # libxt: the X Toolkit Intrinsics library. Already conditions
  # `--enable-malloc0returnsnull` on cross (same AC_RUN_IFELSE dodge as
  # libx11/libxext/libxi), so no configure-flag work needed here — purely the
  # output-trimming class of fix. "devdoc" needs the xorg doc toolchain
  # (xmlto/docbook), never built here.
  libxt = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "devdoc") (o.outputs or [ "out" "dev" "devdoc" ]);
      doCheck = false;
      # Dropping the doc output leaves libXt's specs/ install with an EMPTY
      # docdir -> `mkdir -p '/share/doc/libXt'`. That "worked" in a sandboxed
      # local build (the mkdir lands in the sandbox's private tmpfs /) and
      # only failed loudly on CI's sandbox-less unprivileged builder — so
      # disable the docs/specs install outright instead of relying on where
      # the stray mkdir happens to land.
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-docs" "--disable-specs" ];
    }))
    prev.libxt;

  # libxmu: X miscellaneous utility routines (Xt-based helpers xeyes' Eyes.c
  # uses). "doc" dropped for the same reason as libxt's "devdoc".
  libxmu = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = builtins.filter (x: x != "doc") (o.outputs or [ "out" "dev" "doc" ]);
      doCheck = false;
      # Same empty-docdir trap as libxt above (libXmu also ships a specs/
      # tree): keep the docs install off rather than pointed at "/share".
      configureFlags = (o.configureFlags or [ ]) ++ [ "--disable-docs" "--disable-specs" ];
    }))
    prev.libxmu;

  # libxtst: XTEST + RECORD extension client lib — xdpyinfo's one *required*
  # extra dependency (its meson.build: `dependency('xtst', required: true)`).
  # Already "out"+"dev" only upstream; doCheck guard for symmetry.
  libxtst = whenWasm
    (p: p.overrideAttrs (_o: {
      doCheck = false;
    }))
    prev.libxtst;

  # xeyes: pure Xlib/Xt client (the spiritual sibling of vendored wl-eyes) —
  # nothing here it forks/popens/systems (checked upstream Eyes.c/xeyes.c/
  # transform.c before writing this override). Leaf binary (nothing builds
  # against it) shipped via environment.systemPackages, so its
  # nix-support/propagated-build-inputs metadata (libxt-dev/libxmu-dev/…) is
  # pure served-closure bloat — the galculator/xkbcomp lesson (CLAUDE.md).
  # No fpcast-emu here: unlike Xvfb's DIX device-feedback tables (heterogeneous
  # C function-pointer arities aliased through one slot), Xt's dispatch
  # surfaces (XtCallbackProc, XtActionProc, widget class procs) are each
  # called through ONE consistently-typed typedef throughout the toolkit — a
  # different shape from the class of bug fpcast-emu exists for. Not
  # boot-verified yet (M-X2 build-only per this session's scope); if the
  # guest ever traps with "null function or function signature mismatch"
  # inside Xt/Xmu, that is the seam to revisit — see xorg-server's fpcast
  # entry above for the fix shape.
  xeyes = whenWasm
    (p: p.overrideAttrs (o: {
      doCheck = false;
      postFixup = (o.postFixup or "") + ''
        rm -rf $out/nix-support
      '';
    }))
    prev.xeyes;

  # xwd: root-window dump utility — plain autotools over libx11 + libxkbfile
  # (both already crossed). Leaf binary; same nix-support trim as xeyes.
  xwd = whenWasm
    (p: p.overrideAttrs (o: {
      doCheck = false;
      postFixup = (o.postFixup or "") + ''
        rm -rf $out/nix-support
      '';
    }))
    prev.xwd;

  # xdpyinfo: server-info query utility, meson-built. Upstream's
  # nixpkgs package.nix lists ELEVEN buildInputs, but its own meson.build
  # marks all but six of them `required: false, disabler: true` (xtst/x11-xcb/
  # xcb/xext/x11/xproto are the only `required: true` deps — verified by
  # reading the vendored meson.build source before writing this override).
  # Trim buildInputs down to those six PLUS the M-X0 optional extensions we
  # already cross for free (libxi/libxrender/libxcomposite/libxrandr) —
  # dropping libxinerama/libxpresent/libxxf86dga/libxxf86vm, which meson
  # gracefully disables (`.found() == false`) rather than failing on. This is
  # the same "question whether it's really needed before crossing it" call
  # this milestone made for libXaw (xeyes/xwd/xdpyinfo need none of it): four
  # more small X extension libs would cross fine, but nothing in this
  # milestone's proof (xeyes rendering + xdpyinfo's PASS line) needs their
  # info, so they're left uncrossed.
  xdpyinfo = whenWasm
    (p: p.overrideAttrs (o: let
      trimmedInputs = [
        final.libx11
        final.libxcb
        final.libxext
        final.libxtst
        final.libxi
        final.libxrender
        final.libxcomposite
        final.libxrandr
        final.xorgproto
      ];
    in {
      buildInputs = trimmedInputs;
      # isStatic packages default propagatedBuildInputs to mirror the FULL
      # (pre-override) buildInputs list — confirmed by attempting the trim
      # with only `buildInputs` overridden: meson's `dependency('xxf86dga',
      # required: false)` still FOUND + linked libXxf86dga because its .pc
      # was still reachable through propagatedBuildInputs' PKG_CONFIG_PATH
      # contribution, and the link failed the same `undefined symbol: fork`
      # (libXxf86dga wraps XF86DGA, an old server-extension client lib that
      # forks internally). Overriding propagatedBuildInputs too closes that
      # back door.
      propagatedBuildInputs = trimmedInputs;
      doCheck = false;
      postFixup = (o.postFixup or "") + ''
        rm -rf $out/nix-support
      '';
    }))
    prev.xdpyinfo;

  # libxcvt (M-X3, XChat/X11 epic): Xwayland's ONE new required dep beyond the
  # M-X1/M-X2 X11 closure (`dependency('libxcvt', required: true)`, unconditional
  # in its meson.build). nixpkgs marks it `badPlatforms = [ isStatic ]` — its
  # lib/meson.build hardcodes `shared_library()` regardless of meson's
  # `default_library` option, so on our all-static crossSystem the standalone
  # `cvt` tool tried to link against a wasm .so and hit the general-dynamic-TLS
  # `__musl_tp` problem (CLAUDE.md's "Static is a PLATFORM flag" entry) —
  # confirmed by attempting the plain cross-build before writing this patch.
  # Fix: `library()` is meson's generic helper that DOES respect
  # `default_library`; one-line source patch, not a per-package static flag
  # (none exists — this isn't a configure option, meson picked a literal type).
  libxcvt = whenWasm
    (p: p.overrideAttrs (o: {
      patches = (o.patches or [ ]) ++ [ ./patches/libxcvt/0001-static-library.patch ];
      doCheck = false;
    }))
    prev.libxcvt;

  # --- Xwayland (M-X3, XChat/X11 epic) --------------------------------------
  # Cross-build Xwayland 24.1.12 — a SEPARATE upstream release from the
  # xorg-server 21.1.23 tarball that builds Xvfb (M-X1): since the freedesktop
  # xserver/Xwayland split, "xwayland" ships its own tarball containing only
  # the Xwayland + (a second, unused-here) Xvfb DDX, not the full xserver
  # monorepo (no Xorg/Xnest/XWin/XQuartz code at all in this tree — confirmed
  # by reading its meson_options.txt/meson.build before writing this override,
  # not assumed from the M-X1 xorg-server shape). PRIME DIRECTIVE corollary 1:
  # override nixpkgs' own `xwayland` recipe (the galculator/l3afpad/xorg-server
  # posture) rather than a from-scratch userspace/xwayland.nix derivation.
  #
  # Off: glamor/GL/GLX/DRI3/libdrm-accel (no GPU on the guest — libepoxy is
  # built no-GL and minigbm is an abort-stub per the sommelier learnings
  # entry; `-Dglamor=false` alone drops the gbm/epoxy/libdrm(accel)/xshmfence
  # requirement — verified via the tree's meson.build `if build_glamor` gates
  # before writing this), libei/emulated-input, libdecor, XDMCP, secure-rpc,
  # systemd-notify, XSELinux, docs/devel-docs, libunwind (already off under
  # useLLVM), this tree's OWN Xvfb (`-Dxvfb=false` — we already have one from
  # M-X1; building a second here would be pure duplication).
  # On: rootless wl_shm Xwayland (sommelier always passes `-shm -rootless`),
  # XKB (xkbcomp + xkeyboard-config — the SAME cross-built paths Xvfb already
  # uses), MIT-SHM left at its build default (matches Xvfb: compiles fine,
  # ENOSYS's at runtime with no guest SysV IPC, clients fall back to
  # core-protocol PutImage — not worth fighting per the M-X1 plan).
  #
  # sha1=libcrypto: same reasoning as Xvfb — musl has none of meson's other
  # SHA1 providers in this cross closure.
  #
  # patches/xwayland/0001: os/utils.c's Popen() fork()+exec, ported to
  # posix_spawn — this tree's Popen has DRIFTED far enough from 21.1.23's
  # (verified: `patch --fuzz=0` of xserver's 0001 fails 4/6 hunks against this
  # tree) that it needs its own patch rather than reuse; the actual C change
  # is the same posix_spawn shape (docs/process-model.md handling rule 2).
  # Note this tree's Popen is the ONLY fork site that matters here — unlike
  # 21.1.23, this tree's non-Windows build has no separate System() function
  # at all (xkb/ddxLoad.c's System() call is inside `#ifdef WIN32`; verified
  # by reading ddxLoad.c before writing this comment), so no analogous System
  # patch is needed.
  # patches/xwayland/0002: test/meson.build's `simple-xinit` helper — same
  # "unused CLI, unconditionally built by `ninja`" issue as xserver's 0002,
  # but this tree's file has an extra `dependencies:` line so the context
  # drifted too; same fix (`build_by_default: false`), separate patch.
  # patches/xwayland/0003: dix/stubmain.c's 3-arg `main` — BYTE-IDENTICAL file
  # to xserver's copy (diffed before writing this comment), so the same
  # clang-wasm-ABI fix (patches/xserver/0003) applies verbatim; kept as its
  # own file per vendor-tree-owns-its-patches convention rather than shared.
  #
  # postPatch: nixpkgs' own package.nix rewrites the os/utils.c Popen() exec
  # target from the literal "/bin/sh" to `${bash}/bin/sh` — but this overlay
  # ALREADY redirects `bash` to `buildPackages.bash` (the native x86_64 build
  # tool) for wasm cross builds, for build-time helper scripts (see the `bash`
  # entry near the top of this file) — baking THAT path into Xwayland would
  # embed a native x86_64 ELF path into the wasm guest binary, unusable at
  # guest runtime. Drop nixpkgs' postPatch entirely: the guest DOES have a
  # real `/bin/sh` (busybox's forkshell ash, promoted to /bin/sh in
  # bootstrap.nix per CLAUDE.md's "In-guest autotools" note), so the tree's
  # original literal is already correct for this target and needs no rewrite.
  #
  # buildInputs: fully replaced (not appended — nixpkgs' own list pulls in
  # dri-pkgconfig-stub/egl-wayland/libdecor/libgbm/libepoxy/libei/libGL/libGLU/
  # libxres/libtirpc/systemd, none of which a glamor-less wl_shm-only build
  # needs) with the minimal set this tree's meson.build actually requires with
  # every optional feature off: the same X11/XKB/font stack Xvfb already
  # cross-builds, PLUS libxcvt (unconditionally `required: true` in this
  # tree — cross-builds with no override needed, confirmed standalone) and
  # wayland/wayland-protocols (Xwayland is fundamentally a Wayland client).
  #
  # No dynsym-inject: like Xvfb, Xwayland resolves nothing by name (unlike
  # galculator's GtkBuilder .ui lookup) — the raw fpcast-emu canonicalizing
  # pass alone is the fix for its DIX device-feedback vtable casts (SAME
  # dix/devices.c code Xvfb hit — see xorg-server's fpcast-emu comment above;
  # both trees share this file nearly verbatim).
  xwayland = whenWasm
    (p: p.overrideAttrs (o: {
      outputs = [ "out" ]; # no "dev": nothing in this closure links against Xwayland
      doCheck = false;
      postPatch = ""; # see the postPatch note above — do NOT inherit o.postPatch
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ fpcast.binaryen ];
      buildInputs = [
        final.xorgproto
        final.xtrans
        final.libxau
        final.libxdmcp
        final.libxcb
        final.libx11
        final.libxext
        final.libxfixes
        final.libxkbfile
        final.libxfont_2
        final.font-util
        final.libxcvt
        # miext/sync/misyncshm.c unconditionally #includes <X11/xshmfence.h>
        # (the SYNC extension's shm-fence support — not gated behind glamor/
        # dri3/mitshm at all; found by attempting the build before adding
        # this). Link-only in practice (glamor=false means nothing calls the
        # fence-wait path at runtime), but the header + .a must be present.
        final.libxshmfence
        # hw/xwayland/xwayland-window.h unconditionally #includes <xf86drm.h>
        # (found by attempting the build): header-only need here — glamor is
        # off, so the DRM-lease/dmabuf code paths this guards never execute.
        # Reuse the SAME link-only libdrm stub Sommelier already established
        # (see the "Sommelier link-only cross closure" entry in CLAUDE.md) —
        # not a new dependency class.
        final.libdrm
        final.pixman
        final.wayland
        final.wayland-protocols
        final.zlib
        final.openssl
      ];
      propagatedBuildInputs = [ ];
      patches = [
        ./patches/xwayland/0001-popen-posix-spawn.patch
        ./patches/xwayland/0002-skip-simple-xinit-fork.patch
        ./patches/xwayland/0003-stubmain-wasm-abi.patch
      ];
      mesonFlags = [
        "-Dxvfb=false"
        "-Dglamor=false"
        "-Dglx=false"
        "-Ddri3=false"
        "-Dxwayland_ei=false"
        "-Dlibdecor=false"
        "-Dxdmcp=false"
        "-Dxdm-auth-1=false"
        "-Dsecure-rpc=false"
        "-Dsystemd_notify=false"
        "-Dxselinux=false"
        "-Ddocs=false"
        "-Ddevel-docs=false"
        "-Ddocs-pdf=false"
        "-Dlibunwind=false"
        "-Ddtrace=false"
        "-Dsha1=libcrypto"
        "-Ddefault_font_path="
        "-Dxkb_bin_dir=${final.xkbcomp}/bin"
        "-Dxkb_dir=${final.xkeyboard-config}/share/X11/xkb"
        "-Dxkb_output_dir=/tmp"
      ];
      postInstall = (o.postInstall or "") + ''
        rm -rf $out/share/man
      '';
      postFixup = (o.postFixup or "") + ''
        # Leaf binary shipped via environment.systemPackages (nothing builds
        # against it) — same nix-support bloat trim as galculator/xkbcomp/
        # xeyes/xwd/xdpyinfo above (CLAUDE.md's galculator lesson).
        rm -rf $out/nix-support
        if [ -f "$out/bin/Xwayland" ]; then
          ${fpcast.binaryen}/bin/wasm-opt \
            --enable-threads --enable-bulk-memory --enable-mutable-globals \
            --enable-nontrapping-float-to-int --enable-sign-ext \
            --enable-reference-types --enable-multivalue \
            -pa max-func-params@128 --fpcast-emu \
            "$out/bin/Xwayland" -o "$out/bin/Xwayland.fpcast"
          mv "$out/bin/Xwayland.fpcast" "$out/bin/Xwayland"
          chmod +x "$out/bin/Xwayland"
        fi
      '';
    }))
    prev.xwayland;
}
