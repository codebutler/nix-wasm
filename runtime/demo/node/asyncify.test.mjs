// Phase-2 Task 4a — unit coverage for the shipped asyncify orchestration helpers
// (runtime/asyncify.js). The Task-0 spike (spikes/asyncify-fork/) already proves
// the mechanism against REAL clang -O2 codegen; this asserts the extracted,
// shipped helpers reproduce that exact protocol (state machine + ctl-ptr capture
// + verbatim dup), driven by a scripted mock instance — no wasm artifact needed,
// so it runs in every CI without a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASYNCIFY_STATE,
  makeCaptureStack,
  isPendingUnwind,
  stopUnwind,
  startRewind,
  dupAddressSpace,
} from "../../asyncify.js";

// A mock that faithfully models Binaryen's asyncify state transitions: the only
// thing capture_stack / the orchestrator can observe is asyncify_get_state() and
// the start/stop unwind/rewind calls. Records the pointers it was handed.
function mockInstance() {
  let state = ASYNCIFY_STATE.NORMAL;
  const calls = { unwindPtr: null, rewindPtr: null, stopUnwind: 0, stopRewind: 0 };
  return {
    calls,
    exports: {
      asyncify_get_state: () => state,
      asyncify_start_unwind: (ptr) => {
        calls.unwindPtr = ptr;
        state = ASYNCIFY_STATE.UNWINDING;
      },
      asyncify_stop_unwind: () => {
        calls.stopUnwind++;
        state = ASYNCIFY_STATE.NORMAL;
      },
      asyncify_start_rewind: (ptr) => {
        calls.rewindPtr = ptr;
        state = ASYNCIFY_STATE.REWINDING;
      },
      asyncify_stop_rewind: () => {
        calls.stopRewind++;
        state = ASYNCIFY_STATE.NORMAL;
      },
    },
  };
}

test("makeCaptureStack: NORMAL call triggers unwind, records ctlPtr, returns 0", () => {
  const inst = mockInstance();
  const capture = makeCaptureStack(
    () => inst,
    () => 99,
  );
  const ret = capture(0x18000);
  assert.equal(ret, 0, "the unwind-triggering call returns 0 (discarded by the unwind)");
  assert.equal(capture.ctlPtr, 0x18000, "ctlPtr recorded for the later rewind");
  assert.equal(inst.calls.unwindPtr, 0x18000, "start_unwind got the ctl pointer");
  assert.ok(isPendingUnwind(inst), "instance is parked mid-unwind");
});

test("makeCaptureStack: REWINDING re-entry stops rewind and returns the fork result", () => {
  const inst = mockInstance();
  let forkResult = 0;
  const capture = makeCaptureStack(
    () => inst,
    () => forkResult,
  );
  capture(0x18000); // unwind
  stopUnwind(inst);
  forkResult = 4242; // orchestrator sets the parent's return AFTER the unwind
  startRewind(inst, capture.ctlPtr);
  const ret = capture(0x18000); // re-entry during rewind
  assert.equal(ret, 4242, "capture_stack returns the fork result on the rewind side");
  assert.equal(inst.calls.stopRewind, 1, "stop_rewind called exactly once");
  assert.equal(inst.exports.asyncify_get_state(), ASYNCIFY_STATE.NORMAL);
});

test("full double-return cycle through the helpers (parent + child)", () => {
  // Parent side: fork() returns the child pid.
  const parent = mockInstance();
  let parentRet = 0;
  const pcap = makeCaptureStack(
    () => parent,
    () => parentRet,
  );
  assert.equal(pcap(0x18000), 0);
  assert.ok(isPendingUnwind(parent));
  stopUnwind(parent);
  parentRet = 7; // the child pid
  startRewind(parent, pcap.ctlPtr);
  assert.equal(pcap(0x18000), 7, "parent fork() returns child pid");

  // Child side: a distinct instance, fork() returns 0.
  const child = mockInstance();
  const ccap = makeCaptureStack(
    () => child,
    () => 0,
  );
  // The child never runs the NORMAL/unwind pass — it is BORN mid-rewind from the
  // copied image, so the orchestrator arms the rewind directly.
  startRewind(child, 0x18000);
  assert.equal(ccap(0x18000), 0, "child fork() returns 0");
  assert.equal(parent.calls.unwindPtr, 0x18000);
  assert.equal(child.calls.unwindPtr, null, "child never unwinds — it rewinds a copied image");
});

test("isPendingUnwind is false for a fast-path (non-asyncify) instance", () => {
  // The clone-with-fn fast path pays no asyncify cost: its module has no
  // asyncify_get_state export, so the run-loop's pending-fork check is a no-op
  // and the legacy "_start returned" guard applies unchanged.
  const fastPath = { exports: { _start: () => {} } };
  assert.equal(isPendingUnwind(fastPath), false);
});

test("dupAddressSpace verbatim-copies the parent buffer into the child", () => {
  const parent = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const child = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const pv = new Uint8Array(parent.buffer);
  pv[0] = 0xab;
  pv[0x1f000] = 0xcd; // a byte deep in the (shared) buffer, e.g. the asyncify image
  pv[pv.length - 1] = 0xef;

  dupAddressSpace(parent, child);

  const cv = new Uint8Array(child.buffer);
  assert.equal(cv[0], 0xab);
  assert.equal(cv[0x1f000], 0xcd);
  assert.equal(cv[cv.length - 1], 0xef);

  // Isolation: post-dup the child is independent — a parent mutation does not
  // cross (distinct Memory objects, not aliased).
  pv[0] = 0x11;
  assert.equal(new Uint8Array(child.buffer)[0], 0xab, "child unaffected by later parent write");
});

test("dupAddressSpace rejects a child smaller than the parent", () => {
  const parent = new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true });
  const child = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  assert.throws(() => dupAddressSpace(parent, child), /smaller than parent/);
});
