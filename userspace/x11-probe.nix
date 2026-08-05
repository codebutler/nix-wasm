# x11-probe — M-X2 (XChat/X11 epic). The smallest possible real X11 client:
# libxcb only (no Xlib, no toolkit), connects to $DISPLAY, reads the
# connection setup reply, and prints vendor + first-screen dimensions. This
# is the client/server wire-protocol proof against our cross-built Xvfb
# (M-X1) — see x11-probe.c for the exact PASS/FAIL line format.
{ cross, libxcb ? cross.libxcb }:
cross.stdenv.mkDerivation {
  pname = "x11-probe";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ libxcb ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags xcb) -O2"
    LDLIBS="$($PKG_CONFIG --libs xcb)"
    $CC $CFLAGS ${./x11-probe.c} $LDLIBS -o x11-probe
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 x11-probe $out/bin/x11-probe
    runHook postInstall
  '';
  meta.description = "Minimal libxcb X11 client proof against cross-built Xvfb (M-X2), wasm32";
}
