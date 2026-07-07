// fork-exec-smoke.mjs — the fork + EXEC + wait gate on the software MMU
// (#131/#129). Boots fork-exec-init (asyncify seam, RAW — the engine
// instruments it at load) under .#kernel-mmu-a2 (patch 0026) with an initramfs
// that also carries /bin/exec-child (also raw). Proves the capstone
// multi-process primitive — exactly what busybox init does: fork() → the child
// execve()s a fresh image (new mm/pgd, the COW'd address space discarded) → the
// parent blocks in waitpid() and reaps the child's exit(7).
//
//   MMU_VMLINUX=$(nix build .#kernel-mmu-a2 --print-out-paths)/vmlinux.wasm
//   FORK_EXEC_INIT=$(nix build .#fork-exec-init --print-out-paths)/bin/fork-exec-init
//   EXEC_CHILD=$(nix build .#exec-child --print-out-paths)/bin/exec-child
//   node runtime/demo/node/fork-exec-smoke.mjs
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const initPath = process.env.FORK_EXEC_INIT;
const childPath = process.env.EXEC_CHILD;
if (!vmlinuxPath || !initPath || !childPath) {
  console.error(
    "fork-exec-smoke: set MMU_VMLINUX (.#kernel-mmu-a2), FORK_EXEC_INIT (.#fork-exec-init), EXEC_CHILD (.#exec-child)",
  );
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

// RAW binaries — the engine instruments each at load (instrument-on-load,
// pt_base != 0). /init = fork-exec-init, /bin/exec-child = the exec target.
const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "bin", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: new Uint8Array(readFileSync(initPath)) },
  { name: "bin/exec-child", mode: 0o100755, data: new Uint8Array(readFileSync(childPath)) },
]);
const dir = mkdtempSync(join(tmpdir(), "fork-exec-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
let pass = false;
try {
  const ok = await s.waitForOutput(/FORK-EXEC: OK/, 150000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[fork-exec-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  const snap = s.snapshot();
  const alive = snap.includes("FORK-EXEC: init alive");
  // the child's line comes from the EXEC'd fresh image (exec-child), proving
  // fork → execve into a new mm/pgd worked.
  const childExeced = snap.includes("FORK-EXEC: child exec'd a fresh image, exiting 7");
  // the parent reaped ALL N children (each exec'd a fresh image then exited 7),
  // across N concurrent user tasks + N page tables + the pt_base-restore churn.
  const parentReaped =
    /FORK-EXEC: parent reaped 0x00000003 of 0x00000003 children status=0x00000007/.test(snap);
  pass = !!ok && alive && childExeced && parentReaped;
  if (ok && !childExeced) console.log("[fork-exec-smoke] child EXEC missing/incorrect");
  if (ok && !parentReaped) console.log("[fork-exec-smoke] parent REAP missing/incorrect");
  if (pass) {
    for (const line of snap.split("\n")) {
      if (/FORK-EXEC: (child exec|parent reaped)/.test(line)) console.log("  " + line.trim());
    }
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[fork-exec-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
