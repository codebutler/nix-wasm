// softmmu-fork.test.js — the MMU-native fork ENGINE mechanism (#129 Track B on
// the #128 software-MMU foundation), proven end-to-end without the kernel.
//
// What PR #20 proved with a VERBATIM per-process memory copy (the NOMMU model),
// this proves on the model that replaces it: parent and child are two
// WebAssembly.Instances of the SAME asyncify+softmmu-instrumented module on ONE
// shared linear memory, isolated purely by per-process page tables with COW.
// The harness plays the kernel: "fork" duplicates the page tables and
// write-protects both sides' leaf PTEs (what copy_page_range does for private
// anon mappings); a store to a write-protected page faults through the checked
// translate's permission test into the mock handler, which copies the page and
// installs a private writable PTE (do_wp_page).
//
// The pass ORDER is the production order: wasm-opt --asyncify at BUILD time
// (test-fixtures/softmmu/build-fork-probe.sh — capture_stack is the sole unwind
// import, the musl 0010 seam contract), instrument({checked:true}) at TEST
// time. So asyncify's own machinery — the ctl buffer + captured stack image
// loads/stores — is TRANSLATED: the stack image lives in VIRTUAL space, COW
// protects it per side, and each side's rewind writes (asyncify consumes the
// image) fault into private copies. That is the subtle heart of MMU fork: the
// captured fork() stack is just process memory, duplicated like any other page.
//
// Flow proven here (the exact kernel-worker wiring this de-risks):
//   1. parent runs → capture_stack unwinds → entry export RETURNS
//      (isPendingUnwind) → stopUnwind.
//   2. "kernel fork": dup tables + write-protect (COW).
//   3. child instantiated on the SAME memory, own pt_base, parent's
//      __stack_pointer value; NO memory copy, NO data-segment clobber (passive
//      segments behind __wasm_init_memory's atomic once-guard, stripped to
//      __mmu_start by the pass and re-run harmlessly in the child).
//   4. child rewind → capture_stack returns 0 → child's post-fork writes COW.
//   5. parent rewind → capture_stack returns the child pid → parent's writes COW.
//   6. one virtual address, two values — and the pre-fork physical page intact.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { instrument, NR_MMU_FAULT } from "./softmmu-pass.js";
import {
  ASYNCIFY_STATE,
  makeCaptureStack,
  isPendingUnwind,
  stopUnwind,
  startRewind,
} from "./asyncify.js";

const FIX = new URL("test-fixtures/softmmu/", import.meta.url);
const PAGE = 4096;

// ---- layout (all "physical" = raw offsets into the one shared Memory) ------
// virtual [0, 1 MiB) maps identity to physical [0, 1 MiB); everything the
// harness owns (page tables, the COW page pool) lives at phys >= 2 MiB, OUTSIDE
// the virtual mapping, so instrumented code can never reach it.
const VIRT_PAGES = 256; // 1 MiB of mapped virtual space
const MEMORY_BASE = 0x10000; // module data/BSS placed here (virtual)
const STACK_TOP = 0xf0000; // C shadow stack (virtual, grows down)
const PT_PARENT = 0x200000; // parent pgd (phys)
const PT_PARENT_PTE = 0x201000; // parent's one pte table (phys)
const PT_CHILD = 0x210000; // child pgd (phys)
const PT_CHILD_PTE = 0x211000; // child's pte table copy (phys)
const COW_POOL = 0x220000; // bump allocator for COW page copies (phys)

const PTE_P = 1; // _PAGE_PRESENT
const PTE_W = 2; // _PAGE_WRITE
const PTE_U = 4; // _PAGE_USER

