# userspace/sommelier.nix — Sommelier cross-compiled to wasm32-nommu.
#
# Sommelier is the Chromium OS Wayland compositor shim: a C++17 meson project
# that bridges guest Wayland clients to the host compositor via /dev/wl0 (virtwl).
# On the wasm32-nommu guest it runs as /bin/sommelier on the wl_shm path; the
# dmabuf/GPU paths (gbm, drm DMA) are reachable at the call-site level but are
# fully guarded by ctx->gbm != null checks that are never true (no /dev/dri on the
# wasm guest). Those deps (gbm, libdrm, libxcb) are link-only stubs or safe
# cross-build packages that satisfy the linker without adding runtime code paths.
#
# Key build notes:
# - wayland-scanner MUST be native (the wasm scanner can't execute on the build
#   host). meson.build uses find_program('wayland-scanner') which, in a cross
#   build, resolves to the cross (wasm32) scanner that can't run. We override
#   WAYLAND_SCANNER in the environment so the cross pkg-config lookup is bypassed.
#   (Same pattern as wl-eyes.nix and wl-server-ffi.nix.)
# - python3 + jinja2 (for gen-shim.py) must also be native. We pull them from
#   buildPackages.
# - The posix-spawn patch replaces fork()/execvp() with posix_spawnp() — the
#   only spawn mechanism available on the NOMMU wasm guest (fork/vfork absent
#   from our nix-built musl). It ALSO already covers sl_spawn_xwayland (the -X
#   Xwayland launch site, M-X3) — the patch fully rewrote that function to use
#   the same sl_spawn() posix_spawn wrapper with a proper
#   posix_spawn_file_actions_t for the display-ready/wm socketpair fds, so no
#   further extension was needed to enable -X (verified by reading the applied
#   patch before writing this comment — see patches/sommelier/0001's
#   sl_spawn_xwayland hunk).
# - No --fpcast-emu: Sommelier uses no GLib/GObject indirect-call dispatch.
# - The dylink/-shared link + --allow-undefined-file come from the cross
#   cc-wrapper (wasm-cross.nix) automatically — same as every other cross binary.
#   Do NOT add --allow-undefined (forbidden, #52).
# - M-X3 (XChat/X11 epic): `-Dxwayland_path=`/`-Dxwayland_gl_driver_path=` bake
#   the cross-built Xwayland's absolute store path in as sommelier.cc's
#   XWAYLAND_PATH/XWAYLAND_GL_DRIVER_PATH compile-time defaults (meson_options.txt:
#   "path to Xwayland" — a full executable path, not a directory, despite the
#   option name; verified against sommelier.cc's `xwayland_path ?: XWAYLAND_PATH`
#   use before choosing the value). This is the SAME reference-into-served-
#   closure trick Xvfb's `-Dxkb_bin_dir=${xkbcomp}/bin` already relies on
#   (deps-overlay.nix) — EXCEPT it does NOT apply here, because sommelier ships
#   via initramfs extraBins (a flat file copy, no Nix closure walk), not
#   environment.systemPackages. Xwayland's own store path only reaches the
#   served /nix squashfs because `xwaylandApp` is ALSO listed directly in
#   extraSystemPackages (flake.nix) — baking the path into sommelier's binary
#   only fixes WHAT it execs, not WHETHER that path exists on the guest.
#   GL driver path is left empty: this build is glamor=false (no GPU), so
#   Xwayland never reads LIBGL_DRIVERS_PATH, but an honest empty default is
#   clearer than leaving Sommelier's own upstream ChromeOS-container default
#   (a path that doesn't exist on this guest either way) baked in.
{ pkgs, cross }:
let
  # All cross-built deps come directly from the `cross` package set, where
  # deps-overlay.nix has already applied all wasm-cross fixes (isWasm guards,
  # static-only libraries, etc.).
  gbm          = cross.minigbm;   # abort-stub libgbm.a (userspace/libgbm-shim)
  libdrm       = cross.libdrm;    # link-only for DRM headers / fourcc.h
  pixman       = cross.pixman;
  libxkbcommon = cross.libxkbcommon;
  libxcb       = cross.libxcb;
  libxau       = cross.libxau;
  libxdmcp     = cross.libxdmcp;
  wayland      = cross.wayland;
  libffi       = cross.libffi;
  xwayland     = cross.xwayland; # M-X3: the Xwayland binary this instance spawns
