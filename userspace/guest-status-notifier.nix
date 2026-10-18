# Guest SNI watcher and host projection. The process speaks D-Bus only inside
# the guest and sends bounded item snapshots/actions over AF_VSOCK 1026.
{ cross, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "guest-status-notifier";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ cross.glib cross.gdk-pixbuf ];
  buildPhase = ''
    runHook preBuild
    $CC -std=gnu11 -O2 $($PKG_CONFIG --cflags gio-2.0 gdk-pixbuf-2.0) \
      ${./guest-status-notifier.c} $($PKG_CONFIG --libs gio-2.0 gdk-pixbuf-2.0) \
      -o guest-status-notifier.pre
    ${fpcast.shellFn}
    fpcast_emu guest-status-notifier.pre guest-status-notifier
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 guest-status-notifier $out/bin/guest-status-notifier
    runHook postInstall
  '';
  postFixup = ''rm -rf "$out/nix-support"'';
  meta.description = "Guest SNI watcher with Yore tray projection";
}
