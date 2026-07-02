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
// Multi-tty: the guest exposes HVC_CONSOLES consoles (hvc0..hvc{N-1}); pc-init
// respawns a shell on each. These ride N stock SINGLE-PORT virtio-console devices
// (issue #83): the kernel's virtio_console driver registers one hvc line per
// device SYNCHRONOUSLY at probe (so the console exists before init), replacing the
// retired bespoke hvc_wasm backend. `bootLinux()` returns a handle exposing every
// console as an independent byte duplex — `console(vtermno) → { write, onData,
// resize, reset }` — plus `consoleCount` and `kill()`. Output that arrives before
// a renderer attaches is buffered PER CONSOLE so no boot/prompt bytes are lost.

import { linux } from "./kernel-host.js";
import { makeSharedQueues } from "./virtio/shared-queues.js";
import { CONSOLE_DEVICES } from "./virtio/console-device.js";
import { createNinePServer } from "./ninep/server.js";

// Number of guest consoles (hvc0..hvc{N-1}) — one per Linux terminal window;
// hvc0 also carries the kernel boot log. One stock single-port virtio-console
// device per console (issue #83), so the count IS CONSOLE_DEVICES (which the
// kernel transport registers and the guest inittab's getty count must match).
// Exported under the historical name for the pc app that imports it.
export const HVC_CONSOLES = CONSOLE_DEVICES;

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
// `console=hvc` binds the kernel console to hvc0, which is now the first
// single-port virtio-console device's hvc line (issue #83) instead of the retired
// hvc_wasm line. That device registers its console SYNCHRONOUSLY at probe (before
// init), so hvc0 exists when PID 1 opens /dev/console; early printk before the
// virtio probe is buffered by the kernel log and flushed once hvc0 registers.
const DEFAULT_CMDLINE =
  "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0";

const enc = new TextEncoder();

/**
 * Boot a linux-wasm kernel with a VFS mounted at /mnt/pc over 9P.
 *
 * @param {{
 *   vfs: any,                         // the async typed-record VFS (MemVfs in tests, pc vfs in prod)
 *   variant?: string,                 // 'wasm32_nommu' (default) | 'wasm64_nommu'
 *   vmlinuxUrl: string,               // URL of the kernel wasm (required)
 *   initrdUrl: string,                // URL of the initramfs.cpio.gz (required)
 *   cmdline?: string,                 // kernel command line
 *   onLog?: (text: string) => void,   // host/diagnostic log sink
 *   squashfs?: ArrayBuffer,           // #43: read-only base-system squashfs image, served to the guest as /dev/vdX over virtio-blk (copied into a SAB shared with every worker). Absent → blk device mounts empty.
 *   nixCache?: any,                   // a read-only Nix binary cache VFS (createNixCacheExport); registered as the `nixcache` 9P export, mounted at /nix-cache so in-guest nix substitutes from it (#141)
 *   onModuleCached?: () => void,      // fires when a streamed user binary finishes compiling + caching host-side — lets the UI close a "loading <tool>…" indicator (#141)
 *   wayland?: { sendOut: (clientId: number, buffer: Uint8Array, fds: Uint8Array[]) => void, onClose?: (clientId: number) => void },  // Phase 4f: worker→main Greenfield bridge (fire-and-forget); onClose = guest closed a ctx
 *   vsock?: { onReady: (device: import("./virtio/vsock-device.js").VsockVirtioDevice) => void },  // issue #10 option 3: called once with the main-thread virtio-vsock device so a caller (the future pc /Ctl consumer) can device.listen(port, conn => …) over a standard AF_VSOCK channel
 * }} opts
 * @returns {Promise<{
 *   consoleCount: number,
 *   memory: WebAssembly.Memory,
 *   console(vtermno: number): { write(b: Uint8Array|string): void, onData(cb: (b: Uint8Array)=>void): () => void, resize(c: number, r: number): void, reset(): void },
 *   pushIn(clientId: number, bytes: Uint8Array, fds?: Uint8Array[]): void,
 *   net: { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, setLinkUp(up: boolean): void },
 *   kill(): void,
 * }>}
 */
export async function bootLinux(opts) {
  const vfs = opts.vfs;
  const variant = opts.variant || "wasm32_nommu";
  // Console count is a fixed property of the transport (how many single-port
  // virtio-console devices it registers), not a caller knob — it must match the
  // guest inittab's getty count and CONSOLE_DEVICES.
  const consoleCount = HVC_CONSOLES;
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

  // The main-thread virtio-console device calls this as (port, bytes) for every
  // chunk of guest console output (port = hvc/vtermno index; bytes = Uint8Array).
  function emit(port, bytes) {
    const vt = port | 0;
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
    // The virtio-console output sink (issue #83): each single-port console
    // device's main-thread ConsoleVirtioDevice drains its transmitq and calls this
    // as (consoleIndex, bytes); emit fans out to that console's onData subscribers
    // (buffering per-console until one attaches). The guest's only console path.
    console_sink: emit,
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

    /** Debug/post-mortem: the shared guest memory (see kernel-host.js). */
    memory: os.memory,

    /** A byte duplex bound to one console port (vtermno = port/hvc index). */
    console(vtermno) {
      const vt = vtermno | 0;
      return {
        /** Feed bytes/text to this console's tty (stdin) over its receiveq. */
        write(data) {
          os.console_input(vt, typeof data === "string" ? enc.encode(data) : data);
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
        /** Set this console's window size (terminal resize). Propagated to the
         *  guest tty via the device's VIRTIO_CONSOLE_F_SIZE config-change
         *  interrupt, which drives hvc_resize() → SIGWINCH. */
        resize(cols, rows) {
          os.console_resize(vt, cols, rows);
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
