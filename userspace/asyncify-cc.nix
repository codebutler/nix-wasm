# Host-side asyncify build path for fork-capable guest binaries (Phase 2 Task 1a).
#
# Reusable builder: cross-compile a C source with the SAME cc-wrapper that builds
# the rest of guest userspace (cross.stdenv.cc — what builds isoa.c/busybox), then
# run a host `wasm-opt --asyncify` pass allow-listed to the fork call graph.
#
# Why host-side: `guest-cc` is the IN-guest driver and there is no in-guest
# wasm-opt; asyncify must instrument the user's own fork-reachable frames (Task-0
# proved user frames get rewound), and the caching design goal is "host builds,
# guest substitutes". In-guest asyncify (cross-built binaryen) is Task 1b.
#
# The unwind point is a DEDICATED `capture_stack()` host import (Task-0 finding B),
# NOT the generic __wasm_syscall_N wrapper — so the clone-with-fn fast path stays
# asyncify-free. `asyncify-onlylist` bounds which functions get instrumented (cost).
# muslFork (Phase 2): the musl-fork variant (canonical musl + patch 0008). Its
# libc.a is linked FIRST so the seam `_Fork` (capture_stack) overrides the
# canonical clone-syscall `_Fork`; everything else in the archive is byte-identical
# to the sysroot's musl, so no ODR risk. `forkSeam = false` skips it (freestanding
# probes like fork-smoke that call capture_stack directly need no libc override).
{ pkgs, cross, muslFork, busyboxKernelHeaders, binaryen ? pkgs.binaryen }:

# src       : the C source file
# name      : output basename (lands at $out/bin/<name>)
# onlylist  : optional comma-separated allow-list = (reachable ∩ list). Bounds
#             instrumentation to functions asyncify ALREADY found reachable to the
#             unwind import. USELESS for a PIC fork program: the call to the
#             capture_stack IMPORT goes through the GOT (indirect), so asyncify's
#             reachability finds NO caller and the intersection is empty.
# addlist   : optional comma-separated list = (reachable ∪ list) — FORCE-instrument
#             these regardless of reachability. This is what a PIC fork program
#             needs: list every frame from the host entry (_start) down to _Fork
#             (the GOT-indirect caller of capture_stack), so the unwind propagates.
# cflags    : extra compile/link flags (e.g. "-nostdlib" for freestanding probes).
# forkSeam  : link muslFork's libc.a first so fork() uses the capture_stack seam.
{ src, name, onlylist ? null, addlist ? null, cflags ? "", forkSeam ? false }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
  onlyArg =
    if onlylist != null then "--pass-arg=asyncify-onlylist@${onlylist}"
    else if addlist != null then "--pass-arg=asyncify-addlist@${addlist}"
    else "";
  # Prepend the seam libc.a so its _Fork.o is pulled before the sysroot's -lc.
  forkLib = if forkSeam then "${muslFork}/lib/libc.a" else "";
in
cross.stdenv.mkDerivation {
  pname = name;
  version = "0.1";
  dontUnpack = true;
  nativeBuildInputs = [ binaryen ];

  buildPhase = ''
    runHook preBuild
    # 1) cross-compile + link the guest dylink module; capture_stack stays an
    #    undefined import (host-provided at runtime, like the syscall imports).
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} -Wl,--import-undefined ${cflags} \
      ${src} ${forkLib} -o ${name}.pre.wasm
    # 2) asyncify: the unwind trigger is env.capture_stack. BOUND the instrumented
    #    set with an onlylist (the fork call graph) — do NOT instrument the whole
    #    module: instrumenting every function rewrites musl stdio's indirect call
    #    sites and breaks the -shared dylink table (call_indirect signature
    #    mismatch). The onlylist MUST include __libc_start_main (it calls main via
    #    a function POINTER, so the unwind from fork() propagates back to the host
    #    entry only if that indirect call site is asyncify-handled — hence NO
    #    asyncify-ignore-indirect, which would stop the unwind at that call).
    wasm-opt ${name}.pre.wasm --asyncify \
      --pass-arg=asyncify-imports@env.capture_stack ${onlyArg} \
      -o ${name}.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp ${name}.wasm $out/bin/${name}
    # wasm-opt emits 0644; the guest binfmt loader needs the +x bit (EACCES else).
    chmod +x $out/bin/${name}
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
