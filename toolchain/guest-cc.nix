# The in-guest `cc` driver — now a thin alias over guest clang (#3). clang is its
# own driver for the wasm32-NOMMU target: guest-clang.nix installs clang.cfg next
# to the `clang` binary, so `clang foo.c -o foo` carries the full compile + dylink
# link flags (sysroot, target features, the dylink/shared-memory link model, the
# #52 --allow-undefined-file contract) and in-process-links via wasm-ld +
# posix_spawn. This `cc` simply execs that clang — the flag vocabulary that used to
# be hand-rolled here (and duplicated across guest-cxx/make.nix/nix-wasm.nix) now
# lives ONCE in toolchain/wasm-clang-config.nix.
#
# Kept as the `guest-cc` package (its pname feeds the generated install catalog —
# `nix-env -iA guest-cc`, codebutler/nix-wasm#48) so the in-guest UX is unchanged;
# `cc hello.c -o hello && ./hello` works exactly as before, and bare `clang
# hello.c` now works too (the point of #3).
{ pkgs, guestClang, ccSysroot }:
# ccSysroot is unused directly here (the config the guest clang auto-loads already
# references it); kept in the signature so the flake wiring is uniform and a future
# sysroot-specific override has the handle.
pkgs.writeTextFile {
  name = "guest-cc";
  destination = "/bin/cc";
  executable = true;
  text = ''
    #!/bin/sh
    # cc — the C driver for the wasm32-linux NOMMU guest. A thin alias over the
    # self-configuring guest clang (#3); all flags live in the auto-loaded
    # clang.cfg next to ${guestClang}/bin/clang.
    exec ${guestClang}/bin/clang "$@"
  '';
}
