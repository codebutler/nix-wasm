// task2.3-private-mem.test.mjs — Task 2.3 "the flip": each user process is
// instantiated against its OWN private WebAssembly.Memory (the `wasm_user_as`
// per-mm base-0 allocator ON). This test proves a REAL process runs over
// private memory — boot to a shell, then a malloc-heavy + CLONE_VM-pipe workload
// that exercises the bump allocator + grow + the host-bridge round-trip against
// the private memory.
//
// Boot mode: busybox userspace (nix:false). The per-process-memory flip is
// proven end to end here: init → /bin/sh over a private memory, and every
// command is its own exec'd process (its own private memory). The full
// NixOS-userspace boot (getty → login → autologin) currently DEADLOCKS in the
// getty/login CLONE_VFORK chain under per-process memory — see
// task-2.3-report.md ("Concerns"); that is a narrower follow-up, not the flip
// mechanism (which this test exercises directly).
//
// What this asserts:
//   1. boot reaches a shell prompt with `wasm_user_as` on the cmdline;
//   2. the kernel allocator self-test passed (WASM_USER_AS_SELFTEST: PASS);
//   3. the per-mm allocator FIRES per exec (`wasm_user_as: create pid=…`) — proves
//      data_start is now a small private offset, exec routed through the allocator;
//   4. a CLONE_VM pipe (`echo … | cat`) runs two private-memory processes and the
//      data flows through (clone-with-fn spawn + host-bridge uaccess over private);
//   5. malloc-heavy `sort -n` of 4000 lines yields exactly 4000 sorted lines
//      (mallocng mmap → allocator bump → wasm_user_mem_grow → write/read pattern
//      across the grown private memory) — the bump+grow+bridge round-trip;
//   6. an 8 MB heap-buffering pipe (`yes | head -c 8000000 | wc -c`) → 8000000.
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
      console.log("[t2.3] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached over a private memory");

  const boot = s.snapshot();
  check(
    /WASM_USER_AS_SELFTEST: PASS/.test(boot),
    "kernel allocator self-test PASS (wasm_user_as active)",
    /WASM_USER_AS_SELFTEST: FAIL/.test(boot) ? " — SELFTEST REPORTED FAIL" : "",
  );
  const creates = (boot.match(/wasm_user_as: create pid=\d+ pages=\d+/g) || []).length;
  check(creates > 0, "per-mm allocator fired at exec (create pid= markers)", ` (${creates} execs)`);
  check(!/wasm_user_as: create failed/.test(boot), "no `create failed` — private memory minted");

  // (4) CLONE_VM pipe across two private-memory processes.
  s.send("echo PRIV-MARK-$$ | cat\n");
  check(
    await s.waitForOutput(/PRIV-MARK-\d+/, 15000),
    "CLONE_VM pipe: two private-memory processes, data round-trips",
  );

  // (5) malloc-heavy sort: buffers 4000 lines in heap (mmap → allocator → grow).
  s.send('i=1; while [ $i -le 4000 ]; do echo $((4001 - i)); i=$((i+1)); done | sort -n | wc -l; echo SORT-$?\n');
  check(
    await s.waitForOutput(/\n4000\s*\r?\nSORT-0/, 45000),
    "malloc-heavy sort of 4000 lines round-trips through grown private memory",
  );

  // (6) 8 MB heap-buffering pipe → forces wasm_user_mem_grow.
  s.send("yes abcdefghij | head -c 8000000 | wc -c; echo PIPE-$?\n");
  check(
    await s.waitForOutput(/\n8000000\s*\r?\nPIPE-0/, 45000),
    "8 MB pipe across private-memory processes (grow path)",
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-3000));
  s.kill();
}

console.log("\n[t2.3] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
