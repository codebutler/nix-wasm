# dltest — in-guest acceptance for the wasm dlopen/dlsym port (#126 Track C /
# #130). Builds FOUR artifacts:
#   $out/bin/dltest             — plain main program (raw-signature dl path)
#   $out/bin/dltest-fpcast      — dynsym-injected + fpcast'd main program
#                                 (the canonical-thunk dl path GTK apps use)
#   $out/share/dltest/side.so         — plain side module
#   $out/share/dltest/side-fpcast.so  — dynsym-injected + fpcast'd side module
# Each main opens its matching side module (baked via -DSIDE_PATH): fpcast'd
# call sites need fpcast'd (thunked) side-module elem entries — the two ABIs
# must not mix within a process (dynsym.nix header).
#
# Side-module link: $CC with -nostartfiles -Wl,--no-entry — still the
# cc-wrapper's dylink link (-shared --export-all + allow-list), minus crt1's
# _start. The module is self-contained (see dltest-side.c) so the allow-list
# is satisfied.
{ cross, fpcast ? import ./fpcast-emu.nix { inherit cross; }, dynsym ? import ./dynsym.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "dltest";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ fpcast.binaryen dynsym.python3 ];
  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    ${dynsym.shellFn}

    # side modules
    $CC -O2 -nostartfiles -Wl,--no-entry ${./dltest-side.c} -o side.so
    dynsym_inject side.so side.mid.so
    fpcast_emu side.mid.so side-fpcast.so

    # main programs (SIDE_PATH points at the installed matching side module)
    $CC -O2 -DSIDE_PATH="\"$out/share/dltest/side.so\"" ${./dltest.c} -o dltest
    $CC -O2 -DSIDE_PATH="\"$out/share/dltest/side-fpcast.so\"" ${./dltest.c} -o dltest-fpcast.pre
    dynsym_inject dltest-fpcast.pre dltest-fpcast.mid
    fpcast_emu dltest-fpcast.mid dltest-fpcast
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dltest $out/bin/dltest
    install -Dm755 dltest-fpcast $out/bin/dltest-fpcast
    install -Dm644 side.so $out/share/dltest/side.so
    install -Dm644 side-fpcast.so $out/share/dltest/side-fpcast.so
    runHook postInstall
  '';
  meta.description = "wasm dlopen/dlsym acceptance (raw + fpcast canonical-thunk paths), #130";
}
