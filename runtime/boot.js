// boot.js — boot the linux-wasm kernel and mount a VFS into it over 9P.
//
// Wiring:
//   - compile vmlinux.wasm + load the initramfs (BusyBox + pc-init),
//   - create the SAB 9P ring and run the 9P server ON THIS THREAD via
//     transport.run() (an Atomics.waitAsync loop — non-blocking), so it can use
//     the real VFS (which may be window-bound or Node-side). The kernel's
//     task-workers are the ones that block (on the ring's reply word), not the
//     host thread,
//   - hand the ring into the kernel host, which spawns a Web Worker per
//     CPU/task over a shared WebAssembly.Memory. Each task worker's
//     wasm_driver_9p_request drives the ring → our 9P server.
//
// Multi-tty: the kernel registers HVC_CONSOLES hvc lines (hvc0..hvc{N-1});
// pc-init respawns a shell on each. `bootLinux()` returns a handle exposing
// every console as an independent byte duplex —
// `console(vtermno) → { write, onData, resize, reset }` — plus `consoleCount`
// and `kill()`. Output that arrives before a renderer attaches is buffered PER
// CONSOLE so no boot/prompt bytes are lost.

import { linux } from "./kernel-host.js";
import { Ring } from "./ninep/ring.js";
import { createNinePServer } from "./ninep/server.js";
import { createNinePTransport } from "./ninep/transport.js";

// Number of hvc consoles the kernel registers (hvc0..hvc{N-1}) — one per Linux
// terminal window; hvc0 also carries the kernel boot log. MUST match the
// kernel's HVC_WASM_NR (patches/0002-hvc-wasm-multi-console.patch). hvc caps at
// 16 (MAX_NR_HVC_CONSOLES).
export const HVC_CONSOLES = 8;

// maxcpus=1: a terminal needs no SMP parallelism, and single-CPU sidesteps the
// linux-wasm secondary-CPU bringup fragility. Paired with patches/0004 (which
// pins every user task to the boot CPU and never hot-plugs a CPU on demand) the
// guest runs strictly on CPU0 — which fixed most of the #108 "Aiee, killing
// interrupt handler!" panic (the old affinity code cpu_device_up()'d a fresh
// CPU per concurrent user task even at maxcpus=1, so busy multi-terminal
// sessions ran truly parallel and corrupted shared state). The residual
// single-CPU panic under extreme load (#118 — 8 terminals in tight fork loops)
// was a kernel shadow-stack overflow: each task had a 4K unguarded stack in
// linear memory, and deep reap/signal paths overran it into the neighbouring
// slab page (the captured wild pid->numbers[].ns). Fixed by patches/0005 (16K
// stacks) + CONFIG_SCHED_STACK_END_CHECK (a future overflow BUGs loudly at the
// culprit instead of corrupting silently). Repro: scripts/linux-demo/stress8.mjs.
const DEFAULT_CMDLINE =
  "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Boot a linux-wasm kernel with a VFS mounted at /mnt/pc over 9P.
 *
 * @param {{
 *   vfs: any,                         // the async typed-record VFS (MemVfs in tests, pc vfs in prod)
 *   variant?: string,                 // 'wasm32_nommu' (default) | 'wasm64_nommu'
 *   vmlinuxUrl: string,               // URL of the kernel wasm (required)
 *   initrdUrl: string,                // URL of the initramfs.cpio.gz (required)
 *   cmdline?: string,                 // kernel command line
 *   consoleCount?: number,            // hvc consoles to expose (default HVC_CONSOLES)
 *   onLog?: (text: string) => void,   // host/diagnostic log sink
 *   nixStore?: any,                   // a read-only /nix store VFS (createNixClosureStore); registered as the `nix` 9P export — carries the whole userspace + toolchain closure
 *   nixCache?: any,                   // a read-only Nix binary cache VFS (createNixCacheExport); registered as the `nixcache` 9P export, mounted at /nix-cache so in-guest nix substitutes from it (#141)
 *   onModuleCached?: () => void,      // fires when a streamed user binary finishes compiling + caching host-side — lets the UI close a "loading <tool>…" indicator (#141)
 * }} opts
 * @returns {Promise<{
 *   consoleCount: number,
 *   console(vtermno: number): { write(b: Uint8Array|string): void, onData(cb: (b: Uint8Array)=>void): () => void, resize(c: number, r: number): void, reset(): void },
 *   kill(): void,
 * }>}
 */
