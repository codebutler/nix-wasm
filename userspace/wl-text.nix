# wl-text — M2 text-stack proof client. fontconfig→freetype→harfbuzz→cairo-ft.
# --selftest renders headlessly + asserts on stdout (CI gate); default renders into
# a wl_shm window (visual check). Mirrors weston-flowers.nix / wl-anim.nix.
{ cross, cairo, fontconfig, harfbuzz, freetype, pixman, zlib
, wayland, wayland-protocols, libffi }:
cross.stdenv.mkDerivation {
  pname = "wl-text";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner
    cross.buildPackages.pkg-config
  ];
  buildInputs = [ cairo fontconfig harfbuzz freetype pixman zlib wayland wayland-protocols libffi ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner
    WP=${wayland-protocols}/share/wayland-protocols
    mkdir -p gen
    "$SCANNER" client-header "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-client-protocol.h
    "$SCANNER" private-code  "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-protocol.c
    CFLAGS="$($PKG_CONFIG --cflags cairo fontconfig harfbuzz freetype2) $($PKG_CONFIG --cflags wayland-client) -I gen -O2"
    LDLIBS="$($PKG_CONFIG --libs cairo fontconfig harfbuzz freetype2) $($PKG_CONFIG --libs wayland-client) -lffi -lm"
    $CC $CFLAGS ${./wl-text.c} gen/xdg-shell-protocol.c $LDLIBS -o wl-text
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 wl-text $out/bin/wl-text
    runHook postInstall
  '';
  meta.description = "Text-stack proof: harfbuzz+cairo-ft into wl_shm (M2), wasm32";
}