function buildHarness() {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 1024, shared: true });
  const u32 = () => new Uint32Array(memory.buffer);
  const u8 = () => new Uint8Array(memory.buffer);

  // identity page table: one pgd slot (virtual 0..4 MiB), leaf PTEs 0..255.
  const t = u32();
  t[PT_PARENT / 4] = PT_PARENT_PTE; // bare pte-page phys, NO flag bits (pmd format)
  for (let p = 0; p < VIRT_PAGES; p++) {
    t[PT_PARENT_PTE / 4 + p] = (p << 12) | (PTE_P | PTE_W | PTE_U);
  }

  let cowNext = COW_POOL;
  const faults = []; // { side, ea, kind } — every __wasm_syscall_2 fault call

  // The mock kernel fault handler, per-side (each side walks ITS OWN pgd —
  // exactly the per-process pt_base contract).
  const makeFault = (pgdPhys, side) => (sp, tp, nr, ea, kind) => {
    expect(Number(nr)).toBe(NR_MMU_FAULT);
    ea = Number(ea) >>> 0;
    kind = Number(kind);
    faults.push({ side, ea, kind });
    const tt = u32();
    const pgdE = tt[pgdPhys / 4 + (ea >>> 22)];
    if (!pgdE) throw new Error(`unexpected pgd miss ${side} ea=${ea.toString(16)}`);
    const pteIdx = (pgdE & ~0xfff) / 4 + ((ea >>> 12) & 0x3ff);
    const pte = tt[pteIdx];
    if (!(pte & PTE_P)) throw new Error(`unexpected non-present ${side} ea=${ea.toString(16)}`);
    if (kind === 1 && !(pte & PTE_W)) {
      // do_wp_page: copy the page into a fresh frame, map it writable.
      const oldPhys = pte & ~0xfff;
      const newPhys = cowNext;
      cowNext += PAGE;
      u8().copyWithin(newPhys, oldPhys, oldPhys + PAGE);
      tt[pteIdx] = newPhys | (PTE_P | PTE_W | PTE_U);
      return 0;
    }
    throw new Error(
      `unexpected fault ${side} ea=0x${ea.toString(16)} kind=${kind} pte=0x${pte.toString(16)}`,
    );
  };

  // copy_page_range for a private anon mapping: duplicate the table structure,
  // write-protect the leaf PTEs on BOTH sides (COW arming).
  const cowFork = () => {
    const tt = u32();
    tt[PT_CHILD / 4] = PT_CHILD_PTE;
    for (let p = 0; p < VIRT_PAGES; p++) {
      const pte = tt[PT_PARENT_PTE / 4 + p];
      const armed = pte & PTE_P ? pte & ~PTE_W : pte;
      tt[PT_PARENT_PTE / 4 + p] = armed;
      tt[PT_CHILD_PTE / 4 + p] = armed;
    }
  };

  return { memory, u32, u8, faults, makeFault, cowFork };
}

// Instantiate one side of the fork on the shared memory. Mirrors kernel-worker's
// user_executable_setup: own __stack_pointer global, own fault import (own
// pgd), pt_base applied to __mmu_pt_base BEFORE __mmu_start.
function bootSide(module, h, { pgd, side, stackPtr, forkResult }) {
  const logs = [];
  let inst;
  const capture = makeCaptureStack(
    () => inst,
    () => forkResult(),
  );
  const sp = new WebAssembly.Global({ value: "i32", mutable: true }, stackPtr);
  inst = new WebAssembly.Instance(module, {
    env: {
      memory: h.memory,
      __stack_pointer: sp,
      __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MEMORY_BASE),
      __wasm_syscall_2: h.makeFault(pgd, side),
      log_i: (v) => logs.push(Number(v) | 0),
      capture_stack: capture,
    },
  });
  inst.exports.__mmu_pt_base.value = pgd;
  if (inst.exports.__mmu_start) inst.exports.__mmu_start();
  return { inst, logs, capture, sp };
}

