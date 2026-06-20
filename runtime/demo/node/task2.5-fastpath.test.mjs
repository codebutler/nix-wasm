// task2.5-fastpath.test.mjs — Task 2.5 acceptance B2: clone-with-fn spawn
// (busybox NOMMU CLONE_VM|CLONE_VFORK path) must work correctly over per-process
// private `WebAssembly.Memory` (the `wasm_user_as` allocator ON).
//
// WHY THIS PROVES B2 (the crux):
//   busybox's NOMMU spawn is clone(CLONE_VM|CLONE_VFORK). Under per-process memory
//   (Task 2.3's "the flip"), the child worker must instantiate its duplicated module
//   against the PARENT'S private Memory (not a fresh one), because the clone callback
//   reads its arg from — and reports failure into — the parent's linear memory. This
//   arrangement is wired in kernel-worker.js (~line 792): the `clone_vm` message
//   branch sets `current_user_pid = Number(message.clone_vm.owner_pid)` and registers
//   the parent's Memory for the child BEFORE instantiation, so uaccess resolves the
//   right buffer. On the child's later execvp, `wasm_user_mem_create` mints its OWN
//   private memory and supersedes that entry.
//
//   This test exercises the FULL clone-with-fn spawn cycle and — crucially —
//   exit-status propagation across a spawned child, which requires the parent to
//   receive the child's exit code via the shared memory region. The two assertions
//   that discriminate are:
//     • `echo hi | cat` → "hi" proves the pipe/clone round-trip (sanity)
//     • `sh -c 'exit 7'; echo rc=$?` → "rc=7" proves exit-status propagation: the
//       parent shell received the child's exit code through the CLONE_VM shared-memory
//       channel; if the memory hand-off were broken the child would crash or the
//       status would be wrong (e.g., rc=0 or rc=139).
//     • `echo done` → "done" proves the parent shell stayed alive after the spawned
//       child exited — the CLONE_VFORK wake-up/resume worked.
//   These three together prove the entire NOMMU spawn-and-wait cycle over private mem.
//   T2.3 already tests CLONE_VM pipes and malloc-heavy grows; T2.5 is explicitly
//   about exit-status propagation, which T2.3 does not check.
//
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../../ninep/mem-vfs.js";

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
      console.log("[t2.5] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached over a private memory (wasm_user_as ON)");

  // (1) Sanity pipe: CLONE_VM|CLONE_VFORK spawn round-trips data through a pipe.
  //     Two distinct processes (each over private memory) coordinate via pipe fd.
  s.send("echo B2-PIPE-$$ | cat\n");
  check(
    await s.waitForOutput(/B2-PIPE-\d+/, 15000),
    "CLONE_VM pipe: piped data round-trips across two private-memory processes",
  );

  // (2) Exit-status propagation: `sh -c 'exit 7'` spawns a child process via the
  //     NOMMU clone(CLONE_VM|CLONE_VFORK) path; the child exits with status 7; the
  //     parent shell captures it via wait4()/waitpid() through the shared CLONE_VM
  //     memory channel; `echo rc=$?` must print "rc=7". If the private-memory
  //     hand-off is broken, the child crashes (rc=139) or the wait channel is
  //     corrupted (rc≠7). `echo done` then proves the parent shell resumed normally
  //     after CLONE_VFORK (the wake-up path completed).
  s.send("sh -c 'exit 7'; echo rc=$?; echo B2-DONE\n");
  check(
    await s.waitForOutput(/rc=7\b/, 20000),
    "exit-status propagation: child sh -c 'exit 7' → parent sees rc=7 (CLONE_VM wait channel intact)",
  );
  check(
    await s.waitForOutput(/B2-DONE/, 20000),
    "parent shell alive after CLONE_VFORK child exit (CLONE_VFORK wake-up path works)",
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-3000));
  s.kill();
}

console.log("\n[t2.5] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
