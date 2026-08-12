// busybox-fork-smoke.mjs — #131 slice 1: boot the REAL-FORK busybox as PID 1 on
// the software MMU and prove a full multi-process SHELL SCRIPT runs.
//
// This is the payoff of the fork+exec foundation (fork-exec-smoke): the NOMMU
// clone-with-fn busybox (userspace/busybox.nix) NULL-derefs in its steady-state
// spawn/reap loop under the per-process-page-table MMU. The real-fork busybox
// (userspace/busybox-fork.nix — CONFIG_NOMMU=n, stock fork()+exec, muslFork
// asyncify seam, no clone hack) instead spawns children through real COW-fork.
// We boot it with a minimal inittab whose ::sysinit action forks a child that
// execs /bin/sh -c '<script>'; the script runs a builtin, then a NON-LAST
// EXTERNAL command (/bin/date — hush fork+execs it and WAITS, with hush's
// HUSH_FAST SIGCHLD handler live), then a final witness echo. The final witness
// proves the WHOLE multi-process chain: init fork+exec, shell fork+exec+wait of
// an external command, SIGCHLD handler delivery (the musl __libc_handle_signal
// NULL-page bug this once exposed — see userspace/busybox-fork.nix HISTORY),
// and the parent shell resuming correctly after the wait.
//
//   MMU_VMLINUX=$(nix build .#kernel-mmu-a2 --print-out-paths)/vmlinux.wasm
//   BUSYBOX_FORK=$(nix build .#userspace-busybox-fork --print-out-paths)/bin
//   node runtime/demo/node/busybox-fork-smoke.mjs
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const bbDir = process.env.BUSYBOX_FORK; // $out/bin of .#userspace-busybox-fork
if (!vmlinuxPath || !bbDir) {
  console.error(
    "busybox-fork-smoke: set MMU_VMLINUX (.#kernel-mmu-a2) and BUSYBOX_FORK (.#userspace-busybox-fork /bin dir)",
  );
  process.exit(1);
}

const enc = new TextEncoder();

