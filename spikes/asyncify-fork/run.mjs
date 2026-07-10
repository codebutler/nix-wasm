// Phase-2 Task-0 spike harness: orchestrates the asyncify double-return.
//
// Models the host run-loop's role in true fork() WITHOUT the kernel/musl:
//   1. run the parent instance until $do_fork triggers asyncify_start_unwind;
//      the call returns to us (the "host run-loop") — a pending fork.
//   2. asyncify_stop_unwind, then VERBATIM-COPY the parent's linear memory into
//      a fresh Memory for the child (the asyncify stack buffer rides along).
//   3. asyncify_start_rewind both instances and re-enter run() — $do_fork now
//      returns the per-side value (parent: child token; child: 0). Double return.
//
// Two genuinely separate WebAssembly.Memory objects prove isolation: post-fork
// mutations to mem[2048] must diverge (parent 543 vs child 501).
//
// Asserts B3: the pre-fork marker (1111) fires EXACTLY ONCE — resume lands at
// the $do_fork call site, never re-running run() from the top.
import { readFileSync } from "node:fs";

const STATE = { NORMAL: 0, UNWINDING: 1, REWINDING: 2 };

// asyncify data struct at DATA_PTR: i32 stack_ptr (current), i32 stack_end.
// The scratch stack region [STACK_BASE, STACK_END) is where asyncify spills
// locals; keep it clear of our counter at mem[2048].
const DATA_PTR = 16;
const STACK_BASE = 64;
const STACK_END = 1024;

const CHILD_TOKEN = 42; // stand-in for the kernel-assigned child pid

const mod = await WebAssembly.compile(readFileSync(new URL("./probe.async.wasm", import.meta.url)));

const log = [];

// Build an instance bound to `memory`; `ctx.forkRet` is what $do_fork returns
// after the rewind (set by the orchestrator just before start_rewind).
function makeInstance(memory, role, ctx) {
  let inst;
  const imports = {
    env: { memory },
    host: {
      do_fork() {
        if (inst.exports.asyncify_get_state() === STATE.REWINDING) {
          inst.exports.asyncify_stop_rewind();
          return ctx.forkRet; // second arrival (rewind): the real return value
        }
        // first arrival (normal): freeze the stack and bubble back to the host.
        inst.exports.asyncify_start_unwind(DATA_PTR);
        return 0; // ignored — we are unwinding
      },
      log(v) {
        log.push([role, v]);
      },
    },
  };
  inst = new WebAssembly.Instance(mod, imports);
  return inst;
}

function initAsyncifyData(memory) {
  const dv = new DataView(memory.buffer);
  dv.setInt32(DATA_PTR, STACK_BASE, true);
  dv.setInt32(DATA_PTR + 4, STACK_END, true);
}

// ---- parent: run to the fork point, then freeze ----
const parentMem = new WebAssembly.Memory({ initial: 1 });
initAsyncifyData(parentMem);
const parentCtx = { forkRet: 0 };
const parent = makeInstance(parentMem, "P", parentCtx);

parent.exports.run(); // unwinds at $do_fork
if (parent.exports.asyncify_get_state() !== STATE.UNWINDING) {
  throw new Error("expected parent to be UNWINDING after run()");
}
parent.exports.asyncify_stop_unwind();

// ---- duplicate the address space: verbatim byte-copy parent -> child ----
const childMem = new WebAssembly.Memory({ initial: 1 });
new Uint8Array(childMem.buffer).set(new Uint8Array(parentMem.buffer));
const childCtx = { forkRet: 0 };
const child = makeInstance(childMem, "C", childCtx);

// ---- resume BOTH: the single $do_fork() call returns twice ----
parentCtx.forkRet = CHILD_TOKEN; // parent sees the child pid
parent.exports.asyncify_start_rewind(DATA_PTR);
parent.exports.run();

childCtx.forkRet = 0; // child sees 0
child.exports.asyncify_start_rewind(DATA_PTR);
child.exports.run();

// ---- verdict ----
console.log("log:", JSON.stringify(log));

const preForkMarkers = log.filter(([, v]) => v === 1111).length;
const rets = log.filter(([r]) => true);
const parentRet = log.find(([r, v]) => r === "P" && (v === CHILD_TOKEN || v === 0));
const childRet = log.find(([r, v]) => r === "C" && (v === CHILD_TOKEN || v === 0));
const parentWitness = log.filter(([r]) => r === "P").map(([, v]) => v).at(-1);
const childWitness = log.filter(([r]) => r === "C").map(([, v]) => v).at(-1);

const checks = [
  ["B3: pre-fork marker fires exactly once", preForkMarkers === 1, `got ${preForkMarkers}`],
  ["returns twice: parent sees child token", parentRet?.[1] === CHILD_TOKEN, `parentRet=${parentRet?.[1]}`],
  ["returns twice: child sees 0", childRet?.[1] === 0, `childRet=${childRet?.[1]}`],
  ["isolation: parent witness = 500+token+1 = 543", parentWitness === 500 + CHILD_TOKEN + 1, `parent=${parentWitness}`],
  ["isolation: child witness = 500+0+1 = 501", childWitness === 501, `child=${childWitness}`],
];

let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : "  (" + detail + ")"}`);
  ok = ok && pass;
}

if (!ok) {
  console.error("SPIKE FAIL");
  process.exit(1);
}
console.log("SPIKE PASS — asyncify double-return + verbatim memory dup proven (B3)");
