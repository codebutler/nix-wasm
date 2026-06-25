# The in-guest `c++` driver — now a thin alias over guest clang++ (#3), the C++
# companion to guest-cc.nix. guest-clang.nix installs a `clang++` entrypoint
# (clang dispatches C++ mode on the `++` in argv[0]) plus the auto-loaded
# clang++.cfg, which adds — over clang.cfg — the libc++ headers, wasm exception
# handling, and the libc++/libc++abi/libunwind link. So `clang++ foo.cpp -o foo`
# is a complete C++ driver and this `c++` simply execs it. The flag vocabulary
# that used to be hand-rolled here lives ONCE in toolchain/wasm-clang-config.nix.
#
# Kept as the `guest-cxx` package (its pname feeds the install catalog —
# `nix-env -iA guest-cxx`, codebutler/nix-wasm#48). `c++ foo.cpp -o foo && ./foo`
# works as before (std::string/vector/exceptions/iostream), and bare `clang++ …`
# now works too.
{ pkgs, guestClang, ccSysroot }:
# ccSysroot unused directly (the auto-loaded clang++.cfg references it); kept for a
# uniform flake signature.
pkgs.writeTextFile {
  name = "guest-cxx";
  destination = "/bin/c++";
  executable = true;
  text = ''
    #!/bin/sh
    # c++ — the C++ driver for the wasm32-linux NOMMU guest. A thin alias over the
    # self-configuring guest clang++ (#3); all flags live in the auto-loaded
    # clang++.cfg next to ${guestClang}/bin/clang++.
    exec ${guestClang}/bin/clang++ "$@"
  '';
}
