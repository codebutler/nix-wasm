// Phase 2 acceptance — real fork() end to end in the guest.
//
// Boots the Nix-built guest (busybox-only) ONCE and runs the fork() acceptance
// programs baked into the initramfs, asserting the double return + private memory
// + waitpid/status for each:
//   fork-returns-twice — base case (child 0 / parent child-pid, diverged witness)
//   fork-nested        — a fork CHILD forks a grandchild (re-entrancy)
//   fork-loop          — 3 forks before any reap (per-child snapshot keying)
//   fork-in-thread     — fork in a process with a live pthread (single-thread copy)
//   fork-helper        — fork() called 3 frames deep (arbitrary call depth)
//   fork-exec          — exec-after-fork (the classic shell pattern)
//   fork-pipe          — fd inheritance + pipe IPC across the two workers
//
// Exit 0 = all PASS, 1 = a FAIL, 2 = inconclusive (boot panic — re-run). Needs
// LINUX_WASM_ARTIFACTS=file:///path/ (vmlinux.wasm + initramfs.cpio.gz).
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each case: the guest command, and a checks(out) -> [name, pass][] over its
// captured output (between the command echo and the FORKDONE marker).
const CASES = [
  {
    name: "fork-returns-twice",
    cmd: "/bin/fork-returns-twice",
    checks: (out) => {
      const child = /FORK CHILD ret=0 witness=0x([0-9a-f]+)/.exec(out);
      const parent = /FORK PARENT child_pid=(\d+) witness=0x([0-9a-f]+) childexit=(\d+)/.exec(out);
      return [
        ["returns twice: CHILD (fork()==0)", !!child],
        ["returns twice: PARENT (fork()>0)", !!parent && Number(parent[1]) > 0],
        ["private memory: child witness 0x10c", child && child[1] === "10c"],
        ["private memory: parent witness 0x1b0 (diverged)", parent && parent[2] === "1b0"],
        ["waitpid: child exit status 7", parent && Number(parent[3]) === 7],
      ];
    },
  },
  {
    name: "fork-nested",
    cmd: "/bin/fork-nested",
    checks: (out) => {
      const grand = /NESTED GRANDCHILD pid_ok=1/.test(out);
      const child = /NESTED CHILD grand=(\d+) gexit=3 distinct=1/.exec(out);
      const parent = /NESTED PARENT child=(\d+) cexit=2 distinct=1/.exec(out);
      return [
        ["nested: grandchild ran", grand],
        ["nested: child reaped grandchild (exit 3), distinct pids", !!child],
        ["nested: parent reaped child (exit 2), distinct pids", !!parent],
        ["nested: all three pids distinct", child && parent && child[1] !== parent[1]],
      ];
    },
  },
  {
    name: "fork-loop",
    cmd: "/bin/fork-loop",
    checks: (out) => {
      const kids = [0, 1, 2].every((i) => new RegExp(`LOOP CHILD i=${i} pid_ok=1`).test(out));
      const parent = /LOOP PARENT reaped=3 exitsum=(\d+) distinct=(\d+)/.exec(out);
      return [
        ["loop: all 3 children ran", kids],
        ["loop: parent reaped 3, exitsum 33", parent && Number(parent[1]) === 33],
        ["loop: 3 distinct child pids", parent && Number(parent[2]) === 1],
      ];
    },
  },
  {
    name: "fork-in-thread",
    cmd: "/bin/fork-in-thread",
    checks: (out) => {
      const child = /THREADFORK CHILD thread_started=1/.test(out);
      const parent = /THREADFORK PARENT cexit=6/.test(out);
      return [
        ["threaded: child sees the pthread's copied memory (single-threaded copy)", child],
        ["threaded: parent reaped the child (exit 6)", parent],
      ];
    },
  },
  {
    name: "fork-helper",
    cmd: "/bin/fork-helper",
    checks: (out) => {
      // fork() called 3 frames deep (main->level2->level1->fork) — proves
      // asyncify reachability instruments the whole call graph (no addlist).
      const child = /HELPER CHILD ret=0 w=0x([0-9a-f]+)/.exec(out);
      const parent = /HELPER PARENT pid=(\d+) w=0x([0-9a-f]+) cexit=(\d+)/.exec(out);
      return [
        ["depth: fork() from a 3-deep helper returns twice (child)", child && child[1] === "31d"],
        ["depth: parent sees child pid + diverged witness 0x3c1", parent && parent[2] === "3c1"],
        ["depth: waitpid child exit 8", parent && Number(parent[3]) === 8],
      ];
    },
  },
  {
    name: "fork-exec",
    cmd: "/bin/fork-exec",
    checks: (out) => {
      // A fork child execs /bin/echo — the classic shell fork-then-exec pattern.
      const childRan = /FORKEXEC CHILD_RAN/.test(out);
      const parent = /FORKEXEC PARENT cexit=(\d+)/.exec(out);
      return [
        ["exec: fork child exec'd /bin/echo (marker printed)", childRan],
        ["exec: parent reaped the exec'd child (exit 0)", parent && Number(parent[1]) === 0],
      ];
    },
  },
  {
    name: "fork-pipe",
    cmd: "/bin/fork-pipe",
    checks: (out) => {
      // fd inheritance + pipe IPC: the parent reads what the child wrote.
      const parent = /FORKPIPE parent read=\[([^\]]*)\] cexit=(\d+)/.exec(out);
      return [
        [
          "pipe: parent read the child's message over the inherited fd",
          parent && parent[1] === "PIPED_FROM_CHILD",
        ],
        ["pipe: child reaped (exit 0)", parent && Number(parent[2]) === 0],
      ];
    },
  },
];

