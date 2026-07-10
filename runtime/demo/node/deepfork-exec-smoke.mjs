// deepfork-exec-smoke.mjs — #131 diagnosis: exec'd task + DEEP fork+wait+resume.
// PID1 (deepfork-exec-init) fork+execs /bin/deepfork-child, which recurses deep,
// fork+waits at the bottom, and returns all the way up ("DEEP2: CHILD-ALL-OK"),
// then the init reaps it ("DEEP2: ALL-OK"). Missing ALL-OK == the exec'd+deep
// cell reproduces the busybox mis-rewind in a tiny asyncify-seam program.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const initPath = process.env.DEEPFORK_EXEC_INIT;
const childPath = process.env.DEEPFORK_CHILD;
if (!vmlinuxPath || !initPath || !childPath) {
  console.error("deepfork-exec-smoke: set MMU_VMLINUX, DEEPFORK_EXEC_INIT, DEEPFORK_CHILD");
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
  { name: "bin", mode: 0o040755 },
  { name: "init", mode: 0o100755, data: new Uint8Array(readFileSync(initPath)) },
  { name: "bin/deepfork-child", mode: 0o100755, data: new Uint8Array(readFileSync(childPath)) },
]);
const dir = mkdtempSync(join(tmpdir(), "deepfork-exec-smoke-"));
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
    // DEEP2 = init + the plain deepfork-child; DEEP3 = deepfork-sig-child (the
    // SIGCHLD-handler repro — same init, same cpio slot, different witness tag).
    if (/DEEP[23]:|panic|kill init|SIGSEGV|segfault|Unable|Oops|BUG/i.test(line))
      console.log(stamp() + " | " + line.trim());
  }
});
await s
  .waitForOutput(/DEEP2: ALL-OK|DEEP2: init reaped|Kernel panic|Attempted to kill init/, 120000)
  .catch((e) => console.log(stamp() + " WAIT-ERR " + (e && e.message)));
const snap = s.snapshot();
const pass = /DEEP2: ALL-OK/.test(snap);
if (!pass) console.log("\n── full transcript tail ──\n" + snap.slice(-4000));
console.log(stamp() + " [deepfork-exec-smoke] " + (pass ? "PASS" : "FAIL"));
s.kill();
process.exit(pass ? 0 : 1);