describe("MMU-native fork engine mechanism (asyncify × softmmu × COW)", () => {
  test("double return + COW isolation across two instances on one memory", () => {
    const raw = new Uint8Array(readFileSync(new URL("fork-probe.wasm", FIX)));
    const bytes = instrument(raw, { checked: true, exportControls: true });
    const module = new WebAssembly.Module(bytes);
    const h = buildHarness();
    const CHILD_PID = 42;

    // ---- parent boots and runs to the fork point --------------------------
    const parent = bootSide(module, h, {
      pgd: PT_PARENT,
      side: "parent",
      stackPtr: STACK_TOP,
      forkResult: () => CHILD_PID,
    });
    parent.inst.exports.__wasm_apply_data_relocs();
    parent.inst.exports.run();

    // capture_stack unwound: run() returned early, parked mid-unwind.
    expect(parent.logs).toEqual([1111]); // pre-fork marker fired exactly once
    expect(isPendingUnwind(parent.inst)).toBe(true);
    stopUnwind(parent.inst);
    const ctl = parent.capture.ctlPtr;
    expect(ctl).toBeGreaterThanOrEqual(MEMORY_BASE); // ctl buffer is VIRTUAL (BSS)

    // ---- "kernel fork": dup tables, write-protect both sides (COW) --------
    h.cowFork();

    // ---- child: fresh instance, SAME memory, own pt_base — NO memory copy -
    const child = bootSide(module, h, {
      pgd: PT_CHILD,
      side: "child",
      stackPtr: parent.sp.value, // fork-time SP (kernel: pt_regs → ret_from_fork)
      forkResult: () => 0,
    });
    // NOTE: __mmu_start ran again in the child — __wasm_init_memory's atomic
    // once-guard (flag already set, read through the child's COW tables) makes
    // it a no-op instead of re-placing data over the parent's live image.

    // ---- child rewinds the captured stack: fork() returns 0 ---------------
    startRewind(child.inst, ctl);
    child.inst.exports.run();
    expect(child.inst.exports.asyncify_get_state()).toBe(ASYNCIFY_STATE.NORMAL);
    // pre-fork marker did NOT re-fire (rewind skips to the recorded call);
    // pid=0, counter=500+0+1 via the child's private COW copy, live local 7.
    expect(child.logs).toEqual([0, 501, 7]);

    // ---- parent rewinds: fork() returns the child pid ---------------------
    startRewind(parent.inst, ctl);
    parent.inst.exports.run();
    expect(parent.inst.exports.asyncify_get_state()).toBe(ASYNCIFY_STATE.NORMAL);
    expect(parent.logs).toEqual([1111, CHILD_PID, 500 + CHILD_PID + 1, 7]);

    // ---- COW actually happened, on both sides ------------------------------
    const childWrites = h.faults.filter((f) => f.side === "child" && f.kind === 1);
    const parentWrites = h.faults.filter((f) => f.side === "parent" && f.kind === 1);
    expect(childWrites.length).toBeGreaterThan(0);
    expect(parentWrites.length).toBeGreaterThan(0);
    // no read faults ever (everything stayed present; only write-protect fired)
    expect(h.faults.every((f) => f.kind === 1)).toBe(true);

    // one virtual address, two diverged values — and both sides' page tables
    // now point counter's page at DIFFERENT physical frames, neither of which
    // is the original (both sides COW'd away from the shared pre-fork page).
    const t = h.u32();
    const counterFaultEa = parentWrites[0].ea; // first parent COW = the counter page
    const vpage = counterFaultEa >>> 12;
    const pPhys = t[PT_PARENT_PTE / 4 + vpage] & ~0xfff;
    const cPhys = t[PT_CHILD_PTE / 4 + vpage] & ~0xfff;
    expect(pPhys).not.toBe(cPhys);
    expect(pPhys).toBeGreaterThanOrEqual(COW_POOL);
    expect(cPhys).toBeGreaterThanOrEqual(COW_POOL);
  });

  test("the ctl buffer + captured stack image COW-isolate per side", () => {
    // The rewind CONSUMES the stack image (asyncify writes cur back as frames
    // pop), so each side's rewind must fault its ctl/stack pages into private
    // copies — otherwise the first rewind corrupts the image for the second.
    // Proven by ordering: the CHILD rewinds first above and the parent's rewind
    // still resumes correctly. This test asserts the mechanism directly: after
    // both rewinds, the ctl page is COW'd in both tables.
    const raw = new Uint8Array(readFileSync(new URL("fork-probe.wasm", FIX)));
    const bytes = instrument(raw, { checked: true, exportControls: true });
    const module = new WebAssembly.Module(bytes);
    const h = buildHarness();

    const parent = bootSide(module, h, {
      pgd: PT_PARENT,
      side: "parent",
      stackPtr: STACK_TOP,
      forkResult: () => 7,
    });
    parent.inst.exports.__wasm_apply_data_relocs();
    parent.inst.exports.run();
    stopUnwind(parent.inst);
    const ctl = parent.capture.ctlPtr;
    h.cowFork();

    const child = bootSide(module, h, {
      pgd: PT_CHILD,
      side: "child",
      stackPtr: parent.sp.value,
      forkResult: () => 0,
    });
    startRewind(child.inst, ctl);
    child.inst.exports.run();
    startRewind(parent.inst, ctl);
    parent.inst.exports.run();

    const t = h.u32();
    const vpage = ctl >>> 12;
    const pPte = t[PT_PARENT_PTE / 4 + vpage];
    const cPte = t[PT_CHILD_PTE / 4 + vpage];
    expect(pPte & ~0xfff).not.toBe(cPte & ~0xfff); // private copies
    expect(pPte & PTE_W).toBe(PTE_W); // both writable again post-COW
    expect(cPte & PTE_W).toBe(PTE_W);
  });
});
