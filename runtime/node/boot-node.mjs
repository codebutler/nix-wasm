// boot-node.mjs — boot the linux-wasm guest to a shell from Node, returning a
// session with raw consoles + an expect API (send/waitForOutput/waitForPrompt).
import { terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../index.js";
import { MemVfs } from "../ninep/mem-vfs.js";

// Artifacts: default to the env var, else the repo-relative web/artifacts dir.
// CI sets LINUX_WASM_ARTIFACTS to the `nix build` output dir.
const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
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
  // Bound each transcript so a wedged guest's console flood (e.g. respawning
  // gettys printing forever) can't OOM the main-thread JS heap during a long
  // diagnostic run. Keep the tail (where the prompt / probe output lives).
  const CAP = 1 << 20; // 1 MiB tail per console
  const tap = (n) => {
    if (tapped.has(n)) return;
    transcripts.set(n, "");
    handle.console(n).onData((bytes) => {
      let s = transcripts.get(n) + dec.decode(bytes);
      if (s.length > CAP) s = s.slice(s.length - CAP);
      transcripts.set(n, s);
    });
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
    dumpWtrace(n) {
      return handle.dumpWtrace ? handle.dumpWtrace(n) : [];
    },
    kill() {
      handle.kill(); // stops the 9P Atomics.waitAsync loop
      terminateAllWorkers(); // terminates the kernel worker_threads workers
    },
  };
}
