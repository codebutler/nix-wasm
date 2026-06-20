// asyncify.js — host-side asyncify double-return orchestration for Phase-2
// fork(). The shared module the worker fork path (kernel-worker.js) builds on;
// extracted verbatim-in-spirit from the Task-0 spike (spikes/asyncify-fork/),
// which proved the mechanism end-to-end through real clang -O2 codegen.
//
// Mechanism (see docs/superpowers/specs/2026-06-20-fork-host-abi-v3.md):
// a fork-capable user module is built with `wasm-opt --asyncify
// --pass-arg=asyncify-imports@env.capture_stack`. Its fork() calls the host
// import capture_stack(ctl_ptr); the host unwinds the instance's call stack into
// a buffer in the instance's OWN linear memory, returns to the run-loop,
// verbatim-copies that memory into a child instance, then REWINDS BOTH so the
// single capture_stack() call returns twice — child pid in the parent, 0 in the
// child. The resume lands exactly at the fork() call site (spec risk B3, proven).

// asyncify_get_state() return values (Binaryen ABI).
export const ASYNCIFY_STATE = Object.freeze({ NORMAL: 0, UNWINDING: 1, REWINDING: 2 });

// makeCaptureStack(getInstance, getForkResult) -> the `capture_stack` host
// import function (env.capture_stack on the user instance).
//
//   getInstance()   -> the user WebAssembly.Instance. Late-bound (a thunk)
//                      because the import object is assembled BEFORE the instance
//                      exists; the closure resolves it lazily at call time.
//   getForkResult() -> the value capture_stack returns on the REWIND side: the
//                      child pid in the parent worker, 0 in the child worker.
//                      Read lazily so the orchestrator can set it AFTER the
//                      unwind completes and BEFORE it starts the rewind.
//
// The returned function records the control-buffer pointer the user passed in
// `.ctlPtr` (the orchestrator needs it to drive asyncify_start_rewind). State
// machine mirrors the spike's do_fork exactly:
//   NORMAL  (the fork() call): record ctl_ptr, asyncify_start_unwind(ctl_ptr),
//           return 0 (discarded by the unwind).
//   REWINDING (re-entry during rewind): asyncify_stop_rewind(), return the
//           fork result (the second of the double-return).
export function makeCaptureStack(getInstance, getForkResult) {
  const fn = (ctlPtr) => {
    const inst = getInstance();
    if (inst.exports.asyncify_get_state() === ASYNCIFY_STATE.REWINDING) {
      inst.exports.asyncify_stop_rewind();
      return getForkResult();
    }
    fn.ctlPtr = ctlPtr >>> 0;
    inst.exports.asyncify_start_unwind(fn.ctlPtr);
    return 0;
  };
  fn.ctlPtr = 0;
  return fn;
}

// True iff `instance` is parked mid-unwind — i.e. its entry export (_start /
// __libc_clone_callback) just RETURNED because a fork() unwound it, not because
// the program exited. The run-loop checks this after every entry call; an
// asyncify-free (fast-path) instance has no asyncify_get_state export, so this
// is false and the legacy "_start returned" guard applies unchanged.
export function isPendingUnwind(instance) {
  const st = instance.exports.asyncify_get_state;
  return typeof st === "function" && st() === ASYNCIFY_STATE.UNWINDING;
}

// Finish the unwind: state UNWINDING -> NORMAL, leaving the captured stack image
// in linear memory (cur at the top of the written image — symmetric input for
// the rewind, which reads it back down; do NOT reset cur between the two).
export function stopUnwind(instance) {
  instance.exports.asyncify_stop_unwind();
}

// Arm a rewind from the control buffer at `ctlPtr`. The caller then RE-ENTERS the
// same entry export (_start / __libc_clone_callback); asyncify fast-forwards to
// the captured fork() call site, where capture_stack (REWINDING) returns the
// fork result. The image at ctlPtr must already be the one to resume — in the
// child that means the verbatim copy from the parent has already happened.
export function startRewind(instance, ctlPtr) {
  instance.exports.asyncify_start_rewind(ctlPtr >>> 0);
}

// Verbatim-duplicate a parent address space into a child's. FINDING A
// (mandatory): the child WebAssembly.Instance must ALREADY exist when this runs
// — a fresh Instance re-applies the module's active data segments to its memory,
// which would clobber a pre-copied .bss/.data. So: instantiate child, THEN call
// this. Copies the WHOLE parent buffer (including the asyncify control buffer +
// stack image, which live in BSS) so the child rewinds the identical image.
// Requires child capacity >= parent size (the dup mints the child at the
// parent's current page count; equal is the normal case).
export function dupAddressSpace(parentMemory, childMemory) {
  const src = new Uint8Array(parentMemory.buffer);
  const dst = new Uint8Array(childMemory.buffer);
  if (dst.length < src.length) {
    throw new Error(
      `dupAddressSpace: child memory (${dst.length}B) smaller than parent (${src.length}B)`,
    );
  }
  dst.set(src);
}
