# exec-reject-test — the #179 hardening fixture: a guest binary the HOST cannot
# run, used to prove that an unsupported image kills only the execing task instead
# of panicking the guest kernel.
#
# THE BUG: when the software-MMU instrumentation pass refuses an image (the #179
# case: a binary that exports no `__get_tls_base`, which the pass needs for the
# fault syscall's `tp` operand), `wasm_load_executable` threw. The throw escaped
# into the kernel's own wasm frames and only landed later — with no kernel context
# — in `raise_exception()` -> `make_task_dead()`, which panics the whole guest:
# "Aiee, killing interrupt handler!". ONE bad user binary took down the system.
#
# THE FIXTURE: build a perfectly ordinary guest program, then DELETE the
# `__get_tls_base` export from its export section. The result still passes
# binfmt_wasm's early checks (wasm magic, version, a leading `dylink.0` section),
# so the kernel commits to the exec — and then the host must refuse it. That is
# precisely the shape of the failure, on a real program rather than a synthetic
# module. It has to be manufactured this way because the toolchain now FORCES
# those exports into every link (toolchain/wasm-host-exports.nix `forcedNames`),
# so no compiler invocation can produce one any more.
#
# Ships as an initramfs extraBin so the busybox-only boot smoke can exec it with
# no /nix closure: `exec-reject-test` in the guest. The GOOD twin is installed
# alongside it, so the smoke can prove the difference is exactly the one export —
# `exec-ok-test` must run to completion on the same boot.
{ pkgs, cross }:
cross.stdenv.mkDerivation {
  pname = "exec-reject-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  nativeBuildInputs = [ pkgs.buildPackages.python3 ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./exec-reject-test.c} -o exec-ok-test
    # Sanity: the toolchain must have produced a CONFORMING binary — if this ever
    # fails, the forced-export contract regressed and #179 is back (in which case
    # the fixture below would be a no-op copy and the smoke would pass vacuously).
    python3 ${../scripts/wasm-check-exports.py} exec-ok-test \
      _start __wasm_call_ctors __wasm_early_tp_init __get_tls_base __set_tls_base
    # Now the fixture: the same program minus the one export the host requires.
    # wasm-strip-export.py exits non-zero if the symbol was not there to remove.
    python3 ${../scripts/wasm-strip-export.py} exec-ok-test exec-reject-test \
      __get_tls_base
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 exec-ok-test     $out/bin/exec-ok-test
    install -Dm755 exec-reject-test $out/bin/exec-reject-test
    runHook postInstall
  '';
  meta.description = "#179: an unsupported guest image (a required export removed) + its conforming twin, wasm32";
}
