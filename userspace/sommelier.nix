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
#   from our nix-built musl).
# - No --fpcast-emu: Sommelier uses no GLib/GObject indirect-call dispatch.
# - The dylink/-shared link + --allow-undefined-file come from the cross
#   cc-wrapper (wasm-cross.nix) automatically — same as every other cross binary.
#   Do NOT add --allow-undefined (forbidden, #52).
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
