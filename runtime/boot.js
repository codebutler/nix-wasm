// boot.js — boot the linux-wasm kernel and mount a VFS into it over 9P.
//
// Wiring:
//   - compile vmlinux.wasm + load the initramfs (BusyBox + pc-init),
//   - create the 9P server (createNinePServer) bound to the real VFS (which may
//     be window-bound or Node-side) and hand it to the kernel host as
//     `ninep_server`. The guest mounts it over the stock virtio-9p transport
//     (issue #10): the main-thread virtio-9p host devices run server.handle()
//     and raise the completion IRQ; the kernel's task-workers park in
//     p9_client_rpc until woken. No SAB ring / no synchronous host import.
//   - the kernel host spawns a Web Worker per CPU/task over a shared
//     WebAssembly.Memory; a worker forwards each 9P vq kick to the main thread.
//
// Multi-tty: the kernel registers HVC_CONSOLES hvc lines (hvc0..hvc{N-1});
// pc-init respawns a shell on each. `bootLinux()` returns a handle exposing
// every console as an independent byte duplex —
// `console(vtermno) → { write, onData, resize, reset }` — plus `consoleCount`
// and `kill()`. Output that arrives before a renderer attaches is buffered PER
// CONSOLE so no boot/prompt bytes are lost.

import { linux } from "./kernel-host.js";
import { makeSharedQueues } from "./virtio/shared-queues.js";
import { createNinePServer } from "./ninep/server.js";

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
 *   squashfs?: ArrayBuffer,           // #43: read-only base-system squashfs image, served to the guest as /dev/vdX over virtio-blk (copied into a SAB shared with every worker). Absent → blk device mounts empty.
 *   nixCache?: any,                   // a read-only Nix binary cache VFS (createNixCacheExport); registered as the `nixcache` 9P export, mounted at /nix-cache so in-guest nix substitutes from it (#141)
 *   onModuleCached?: () => void,      // fires when a streamed user binary finishes compiling + caching host-side — lets the UI close a "loading <tool>…" indicator (#141)
 *   wayland?: { sendOut: (clientId: number, buffer: Uint8Array, fds: Uint8Array[]) => void, onClose?: (clientId: number) => void },  // Phase 4f: worker→main Greenfield bridge (fire-and-forget); onClose = guest closed a ctx
 *   onVirtioConsole?: (bytes: Uint8Array) => void,  // #10 option 2: sink for the stock virtio-console's guest output (the A/B counterpart of the hvc console). Absent → logged.
 *   vsock?: { onReady: (device: import("./virtio/vsock-device.js").VsockVirtioDevice) => void },  // issue #10 option 3: called once with the main-thread virtio-vsock device so a caller (the future pc /Ctl consumer) can device.listen(port, conn => …) over a standard AF_VSOCK channel
 * }} opts
 * @returns {Promise<{
 *   consoleCount: number,
 *   console(vtermno: number): { write(b: Uint8Array|string): void, onData(cb: (b: Uint8Array)=>void): () => void, resize(c: number, r: number): void, reset(): void },
 *   pushIn(clientId: number, bytes: Uint8Array, fds?: Uint8Array[]): void,
 *   net: { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, setLinkUp(up: boolean): void },
 *   virtioConsoleInput(data: Uint8Array|string): void,
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

  // 9P server, driven by the virtio-9p host devices (kernel-host.js) over the
  // virtio_wasm transport. msize is the max bytes per 9P request/reply; 512 KB
  // matches what 9pnet_virtio negotiates (PAGE_SIZE*(VIRTQUEUE_NUM-3) ≈ 500 KB),
  // so big reads (e.g. a nix-env NAR fetch) aren't round-trip-bound on tiny
  // chunks. The server is transport-agnostic — it speaks bytes-in/bytes-out via
  // handle(frame, cid); the per-mount cid keeps each connection's state isolated.
  const NINEP_MSIZE = 512 * 1024;
  // Register the user VFS at the root aname; the /nix-cache binary cache is
  // a second export when provided (#141).
  const exports = { "/": vfs };
  if (opts.nixCache) exports.nixcache = opts.nixCache; // read-only Nix binary cache, pc-init mounts at /nix-cache + substituters=file:///nix-cache (#141)
  const ninepServer = createNinePServer({ exports, msize: NINEP_MSIZE });

  // Wayland Phase 1 (1b): cross-worker virtio queue-layout store (SAB), threaded
  // into every task worker so a queue set up on the boot worker is serviceable
  // from a userspace task worker (same model as the 9P ring).
  const virtioQueues = makeSharedQueues();

  // Wayland Phase 4f: the caller's compositor bridge, passed straight through. A
  // guest VFD_SEND's bytes are posted out FIRE-AND-FORGET (kernel-host calls
  // `wayland.sendOut(clientId, buffer, fds)`); the host feeds them to Greenfield
  // and the server→client response — replies, configure, pointer/keyboard, frame
  // callbacks, the keymap fd — returns ASYNCHRONOUSLY over the IN queue via
  // `os.wayland_push_in`. There is no SAB reply channel: Wayland events are async
  // (the client never blocks on its own request), and the self-wake IN path can
  // wake a parked guest, so the old synchronous round-trip is gone (it dropped
  // steady-state frame callbacks — see wl-device.js / kernel-worker.js).
  /** @type {{ sendOut?: (clientId:number, buffer:Uint8Array, fds:Uint8Array[])=>void, onClose?: (clientId:number)=>void } | undefined} */
  const wayland = opts.wayland;
  let waylandPushIn = null; // os.wayland_push_in: the single async host→guest path

  const workerUrl = new URL("./kernel-worker.js", import.meta.url);
  const os = await linux({
    worker_url: workerUrl,
    variant,
    vmlinux,
    boot_cmdline: opts.cmdline || DEFAULT_CMDLINE,
    initrd,
    log: onLog,
    console_write: emit,
    // Issue #10 (option 2): the virtio-console output sink — guest bytes drained
    // from the stock virtio_console transmitq. This is the A/B counterpart to the
    // hvc_wasm console (console_write/emit above), NOT a replacement: both probe
    // and run. Funnel it to the caller's onVirtioConsole hook if provided, else
    // the host log so the path is observable rather than silently dropped.
    console_sink:
      opts.onVirtioConsole || ((bytes) => onLog("[virtio-console] " + dec.decode(bytes))),
    ninep_server: ninepServer, // #10: main-thread virtio-9p host devices service this
    virtio_queues: virtioQueues,
    // #43: the read-only base-system squashfs served as /dev/vdX (virtio-blk).
    // An ArrayBuffer; kernel-host copies it once into a SharedArrayBuffer so
    // every task worker (any may service the blk vring) sees the same image.
    // Absent on a --no-nix / busybox-only boot (the blk device mounts empty).
    squashfs: opts.squashfs,
    wayland,
    // Issue #10 option 3: the virtio-vsock /Ctl bridge hook (passed straight
    // through). The host VsockVirtioDevice runs the vsock protocol; `vsock.onReady`
    // hands it to the caller so it can listen()/connect() over AF_VSOCK.
    vsock: opts.vsock,
    on_module_cached: opts.onModuleCached, // fires when a streamed binary finishes compiling+caching
  });

  // Now that the boot worker exists, wire the async IN sink so the compositor
  // bridge can deliver server→client messages (incl fds) to the guest.
  if (wayland) waylandPushIn = os.wayland_push_in;

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

    /**
     * Deliver a server→client wayland message to the guest — the SINGLE async
     * host→guest path (Phase 4f). The compositor calls this for EVERY event
     * Greenfield emits: replies, xdg_surface.configure, pointer/keyboard, frame
     * callbacks, wl_buffer.release, and server→client fds (the keymap). The bytes
     * (+ any fds) go onto the IN vring and raise the IRQ, waking the guest if it
     * is parked in poll()/dispatch. No-op if the wayland bridge is not wired.
     * @param {number} clientId guest ctx vfd_id
     * @param {Uint8Array} bytes wire bytes
     * @param {Uint8Array[]} [fds] server→client fd payloads (keymap)
     */
    pushIn(clientId, bytes, fds) {
      waylandPushIn?.(clientId, bytes, fds);
    },

    /**
     * Guest networking (virtio-net eth0). The seam pc's js/vnet/ consumes:
     *   - `readable`: a ReadableStream<Uint8Array> of guest-egress ethernet frames.
     *   - `writable`: a WritableStream<Uint8Array>; writing a frame injects it into
     *     the guest's RX vring (host→guest), waking a parked idle CPU.
     *   - `setLinkUp(up)`: flips the reported link-status config bit.
     */
    net: os.net,

    /**
     * Issue #10 (option 2): feed host input bytes to the guest over the stock
     * virtio-console (the A/B counterpart of console(vt).write's hvc path). Bytes
     * posted before the guest sets up the receiveq stay pending and are delivered
     * on the next refill. No-op until a virtio-console device exists (a
     * console_sink was wired AND the self-wake address is published post-boot).
     * @param {Uint8Array|string} data
     */
    virtioConsoleInput(data) {
      os.virtio_console_input(typeof data === "string" ? enc.encode(data) : data);
    },

    /** Mark this boot handle dead. The 9P server is passive (driven by the
     *  guest's virtio-9p kicks — no background loop to stop); worker teardown is
     *  the caller's concern. */
    kill() {
      if (!alive) return;
      alive = false;
    },
  };
}

export { DEFAULT_CMDLINE };
