# The assembled wasm32 sysroot the cc-wrapper's --sysroot points at: musl's
# lib/ (crt*.o + libc.a + stubs) and include/, overlaid with the kernel UAPI
# headers (linux/*.h). compiler-rt (resource-dir) and libcxx are referenced by
# the cc-wrapper separately, so they are NOT folded in here.
{ pkgs, musl, kernelHeaders }:
pkgs.runCommand "wasm32-sysroot" { } ''
  mkdir -p $out/lib $out/include
  cp -a ${musl}/lib/. $out/lib/
  cp -a ${musl}/include/. $out/include/
  chmod -R u+w $out/include
  cp -a ${kernelHeaders}/include/. $out/include/
''
