# Manual X11 urgency acceptance client. It requests WM_HINTS urgency itself;
# the XWM and host shell must propagate and clear the state.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "x11-attention-fixture";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ cross.libx11 ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 $($PKG_CONFIG --cflags x11) ${./x11-attention-fixture.c} \
      $($PKG_CONFIG --libs x11) -o x11-attention-fixture
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 x11-attention-fixture $out/bin/x11-attention-fixture
    runHook postInstall
  '';
  postFixup = ''rm -rf "$out/nix-support"'';
  meta.description = "X11 WM_HINTS urgency acceptance fixture";
}
