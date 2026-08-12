# x11-probe — M-X1's probe (XChat/X11 epic). The smallest possible real X11
# client: libxcb only (no Xlib, no toolkit), connects to $DISPLAY, reads the
# connection setup reply, and prints vendor + first-screen dimensions. This
# is the client/server wire-protocol proof against our cross-built Xvfb
# (M-X1) — see x11-probe.c for the exact PASS/FAIL line format. (M-X2 proper
# — xeyes + xwd against a real running Xvfb — is still open.)
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
  # x11-probe is a leaf binary (nothing builds against it) — its
  # nix-support/propagated-build-inputs metadata (libxcb-dev, ~7.4MB) is
  # pure served-closure bloat, same lesson as galculator's (CLAUDE.md).
  # nix-support is written during fixupPhase, so this must be postFixup, not
  # postInstall (postInstall runs too early to catch it).
  postFixup = ''
    rm -rf $out/nix-support
  '';
  meta.description = "Minimal libxcb X11 client proof against cross-built Xvfb (M-X1), wasm32";
}
