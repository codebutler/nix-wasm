# fpcast-vtable-test — diagnostic: does --fpcast-emu dispatch rodata (static const)
# function pointers correctly? See fpcast-vtable-test.c for the full rationale.
# Built through the SAME fpcast seam gtk-hello/pango use, statically linked so it
# runs from the initramfs (no /nix needed). Run in guest: `fpcast-vtable-test`.
{ cross, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "fpcast-vtable-test";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ fpcast.binaryen ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    $CC -O2 ${./fpcast-vtable-test.c} -o fpcast-vtable-test.pre
    fpcast_emu fpcast-vtable-test.pre fpcast-vtable-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 fpcast-vtable-test $out/bin/fpcast-vtable-test
    runHook postInstall
  '';
  meta.description = "fpcast-emu rodata-vtable dispatch diagnostic, wasm32";
}
