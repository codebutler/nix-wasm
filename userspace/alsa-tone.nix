# alsa-tone — in-guest ALSA playback test for the virtio-snd sound card
# (issue #145). Statically links cross alsa-lib and plays a deterministic
# 440Hz sine through the real snd_pcm_open/set_params/writei/drain path; the
# host-side smoke (runtime/demo/node/snd-smoke.mjs) asserts the device model
# received the exact samples. Baked into the initramfs via `extraBins`
# (+ alsa-lib's share/alsa config via `extraShare`). See userspace/alsa-tone.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "alsa-tone";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildInputs = [ cross.alsa-lib ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./alsa-tone.c} -o alsa-tone -lasound -lm
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 alsa-tone $out/bin/alsa-tone
    runHook postInstall
  '';
  meta.description = "ALSA 440Hz test tone for the virtio-snd sound card, wasm32";
}
