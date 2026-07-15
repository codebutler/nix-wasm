// mmu-smoke-a2.mjs — the A2 DEMAND-PAGING gate (#128). Boots a CHECKED-mode
// softmmu-instrumented init (userspace/mmu-init-a2.c) under the A2 kernel
// (.#kernel-mmu-a2, VM_LOCKED/populate dropped). Proves the full demand-paging
// path: the present-checked translate faults on not-present pages via
// __wasm_syscall_2(244, ea, kind) -> do_page_fault -> handle_mm_fault, then
// re-walks — a large demand-zero mmap + deep stack growth both fault-in and
// checksum correctly.
//
//   MMU_VMLINUX=$(nix build .#kernel-mmu-a2 --print-out-paths)/vmlinux.wasm
//   MMU_INIT=$(nix build .#mmu-init-a2 --print-out-paths)/bin/mmu-init-a2
//   node runtime/demo/node/mmu-smoke-a2.mjs
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
  console.error("mmu-smoke-a2: set MMU_VMLINUX (.#kernel-mmu-a2) and MMU_INIT (.#mmu-init-a2)");
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
// CHECKED mode: the present-checked translate that demand-pages via the fault
// syscall — the whole point of A2.
//
// inlineLimit: 1 (#164 helper-path real-boot gate) — force EVERY function onto
// the >6MB helper-call translate (__mmu_translate_ck) instead of the inline
// walk. nix.wasm's __wasm_apply_data_relocs (fn #2, 10.7MB inline) is the ONLY
// startup function big enough to take this path, so it is otherwise NEVER
// boot-exercised: the nix-env Config::set "bina" fault is the first time it
// runs on a real kernel. inlineLimit:1 makes this tiny init (incl. the 128 MiB
// fragmented pointer-chase below) drive its ENTIRE execution through the helper
// translate, so a helper-path mis-encode corrupts here in the ~3-min a2 smoke.
// The helper path is size-independent (a call is a call at 10B or 10MB), so
// this is a faithful correctness test of it. If this PASSES, the helper path is
// exonerated on real hardware; the inline path already passed at the default
// 6MB limit (run #347), so both translate paths are then boot-proven.
const initInstr = instrument(initRaw, { checked: true, exportControls: true, inlineLimit: 1 });
console.log(
  `[mmu-smoke-a2] instrumented (checked, inlineLimit=1 -> all-helper): ${initRaw.length} -> ${initInstr.length} bytes`,
);

// expected mmap checksum: sum over 8MiB / 4KiB pages of ((i>>12) & 0xff)
let expSum = 0;
for (let i = 0; i < 8 * 1024 * 1024; i += 4096) expSum += (i >> 12) & 0xff;
const expHex = "0x" + (expSum >>> 0).toString(16).padStart(8, "0");

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: initInstr },
]);
const dir = mkdtempSync(join(tmpdir(), "mmu-smoke-a2-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
let pass = false;
try {
  const ok = await s.waitForOutput(/MMU-A2: OK/, 150000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") {
      console.log("[mmu-smoke-a2] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    return false;
  });
  const snap = s.snapshot();
  const alive = snap.includes("MMU-A2: checked init alive");
  const mmapOk = snap.includes(`MMU-A2: mmap checksum ${expHex}`);
  const stackOk = /MMU-A2: stack-grow 0x[0-9a-f]{8}/.test(snap);
  // COW via the shared zeropage: a first-READ maps the zeropage RO (sees 0x00),
  // the WRITE write-protect-faults into do_wp_page and the re-read sees 0xab.
  const cowOk = snap.includes("MMU-A2: cow ro-read 0x00000000 wr-read 0x000000ab");
  // mprotect narrow->read->widen->write round-trip returned 1.
  const mprotectOk = snap.includes("MMU-A2: mprotect 0x00000001");
  // Large fragmented pointer-chase (128 MiB / ~32 pgd entries): every stored
  // ->next dereferences correctly and every ->tag round-trips (sumok=1). A
  // multi-pgd translation bug corrupts a node -> "chase CORRUPT" (clean hang,
  // no OK). This is the fast repro for the nix-env Config::set "bina" fault.
  const chaseOk =
    /MMU-A2: chase nodes 0x[0-9a-f]{8} seen 0x[0-9a-f]{8} sumok 0x00000001/.test(snap) &&
    !snap.includes("chase CORRUPT") &&
    !snap.includes("chase mmap FAIL");
  // Low-VA .bss pointer-chase (128 MiB static array, exec-mapped at low VA):
  // the discriminating control vs the high-VA mmap chase for the nix-env
  // Config::set fault. A multi-pgd translation bug specific to the exec-time
  // data-segment mapping / low VA corrupts here -> "bsschase CORRUPT".
  const bssChaseOk =
    /MMU-A2: bsschase nodes 0x[0-9a-f]{8} seen 0x[0-9a-f]{8} sumok 0x00000001/.test(snap) &&
    !snap.includes("bsschase CORRUPT");
  pass = !!ok && alive && mmapOk && stackOk && cowOk && mprotectOk && chaseOk && bssChaseOk;
  if (ok && !bssChaseOk)
    console.log("[mmu-smoke-a2] low-VA .bss pointer-chase FAILED (exec-data/low-VA translation)");
  if (ok && !mmapOk) console.log(`[mmu-smoke-a2] mmap checksum MISMATCH (want ${expHex})`);
  if (ok && !cowOk) console.log("[mmu-smoke-a2] COW write-protect FAULT path FAILED");
  if (ok && !mprotectOk) console.log("[mmu-smoke-a2] mprotect round-trip FAILED");
  if (!chaseOk)
    console.log("[mmu-smoke-a2] large fragmented pointer-chase FAILED (see BAD@/CORRUPT)");
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}
console.log("\n[mmu-smoke-a2] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
