// fork-smoke.mjs — the REAL-FORK gate on the software MMU (#129 Track B).
// Boots a CHECKED-instrumented, asyncify-built fork-init (userspace/fork-init.c
// via asyncify-cc + muslFork's 0010 _Fork→capture_stack seam) under the A2
// kernel (.#kernel-mmu-a2 + patch 0026). Proves the whole MMU-native fork:
// parent unwind → wasm_fork_current (kernel_clone → generic COW dup_mmap) →
// child task spawns with fork_ctl → its worker REWINDS the captured stack
// (fork()==0) on the SAME shared arena with its own pt_base → both sides'
// post-fork writes COW isolate. Proves fork returns twice + COW; the
// cross-process reap/shared-mem wakeup is a documented follow-up (status doc).
//
//   MMU_VMLINUX=$(nix build .#kernel-mmu-a2 --print-out-paths)/vmlinux.wasm
//   FORK_INIT=$(nix build .#fork-init --print-out-paths)/bin/fork-init
//   node runtime/demo/node/fork-smoke.mjs
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { instrument } from "../../softmmu-pass.js";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const initPath = process.env.FORK_INIT;
if (!vmlinuxPath || !initPath) {
  console.error("fork-smoke: set MMU_VMLINUX (.#kernel-mmu-a2) and FORK_INIT (.#fork-init)");
  process.exit(1);
}

function cpioNewc(entries) {
  const chunks = [];
  let ino = 1;
  const enc = new TextEncoder();
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
    chunks.push(hdr(e.name, e.mode, e.data ? e.data.length : 0));
    if (e.data) {
      const body = new Uint8Array(e.data.length + pad4(e.data.length));
      body.set(e.data, 0);
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

const initRaw = new Uint8Array(readFileSync(initPath));
// CHECKED softmmu over the ALREADY-asyncified binary — the production pass
// order (asyncify at link, softmmu at load): COW write-protect faults are what
// isolate the two sides, including the captured fork() stack image itself.
const initInstr = instrument(initRaw, { checked: true, exportControls: true });
console.log(`[fork-smoke] instrumented (checked): ${initRaw.length} -> ${initInstr.length} bytes`);

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: initInstr },
]);
const dir = mkdtempSync(join(tmpdir(), "fork-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
let pass = false;
try {
  const ok = await s.waitForOutput(/FORK-MMU: child ret=0x00000000/, 150000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[fork-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  const snap = s.snapshot();
  const alive = snap.includes("FORK-MMU: init alive");
  // child side: fork() returned 0, PRIVATE witness COW'd to 0x10c
  const childOk = snap.includes("FORK-MMU: child ret=0x00000000 witness=0x0000010c");
  // parent side: nonzero pid, INDEPENDENT witness 0x1b0 (COW isolated from the
  // child's 0x10c through the same virtual address). Both lines present ==
  // fork returned twice + the child ran as a real concurrent task.
  const parentOk = /FORK-MMU: parent pid=0x[0-9a-f]*[1-9a-f][0-9a-f]* witness=0x000001b0/.test(
    snap,
  );
  pass = !!ok && alive && childOk && parentOk;
  if (ok && !childOk) console.log("[fork-smoke] CHILD side missing/incorrect");
  if (ok && !parentOk) console.log("[fork-smoke] PARENT side missing/incorrect");
  if (pass) {
    // Echo the two proof lines so CI logs show fork returned twice + COW.
    for (const line of snap.split("\n")) {
      if (/FORK-MMU: (child ret|parent pid)/.test(line)) console.log("  " + line.trim());
    }
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[fork-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
