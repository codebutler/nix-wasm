# Compiler facade used by the native wasm32 stdenv (#173). The actual compiler
# and LLVM object tools are cross-built guest executables from guestClang. This
# small host-built output only supplies conventional names and the setup hook a
# nixpkgs stdenv expects from its `cc` input.
{
  pkgs,
  guestClang,
  seedBash,
  ccSysroot,
}:
let
  drv = pkgs.runCommand "wasm-native-bootstrap-cc" { } ''
    mkdir -p $out/bin $out/nix-support

    # Keep the compiler wrappers intentionally small. clang.cfg/clang++.cfg next
    # to guest clang carry the target/sysroot/link ABI; these wrappers add the
    # dependency flags accumulated by the setup hook below.
    for lang in cc c++; do
      driver=clang
      [ "$lang" = c++ ] && driver=clang++
      cat > "$out/bin/$lang" <<EOF
#!${seedBash}/bin/bash
compileFlags=( \''${NIX_CFLAGS_COMPILE:-} )
linkFlags=( \''${NIX_LDFLAGS:-} )
exec ${guestClang}/bin/$driver "\''${compileFlags[@]}" "\$@" "\''${linkFlags[@]}"
EOF
      chmod +x "$out/bin/$lang"
    done

    for tool in clang clang++ wasm-ld llvm-ar llvm-ranlib llvm-nm \
                llvm-objcopy llvm-strip ar ranlib nm objcopy strip; do
      ln -s ${guestClang}/bin/$tool $out/bin/$tool
    done
    ln -s wasm-ld $out/bin/ld

    cat > $out/nix-support/setup-hook <<'EOF'
wasmNativeCCAddCVars() {
  local role_post
  getHostRoleEnvHook
  if [ -d "$1/include" ]; then
    export NIX_CFLAGS_COMPILE''${role_post}+=" -isystem $1/include"
  fi
  if [ -d "$1/lib" ]; then
    export NIX_LDFLAGS''${role_post}+=" -L$1/lib"
  fi
}

getTargetRole
getTargetRoleWrapper
addEnvHooks "$targetOffset" wasmNativeCCAddCVars
export NIX_CC''${role_post}=@out@
export CC''${role_post}=cc
export CXX''${role_post}=c++
unset -v role_post
EOF
    substituteInPlace $out/nix-support/setup-hook --replace-fail @out@ "$out"
  '';
in
drv
// rec {
  isClang = true;
  isGNU = false;
  inherit (guestClang) version;
  targetPrefix = "";
  cc = guestClang;
  libc = ccSysroot;
  bintools = drv // {
    inherit targetPrefix;
    isLLVM = true;
    inherit (guestClang) version;
    bintools = guestClang;
  };
}
