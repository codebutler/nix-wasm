// exec-reject-smoke.mjs — issue #179 hardening gate: an exec'd image the HOST
// cannot run must kill only that task, NOT panic the guest kernel.
//
// THE BUG: the software-MMU instrumentation pass refuses an image that exports no
// `__get_tls_base` (it needs musl's `tp` operand for the fault syscall). That
// refusal was a THROW out of `wasm_load_executable`, which escaped into the
// kernel's own wasm frames and only landed later — with no kernel context — in
// `raise_exception()` -> `make_task_dead()`, i.e. `panic("Aiee, killing interrupt
// handler!")`. One unsupported user binary took down the whole system, which is
// how #179's real cause (a missing startup export in guest-clang) presented.
//
// THE FIX: `wasm_load_executable` returns a status; `start_thread()` kills just
// the execing task (`force_fatal_sig(SIGSEGV)`) and skips `_TIF_RELOAD_PROGRAM`.
// Past `begin_new_exec()` there is no route back to -ENOEXEC, so killing the task
// is exactly what Linux itself does for a late `load_binary` failure.
//
// WHAT THIS ASSERTS, in one busybox-only boot (no /nix closure needed):
//   1. `exec-ok-test` (the conforming twin) runs to completion — so the fixture
//      differs from a working program by exactly the one stripped export, and the
//      test cannot pass vacuously on a guest that rejects everything.
//   2. `exec-reject-test` (that binary minus `__get_tls_base`) does NOT run: it
//      dies without printing its marker.
//   3. NO kernel panic — the regression this whole gate exists for.
//   4. The SHELL SURVIVES: a command after the rejected exec still works. This is
//      the real payload; a panicked kernel takes the shell with it.
//
// NOTE: assertions 2-4 only bite on a software-MMU kernel (.#kernel-mmu-a2), where
// the pass runs and can refuse. On the shipped NOMMU kernel there is no
// instrumentation, so the stripped binary simply runs — the smoke says so and
// still gates 1/3/4 (no panic, shell alive). Point LINUX_WASM_ARTIFACTS at MMU
// artifacts to exercise the reject path itself.
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
  return ok;
};
// Markers are collision-free and matched on the EXPANDED value, never the echoed
// command line (the #96 / #179 lesson).
async function run(cmd, tag, ms = 60000) {
  s.send(`${cmd}; echo ${tag}=$?\n`);
  if (!(await s.waitForOutput(new RegExp(`${tag}=[0-9]`), ms))) return null;
  return s.snapshot().match(new RegExp(`${tag}=([0-9]+)`))?.[1] ?? "?";
}

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[exec-reject-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!check(reached, "shell prompt reached")) {
    console.log("\n── transcript ──\n" + s.snapshot().slice(-2000));
    s.kill();
    process.exit(1);
  }

  // 1. The conforming twin must run — proves the fixture is a real program and
  //    the only difference is the stripped export.
  const okRc = await run("exec-ok-test", "RC_OK");
  check(
    okRc === "0" && /EXEC-FIXTURE: ran OK/.test(s.snapshot()),
    "conforming twin runs (exec-ok-test → marker, rc 0)",
    ` [rc=${okRc}]`,
  );

  // 2-3. The rejected image must not run, and must not panic.
  const before = s.snapshot().length;
  const badRc = await run("exec-reject-test", "RC_BAD");
  const after = s.snapshot().slice(before);
  const mmu = /rejecting exec image|host rejected exec image/.test(s.snapshot());
  if (mmu) {
    check(!/EXEC-FIXTURE: ran OK/.test(after), "rejected image does not run", ` [rc=${badRc}]`);
  } else {
    console.log(
      `  note  no rejection seen (rc=${badRc}) — NOMMU kernel: no instrumentation, so the` +
        " stripped binary is runnable. Assertions 1/3/4 still gate; use .#kernel-mmu-a2" +
        " artifacts to exercise the reject path.",
    );
  }
  check(!/Kernel panic/i.test(s.snapshot()), "no kernel panic (the #179 regression)");

  // 4. The kernel — and this shell — survived the rejected exec.
  const aliveRc = await run("echo still-alive", "RC_ALIVE");
  check(
    aliveRc === "0" && /still-alive/.test(s.snapshot()),
    "shell still responsive after the rejected exec (kernel survived)",
  );

  console.log("\n[exec-reject-smoke] " + (pass ? "PASS" : "FAIL"));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}
process.exit(pass ? 0 : 1);
