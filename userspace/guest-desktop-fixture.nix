# Manual zero-X11 acceptance publisher for SNI and desktop notifications.
{ cross, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "guest-desktop-fixture";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ cross.glib ];
  buildPhase = ''
    runHook preBuild
    $CC -std=gnu11 -O2 $($PKG_CONFIG --cflags gio-2.0) \
      ${./guest-desktop-fixture.c} $($PKG_CONFIG --libs gio-2.0) \
      -o guest-desktop-fixture.pre
    ${fpcast.shellFn}
    fpcast_emu guest-desktop-fixture.pre guest-desktop-fixture
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 guest-desktop-fixture $out/bin/guest-desktop-fixture
    runHook postInstall
  '';
  postFixup = ''rm -rf "$out/nix-support"'';
  meta.description = "Manual guest SNI and notification acceptance fixture";
}
