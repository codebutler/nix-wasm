// mmu-smoke.mjs — the FIRST full-stack software-MMU boot (#128 A1): a
// CONFIG_MMU=y vmlinux boots a single-file initramfs whose /init is a
// softmmu-INSTRUMENTED static binary (userspace/mmu-init.c). Proves, end to
// end: the MMU exec path (kernel binary buffer -> engine instantiation with
// pt_base -> __mmu_start), the software uaccess table-walk (write() payloads
// cross through it), VM_LOCKED population, translated scalar/bulk user
// execution, and the per-task-instance pt_base model.
//
// Inputs (env):
//   MMU_VMLINUX  path to the CONFIG_MMU=y vmlinux.wasm (not yet a nix attr —
//                built from the WIP patch; see docs/superpowers/notes/)
//   MMU_INIT     path to the UNinstrumented mmu-init binary
//                (nix build .#mmu-init -> $out/bin/mmu-init)
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { instrument } from "../../softmmu-pass.js";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const initPath = process.env.MMU_INIT;
if (!vmlinuxPath || !initPath) {
  console.error("mmu-smoke: set MMU_VMLINUX and MMU_INIT");
  process.exit(1);
}

// ---- newc cpio writer (just enough for: /dev dir + /init file) --------------
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

// ---- assemble the artifacts dir ---------------------------------------------
const initRaw = new Uint8Array(readFileSync(initPath));
const initInstr = instrument(initRaw, { exportControls: true });
console.log(
  `[mmu-smoke] instrumented init: ${initRaw.length} -> ${initInstr.length} bytes`,
);

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: initInstr },
]);
const dir = mkdtempSync(join(tmpdir(), "mmu-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));
console.log(`[mmu-smoke] artifacts: ${dir}`);

// expected checksum: sum_{i<16384} (i*2654435761 mod 2^32) mod 2^32
const K = 2654435761n;
const expected = (K * ((16383n * 16384n) / 2n)) % 4294967296n;
const expHex = "0x" + expected.toString(16).padStart(8, "0");

// ---- boot -------------------------------------------------------------------
const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
let pass = false;
try {
  const ok = await s.waitForOutput(/MMU-SMOKE: OK/, 120000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[mmu-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  const snap = s.snapshot();
  const checksumOk = snap.includes(`MMU-SMOKE: checksum ${expHex}`);
  const bulkOk = snap.includes("MMU-SMOKE: bulk OK");
  pass = !!ok && checksumOk && bulkOk;
  if (ok && !checksumOk) console.log(`[mmu-smoke] checksum MISMATCH (want ${expHex})`);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}
console.log("\n[mmu-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
