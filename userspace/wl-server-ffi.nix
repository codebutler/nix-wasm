# .#wl-server-ffi — proves libwayland-SERVER's wl_closure_invoke dispatches
# through our raw wasm libffi backend (risk B de-risk for the Sommelier project).
#
# Client-side wl_closure_invoke→ffi_call is already proven (wlhandshake/wl-eyes).
# Server-side dispatch is new: when a client sends a request, libwayland-server
# demarshals it into a wl_closure and calls wl_closure_invoke → ffi_call with the
# server handler's signature. This binary proves that path works in-guest.
#
# The program creates an in-process wl_display + wl_client over a socketpair,
# defines a minimal "test_ffi" protocol with a single ping(int) request, sends
# ping(42) from the client side, and asserts the server handler received value=42.
#
# Protocol glue is generated with NATIVE wayland-scanner (the cross scanner can't
# execute on the build host) — same pattern as wl-anim.nix and wl-eyes.nix.
# Links: -lwayland-server -lwayland-client -lffi (our raw wasm FFI backend).
{ pkgs, cross }:
let
  wayland = cross.wayland;
  libffi = cross.libffi;
in
cross.stdenv.mkDerivation {
  pname = "wl-server-ffi-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  # wayland-scanner: native (host) binary to generate protocol glue from XML.
  # pkg-config: resolves the cross wayland-server.pc / wayland-client.pc.
  # wayland.dev: wayland-server.h + wayland-client.h + static .a libs.
  # libffi.dev: our raw wasm FFI backend headers + static libffi.a.
  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner
    cross.buildPackages.pkg-config
  ];
  buildInputs = [ wayland.dev libffi.dev ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner

    mkdir -p gen
    # Generate server-side and client-side protocol glue from the test XML.
    "$SCANNER" server-header  ${./test-ffi.xml} gen/test-ffi-server-protocol.h
    "$SCANNER" client-header  ${./test-ffi.xml} gen/test-ffi-client-protocol.h
    "$SCANNER" private-code   ${./test-ffi.xml} gen/test-ffi-protocol.c

    # pkg-config gives us the cross -I and -L for wayland-{server,client} and
    # transitively libffi (wayland-client.pc Requires: libffi).
    CFLAGS_SERVER="$($PKG_CONFIG --cflags wayland-server) -I gen -O2"
    CFLAGS_CLIENT="$($PKG_CONFIG --cflags wayland-client) -I gen -O2"
    LDLIBS="$($PKG_CONFIG --libs wayland-server) $($PKG_CONFIG --libs wayland-client) -lffi"

    echo "Compiling wl-server-ffi (CC=$CC)..."
    $CC $CFLAGS_SERVER $CFLAGS_CLIENT \
      ${./wl-server-ffi.c} gen/test-ffi-protocol.c \
      $LDLIBS -o wl-server-ffi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp wl-server-ffi $out/bin/wl-server-ffi
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