// newc cpio with regular-file AND symlink support (busybox ships as one binary
// plus a symlink-per-applet; the fork+exec test needs the applet symlinks so sh
// can exec external /bin/<applet> images rather than shell builtins).
function cpioNewc(entries) {
  const chunks = [];
  let ino = 1;
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const hdr = (name, mode, size) => {
    const h =
      "070701" +
      [ino++, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, name.length + 1, 0]
        .map((x) => x.toString(16).padStart(8, "0"))
        .join("");
    const nameB = enc.encode(name + "\0");
    const head = new Uint8Array(110 + nameB.length + pad4(110 + nameB.length));
    head.set(enc.encode(h), 0);
    head.set(nameB, 110);
    return head;
  };
  for (const e of entries) {
    const data = e.data ? e.data : new Uint8Array(0);
    chunks.push(hdr(e.name, e.mode, data.length));
    if (data.length) {
      const body = new Uint8Array(data.length + pad4(data.length));
      body.set(data, 0);
      chunks.push(body);
    }
  }
  chunks.push(hdr("TRAILER!!!", 0, 0));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Assert an EXACT marker value in the transcript: NAME=<value>, matched by the
// value's shell EXPANSION (never the echoed command text — the #96 lesson).
// Anchored to a LINE START (^, multiline) so a marker can only match a real
// echoed output line, never a mid-line substring (e.g. inside an echoed
// command); \r? tolerates the console's CRLF line endings. Returns true/logs
// a mismatch (missing marker, or a stale/garbage $?) rather than throwing, so
// the caller can report every failing check in one pass.
function assertMarker(snap, name, expected) {
  const m = snap.match(new RegExp("^" + name + "=(\\S+?)\\r?$", "m"));
  const got = m ? m[1] : undefined;
  const ok = got === expected;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}=${got ?? "<missing>"} (expected ${expected})`);
  return ok;
}

// Minimal inittab. busybox init runs ::sysinit actions in order, forking a child
// per action (run()/run_child — the path that clone-hacked before). The first
// mounts devtmpfs so /dev/console exists; the second FORKS a child that EXECs
// /bin/sh running the script below. `/bin/date` is a NON-LAST external command:
// hush fork+execs it and blocks in wait with its SIGCHLD handler installed —
// exactly the path that used to die on the musl __libc_handle_signal NULL-page
// load (task #5). "BBFORK: script done" printing after date proves the parent
// shell survived the delivery and resumed at the correct continuation.
//
// Exit-status assertions (#188/#189): a busybox build whose shell ABORTS on
// every forked child (musl's wasm longjmp is an abort() stub — nix-wasm#188)
// still printed all the right STDOUT markers here (children write before
// aborting) while every single $? was garbage, and this smoke PASSED anyway
// — it only ever waited for a stdout regex, never checked an exit status.
// These five checks close that gap: $(), a bare subshell, an external/applet
// command, an if/else branch, and a pipeline all assert their EXACT `$?`, so
// a shell that can't propagate real child exit statuses fails loudly again.
// Each marker uses `NAME=$?` / `NAME=<word>` — the value comes from a shell
// EXPANSION printed by echo, never from an echoed command line (the #96
// lesson: matching the echoed input instead of its expansion made a stale
// marker look like a fresh pass before).
const initScript = [
  "exec >/dev/console 2>&1",
  'echo "BBFORK: init alive pid=$$"',
  "/bin/date",
  "x=$(exit 3)",
  'echo "CMDSUB_RC=$?"', // command substitution: real exit(3) inside $()
  "(exit 5)",
  'echo "SUBSH_RC=$?"', // bare ( ) subshell: forks, must propagate exit(5)
  "false",
  'echo "FALSE_RC=$?"', // external/applet false: exit(1)
  "if (exit 0); then r=then; else r=else; fi",
  'echo "IFELSE_TAKEN=$r"', // real branch taken, via a variable expansion — not a literal in the command text
  "true | false",
  'echo "PIPE_RC=$?"', // pipeline status: last stage (false) => exit(1)
  'echo "BBFORK: script done"',
].join("; ");
const inittab =
  "::sysinit:/bin/mount -t devtmpfs devtmpfs /dev\n" +
  "::sysinit:/bin/sh -c '" +
  initScript.replace(/'/g, "'\\''") +
  "'\n";

// Walk the busybox /bin dir: the binary as a regular file, everything else as a
// symlink → busybox (exactly how it is installed on disk).
const bbEntries = [];
for (const name of readdirSync(bbDir)) {
  const st = lstatSync(join(bbDir, name));
  if (st.isSymbolicLink()) {
    bbEntries.push({
      name: "bin/" + name,
      mode: 0o120777,
      data: enc.encode(readlinkSync(join(bbDir, name))),
    });
  } else if (st.isFile()) {
    bbEntries.push({
      name: "bin/" + name,
      mode: 0o100755,
      data: new Uint8Array(readFileSync(join(bbDir, name))),
    });
  }
}

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "proc", mode: 0o040755 },
  { name: "etc", mode: 0o040755 },
  { name: "bin", mode: 0o040755 },
  { name: "etc/inittab", mode: 0o100644, data: enc.encode(inittab) },
  // /init = busybox (argv[0] basename "init" → busybox runs the init applet).
  { name: "init", mode: 0o100755, data: new Uint8Array(readFileSync(join(bbDir, "busybox"))) },
  ...bbEntries,
]);

const dir = mkdtempSync(join(tmpdir(), "busybox-fork-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
let pass = false;
try {
  // The final witness line is printed by the shell AFTER fork+wait-ing the
  // external /bin/date — proving the full multi-process script chain.
  const ok = await s.waitForOutput(/BBFORK: script done/, 180000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[busybox-fork-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  pass = !!ok;
  if (pass) {
    const snap = s.snapshot();
    for (const line of snap.split("\n")) {
      if (/BBFORK:|Run \/init/.test(line)) console.log("  " + line.trim());
    }
    // #188/#189: exit-status correctness, not just stdout shape. A shell
    // that aborts every forked child instead of returning its real exit
    // status (musl wasm longjmp==abort) must fail HERE. Every check runs
    // (no short-circuit) so a re-run shows every failing marker at once.
    const rcChecks = [
      assertMarker(snap, "CMDSUB_RC", "3"),
      assertMarker(snap, "SUBSH_RC", "5"),
      assertMarker(snap, "FALSE_RC", "1"),
      assertMarker(snap, "IFELSE_TAKEN", "then"),
      assertMarker(snap, "PIPE_RC", "1"),
    ];
    pass = rcChecks.every(Boolean);
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log(
  "\n[busybox-fork-smoke] " + (pass ? "PASS (multi-process shell script + exit statuses)" : "FAIL"),
);
process.exit(pass ? 0 : 1);
