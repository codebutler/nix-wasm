# wl-anim — a minimal SELF-ANIMATING Wayland client (pure wl_shm + xdg-shell)
# cross-built to wasm32-nommu. Verifies the steady-state frame-callback render
# loop runs end-to-end on host self-wake alone (see userspace/wl-anim.c). Baked
# into the initramfs as /bin/wl-anim. Modeled on wl-eyes.nix + weston-flowers.nix
# (the latter for the native wayland-scanner xdg-shell codegen).
{ cross, wayland, wayland-protocols, libffi }:
cross.stdenv.mkDerivation {
  pname = "wl-anim";
  version = "0.1.0";

  dontUnpack = true;

  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner # native protocol code generator
    cross.buildPackages.pkg-config      # resolves the target wayland-client.pc
  ];
  buildInputs = [ wayland wayland-protocols libffi ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner
    WP=${wayland-protocols}/share/wayland-protocols

    mkdir -p gen
    "$SCANNER" client-header "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-client-protocol.h
    "$SCANNER" private-code  "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-protocol.c

    CFLAGS="$($PKG_CONFIG --cflags wayland-client) -I gen -O2"
    LDLIBS="$($PKG_CONFIG --libs wayland-client) -lffi -lm"

    echo "Compiling wl-anim (CC=$CC)..."
    $CC $CFLAGS ${./wl-anim.c} gen/xdg-shell-protocol.c $LDLIBS -o wl-anim

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 wl-anim $out/bin/wl-anim
    runHook postInstall
  '';

  meta.description = "Self-animating Wayland client (wl_shm/xdg-shell + frame callbacks), wasm32";
}
