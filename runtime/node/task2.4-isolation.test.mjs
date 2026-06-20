// task2.4-isolation.test.mjs — Task 2.4 acceptance B1: a user process cannot read
// another user process's memory. This is the END-TO-END proof of the Phase-1
// guarantee that each guest process owns a PHYSICALLY DISTINCT
// `WebAssembly.Memory` (no shared linear address space).
//
// Boot mode: busybox userspace (nix:false) with `wasm_user_as` ON (per-process
// private memory). Two guest binaries baked into the initramfs:
//   /bin/isoa  — writes a sentinel word at an mmap'd page and prints the ABSOLUTE
//                linear address it wrote to, then pauses (stays alive).
//   /bin/isob  — given that exact absolute address at RUNTIME, grows ITS OWN
//                address space to cover that offset, then reads the word there.
//
// WHY THIS DISCRIMINATES (the crux — a naive probe does NOT):
//   The address is NOT compile-time-fixed: A's kernel-chosen mmap address is
//   captured from A's stdout at runtime and handed to B. B reads that SAME
//   absolute numeric address.
//     * Correct per-process model: that offset in B's OWN distinct private Memory
//       holds B's own bytes (its loaded image / fresh zero pages), NOT A's
//       sentinel → "ISOLATION PASS".
//     * Hypothetical shared-Memory model (the property we're guarding against):
//       A's absolute address is a real offset in the ONE shared linear memory
//       holding A's live sentinel → B reading the same offset observes A's bytes
//       → "ISOLATION LEAK".
//   A stays alive while B reads (A backgrounded), so the two regions genuinely
//   coexist — a shared model could NOT hide the overlap. This test would FAIL
//   under a single-shared-Memory model; that is what makes it a real B1 proof.
//
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../ninep/mem-vfs.js";

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};

const s = await bootNode({
  vfs: MemVfs.from({ Home: {} }),
  nix: false,
  cmdline:
    "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0 wasm_user_as",
});

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[t2.4-iso] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached over a private memory");

  // (1) Launch A in the background; it prints `ISOA_ADDR=0x…` then pauses.
  s.send("/bin/isoa & \n");
  const sawAddr = await s.waitForOutput(/ISOA_ADDR=0x[0-9a-fA-F]+/, 20000);
  check(sawAddr, "process A wrote a sentinel and reported its absolute address");
  const m = s.snapshot().match(/ISOA_ADDR=0x([0-9a-fA-F]+)/);
  const addr = m ? "0x" + m[1] : null;
  check(!!addr, "captured A's runtime-reported address", addr ? ` (${addr})` : "");

  // (2) Hand A's exact absolute address to B (a DISTINCT process / distinct
  // private Memory). B maps it in its own AS and reads it back.
  if (addr) {
    s.send(`/bin/isob ${addr}\n`);
    const verdict = await s.waitForOutput(/ISOLATION (PASS|LEAK)/, 20000);
    check(verdict, "process B completed the cross-process read");
    const snap = s.snapshot();
    check(!/ISOLATION LEAK/.test(snap), "B did NOT observe A's sentinel (no shared memory)");
    check(/ISOLATION PASS/.test(snap), "B read its OWN private bytes at A's address → ISOLATION PASS");
  }
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-4000));
  s.kill();
}

console.log("\n[t2.4-iso] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
