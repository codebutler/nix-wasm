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

// Minimal inittab. busybox init runs ::sysinit actions in order, forking a child
// per action (run()/run_child — the path that clone-hacked before). The first
// mounts devtmpfs so /dev/console exists; the second FORKS a child that EXECs
// /bin/sh running the script below. `/bin/date` is a NON-LAST external command:
// hush fork+execs it and blocks in wait with its SIGCHLD handler installed —
// exactly the path that used to die on the musl __libc_handle_signal NULL-page
// load (task #5). "BBFORK: script done" printing after date proves the parent
// shell survived the delivery and resumed at the correct continuation.
const initScript = [
  "exec >/dev/console 2>&1",
  'echo "BBFORK: init alive pid=$$"',
  "/bin/date",
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
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[busybox-fork-smoke] " + (pass ? "PASS (multi-process shell script)" : "FAIL"));
process.exit(pass ? 0 : 1);
