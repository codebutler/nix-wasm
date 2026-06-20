# wl-input-probe — M0 input spike. Binds wl_seat/pointer/keyboard and logs input
# events. Manual proof (run in the browser demo against Greenfield). Mirrors
# wl-anim.nix. Diagnostic only — kept as a fixture, not a production client.
{ cross, wayland, wayland-protocols, libffi }:
cross.stdenv.mkDerivation {
  pname = "wl-input-probe";
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

    $CC $CFLAGS ${./wl-input-probe.c} gen/xdg-shell-protocol.c $LDLIBS -o wl-input-probe

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 wl-input-probe $out/bin/wl-input-probe
    runHook postInstall
  '';

  meta.description = "wl_seat input probe (M0 spike), wasm32";
}