in
cross.stdenv.mkDerivation {
  pname = "sommelier-wasm32-nommu";
  version = "virtwl";

  src = ../vendor/sommelier;

  # Remove all fork/execvp sites; replace with posix_spawnp (the only spawn
  # mechanism available on the NOMMU wasm guest — fork/vfork absent from musl).
  patches = [
    ../patches/sommelier/0001-posix-spawn.patch
    # Gracefully handle the non-mmappable host->guest keymap fd on NOMMU (the
    # keymap is already forwarded to the client; the mmap is only for Sommelier's
    # own null-guarded xkb state) instead of asserting — else keyboard-using GTK
    # apps abort the per-client worker on wl_keyboard.keymap.
    ../patches/sommelier/0002-keymap-mmap-graceful.patch
    # xdg-decoration passthrough: advertise zxdg_decoration_manager_v1 to guest
    # clients when the HOST compositor offers it and forward the negotiation 1:1
    # (new sommelier-xdg-decoration.cc, viewporter-passthrough pattern). Without
    # this a guest client that wants server-side decorations (wl-eyes -- it draws
    # no frame of its own) can never ask: sommelier is the compositor it talks
    # to, and stock sommelier doesn't implement the protocol, so the host
    # (Greenfield -> pc) sees a silent client and CSD-defaults it to frameless.
    ../patches/sommelier/0003-xdg-decoration-passthrough.patch
    # 0004: `-X` with no [program] = a standing X server, not a usage error.
    # Sommelier's model is "run this app under X": it REQUIRES a trailing
    # [program] and execs it as the X session leader when Xwayland signals
    # display-ready. We want the other shape — a boot-time daemon that just
    # SERVES :1 for whatever connects later — and Sommelier itself (Xwayland
    # + the XWM) is the whole service, so there is no leader to run. Without
    # this the daemon must be fed a filler program purely to satisfy the
    # exec, and any exec failure asserts and takes X down with it (that is
    # exactly how the first `-X` wiring died: a bogus placeholder ->
    # ENOENT -> `Assertion failed: sl_handle_display_ready_event`). Making
    # server-only a first-class mode is the honest fix, and it is generic:
    # nothing here knows or cares which X app connects.
    ../patches/sommelier/0004-xwayland-server-only-mode.patch
  ];

  nativeBuildInputs = [
    cross.buildPackages.meson
    cross.buildPackages.ninja
    cross.buildPackages.pkg-config
    # wayland-scanner: code-generates the wayland protocol C/H files.
    # Must be the NATIVE binary; the wasm scanner can't execute.
    cross.buildPackages.wayland-scanner
    # gen-shim.py (in the source tree) uses python3 + jinja2 at configure time.
    cross.buildPackages.python3
    cross.buildPackages.python3Packages.jinja2
  ];

  buildInputs = [
    wayland        # wayland-client + wayland-server static .a
    libffi         # required transitively by wayland-client.pc
    libxkbcommon   # xkbcommon.h + libxkbcommon.a
    pixman         # pixman-1.h + libpixman-1.a
    gbm            # gbm.h + libgbm.a (abort-stub shim)
    libdrm         # xf86drm.h + libdrm/drm_fourcc.h
    libxcb         # xcb.h + xcb-composite/shape/xfixes .pc files
    libxau         # X authority (libxcb dependency)
    libxdmcp       # X display manager control (libxcb dependency)
  ];

  mesonFlags = [
    # Feature flags — keep all optional subsystems off:
    "-Dtracing=false"       # would pull perfetto (unavailable)
    "-Dgamepad=false"       # would pull libevdev (unavailable)
    "-Dquirks=false"        # would pull protobuf (unavailable)
    "-Dwith_tests=false"    # default is TRUE; gtest not cross-built
    # commit_loop_fix defaults false; set explicitly for clarity
    "-Dcommit_loop_fix=false"
    # wasm-ld doesn't support PIE relocations
    "-Db_pie=false"
    # M-X3: default -X target — see the file-header comment above.
    "-Dxwayland_path=${xwayland}/bin/Xwayland"
    "-Dxwayland_gl_driver_path="
  ];

  # meson's find_program('wayland-scanner') in a cross build walks the cross
  # pkg-config sysroot and finds the wasm32 wayland-scanner binary (which
  # cannot execute on the build host). Override via the env var that meson's
  # cross-file mechanism would set, and also pass it as a define so any
  # pkg-config --variable=wayland_scanner lookup is bypassed.
  WAYLAND_SCANNER = "${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner";

  # Override the wayland_scanner program search so meson uses our native binary.
  # meson respects WAYLAND_SCANNER only if the build system is set up for it;
  # we also supply a cross file override fragment via preConfigure.
  postPatch = ''
    # gen-shim.py has #!/usr/bin/env python3 which doesn't exist in the Nix
    # sandbox. Patch the shebang to the native python3 store path so meson's
    # generator can invoke it directly.
    substituteInPlace gen-shim.py \
      --replace-fail '#!/usr/bin/env python3' '#!${cross.buildPackages.python3}/bin/python3'
  '';

  preConfigure = ''
    # Write a meson machine-file that pins the native wayland-scanner.
    # meson loads all files passed via --native-file (or implicitly via
    # MESON_NATIVE_FILE); we use a temporary one here.
    mkdir -p "$TMPDIR/meson-native"
    cat > "$TMPDIR/meson-native/scanner.ini" <<EOF
[binaries]
wayland-scanner = '${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner'
EOF
    mesonFlags="$mesonFlags --native-file=$TMPDIR/meson-native/scanner.ini"
  '';

  dontStrip = true;

  meta = {
    description = "Sommelier Wayland compositor shim (wasm32-nommu, virtwl/wl_shm path)";
  };
}
