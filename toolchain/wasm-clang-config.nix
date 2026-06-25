# clang.cfg / clang++.cfg — the SINGLE SOURCE OF TRUTH for the guest's
# compile + link flags (#3). clang auto-loads a config named after the driver
# (`clang.cfg` / `clang++.cfg`) from the directory holding the clang binary, so
# installing these next to guest-clang's `clang`/`clang++` makes the bare driver
# a complete wasm32-NOMMU compiler: `clang hello.c -o hello` compiles AND
# in-process-links (clang spawns wasm-ld via posix_spawn — patches/llvm/0001) with
# no wrapper on PATH.
#
# Why this replaces the old `cc`/`c++` SHELL wrappers (toolchain/guest-{cc,cxx}.nix):
# clang's stock wasm driver ALREADY knows the sysroot layout — given --sysroot +
# -resource-dir it emits exactly the link the wrappers hand-rolled (crt1.o, the
# -L search paths, -lc, the builtins.a). The wrappers existed only to add the
# flags the bare driver doesn't default for our target: the wasm target features,
# the dylink/shared-memory link model, and (C++) the libc++ headers/EH/link. Those
# are precisely what a config file injects — so the flag vocabulary that used to be
# duplicated across guest-cc, guest-cxx, make.nix and nix-wasm.nix collapses here.
#
# `sr` is the cc-sysroot store dir ($ccSysroot/sys) with {musl,clang,cxx}; the
# config references it by absolute store path (served read-only over 9P in the
# /nix closure), exactly as the wrappers did. `allowUndefined` is the shared
# no-undef allow-list (toolchain/wasm-host-imports.nix, #52) — the link uses
# --allow-undefined-file so a stray fork/exec fails the link, not silently
# becomes a dangling env.* import.
{ pkgs, ccSysroot, allowUndefined }:
let
  sr = "${ccSysroot}/sys";

  # Flags shared by C and C++ compile + the dylink link. clang's wasm driver
  # adds crt1.o / -L / -lc / builtins from --sysroot + -resource-dir; we add the
  # target features, the macros, and the dylink link model. --export-all roots
  # every named symbol (the host bridge looks them up by name); --gc-sections
  # then drops crt1.o's dead weak-`main` forwarder (else its __main_argc_argv
  # reference dangles into an env import for `int main(void)` — the documented
  # guest-cc startup-SIGILL fix). --allow-undefined-file enforces the #52 contract.
  commonCfg = ''
    --target=wasm32-unknown-unknown
    -fPIC
    --sysroot=${sr}/musl
    -resource-dir=${sr}/clang
    -D__linux__
    -D_GNU_SOURCE
    -matomics
    -mbulk-memory
    -Wl,-shared
    -Wl,-Bsymbolic
    -Wl,--no-entry
    -Wl,--export-all
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=4294967296
    -Wl,--import-table
    -Wl,--no-merge-data-segments
    -Wl,--gc-sections
    -Wl,--allow-undefined-file=${allowUndefined}
  '';

  # C++ adds, over C: the libc++ headers (-nostdinc++ -isystem .../c++/v1), wasm
  # exception handling (-fwasm-exceptions — the model libc++ was built with), the
  # libc++ visibility-annotation disables (match the hermetic/hidden libcxx
  # build), and the libc++/libc++abi/libunwind link (unwind shim folded into
  # libc++abi). -D__linux__ (already in commonCfg) is what lets libc++'s __config
  # select the pthread thread API on the -unknown triple ("No thread API"
  # otherwise). The link libs are added as -Wl, so they ride the same wasm-ld
  # invocation, BEFORE -lc (which clang's driver appends).
  cxxCfg = ''
    -nostdinc++
    -isystem ${sr}/cxx/include/c++/v1
    -fwasm-exceptions
    -D__USING_WASM_EXCEPTIONS__
    -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS
    -D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS
    -L${sr}/cxx/lib
    -Wl,-lc++
    -Wl,-lc++abi
    -Wl,-lunwind
  '';
in
pkgs.runCommand "wasm-clang-config" { } ''
  mkdir -p $out
  cat > $out/clang.cfg <<'EOF'
  ${commonCfg}
  EOF
  cat > $out/clang++.cfg <<'EOF'
  ${commonCfg}
  ${cxxCfg}
  EOF
''
