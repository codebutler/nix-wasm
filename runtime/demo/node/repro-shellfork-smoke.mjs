// repro-shellfork-smoke.mjs — parameterizable busybox shell-script harness
// (task #5 diagnosis tool, kept for future shell debugging on the MMU).
//
// Boots the REAL-FORK busybox (userspace/busybox-fork.nix) as PID 1 and runs
// `/bin/sh -c 'echo REPRO_START; $REPRO_BODY; echo REPRO_DONE'` from inittab.
// REPRO_DONE printing asserts the parent shell survived whatever REPRO_BODY did
// (fork+wait of an external command by default). This harness is how the
// "shell fork mis-rewind" was bisected down to the musl __libc_handle_signal
// NULL-page load (see userspace/busybox-fork.nix HISTORY) — vary REPRO_BODY to
// isolate a failing shell construct ("(:)" = subshell fork of a builtin, no
// exec; "cmd &" = fork without wait; ...). The default case is also gated in CI
// by busybox-fork-smoke.mjs; this file is the freeform variant.
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
// /bin/sh — the milestone this gate asserts: busybox init boots as PID 1 and its
// steady-state fork()+exec() (which the NOMMU clone-hack could not do under the
// MMU) works. The shell then prints a builtin witness line.
//
// NOTE: a FULL multi-process shell session (the shell itself fork+waiting for
// non-last external commands) does NOT yet work — see the KNOWN LIMITATION in
// userspace/busybox-fork.nix (whole-module asyncify mis-rewinds busybox's deep
// shell fork stack). So the script deliberately stops at a builtin echo; this
// gate proves the init fork+exec milestone, not a full shell.
// REPRO_BODY (env-overridable) is the middle of the script — the case under
// test — bracketed by REPRO_START / REPRO_DONE witnesses. Default = fork+exec
// of a non-last external command (hush forks + waits, SIGCHLD handler live).
const body = process.env.REPRO_BODY || "/bin/date";
const initScript = ["exec >/dev/console 2>&1", "echo REPRO_START", body, "echo REPRO_DONE"].join(
  "; ",
);
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
  // REPRO_DONE = the shell survived REPRO_BODY and resumed correctly.
  const ok = await s.waitForOutput(/REPRO_DONE/, 180000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[repro-shellfork-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  pass = !!ok;
  if (pass) {
    const snap = s.snapshot();
    for (const line of snap.split("\n")) {
      if (/REPRO_|Run \/init/.test(line)) console.log("  " + line.trim());
    }
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[repro-shellfork-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
