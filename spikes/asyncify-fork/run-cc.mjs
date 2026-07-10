// Phase-2 Task-0 spike harness for the CLANG-compiled probe (probe.c).
//
// Same double-return orchestration as run.mjs, but against real clang codegen:
// proves asyncify rewinds through a nested C call frame (deep()) and that the C
// shadow stack (live locals like `salt`, the deep() frame) rides along in the
// verbatim memory copy, landing the resume exactly at the do_fork() call site.
//
// Layout: __stack_pointer starts at 66576 (0x10410); the C shadow stack grows
// DOWN from there, so [0x10410, 0x20000) is free — the asyncify scratch lives
// there, clear of the shadow stack and .bss counter (both in low memory).
import { readFileSync } from "node:fs";
// Phase-2: the spike now drives the SHIPPED orchestration helpers
// (runtime/asyncify.js), so this throwaway harness double-proves them against
// real clang -O2 codegen — the same module the worker fork path uses.
import { ASYNCIFY_STATE as STATE, makeCaptureStack, dupAddressSpace } from "../../runtime/asyncify.js";

const DATA_PTR = 0x18000;
const STACK_BASE = 0x18010;
const STACK_END = 0x1f000;
const CHILD_TOKEN = 42;

const mod = await WebAssembly.compile(readFileSync(new URL("./probe.cc.async.wasm", import.meta.url)));
const log = [];

function makeInstance(memory, role, ctx) {
  let inst;
  // do_fork is this module's unwind import (the spike predates the rename to
  // capture_stack); makeCaptureStack is import-name agnostic. ctx.forkRet is the
  // value returned on the rewind side (parent token vs child 0).
  const captureStack = makeCaptureStack(
    () => inst,
    () => ctx.forkRet,
  );
  inst = new WebAssembly.Instance(mod, {
    env: {
      memory,
      log_i: (v) => log.push([role, v]),
      do_fork: () => captureStack(DATA_PTR),
    },
  });
  return inst;
}

function initAsyncifyData(memory) {
  const dv = new DataView(memory.buffer);
  dv.setInt32(DATA_PTR, STACK_BASE, true);
  dv.setInt32(DATA_PTR + 4, STACK_END, true);
}

const parentMem = new WebAssembly.Memory({ initial: 2 });
initAsyncifyData(parentMem);
const parentCtx = { forkRet: 0 };
const parent = makeInstance(parentMem, "P", parentCtx);

parent.exports.run();
if (parent.exports.asyncify_get_state() !== STATE.UNWINDING) {
  throw new Error("expected parent UNWINDING after run()");
}
parent.exports.asyncify_stop_unwind();

// ORDERING CONSTRAINT (spike finding, locks in Task 4): instantiate the child
// FIRST — a fresh Instance re-applies the module's active data segments to its
// memory — THEN verbatim-copy the parent bytes over the top, so the forked
// state wins over segment re-initialization (which would otherwise reset .bss).
const childMem = new WebAssembly.Memory({ initial: 2 });
const childCtx = { forkRet: 0 };
const child = makeInstance(childMem, "C", childCtx);
dupAddressSpace(parentMem, childMem);

parentCtx.forkRet = CHILD_TOKEN;
parent.exports.asyncify_start_rewind(DATA_PTR);
parent.exports.run();

childCtx.forkRet = 0;
child.exports.asyncify_start_rewind(DATA_PTR);
child.exports.run();

console.log("log:", JSON.stringify(log));

const pre = log.filter(([, v]) => v === 1111).length;
const pRet = log.find(([r, v]) => r === "P" && (v === CHILD_TOKEN || v === 0));
const cRet = log.find(([r, v]) => r === "C" && (v === CHILD_TOKEN || v === 0));
// Strip the one-time pre-fork marker (1111, emitted during the parent's unwind
// pass) so each role's post-fork sequence is uniformly [pid, counter, salt].
const pVals = log.filter(([r, v]) => r === "P" && v !== 1111).map(([, v]) => v);
const cVals = log.filter(([r, v]) => r === "C" && v !== 1111).map(([, v]) => v);
const pWitness = pVals[1]; // counter after mutation
const cWitness = cVals[1];
const pSalt = pVals[2]; // live local across fork
const cSalt = cVals[2];

const checks = [
  ["B3: pre-fork marker fires exactly once (nested frame)", pre === 1, `got ${pre}`],
  ["returns twice: parent sees child token", pRet?.[1] === CHILD_TOKEN, `parentRet=${pRet?.[1]}`],
  ["returns twice: child sees 0", cRet?.[1] === 0, `childRet=${cRet?.[1]}`],
  ["isolation: parent counter = 543", pWitness === 543, `parent=${pWitness}`],
  ["isolation: child counter = 501", cWitness === 501, `child=${cWitness}`],
  ["live C local survives unwind/rewind: parent salt = 7", pSalt === 7, `parent salt=${pSalt}`],
  ["live C local survives unwind/rewind: child salt = 7", cSalt === 7, `child salt=${cSalt}`],
];

let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : "  (" + detail + ")"}`);
  ok = ok && pass;
}
if (!ok) {
  console.error("SPIKE-CC FAIL");
  process.exit(1);
}
console.log("SPIKE-CC PASS — asyncify double-return through real clang codegen (nested frame + shadow stack + live locals)");
