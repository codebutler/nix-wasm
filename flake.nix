{
  description = "wasm32-linux-musl NOMMU toolchain + Nix, built with Nix (#139/#141)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # wl-eyes: a native Wayland client (source-only; built by ./wl-eyes.nix against
  # the wasm32 cross stack). flake = false → consumed as a plain source tree.
  inputs.wl-eyes = { url = "git+file:///home/vbvntv/Code/wl-eyes"; flake = false; };
  # weston: upstream source for the weston-flowers demo client (built by
  # ./weston-flowers.nix — minimal toytoolkit subset, see that file). Pinned to
  # the 14.0.1 release tarball; flake = false → plain source tree.
  inputs.weston = {
    url = "https://gitlab.freedesktop.org/wayland/weston/-/releases/14.0.1/downloads/weston-14.0.1.tar.xz";
    flake = false;
  };

  outputs = { self, nixpkgs, wl-eyes, weston }:
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

      # ---- kernel-only patched LLVM-21 scope: stock LLVM-21 carrying BOTH the
      # joelseverin wasm-ld GNU linker-script patch (lld) AND the WasmAsmParser
      # MC-layer patch for the kernel's EXPORT_SYMBOL inline-asm (libllvm),
      # rebased onto 21. A LOCAL overrideScope (not a global overlay) so the
      # patched lld links the patched libllvm and the shared cached toolchain is
      # untouched (no rebuild cascade). Consumed only by the kernel build.
      kernelLlvm = import ./toolchain/kernel-llvm.nix { inherit pkgs; };

      # `.#patched-lld` still exposes the linker-script-capable wasm-ld; it now
      # comes from the kernel scope (which also carries the MC patch).
      patchedLld = kernelLlvm.lld;

      # ---- kernel cc/ld toolchain: the patched-scope clang-21 + wasm-ld,
      # carrying pc's fake-llvm argv rewrites. Consumed only by kernel.nix.
      kernelCC = import ./toolchain/kernel-cc.nix { inherit pkgs; llvm = kernelLlvm; };

      # ---- the wasm guest kernel: vmlinux.wasm, built from pinned source with
      # stock clang-21 + the patched wasm-ld. New exec ABI (039e5f3e); does not
      # boot yet (runtime forward-port pending).
      kernelSrc = import ./toolchain/kernel-src.nix { inherit pkgs; };
      kernel = import ./kernel.nix { inherit pkgs kernelCC kernelSrc; };

      # ---- opt-in ccache variant of the from-source kernel LLVM (CLAUDE.md §
      # ccache). Same derivations as kernelLlvm/kernelCC/kernel except the patched
      # libllvm/lld/clang rebuild routes clang through ccache, turning a from-
      # scratch ~1–2 h LLVM rebuild into a near-cache-hit when iterating on the
      # two LLVM patches. Default builds stay hermetic; build via `.#kernel-ccache`.
      kernelLlvmCcache = import ./toolchain/kernel-llvm.nix { inherit pkgs; useCcache = true; };
      kernelCCcache = import ./toolchain/kernel-cc.nix { inherit pkgs; llvm = kernelLlvmCcache; };
      kernelCcache = import ./kernel.nix { inherit pkgs kernelSrc; kernelCC = kernelCCcache; };

      # ---- the wasm32-linux-musl cross package set (cross.zlib, cross.curl…) --
      cross = import ./wasm-cross.nix {
        inherit nixpkgs sysroot compilerRt libcxx;
        overlays = [ (import ./deps-overlay.nix { inherit kernelHeaders; muslWasm = musl; }) ];
      };

      # ---- the guest busybox: 1.36.1 + the harness wasm-arch/clone-spawn patch,
      # built with kernelCC over the musl sysroot. THE fix for in-guest spawn —
      # stock cross.busybox forks/vforks (impossible on the wasm NOMMU clone-with-
      # fn model); this one clones-with-a-fn. Replaces cross.busybox everywhere
      # the guest runs it (system profile + initramfs).
      wasmBusyboxKernelHeaders = import ./userspace/busybox-kernel-headers.nix {
        inherit pkgs kernelHeaders;
      };
      wasmBusybox = import ./userspace/busybox.nix {
        inherit pkgs cross;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };
      # busybox ASH — the autoconf-capable guest shell (forkshell, NOMMU
      # fork-without-exec via the guest cb adapter). See CLAUDE.md (Architecture)
      # + the userspace/ash.nix postPatch comments.
      wasmAsh = import ./userspace/ash.nix {
        inherit pkgs cross;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };

      # Wayland Phase 1 (1b M3): the /dev/wl0 userspace round-trip self-test.
      wasmWlTest = import ./userspace/wltest.nix {
        inherit pkgs cross;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };

      # Wayland Phase 1 (1c, Sommelier pivot): the thin guest-side Wayland↔virtwl
      # bridge. Opens /dev/wl0 + a wayland-0 AF_UNIX socket and splices the wire
      # protocol (bytes + fds) between guest clients and the host compositor.
      wasmWaylandProxyd = import ./userspace/waylandproxyd.nix {
        inherit pkgs cross;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };

      # Wayland Phase 1 (1c M3): a minimal AF_UNIX test client that sends a
      # wl_display.get_registry request to wayland-0 — proves waylandproxyd
      # accepts a connection and forwards the initial bytes to the host.
      wasmWlClient = import ./userspace/wlclient.nix {
        inherit pkgs cross;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };

      # Wayland Phase 1 (1d M2): the STOCK-libwayland registry-handshake client —
      # the Phase 1 deliverable. Links the cross libwayland-client and runs the
      # canonical wl_display_connect → get_registry → roundtrip → enumerate
      # globals flow THROUGH waylandproxyd, end-to-end across the transport.
      wasmWlHandshake = import ./userspace/wlhandshake.nix {
        inherit pkgs cross;
      };

      # Wayland Phase 2 (2c): wl-eyes — the first end-user Wayland app. Links the
      # cross libwayland-client + libffi (raw backend) + wayland-protocols
      # (xdg-shell), generates the xdg-shell glue with the BUILD-host
      # wayland-scanner, and rasterizes two pointer-tracking eyes into a wl_shm
      # pool. Baked into the initramfs as /bin/wl-eyes. See wl-eyes.nix.
      wlEyes = import ./wl-eyes.nix {
        inherit cross;
        wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
        src = wl-eyes;
      };

      # Wayland Phase 4f: wl-anim — a minimal SELF-ANIMATING client (wl_shm +
      # xdg-shell + a frame-callback loop). Proves the steady-state render cycle
      # self-sustains on host self-wake alone (weston-flowers is static and
      # can't). Baked into the initramfs as /bin/wl-anim. See userspace/wl-anim.*.
      wlAnim = import ./userspace/wl-anim.nix {
        inherit cross;
        wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
      };

      # M0 (galculator): wl-input-probe — wl_seat/pointer/keyboard event logger.
      # Manual proof that browser input reaches a guest client through Greenfield.
      wlInputProbe = import ./userspace/wl-input-probe.nix {
        inherit cross;
        wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
      };

      # M1 (galculator): libffi-selftest — in-guest unit test for the raw wasm
      # FFI backend's f32/f64/i64 by-value argument support.
      libffiSelftest = import ./userspace/libffi-selftest.nix {
        inherit cross;
        libffi = cross.libffi;
      };

      # Regression test for detached-thread exit on wasm (the __unmapself/CRTJMP
      # SIGILL fixed by patches/musl/0008). See userspace/pthread-exit-test.c.
      pthreadExitTest = import ./userspace/pthread-exit-test.nix {
        inherit cross;
      };

      # Diagnostic for the GTK render heap-corruption crash: does --fpcast-emu
      # dispatch rodata (static const) fn pointers correctly? See
      # userspace/fpcast-vtable-test.c.
      fpcastVtableTest = import ./userspace/fpcast-vtable-test.nix {
        inherit cross;
      };

      # M3a (galculator): glib-selftest — in-guest gobject proof. Round-trips a
      # GObject and emits a `double` signal through gobject's GENERIC (libffi)
      # marshaller (g_cclosure_marshal_generic → ffi_call) — the first real exercise
      # of the M1 raw wasm FFI backend's f64 path under gobject. See
      # userspace/glib-selftest.*.
      glibSelftest = import ./userspace/glib-selftest.nix {
        inherit cross;
        glib = cross.glib;
        libffi = cross.libffi;
        pcre2 = cross.pcre2;
        zlib = cross.zlib;
      };

      # M3a (galculator): pango-text — the pango-layout render proof (the GTK text
      # path). PangoLayout on a pangocairo context → cairo image surface, asserting
      # non-white pixels (--selftest). Exercises pango→fontconfig→cairo-ft end-to-end
      # and shares the gobject --fpcast-emu seam. See userspace/pango-text.*.
      pangoText = import ./userspace/pango-text.nix {
        inherit cross;
        pango = cross.pango; cairo = cross.cairo; glib = cross.glib;
        harfbuzz = cross.harfbuzz; fontconfig = cross.fontconfig; freetype = cross.freetype;
        fribidi = cross.fribidi; pcre2 = cross.pcre2; zlib = cross.zlib;
        libffi = cross.libffi; pixman = cross.pixman;
      };

      # M3b (galculator): gtk-hello — the GTK3 hello-window proof. gtk_init +
      # GtkWindow + GtkLabel. --selftest is the headless CI gate (init + widget tree,
      # compositor-independent); default maps a real wayland window for the manual
      # browser check. gtk is gobject → fn-pointer casts, so the linked binary goes
      # through the SHARED --fpcast-emu seam. See userspace/gtk-hello.*.
      gtkHello = import ./userspace/gtk-hello.nix {
        inherit cross;
        gtk3 = cross.gtk3; glib = cross.glib; pango = cross.pango; cairo = cross.cairo;
        gdk-pixbuf = cross.gdk-pixbuf; atk = cross.atk; libepoxy = cross.libepoxy;
        harfbuzz = cross.harfbuzz; fontconfig = cross.fontconfig; freetype = cross.freetype;
        fribidi = cross.fribidi; pixman = cross.pixman; wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols; libxkbcommon = cross.libxkbcommon;
        libffi = cross.libffi; zlib = cross.zlib;
      };

      # #33: gtk3-widget-factory — the headline GTK3 app. GTK's own widget showcase,
      # built standalone against the cross gtk3. Proves GtkBuilder signal autoconnect
      # on the static guest via gtk_builder_add_callback_symbol (no GModule). --selftest
      # is the display-free headless gate; the full window is a manual browser check.
      # See userspace/widget-factory.nix + patches/widget-factory/ + issue #33.
      widgetFactory = import ./userspace/widget-factory.nix {
        inherit cross;
        gtk3 = cross.gtk3; glib = cross.glib; pango = cross.pango; cairo = cross.cairo;
        gdk-pixbuf = cross.gdk-pixbuf; atk = cross.atk; libepoxy = cross.libepoxy;
        harfbuzz = cross.harfbuzz; fontconfig = cross.fontconfig; freetype = cross.freetype;
        fribidi = cross.fribidi; pixman = cross.pixman; wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols; libxkbcommon = cross.libxkbcommon;
        libffi = cross.libffi; zlib = cross.zlib;
      };

      # M2 (text stack): wl-text — the end-to-end text-rendering proof. Resolves a
      # font via fontconfig, shapes with harfbuzz, rasterizes with cairo-ft, and
      # (--selftest) asserts on stdout — the M2 integration gate. Default mode
      # blits the same render into a wl_shm window. See userspace/wl-text.*.
      wlText = import ./userspace/wl-text.nix {
        inherit cross;
        cairo = cross.cairo; fontconfig = cross.fontconfig; harfbuzz = cross.harfbuzz;
        freetype = cross.freetype; pixman = cross.pixman; zlib = cross.zlib;
        wayland = cross.wayland; wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
      };

      # Wayland Phase 2 (4b): weston-flowers — the REAL upstream weston demo
      # client, cross-built from a minimal cairo-toytoolkit subset (flower.c +
      # window.c + shared/*). The first cairo-backed Wayland client on the stack.
      # Links the image-surface-only cross cairo (4b M1) + pixman + zlib +
      # wayland-client/cursor + xkbcommon. Baked into the initramfs as
      # /bin/weston-flowers. See weston-flowers.nix.
      westonFlowers = import ./weston-flowers.nix {
        inherit cross;
        cairo = cross.cairo;
        pixman = cross.pixman;
        zlib = cross.zlib;
        wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols;
        libxkbcommon = cross.libxkbcommon;
        libffi = cross.libffi;
        src = weston;
      };

      # ---- Phase 3: the in-guest compiler (clang.wasm + wasm-ld.wasm), LLVM-21
      # clang+lld cross-built to wasm32 against the nix musl sysroot + libc++.
      guestClang = import ./toolchain/guest-clang.nix {
        inherit pkgs musl libcxx compilerRt;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };
      # Opt-in ccache variant (CLAUDE.md § ccache): same derivation, clang routed
      # through ccache so a rebuild after a flag/patch tweak reuses object files.
      # Build via `.#guest-clang-ccache`; the default `.#guest-clang` stays hermetic.
      guestClangCcache = import ./toolchain/guest-clang.nix {
        inherit pkgs musl libcxx compilerRt;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
        useCcache = true;
      };

      # ---- Phase 3 Stage B: the in-guest `cc` pipeline — cc-sysroot (a store DIR
      # of musl + LLVM-21 builtin headers + compiler-rt builtins) and the `cc`
      # driver (references clang/wasm-ld + the sysroot by store path; no /opt/bin,
      # no cpio extraction — all served read-only over 9P in the /nix closure).
      ccSysroot = import ./toolchain/cc-sysroot.nix { inherit pkgs musl compilerRt libcxx; };
      guestCc = import ./toolchain/guest-cc.nix { inherit pkgs guestClang ccSysroot; };
      # ---- the in-guest `c++` driver (C++ companion to `cc`): same clang+wasm-ld
      # over the cc-sysroot's libc++ (sys/cxx), with wasm-EH + the libc++ link.
      guestCxx = import ./toolchain/guest-cxx.nix { inherit pkgs guestClang ccSysroot; };

      # ---- in-guest `make` (pdpmake → wasm32). Works unpatched: it spawns recipes
      # via system()→posix_spawn→clone(CLONE_VFORK), the only NOMMU spawn mode.
      makeWasm = import ./toolchain/make.nix {
        inherit pkgs musl compilerRt;
        busyboxKernelHeaders = wasmBusyboxKernelHeaders;
      };

      # ---- curated NixOS-module eval -> guest /etc (Approach B) --------------
      wasmSystem = import ./userspace/system.nix {
        inherit nixpkgs cross; busybox = wasmBusybox;
        # The in-guest toolchain, folded into the system profile/closure (one
        # /nix userspace; no /opt/bin side-mount). guestClang gives bin/{clang,
        # wasm-ld}; nixWasm bin/nix; makeWasm bin/make; guestCc bin/cc; guestCxx bin/c++.
        toolchain = [ nixWasmClean guestClang guestCc guestCxx makeWasm wasmAsh ];
        nixPackage = nixWasmClean;
      };
      wasmPasswd = import ./userspace/passwd.nix {
        lib = cross.lib; pkgs = cross; config = wasmSystem.config;
      };

      # ---- generated inittab (profile-absolute paths) + activation script ----
      wasmInittab = import ./userspace/init.nix { lib = cross.lib; pkgs = cross; };
      wasmActivate = import ./userspace/activate.nix { pkgs = cross; };

      # ---- assembled guest system closure (boot layout) ---------------------
      wasmToplevel = import ./userspace/toplevel.nix {
        pkgs = cross;
        busybox = wasmBusybox;
        etc = wasmSystem.config.system.build.etc;
        systemPath = wasmSystem.config.system.path;
        passwd = wasmPasswd.passwd;
        group = wasmPasswd.group;
        inittab = wasmInittab;
        activate = wasmActivate;
      };

      # ---- thin initramfs /init (generated) + the initramfs cpio ------------
      wasmBootstrap = import ./userspace/bootstrap.nix { pkgs = cross; };
      wasmInitramfs = import ./userspace/initramfs.nix {
        inherit pkgs; busybox = wasmBusybox; init = wasmBootstrap;
        extraBins = [ wasmWlTest wasmWaylandProxyd wasmWlClient wasmWlHandshake wlEyes wlAnim westonFlowers wlInputProbe libffiSelftest wlText glibSelftest pangoText gtkHello cross.galculator pthreadExitTest fpcastVtableTest widgetFactory ];
      };

      # ---- the served-closure manifest (store.json) for pc -----------------
      wasmStoreManifest = import ./userspace/store-manifest.nix {
        inherit pkgs; toplevel = wasmToplevel;
      };

      # ---- the base-system store closure as a single squashfs image (#43) ---
      wasmBaseSquashfs = import ./userspace/base-squashfs.nix {
        inherit pkgs; toplevel = wasmToplevel;
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

      # nix.wasm is statically linked, but the wasm binary embeds dead build-time
      # store-path strings (openssl-static/boost-static-dev/nlohmann_json), which
      # Nix scans as references — transitively dragging native glibc + its
      # thousands of locale files into the wasm-system closure (it ballooned
      # store.json to 258MB). The guest never touches those host paths, so strip
      # them (the standard removeReferencesTo technique) via a cheap post-process —
      # no nix rebuild. Result: nix-wasm's closure is just its own binary.
      nixWasmClean = pkgs.runCommand "nix-wasm-2.34.7"
        {
          nativeBuildInputs = [ pkgs.nukeReferences ];
          # config/nix.nix reads `nix.package.version` (for nix.conf generation).
          version = nixWasm.version;
        }
        ''
          mkdir -p $out/bin
          cp -a ${nixWasm}/bin/. $out/bin/
          chmod -R u+w $out/bin
          nuke-refs $out/bin/nix
        '';

      # ---- Wasm binary cache: the on-demand compiler toolchain (#43/#2/#1) -----
      # A standard file:// Nix binary cache (nix-cache-info + narinfo + nar/) for
      # the in-guest compiler tools. Served by runtime/nix-cache.js and substituted
      # in-guest via `nix-env -iA` (bootstrap copies /nix-cache/pkgs.nix to
      # ~/.nix-defexpr at boot). The tools are NOT in the base squashfs; they
      # arrive on demand through substitution.
      wasmDevToolsEnv = pkgs.buildEnv {
        name = "wasm-dev-tools";
        paths = [ guestClang guestCc guestCxx makeWasm ];
      };
      wasmBinaryCache = import ./userspace/binary-cache.nix {
        inherit pkgs;
        devPaths = [ guestClang guestCc guestCxx makeWasm ];
        devToolsEnv = wasmDevToolsEnv;
      };
    in
    {
      # The FULL wasm32 cross package set — exposing it as legacyPackages lets
      # `nix build .#<anypkg>` work ad hoc (e.g. `.#wayland`, `.#pixman`) without
      # enumerating it in `packages` below.
      legacyPackages.${system} = cross;

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

        # The patched guest busybox (clone-spawn fix) + its musl-patched UAPI
        # headers — exposed for build/inspection before wiring into the system.
        # The in-guest compiler: $out/bin/{clang,wasm-ld} (+ lib/clang resource dir).
        guest-clang = guestClang;

        # Opt-in ccache build variants of the two from-source LLVM derivations —
        # for the dev iteration loop only (need `extra-sandbox-paths`; CLAUDE.md
        # § ccache). Byte-identical outputs to guest-clang/kernel, built faster.
        guest-clang-ccache = guestClangCcache;
        kernel-ccache = kernelCcache;

        # The in-guest cc pipeline: $out/sys/{musl,clang} sysroot dir + $out/bin/cc.
        cc-sysroot = ccSysroot;
        guest-cc = guestCc;
        guest-cxx = guestCxx;
        guest-ash = wasmAsh;

        # In-guest make (pdpmake → $out/bin/make).
        make-wasm = makeWasm;

        userspace-busybox = wasmBusybox;
        userspace-busybox-kernel-headers = wasmBusyboxKernelHeaders;

        # Wayland Phase 1 (1b M3): /dev/wl0 round-trip self-test guest binary.
        wltest = wasmWlTest;

        # Wayland Phase 1 (1c): the guest-side Wayland↔virtwl bridge binary.
        waylandproxyd = wasmWaylandProxyd;

        # Wayland Phase 1 (1c M3): the AF_UNIX test client for waylandproxyd.
        wlclient = wasmWlClient;

        # Wayland Phase 1 (1d M2): the stock-libwayland registry-handshake client.
        wlhandshake = wasmWlHandshake;

        # Wayland Phase 2 (2c): wl-eyes — the first end-user Wayland app
        # (wl_shm + xdg-shell + wl_pointer) cross-built to wasm → $out/bin/wl-eyes.
        wl-eyes = wlEyes;

        # Wayland Phase 2 (4b): weston-flowers — real upstream weston demo
        # (cairo toytoolkit) cross-built to wasm → $out/bin/weston-flowers.
        weston-flowers = westonFlowers;

        # Wayland Phase 4f: wl-anim — self-animating frame-callback client →
        # $out/bin/wl-anim. Proves the steady-state render loop self-sustains.
        wl-anim = wlAnim;

        # M0 (galculator): wl-input-probe — wl_seat/pointer/keyboard event logger →
        # $out/bin/wl-input-probe. Manual proof that browser input reaches the guest.
        wl-input-probe = wlInputProbe;

        # M1 (galculator): libffi-selftest — in-guest unit test for the raw wasm
        # FFI backend's f32/f64/i64 by-value argument support → $out/bin/libffi-selftest.
        libffi-selftest = libffiSelftest;

        # Regression test for detached-thread exit on wasm (patches/musl/0008) →
        # $out/bin/pthread-exit-test.
        pthread-exit-test = pthreadExitTest;

        # Diagnostic: --fpcast-emu rodata-vtable dispatch test → $out/bin/fpcast-vtable-test.
        fpcast-vtable-test = fpcastVtableTest;

        # M2 (text stack): wl-text — fontconfig→freetype→harfbuzz→cairo-ft proof →
        # $out/bin/wl-text (--selftest is the headless CI gate).
        wl-text = wlText;

        # M3a (galculator): glib-selftest — gobject + the M1 libffi double-marshaller
        # proof → $out/bin/glib-selftest.
        glib-selftest = glibSelftest;

        # M3a (galculator): pango-text — pango-layout → cairo image surface render
        # proof (--selftest is the headless CI gate) → $out/bin/pango-text.
        pango-text = pangoText;

        # M3b (galculator): gtk-hello — the GTK3 hello-window proof. --selftest is the
        # headless CI gate (gtk_init + GtkWindow + GtkLabel widget tree) → $out/bin/gtk-hello.
        gtk-hello = gtkHello;

        # M4: galculator — the headline GTK3 calculator. fpcast-emu post-link seam
        # applied (same gobject indirect-call fix as gtkHello/pangoText). Baked into
        # the initramfs as /bin/galculator; its $out/share/galculator/ui/*.ui ride the
        # served /nix closure.
        galculator = cross.galculator;

        # #33: gtk3-widget-factory — the headline GTK3 app. GtkBuilder autoconnect
        # via add_callback_symbol (no GModule on the static guest). --selftest is the
        # headless gate (display-free GtkBuilder signal round-trip); the full window
        # renders in the browser (needs the musl/RAM/dev-shm fixes). → $out/bin/gtk3-widget-factory.
        widget-factory = widgetFactory;


        # Nix itself, cross-compiled → $out/bin/nix (the wasm binary).
        nix-wasm = nixWasm;

        # Curated NixOS-module eval -> guest /etc.
        userspace-etc = wasmSystem.config.system.build.etc;

        # Guest system profile (/run/current-system/sw): busybox + ncurses/terminfo.
        userspace-path = wasmSystem.config.system.path;

        # Generated guest inittab (profile-absolute paths) — debug/inspection.
        wasm-inittab = wasmInittab;

        # Assembled guest system closure: $out/{etc,sw,init,activate} in boot layout.
        wasm-system = wasmToplevel;

        # The guest initramfs.cpio.gz (cross busybox + the generated thin /init).
        wasm-initramfs = wasmInitramfs;

        # The base-system store closure as a single squashfs image for virtio-blk.
        wasm-base-squashfs = wasmBaseSquashfs;

        # On-demand compiler toolchain as a Nix binary cache (#43/#2/#1):
        # nix-cache-info + narinfo + nar/ + pkgs.nix (the defexpr index).
        # Served by runtime/nix-cache.js; in-guest: `nix-env -iA dev-tools`.
        wasm-binary-cache = wasmBinaryCache;

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
      ])
      # The Wayland stack (client + server libs), each cross-built to wasm.
      # Exposed as `wl-<name>` so `nix build -k .#wl-…` surfaces every cross
      # failure at once. wayland-scanner builds for the BUILD host (buildPackages
      # native/target split, same as wl-eyes); the libwayland-* libraries cross-
      # compile. These deps are what waylandproxyd (1c) + the stock-libwayland
      # client test (1d) link against. Only libffi needed an overlay fix (the raw
      # backend, see deps-overlay.nix); wayland/pixman/expat cross-build unmodified.
      // builtins.listToAttrs (map (n: { name = "wl-${n}"; value = cross.${n}; }) [
        "libffi"
        "expat"
        "wayland"
        "wayland-protocols"
        "pixman"
        # cairo: image-surface-only build (pixman+zlib) for the toolkit path —
        # backs stock cairo+wl_shm clients like weston-flowers. See deps-overlay.nix.
        "cairo"
      ]);
    };
}
