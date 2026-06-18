// boot-node.mjs — boot the linux-wasm guest to a shell from Node, returning a
// session with raw consoles + an expect API (send/waitForOutput/waitForPrompt).
import { terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../index.js";
import { MemVfs } from "../ninep/mem-vfs.js";

// Artifacts: default to the env var, else a conventional local path. CI sets
// LINUX_WASM_ARTIFACTS to the `nix build` output dir.
const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || "file:///home/vbvntv/Code/pc/vendor/linux-wasm/"; // local-dev fallback
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function bootNode(opts = {}) {
  const vfs = opts.vfs || MemVfs.from(opts.seed || { Home: {} });
  const handle = await bootNixSystem({
    vfs,
    baseUrl: opts.baseUrl || ARTIFACTS,
    nix: opts.nix !== false,
    consoleCount: opts.consoleCount,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
  });

  const transcripts = new Map();
  const tapped = new Set();
  const tap = (n) => {
    if (tapped.has(n)) return;
    transcripts.set(n, "");
    handle.console(n).onData((bytes) => transcripts.set(n, transcripts.get(n) + dec.decode(bytes)));
    tapped.add(n);
  };

  return {
    handle,
    consoleCount: handle.consoleCount,
    console: (n) => handle.console(n),
    snapshot(n = 0) {
      tap(n);
      return transcripts.get(n) || "";
    },
    send(s, n = 0) {
      handle.console(n).write(s);
    },
    async waitForOutput(re, ms = 15000, n = 0) {
      tap(n);
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (re.test(transcripts.get(n) || "")) return true;
        await sleep(200);
      }
      return false;
    },
    async waitForPrompt(ms = 45000, n = 0) {
      tap(n);
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const b = transcripts.get(n) || "";
        if (/panic/i.test(b)) throw new Error("KERNEL_PANIC");
        if (/[#$]\s*$/.test(b.trimEnd())) return true;
        await sleep(500);
      }
      return false;
    },
    kill() {
      handle.kill(); // stops the 9P Atomics.waitAsync loop
      terminateAllWorkers(); // terminates the kernel worker_threads workers
    },
  };
}
