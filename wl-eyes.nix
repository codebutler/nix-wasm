# wl-eyes — a native Wayland client (wl_shm + xdg-shell + wl_pointer; ~/Code/
# wl-eyes), cross-compiled to wasm32 through the same crossSystem as the rest of
# the stack. The first real END-USER app on the Wayland-on-wasm stack.
#
# Build mechanics (the project's own Makefile, with two cross overrides):
#   - wayland-scanner must run on the BUILD host (the wasm scanner can't
#     execute), so WAYLAND_SCANNER is pinned to the native one. The Makefile's
#     default discovers it via `pkg-config --variable=wayland_scanner
#     wayland-scanner`, which in a cross build points at the unrunnable wasm
#     scanner — overriding the make var skips that $(shell) entirely.
#   - WAYLAND_PROTOCOLS is pinned to the protocol-XML share dir for the same
#     reason (avoids the cross wayland-protocols.pc lookup).
#   - CFLAGS/LDLIBS are left as-is: `pkg-config --cflags/--libs wayland-client`
#     resolves the target wayland-client.pc (Requires: libffi → -lffi is pulled,
#     plus -lm -pthread), so the link gets libwayland-client.a + our raw libffi
#     backend + libm.
{ cross, wayland, wayland-protocols, libffi, src }:
cross.stdenv.mkDerivation {
  pname = "wl-eyes";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner # native code generator
    cross.buildPackages.pkg-config      # resolves the target wayland-client.pc
  ];
  buildInputs = [ wayland wayland-protocols libffi ];

  # The Makefile invokes bare `pkg-config`, but a cross build only ships the
  # TARGET-prefixed wrapper (wasm32-…-pkg-config) and exports its name as
  # $PKG_CONFIG. Route the Makefile's calls through $(PKG_CONFIG) (make imports
  # the env var) so the cross pkg-config is used.
  postPatch = ''
    substituteInPlace Makefile --replace-quiet 'pkg-config' '$(PKG_CONFIG)'
  '';

  makeFlags = [
    # wayland-scanner's executable is in its `bin` output, not `out`.
    "WAYLAND_SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner"
    "WAYLAND_PROTOCOLS=${wayland-protocols}/share/wayland-protocols"
  ];

  # Install as /bin/wl-eyes (no .wasm suffix) to match the other guest Wayland
  # binaries (wlhandshake, waylandproxyd) the initramfs bakes — the guest exec
  # path keys off the file's wasm magic, not the name.
  installPhase = ''
    runHook preInstall
    install -Dm755 wl-eyes $out/bin/wl-eyes
    runHook postInstall
  '';

  meta.description = "Wayland eyes client (wl_shm/xdg-shell), cross-built to wasm32";
}
