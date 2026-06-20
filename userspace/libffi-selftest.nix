# libffi-selftest — in-guest unit test for the raw wasm FFI_WASM32 backend (M1).
# Links the cross libffi (raw backend) and asserts f32/f64/i64 by-value arg calls.
{ cross, libffi }:
cross.stdenv.mkDerivation {
  pname = "libffi-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ libffi ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags libffi) -O2"
    LDLIBS="$($PKG_CONFIG --libs libffi)"
    $CC $CFLAGS ${./libffi-selftest.c} $LDLIBS -o libffi-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 libffi-selftest $out/bin/libffi-selftest
    runHook postInstall
  '';
  meta.description = "Raw wasm FFI_WASM32 backend unit test (M1), wasm32";
}
