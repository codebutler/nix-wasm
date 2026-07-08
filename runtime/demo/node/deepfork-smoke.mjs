// deepfork-smoke.mjs — #131 diagnosis: does fork()+wait() from a DEEP call stack
// resume all the way back up? PID1 (deepfork-init) recurses DEPTH deep, forks +
// waits at the bottom, then returns through every frame to main and prints
// "DEEP: ALL-OK". "DEEP: bottom" without "ALL-OK" == the deep rewind is broken.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const initPath = process.env.DEEPFORK_INIT;
if (!vmlinuxPath || !initPath) {
  console.error("deepfork-smoke: set MMU_VMLINUX and DEEPFORK_INIT");
  process.exit(1);
}
const enc = new TextEncoder();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";

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

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: new Uint8Array(readFileSync(initPath)) },
]);
const dir = mkdtempSync(join(tmpdir(), "deepfork-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

const s = await bootNode({ nix: false, baseUrl: pathToFileURL(dir + "/").href });
const dec = new TextDecoder();
let buf = "";
s.console(0).onData((bytes) => {
  buf += dec.decode(bytes);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (/DEEP:|panic|kill init|SIGSEGV/.test(line)) console.log(stamp() + " | " + line.trim());
  }
});
await s
  .waitForOutput(/DEEP: ALL-OK|Kernel panic|Attempted to kill init/, 120000)
  .catch((e) => console.log(stamp() + " WAIT-ERR " + (e && e.message)));
const snap = s.snapshot();
const pass = /DEEP: ALL-OK/.test(snap);
console.log(stamp() + " [deepfork-smoke] " + (pass ? "PASS" : "FAIL"));
s.kill();
process.exit(pass ? 0 : 1);