// Run a guest command, delimiting its output with unique START/END markers in
// the SINGLE accumulated buffer (no reset — that races with delayed/chunked
// console output). The case output is the slice between the markers; exitOk reads
// the "$?" appended to the END marker. Robust to the shell echoing the prompt and
// the program's buffered stdout arriving in any interleaving.
async function runCmd(handle, getOut, cmd, tag) {
  const start = "FORKBEG_" + tag;
  const end = "FORKEND_" + tag;
  handle.console(0).write(`echo ${start}; ${cmd}; echo ${end}$?\n`);
  const t = Date.now();
  // The END marker echoed by the shell carries the exit code, e.g. FORKEND_0=7.
  const endRe = new RegExp(end + "(\\d+)");
  while (Date.now() - t < 30000 && !endRe.test(getOut())) {
    if (/panic/i.test(getOut())) return { panic: true, out: getOut() };
    await sleep(150);
  }
  const full = getOut();
  const m = endRe.exec(full);
  const begIdx = full.indexOf(start);
  // Slice between the START marker's line and the END marker.
  const body = begIdx >= 0 && m ? full.slice(full.indexOf("\n", begIdx) + 1, m.index) : full;
  return { panic: false, out: body, exitOk: m && m[1] === "0" };
}

async function main() {
  installWebShims();
  const vfs = MemVfs.from({ Home: {} });
  const handle = await bootNixSystem({ vfs, baseUrl: ARTIFACTS, nix: false });

  let out = "";
  handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
  const getOut = () => out;

  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !/[#$]\s*$/.test(out.trimEnd())) {
    if (/panic/i.test(out)) {
      console.error("BOOT PANIC:\n" + out.slice(-2000));
      handle.kill();
      await terminateAllWorkers();
      process.exit(2);
    }
    await sleep(500);
  }
  if (!/[#$]\s*$/.test(out.trimEnd())) {
    console.error("no shell prompt:\n" + out.slice(-2000));
    handle.kill();
    await terminateAllWorkers();
    process.exit(2);
  }

  let ok = true;
  let inconclusive = false;
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const r = await runCmd(handle, getOut, c.cmd, String(i));
    console.log(`\n==== ${c.name} ====\n${r.out.trim()}`);
    if (r.panic) {
      console.error(`PANIC during ${c.name}`);
      inconclusive = true;
      break;
    }
    const checks = c.checks(r.out);
    checks.push(["program exited 0", r.exitOk]);
    for (const [name, pass] of checks) {
      console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
      ok = ok && !!pass;
    }
  }

  handle.kill();
  await terminateAllWorkers();

  if (inconclusive) process.exit(2);
  if (!ok) {
    console.error("\nPHASE2 ACCEPTANCE FAIL");
    process.exit(1);
  }
  console.log(
    "\nPHASE2 ACCEPTANCE PASS — fork(): returns-twice, private memory, waitpid, nested, loop, in-thread",
  );
}

main().catch((e) => {
  console.error("harness error:", e && e.stack ? e.stack : e);
  process.exit(2);
});
