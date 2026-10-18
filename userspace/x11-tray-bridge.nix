# Generic XEmbed notification area for the guest's standing Xwayland server.
# Icons are forwarded to pc over AF_VSOCK 1026, including pixel updates and
# button events. The daemon is a profile package, started by init.nix after
# activation; it does not depend on an individual X11 application.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "x11-tray-bridge";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ cross.libx11 cross.libxrender ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 $($PKG_CONFIG --cflags x11 xrender) ${./x11-tray-bridge.c} \
      $($PKG_CONFIG --libs x11 xrender) -o x11-tray-bridge
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 x11-tray-bridge $out/bin/x11-tray-bridge
    runHook postInstall
  '';
  postFixup = ''rm -rf "$out/nix-support"'';
  meta.description = "XEmbed tray bridge for the guest Xwayland session";
}