export async function bootLinux(opts) {
  const vfs = opts.vfs;
  const variant = opts.variant || "wasm32_nommu";
  const consoleCount = opts.consoleCount || HVC_CONSOLES;
  const vmlinuxUrl = opts.vmlinuxUrl;
  const initrdUrl = opts.initrdUrl;
  if (!vmlinuxUrl || !initrdUrl) {
    throw new Error("bootLinux: vmlinuxUrl and initrdUrl are required");
  }
  const onLog = opts.onLog || (() => {});

  const [vmlinux, initrd] = await Promise.all([
    WebAssembly.compile(await (await fetch(vmlinuxUrl)).arrayBuffer()),
    (await fetch(initrdUrl)).arrayBuffer(),
  ]);

  // Per-console output fan-out. Bytes for a console with no attached renderer
  // are buffered so its boot/prompt output survives the gap before onData().
  /** @type {Map<number, Set<(b: Uint8Array) => void>>} */
  const sinks = new Map();
  /** @type {Map<number, Uint8Array[]>} */
  const backlog = new Map();

  // The kernel host calls this as (vtermno, text) for every console write.
  function emit(vtermno, text) {
    const vt = vtermno | 0;
    const bytes = enc.encode(text);
    const set = sinks.get(vt);
    if (!set || set.size === 0) {
      const q = backlog.get(vt) || [];
      q.push(bytes);
      backlog.set(vt, q);
      return;
    }
    for (const cb of set) cb(bytes);
  }

  // 9P transport: ring + server, serviced on this thread (real VFS lives here).
  // msize is the max bytes per 9P request/reply. Each round-trip pays cooperative
  // guest↔host Atomics-scheduling latency, so big file I/O is round-trip-bound:
  // exec'ing the 25 MB nix.wasm at the old 64 KB took ~390 round-trips (~6 s);
  // 512 KB cuts that to ~50 (~2.5 s). 512 KB is the kernel transport's cap
  // (P9_CB_MAXSIZE, patches/0001-9p-trans_cb.patch) — the practical max here,
  // and the remaining cost is the tool's own startup, not the read. The ring
  // and the negotiated server msize must agree; pc-init mounts request it too.
  const NINEP_MSIZE = 512 * 1024;
  const ring = Ring.create(8, NINEP_MSIZE);
  // Register the user VFS at the root aname; add the /nix store as a second
  // export when provided (Phase E/N1 — the guest mounts it at /nix via aname=nix,
  // sharing this one ring; the server isolates the two mounts by connection id).
  const exports = { "/": vfs };
  if (opts.nixStore) exports.nix = opts.nixStore; // read-only /nix store: the whole userspace + toolchain closure (lazy big files)
  if (opts.nixCache) exports.nixcache = opts.nixCache; // read-only Nix binary cache, pc-init mounts at /nix-cache + substituters=file:///nix-cache (#141)
  const transport = createNinePTransport({
    ring,
    server: createNinePServer({ exports, msize: NINEP_MSIZE }),
  });
  transport.run(); // Atomics.waitAsync server loop; self-driving, resolves on stop()

  const workerUrl = new URL("./kernel-worker.js", import.meta.url);
  const os = await linux({
    worker_url: workerUrl,
    variant,
    vmlinux,
    boot_cmdline: opts.cmdline || DEFAULT_CMDLINE,
    initrd,
    log: onLog,
    console_write: emit,
    ninep_ring: ring.buffer,
    on_module_cached: opts.onModuleCached, // fires when a streamed binary finishes compiling+caching
  });

  let alive = true;
  return {
    /** How many hvc consoles this kernel exposes (hvc0..hvc{N-1}). */
    consoleCount,

    /** A byte duplex bound to one hvc console (vtermno = console index). */
    console(vtermno) {
      const vt = vtermno | 0;
      return {
        /** Feed bytes/text to this console's tty (stdin). */
        write(data) {
          os.key_input(vt, typeof data === "string" ? data : dec.decode(data));
        },
        /** Subscribe to this console's output; replays any pre-attach backlog. */
        onData(cb) {
          let set = sinks.get(vt);
          if (!set) sinks.set(vt, (set = new Set()));
          set.add(cb);
          const q = backlog.get(vt);
          if (q && q.length) {
            for (const b of q) cb(b);
            backlog.set(vt, []);
          }
          return () => set.delete(cb);
        },
        /** Set this console's window size (TIOCSWINSZ → __hvc_resize). */
        resize(cols, rows) {
          os.set_winsize(vt, cols, rows);
        },
        /** Drop this console's buffered pre-attach output, so a recycled
         *  console doesn't replay the previous tenant's bytes on reuse. */
        reset() {
          backlog.set(vt, []);
        },
      };
    },

    /** Stop the 9P server loop. (Worker teardown is the caller's concern.) */
    kill() {
      if (!alive) return;
      alive = false;
      transport.stop();
    },
  };
}

export { DEFAULT_CMDLINE };
