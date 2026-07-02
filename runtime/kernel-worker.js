// @ts-nocheck
// oxlint-disable -- vendored upstream linux-wasm host runtime (adapted from linux.js/linux-worker.js); exempt from our lint rules, like pc's vendor/ tree
// SPDX-License-Identifier: GPL-2.0-only
// @ts-nocheck — vendored upstream glue (wasm/BigInt browser-isms; not pc-typed)
//
// Adapted from linux-wasm's runtime/linux-worker.js (Joel Severin, GPL-2.0) —
// the per-task Web Worker that runs vmlinux/user wasm over the shared memory.
// pc additions (ticket #74) are marked "pc:". The 9P filesystem rides the stock
// virtio-9p transport (issue #10), serviced by the main-thread host devices —
// this worker only forwards the vq kick. See vendor/linux-wasm/SOURCE.md.
import { DynamicLoader } from "./dylink.js";
import { makeCaptureStack, isPendingUnwind, stopUnwind, startRewind } from "./asyncify.js";
import { FfiTrampolines } from "./ffi-codegen.js";
import { EchoDevice } from "./virtio/echo-device.js";
import { WlDevice } from "./virtio/wl-device.js";
import { NetDevice } from "./virtio/net-device.js";
import { BlkDevice } from "./virtio/blk-device.js";
import { NinePVirtioDevice } from "./virtio/ninep-device.js";
import { ConsoleVirtioDevice, CONSOLE_BASE, CONSOLE_DEVICES } from "./virtio/console-device.js";
import { VsockVirtioDevice } from "./virtio/vsock-device.js";
import { SharedQueues } from "./virtio/shared-queues.js";

(function (console) {
  let port = self;
  let variant;
  let arch_bits;
  let Ulong;
  let memory = null; // Note: memory.buffer has to be re-accessed after growing the memory!
  let locks = null;
  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  // pc (#139): per-syscall console tracing is a DEEP-DEBUG aid for bisecting
  // guest failures (Gate 0.2 surfaced silent -ENOMEM; Phase B located the fork
  // arity/signature-mismatch traps this way). It is OFF BY DEFAULT — emitting a
  // console.error per failing syscall AND per benign exec/sigreturn unwind
  // throttles the whole browser tab under a process-heavy workload (e.g. Nix
  // spawning hundreds of builder/helper processes wedged the UI for minutes).
  // When off, syscalls take the upstream zero-overhead path (no wrapper try/
  // catch, no logging). Enable for a debug session by setting `trace_syscalls`
  // in the worker init message (the init handler spreads `...options`).
  let trace_enabled = false;
  let syscall_trace_budget = 120;
  const syscall_logged =
    (fn) =>
    (...args) => {
      if (!trace_enabled) return fn(...args); // fast path: upstream behaviour
      let r;
      try {
        r = fn(...args);
      } catch (e) {
        // A wasm "function signature mismatch" trap here means the user called
        // wasm_syscall_N for a syscall whose kernel handler has a different arity
        // (call_indirect type check fails). The wrappers are (sp, tp, nr,
        // arg0..argN), so nr is args[2]. Skip the BENIGN exec/sigreturn unwind
        // exceptions (host glue control flow) — only real traps are interesting.
        if (!/should be ignored/.test(String((e && e.message) || e))) {
          console.error(
            `[user-exec ${runner_name}] TRAP at syscall nr=${args[2]} args=[${args.slice(3).join(", ")}] : ${e}`,
          );
        }
        throw e;
      }
      const rn = Number(r);
      // Trace failing user syscalls (budgeted; the budget resets on each exec —
      // see wasm_load_executable — so boot/shell noise can't starve the binary
      // under investigation). The wrappers are (sp, tp, nr, ...), so nr is args[2].
      if (rn < 0 && rn > -4096 && syscall_trace_budget > 0) {
        syscall_trace_budget--;
        console.error(
          `[user-exec ${runner_name}] syscall nr=${args[2]} = ${rn} args=[${args.slice(3).join(", ")}]`,
        );
      }
      return r;
    };
  const reset_syscall_trace = () => {
    syscall_trace_budget = 120;
  };

  /// A string denoting the runner name (same as Worker name), useful for debugging.
  let runner_name = "[Unknown]";

  /// SAB-backed storage for last process in switch_to (when it returns back from another task).
  let switch_to_last_task = null;

  /// The vmlinux instance, to handle boot, idle, kthreads and syscalls etc.
  let vmlinux_instance = null;

  /// The user executable (if any) to run when we're not in vmlinux.
  let user_executable = null;
  let user_executable_params = null;

  /// The user executabe instance, or null. Try using the instance variable in the promise over this one if possible.
  let user_executable_instance = null;
  let user_executable_imports = null;

  /// pc (#126 Track C / #130): per-process dynamic linking (dlopen/dlsym).
  /// dyn_loader is built LAZILY on the first dl host-import call (parsing the
  /// main image's export/elem sections costs a few ms on a huge --export-all
  /// binary; processes that never dlopen pay nothing). user_executable_range
  /// is the main binary's byte range in the SHARED kernel memory (the same
  /// range the exec/clone ABI already passes around — the kernel keeps it
  /// alive for the process lifetime), used to parse the main module's symbol
  /// tables. dyn_replay carries a cloning parent's side-module snapshot into
  /// this (child) worker; it is replayed right after the user instance exists,
  /// before any user code runs (Track 0 §4 step 3).
  let dyn_loader = null;
  let dyn_replay = null;
  let user_executable_range = null;

  /// pc (#130): the per-process runtime-FFI trampoline cache (runtime/
  /// ffi-codegen.js) — built lazily on the first __wasm_ffi_call, sharing this
  /// process's Memory + function table.
  let ffi_trampolines = null;

  /// Flag that a clone callback should be called instead of _start().
  let should_call_clone_callback = false;

  /// pc (#129 MMU fork): nonzero when THIS worker's task is a fork child — the
  /// asyncify ctl pointer to REWIND at first run (fork() returns 0 there)
  /// instead of _start()ing. Set from the create message, consumed once.
  let fork_rewind_ctl = 0;
  /// What capture_stack returns on the REWIND side: the child pid in a forking
  /// parent (set from wasm_fork_current's return), 0 in a fork child. Read
  /// lazily by the capture fn below.
  let fork_result = 0;
  /// The env.capture_stack host import (runtime/asyncify.js) — the musl 0010
  /// _Fork seam calls it; asyncify unwinds the caller's stack and the run loop
  /// (run_user_entry) drives the kernel clone + the dual rewind. One fn per
  /// worker; late-binds the instance (exec replaces it).
  let capture_stack_fn = null;

  /// pc (#128/#129): THIS worker's own page-table root — the pt_base baked into
  /// its user instance's __mmu_pt_base at instantiation (its task's mm->pgd).
  /// IMMUTABLE for the life of the instance (a task's own pgd never changes; an
  /// exec re-instantiates and re-bakes). The kernel's switch_mm calls the host
  /// import __mmu_set_pt_base(next->pgd) on EVERY context switch, and that runs
  /// in whatever worker is executing the scheduler — including THIS worker when
  /// its task schedules OUT (switch_mm(self, next) sets our instance's global to
  /// `next`'s pgd, then we park). Nothing cross-worker restores it, so on resume
  /// we must re-apply our OWN root or the instrumented user code walks the wrong
  /// table and every access faults forever (the #129 two-user-task fork bug —
  /// single-task A2 smokes never switch between two user tasks, so never hit it).
  let own_pt_base = 0;

  /// An exception type used to abort part of execution (useful for collapsing the call stack of user code).
  class Trap extends Error {
    constructor(kind) {
      super("This exception should be ignored. It is part of Linux/Wasm host glue.");
      Error.captureStackTrace && Error.captureStackTrace(this, Trap);
      this.name = "Trap";
      this.kind = kind;
    }
  }

  const log = (message) => {
    port.postMessage({
      method: "log",
      message: "[Runner " + runner_name + "]: " + message,
    });
  };

  // pc (#139 Gate 0.2): the required initial size of a user binary's imported
  // __indirect_function_table, parsed from its import section. Instantiate
  // fails ("table import is smaller than initial N") if the provided table is
  // smaller than the binary declares, and big programs blow past any fixed
  // guess — clang.wasm needs ~27k entries vs the 4096 previously hardcoded.
  // Returns 0 when no table import exists (caller keeps a sane floor).
  const table_import_initial = (bytes) => {
    const uleb = (i) => {
      let r = 0,
        s = 0,
        b;
      do {
        b = bytes[i++];
        r += (b & 0x7f) * 2 ** s;
        s += 7;
      } while (b & 0x80);
      return [r, i];
    };
    let i = 8; // magic + version
    while (i < bytes.length) {
      const id = bytes[i++];
      let size;
      [size, i] = uleb(i);
      if (id !== 2) {
        i += size;
        continue;
      }
      let n;
      [n, i] = uleb(i);
      for (let k = 0; k < n; k++) {
        let len;
        [len, i] = uleb(i);
        i += len; // module name
        [len, i] = uleb(i);
        i += len; // field name
        const kind = bytes[i++];
        if (kind === 0) {
          // function: type index
          [, i] = uleb(i);
        } else if (kind === 1) {
          // table: reftype + limits — what we came for
          i++;
          const flags = bytes[i++];
          let initial;
          [initial, i] = uleb(i);
          return initial;
        } else if (kind === 2) {
          // memory: limits
          const flags = bytes[i++];
          [, i] = uleb(i);
          if (flags & 1) [, i] = uleb(i);
        } else if (kind === 3) {
          // global: valtype + mutability
          i += 2;
        } else if (kind === 4) {
          // tag: attribute + type index
          i++;
          [, i] = uleb(i);
        }
      }
      return 0;
    }
    return 0;
  };

  /// pc (#130): build the per-process dynamic loader on first use — parse the
  /// main image's export/elem/dynsym sections from its byte range in shared
  /// kernel memory and register it as handle 1. Requires the user instance to
  /// exist (dl imports only fire from running user code; the replay path runs
  /// right after instantiation).
  const ensure_dyn_loader = () => {
    if (!dyn_loader) {
      dyn_loader = new DynamicLoader({
        memory,
        table: user_executable_imports.env.__indirect_function_table,
        baseEnv: user_executable_imports.env,
        archBits: arch_bits,
        log: (m) => log(m),
      });
      dyn_loader.registerMain({
        instance: user_executable_instance,
        bytes: new Uint8Array(memory.buffer).subarray(
          user_executable_range.bin_start,
          user_executable_range.bin_end,
        ),
        memoryBase: Number(user_executable_params.data_start),
        tableBase: Number(user_executable_params.table_start),
      });
    }
    return dyn_loader;
  };

  /// pc (#130): the runtime-FFI trampoline cache, over this process's Memory +
  /// function table (the same table dlopen'd modules install into).
  const ensure_ffi = () => {
    if (!ffi_trampolines) {
      ffi_trampolines = new FfiTrampolines({
        memory,
        table: user_executable_imports.env.__indirect_function_table,
      });
    }
    return ffi_trampolines;
  };

  /// Get a JS string object from a (nul-terminated) C-string in a Uint8Array.
  const get_cstring = (memory, index) => {
    const memory_u8 = new Uint8Array(memory.buffer);
    let end;
    for (end = index; memory_u8[end]; ++end); // Find terminating nul-character.
    return text_decoder.decode(memory_u8.slice(index, end));
  };

  const lock_notify = (lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  const serialize_me = () => {
    // Wait for some other task or CPU to wake us up.
    lock_wait("serialize");
    // pc (#128/#129): our task is resuming on THIS worker. Restore our own
    // page-table root — a switch_mm while we were scheduled out (ours, when we
    // parked, or another worker's) may have written a foreign pgd into our
    // instance's __mmu_pt_base. Re-apply the baked root so the instrumented
    // user code we're about to return to walks OUR table. No-op for tasks
    // without a softmmu instance (idle/kthreads, own_pt_base 0).
    if (own_pt_base && user_executable_instance && user_executable_instance.exports.__mmu_pt_base) {
      user_executable_instance.exports.__mmu_pt_base.value = own_pt_base;
    }
    return switch_to_last_task[0]; // last_task was written by the caller just prior to waking.
  };

  /// Wayland Phase 1 (1b): cross-worker virtio queue-layout store (SAB),
  /// attached in init(). Shared so a queue set up on the boot worker is
  /// serviceable from a userspace task worker.
  let virtio_queues = null;

  /// squashfs image bytes for the BlkDevice (VW_DEV_BLK=3); set from the boot
  /// message in init(). Zero-length when no squashfs was provided (--no-nix).
  let squashfsImage = new Uint8Array(0);

  /// Wayland Phase 1 (1a/1b): the JS virtio device models for the `virtio_wasm`
  /// transport, keyed by the host device index `dev` the guest passes in every
  /// import call. Lazily built on first use because they need the guest's
  /// raise_interrupt export (only available once vmlinux_instance exists; the
  /// kick comes from the CPU-0 worker, which holds the same shared `memory`).
  /// The transport assigns dev=0 to virtio_wl and dev=1 to the echo self-test,
  /// with irq = VIRTIO_WASM_IRQ_BASE(8) + dev (see drivers/virtio/virtio_wasm.c).
  ///
  /// CPU-0 RULE (1a finding, now owned by VirtioWasmDevice): pc boots maxcpus=1,
  /// so CPU 0 is the only online CPU; the kernel's nominal IRQ_CPU=1 idle loop
  /// never runs (raise_interrupt(1,…) sets a bit nobody reads). Every device
  /// derives its interrupt-target CPU from the online mask (default {0}) — when
  /// a task blocks (wait_for_completion), CPU 0's idle task runs arch_cpu_idle(),
  /// memory.atomic.wait64's on raised_irqs[0], and dispatches on wake.
  const VIRTIO_WASM_IRQ_BASE = 8;
  const VW_DEV_WL = 0;
  const VW_DEV_ECHO = 1;
  const VW_DEV_NET = 2;
  const VW_DEV_BLK = 3;
  // Issue #10 option 3: virtio-vsock — AF_VSOCK socket channel for the /Ctl
  // bridge. Pinned to host index 7 (must match kernel patch 0020's `VW_DEV_VSOCK
  // = 7` and kernel-host.js). Like virtio-9p, the host socket API is async +
  // main-thread, so the worker instance only answers the synchronous transport
  // probes (features/config/setup) and forwards the kick.
  const VW_DEV_VSOCK = 7;
  // Issue #10: virtio-9p channels — one virtio device per 9P mount/connection.
  // Device index, mount tag, and connection id (cid, for per-connection state
  // isolation in the shared 9P server) MUST match kernel patch 0018's enum and
  // the host side (kernel-host.js). The worker instance only answers the
  // synchronous transport probes (features/config/setup) and forwards the kick;
  // the main-thread instance does the async server round-trip + IRQ self-wake.
  const VW_DEV_9P = [
    { dev: 4, tag: "pcroot", cid: 1 }, // VW_DEV_9P_ROOT — pc VFS export (aname "/")
    { dev: 5, tag: "nixcache", cid: 2 }, // VW_DEV_9P_NIXCACHE — nix binary cache
  ];
  const ninepVirtioByDev = new Map(VW_DEV_9P.map((d) => [d.dev, d]));
  // Issue #10 (option 2) / #83: virtio-console — the guest's consoles on the
  // stock mainline virtio-console driver (now the SOLE console path; hvc_wasm is
  // retired). The transport registers CONSOLE_DEVICES single-port console devices
  // at host indices CONSOLE_BASE..CONSOLE_BASE+CONSOLE_DEVICES-1 (kernel patch
  // 0019), one synchronous hvc line each. Like virtio-9p, the worker instance only
  // answers the synchronous transport probes and FORWARDS the kick (with the dev
  // index); the main-thread instance owns the sink (guest output) + input buffer
  // (host input) per console and raises the completion IRQ via the raised_irqs
  // self-wake.
  const isConsoleDev = (id) => id >= CONSOLE_BASE && id < CONSOLE_BASE + CONSOLE_DEVICES;

  // raised_irqs[0] address is per-cpu-fixed post-boot; publish it once for the
  // main-thread self-wake (shared by virtio-wl/net AND virtio-9p — so 9P works
  // even on a boot with no wayland device to publish it).
  let raised_irqs_published = false;
  const publish_raised_irqs_addr = () => {
    if (raised_irqs_published) return;
    try {
      const fn = vmlinux_instance.exports.wasm_raised_irqs_ptr;
      if (typeof fn === "function") {
        port.postMessage({ method: "wayland_irq_addr", addr: Number(fn(0)) >>> 0 });
        raised_irqs_published = true;
      } else {
        log("[virtio] wasm_raised_irqs_ptr export missing (stale vmlinux?) — idle wake off");
      }
    } catch (e) {
      log("[virtio] wasm_raised_irqs_ptr failed: " + e);
    }
  };

  /** @type {Map<number, import("./virtio/device.js").VirtioWasmDevice>} */
  const virtio_devices = new Map();
  const get_virtio_device = (dev) => {
    const id = dev >>> 0;
    let d = virtio_devices.get(id);
    if (!d && vmlinux_instance && virtio_queues) {
      const common = {
        dev: id,
        irq: VIRTIO_WASM_IRQ_BASE + id,
        memory,
        raiseInterrupt: (cpu, irq) => vmlinux_instance.exports.raise_interrupt(cpu, irq),
        onlineCpus: [0], // maxcpus=1
        sharedQueues: virtio_queues,
        log: (m) => log(m),
      };
      if (id === VW_DEV_WL) {
        // Wayland Phase 4f: the virtio_wl device runs in THIS worker, but the
        // Greenfield compositor is on the MAIN thread. A guest VFD_SEND's wayland
        // bytes are posted OUT to the host FIRE-AND-FORGET; the guest's SEND
        // completes on the synchronous OUT ack the device writes back. The
        // compositor's server→client response (replies, configure, pointer/keyboard
        // events, frame callbacks, keymap fd) arrives LATER, asynchronously, over
        // the IN queue — the MAIN thread injects it directly (host-side WlDevice +
        // raised_irqs self-wake), so this worker never blocks and there is NO SAB
        // reply channel. This replaced the 2b/2c synchronous SAB round-trip, whose
        // bounded deferred-flush window dropped steady-state frame callbacks (they
        // fired after the window and were written to a closed reply slot), stalling
        // animation. Wayland events are inherently async, so a synchronous "reply
        // to this SEND" was the wrong model. Single producer per direction: worker
        // owns OUT, host owns IN.
        common.waylandBridge = {
          sendOut: (clientId, data, fds) => {
            const fdViews = fds.map((v) => ({ byteOffset: v.byteOffset, length: v.byteLength }));
            port.postMessage({
              method: "wayland_out",
              dev: id,
              clientId: clientId >>> 0,
              buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
              fds: fdViews,
            });
          },
          // The guest refilled the IN avail ring; the host owns IN delivery, so
          // tell it to flush anything it deferred for lack of a free inbuf.
          onInRefill: () => port.postMessage({ method: "wayland_in_refill", dev: id }),
          // The guest closed a ctx vfd (its Wayland client exited) — let the host
          // tear down the matching server-side client now.
          onClose: (clientId) =>
            port.postMessage({ method: "wayland_close", dev: id, clientId: clientId >>> 0 }),
        };
        d = new WlDevice(common);
        // Wayland (idle wake): hand the main thread the address of raised_irqs[0]
        // so it can deliver an unsolicited server→client event to a FULLY IDLE
        // guest by replicating raise_interrupt() (OR irq bit + memory.atomic.notify
        // on this word) directly on shared memory — the parked idle Worker can't
        // run JS to service an async `wayland_in` postMessage (the 4e finding).
        publish_raised_irqs_addr();
      } else if (ninepVirtioByDev.has(id)) {
        // Issue #10: virtio-9p channel. The 9P server is async + main-thread, but
        // this kick lands on a task worker — so the worker-side device only
        // answers the synchronous transport probes (getFeatures/configRead via the
        // base ctor + tag) and FORWARDS the notify to the main thread, where the
        // host instance runs server.handle() and raises the completion IRQ via the
        // raised_irqs self-wake. Publish that wake address (9P needs it even with
        // no wayland device present).
        const m = ninepVirtioByDev.get(id);
        d = new NinePVirtioDevice({
          ...common,
          tag: m.tag,
          cid: m.cid,
          forwardNotify: (dev, q) => port.postMessage({ method: "virtio9p_notify", dev, q }),
        });
        publish_raised_irqs_addr();
      } else if (isConsoleDev(id)) {
        // Issue #83: a single-port virtio-console console device. Like virtio-9p,
        // the sink (guest output) + input buffer (host input) are on the MAIN
        // thread, but this kick lands on a task worker — so the worker-side device
        // only answers the synchronous transport probes (getFeatures = 0 → the
        // guest's non-multiport path registers hvc SYNCHRONOUSLY at probe; queue
        // setup via the base ctor) and FORWARDS the notify (with the dev index) to
        // the main thread, where the host instance drains the transmitq / delivers
        // receiveq input and raises the completion IRQ via the raised_irqs
        // self-wake. Publish the wake address (the console needs it for host->guest
        // input).
        d = new ConsoleVirtioDevice({
          ...common,
          forwardNotify: (dev, q) => port.postMessage({ method: "virtioconsole_notify", dev, q }),
        });
        publish_raised_irqs_addr();
      } else if (id === VW_DEV_ECHO) d = new EchoDevice(common);
      else if (id === VW_DEV_NET) {
        // virtio-net: this worker owns the TX queue (guest egress). Each frame
        // the guest transmits is posted FIRE-AND-FORGET to the main thread,
        // which enqueues it on handle.net.readable. RX (host→guest) is driven
        // by the MAIN-thread NetDevice (kernel-host hostNet()) over the same
        // shared queue-layout SAB + raised_irqs self-wake, so a parked idle CPU
        // is woken without this worker servicing a postMessage (the wl pattern).
        const net = new NetDevice({ ...common, mac: [0x52, 0x54, 0x00, 0xcb, 0x00, 0x02] });
        net.setFrameSink((frame) => {
          port.postMessage({ method: "net_out", dev: id, frame: frame.buffer }, [frame.buffer]);
        });
        d = net;
      } else if (id === VW_DEV_BLK) {
        // Read-only base-system squashfs, handed in via the boot message.
        // squashfsImage is a 0-length Uint8Array when absent (--no-nix boot).
        d = new BlkDevice({ ...common, image: squashfsImage });
      } else if (id === VW_DEV_VSOCK) {
        // Issue #10 option 3: virtio-vsock. The host socket API (the /Ctl
        // bridge) is async + main-thread, but this kick lands on a task worker —
        // so the worker-side device only answers the synchronous transport
        // probes (getFeatures/configRead serving the guest CID, via the base
        // ctor) and FORWARDS the notify to the main thread, where the host
        // instance runs the vsock protocol + raises the completion IRQ via the
        // raised_irqs self-wake. Publish that wake address (vsock needs it like
        // 9P, even with no wayland device present).
        d = new VsockVirtioDevice({
          ...common,
          forwardNotify: (dev, q) => port.postMessage({ method: "virtiovsock_notify", dev, q }),
        });
        publish_raised_irqs_addr();
      } else {
        log(`[virtio] import for unknown device index ${id}`);
        return null;
      }
      virtio_devices.set(id, d);
    }
    return d;
  };

  /// Callbacks from within Linux/Wasm out to our host code (cpu is not neccessarily ours).
  const host_callbacks = {
    /// Start secondary CPU.
    wasm_start_cpu: (cpu, idle_task) => {
      // New web workers cannot be spawned from within a Worker in most browsers. It can currently not be spawned from
      // within a SharedWorker in any browser. Do it on the main thread instead.
      port.postMessage({ method: "start_secondary", cpu: cpu, idle_task: idle_task });
    },

    /// Stop secondary CPU (rather abruptly).
    wasm_stop_cpu: (cpu) => {
      port.postMessage({ method: "stop_secondary", cpu: cpu });
    },

    /// Creation of tasks on our end. Runs them too.
    wasm_create_and_run_task: (
      prev_task,
      new_task,
      name,
      bin_start,
      bin_end,
      data_start,
      table_start,
      pt_base,
      fork_ctl,
    ) => {
      // Tell main to create the new task, and then run it for the first time!
      port.postMessage({
        method: "create_and_run_task",
        prev_task: prev_task,
        new_task: new_task,
        name: get_cstring(memory, name),

        // For user tasks, there is user code to load first before trying to run
        // it. pc (new exec ABI): pass the binary's byte range in the SHARED
        // kernel memory; the spawned worker compiles it from shared memory.
        user_executable: bin_start
          ? {
              bin_start: bin_start,
              bin_end: bin_end,
              data_start: data_start,
              table_start: table_start,
              // pc (#128): the new task's page-table root (its mm's pgd).
              pt_base: Number(pt_base || 0),
              // pc (#129 MMU fork): the asyncify fork control-buffer pointer.
              // Nonzero ONLY for a fork child (stamped by wasm_fork_current,
              // consumed once by __switch_to): the child worker REWINDS the
              // captured fork() stack at this ctl — fork() returns 0 there —
              // instead of _start()ing a fresh program.
              fork_ctl: Number(fork_ctl || 0),
              // pc (#130): the parent's dynamic-linking state (side modules +
              // table-op log). Module instances + the wasm table are engine
              // objects OUTSIDE linear memory, so the CLONE_VM-shared memory
              // does NOT carry them — the child worker must REPLAY them to
              // reproduce the exact table layout the parent's function-pointer
              // values (table indices, living in shared memory) refer to.
              dyn: dyn_loader && dyn_loader.opLog.length > 0 ? dyn_loader.snapshot() : null,
            }
          : null,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Remove a task created by wasm_create_and_run_task().
    wasm_release_task: (dead_task) => {
      port.postMessage({
        method: "release_task",
        dead_task: dead_task,
      });
    },

    /// Serialization of tasks (idle tasks and before SMP is started).
    wasm_serialize_tasks: (prev_task, next_task) => {
      // Notify the next task that it can run again.
      port.postMessage({
        method: "serialize_tasks",
        prev_task: prev_task,
        next_task: next_task,
      });

      // Serialize this (old) task.
      return serialize_me();
    },

    /// Kernel panic. We can't proceed.
    wasm_panic: (msg) => {
      const message = "Kernel panic: " + get_cstring(memory, msg);
      console.error(message);
      log(message);

      // This will stop execution of the current task.
      throw new Trap("panic");
    },

    /// Dump a stack trace into a text buffer. (The exact format is implementation-defined and varies by browser.)
    wasm_dump_stacktrace: (stack_trace, max_size) => {
      try {
        throw new Error();
      } catch (error) {
        const memory_u8 = new Uint8Array(memory.buffer);
        const encoded = text_encoder.encode(error.stack).slice(0, max_size - 1);
        memory_u8.set(encoded, stack_trace);
        memory_u8[stack_trace + encoded.length] = 0;
      }
    },

    /// pc (#128 software MMU): the MMU kernel's switch_mm/activate_mm hands
    /// over the incoming mm's page-table root. Each task's image already
    /// carries its own root (applied to its __mmu_pt_base global at
    /// instantiation from pt_base), so this is a write-through for the
    /// CURRENT worker's image only — exec's activate_mm fires before
    /// wasm_load_executable re-passes the same root, and any future pgd
    /// change lands here. NOMMU kernels never import it (--import-undefined
    /// materializes it only in MMU vmlinux builds).
    __mmu_set_pt_base: (pt_base) => {
      const v = Number(pt_base || 0);
      if (user_executable_params) user_executable_params.pt_base = v;
      if (user_executable_instance && user_executable_instance.exports.__mmu_pt_base) {
        user_executable_instance.exports.__mmu_pt_base.value = v;
      }
    },

    /// Replace the currently executing image (kthread spawning init, or user process) with a new user process image.
    /// pc (new exec ABI): `bin_start`/`bin_end` are now a byte range in the
    /// SHARED kernel memory (binfmt_wasm places the user binary there); compile
    /// it straight from that range. No host Module cache / key resolution.
    wasm_load_executable: (bin_start, bin_end, data_start, table_start, pt_base) => {
      reset_syscall_trace(); // pc (#139): re-arm the per-exec syscall-trace budget
      // pc (#130): a fresh program image — drop the old image's dynamic-linking
      // state (side modules die with the image, like an ELF exec) and remember
      // the new image's byte range for the lazy loader.
      dyn_loader = null;
      dyn_replay = null;
      ffi_trampolines = null;
      user_executable_range = { bin_start, bin_end };
      const bytes = new Uint8Array(memory.buffer).slice(bin_start, bin_end);
      user_executable = WebAssembly.compile(bytes);
      user_executable_params = {
        data_start: data_start,
        table_start: table_start,
        // pc (#128 software MMU): this image's page-table root (0 = NOMMU /
        // uninstrumented). Applied to the instance's __mmu_pt_base global at
        // instantiation — per-instance, so context switches swap nothing.
        pt_base: Number(pt_base || 0),
        // pc (#139 Gate 0.2): size the user table from the binary's import
        // section (a table smaller than declared fails instantiate).
        table_initial: table_import_initial(bytes),
      };

      // We release our reference already, just to be sure. The promise chain will still have a reference until the
      // kernel exits back to userland, which will termintate the user executable with a Trap.
      user_executable_instance = null;
      user_executable_imports = null;
    },

    /// Handle user mode return (e.g. from syscall) that should not proceed normally. (Not called on normal returns.)
    wasm_user_mode_tail: (flow) => {
      if (flow == -1) {
        // Exec has been called and we should not return from the syscall. Trap() to collapse the call stack of the user
        // executable. When swallowed, run the new user executable that was already preloaded by wasm_load_executable().
        // This takes precedence of signal handlers or signal return - no reason to run any old user code!
        throw new Trap("reload_program");
      } else if (flow >= 1 && flow <= 3) {
        // First, handle any signal (possibly stacked). Then, handle any signal return (happens after stacked signals).
        // If exec() happens, we will slip out in the catch-else clause, ensuring the sigreturn does not proceed.
        if (flow & 1) {
          try {
            if (user_executable_instance.exports.__libc_handle_signal) {
              // Setup signal frame...
              user_executable_imports.env.__stack_pointer.value =
                vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(
                vmlinux_instance.exports.get_user_tls_base(),
              );

              user_executable_instance.exports.__libc_handle_signal();
              throw new Error(
                "Wasm function __libc_handle_signal() returned (it should never return)!",
              );
            } else {
              throw new Error("Wasm function __libc_handle_signal() not defined!");
            }
          } catch (error) {
            if (error instanceof Trap && error.kind == "signal_return") {
              // ...restore signal frame.
              user_executable_imports.env.__stack_pointer.value =
                vmlinux_instance.exports.get_user_stack_pointer();
              user_executable_instance.exports.__set_tls_base(
                vmlinux_instance.exports.get_user_tls_base(),
              );
            } else {
              // Either a genuine error, or a Trap() from exec() (signal handlers are allowed to call exec()).
              throw error;
            }
          }
        }

        if (flow & 2) {
          throw new Trap("signal_return");
        }
      } else {
        throw new Error("wasm_syscall_tail called with unknown kind");
      }
    },

    // After this line follows host callbacks used by various drivers. In the future, we may make drivers more
    // modularized and allow them to allocate certain resources, like host callbacks, IRQ numbers, even syscalls...

    // Host callbacks by the Wasm-default clocksource.

    wasm_cpu_clock_get_monotonic: () => {
      // Convert this double in ms to u64 in us.
      // Modern browsers can on good days reach 5us accuracy, given that the platform supports it.
      return BigInt(Math.round(1000 * (performance.timeOrigin + performance.now()))) * 1000n;
    },

    // Host callbacks by the Wasm-default random number generator.
    wasm_random_get_bytes: (buffer, count) => {
      if (count > 0x10000) {
        return -1;
      }

      const data = new Uint8Array(count);
      crypto.getRandomValues(data);
      new Uint8Array(memory.buffer).set(data, buffer);

      return count;
    },

    // The guest console is N stock single-port virtio-console devices (issue #83),
    // serviced via the virtio_wasm transport host imports below — there are no
    // bespoke hvc console host callbacks anymore (the hvc_wasm backend is retired).

    // Wayland Phase 1 (1a/1b): the `virtio_wasm` transport's host imports. Every
    // call leads with the host device index `dev`. setup_queue hands us a vq's
    // split-vring byte offsets (nommu identity phys) so the device indexes
    // `memory.buffer` directly; notify is the guest->host kick. The device
    // services the queue synchronously here, then raise_interrupt(0, irq)
    // delivers the used-buffer interrupt. get_features/config_read/config_write/
    // reset back the transport's virtio_config_ops with real host state.
    wasm_virtio_setup_queue: (dev, q, desc, avail, used, num) => {
      const d = get_virtio_device(dev);
      if (d) d.setupQueue(q, desc, avail, used, num);
    },
    wasm_virtio_notify: (dev, q) => {
      const d = get_virtio_device(dev);
      if (d) d.onNotify(q);
    },
    wasm_virtio_get_features: (dev) => {
      const d = get_virtio_device(dev);
      return d ? d.getFeatures() : 0n;
    },
    wasm_virtio_config_read: (dev, off, buf, len) => {
      const d = get_virtio_device(dev);
      if (d) d.configRead(Number(off), d.memView(buf, len));
    },
    wasm_virtio_config_write: (dev, off, buf, len) => {
      const d = get_virtio_device(dev);
      if (d) d.configWrite(Number(off), d.memView(buf, len));
    },
    wasm_virtio_reset: (dev) => {
      const d = get_virtio_device(dev);
      if (d) d.reset();
    },
  };

  /// Callbacks from the main thread.
  const message_callbacks = {
    init: (message) => {
      variant = message.variant;
      arch_bits = variant.startsWith("wasm32_") ? 32 : 64;
      Ulong = arch_bits == 32 ? Number : BigInt;

      if (arch_bits == 64) {
        // Quick hack that truncates parameters to 32-bit Number, then upsamples them to BigInt. Ugly but works in practice for memories <4G.
        for (const method in host_callbacks) {
          const original = host_callbacks[method];
          host_callbacks[method] = function (...args) {
            const result = original(...args.map(Number));
            if (typeof result !== "undefined") {
              return BigInt(result);
            }
          };
        }
      }

      runner_name = message.runner_name;
      if (message.trace_syscalls) trace_enabled = true; // pc (#139): opt-in deep-debug syscall tracing (off by default)
      memory = message.memory;
      locks = message.locks;
      switch_to_last_task = message.last_task; // Only defined for tasks and CPU 0 (init task).

      // Wayland Phase 1 (1b): attach the shared virtio queue-layout store.
      if (message.virtio_queues) {
        virtio_queues = new SharedQueues(message.virtio_queues);
      }
      // Task 2 (#43): squashfs image for the read-only virtio-blk device.
      // Absent on --no-nix boots; the 0-capacity device simply mounts empty.
      if (message.squashfs) {
        squashfsImage = new Uint8Array(message.squashfs);
      }

      if (message.user_executable) {
        // We are in a new runner that should duplicate the user executable. Happens when someone calls clone().
        // pc (new exec ABI): the binary lives as a byte range in the SHARED
        // kernel memory; compile it straight from there (no host Module cache).
        host_callbacks.wasm_load_executable(
          message.user_executable.bin_start,
          message.user_executable.bin_end,
          message.user_executable.data_start,
          message.user_executable.table_start,
          message.user_executable.pt_base,
        );
        // pc (#130): a cloning parent's dynamic-linking snapshot — replayed
        // after the user instance is created (wasm_load_executable above just
        // reset it, so set it after).
        if (message.user_executable.dyn) dyn_replay = message.user_executable.dyn;
        // pc (#129 MMU fork): a fork child rewinds the captured fork() stack
        // at this ctl on first run instead of _start()ing.
        if (message.user_executable.fork_ctl) fork_rewind_ctl = message.user_executable.fork_ctl;
      }

      let import_object = {
        env: {
          ...host_callbacks,
          memory: message.memory,
        },
      };

      // pc (#139 Gate 0.2): a C++ exception that escapes _start surfaces here
      // as a bare WebAssembly.Exception ("Exception" — zero diagnostic value).
      // Decode its payload: the thrown pointer sits right after libc++abi's
      // __cxa_exception header, whose exceptionType field is a type_info
      // whose name pointer is the mangled type name. Header layout isn't
      // worth hardcoding — scan the words just before the thrown object for
      // a pointer that dereferences like a type_info with a plausible
      // mangled-name string, and report what we find. Best-effort.
      const describe_cpp_exception = (error) => {
        try {
          const tag = user_executable_imports && user_executable_imports.env.__cpp_exception;
          if (!tag || !(error instanceof WebAssembly.Exception) || !error.is(tag)) return null;
          const ptr = Number(error.getArg(tag, 0));
          const dv = new DataView(memory.buffer);
          const u8 = new Uint8Array(memory.buffer);
          const cstr = (p, max = 256) => {
            if (p < 8 || p + max > u8.length) return null;
            let s = "";
            for (let i = 0; i < max && u8[p + i]; i++) s += String.fromCharCode(u8[p + i]);
            return s;
          };
          for (let back = 4; back <= 160; back += 4) {
            const ti = dv.getUint32(ptr - back, true);
            if (ti < 8 || ti + 8 > u8.length) continue;
            const name = cstr(dv.getUint32(ti + 4, true));
            if (name && /^(\d+\w|N\w|St\w|PK?\w)/.test(name) && name.length > 2) {
              // Most exception types derive std::exception: first object
              // field is the vptr, what() strings aren't reachable without
              // a vcall — the type name is the actionable part.
              return `uncaught C++ exception @${ptr}: type ${name}`;
            }
          }
          return `uncaught C++ exception @${ptr}: type unknown (header scan failed)`;
        } catch {
          return null;
        }
      };

      // This is a global error handler that is used when calling Wasm code.
      const wasm_error = (error) => {
        // console.error, not log(): log() drains into boot.js's onLog sink,
        // which defaults to a no-op — the page console is what the headless
        // harness (debug.mjs) actually captures.
        const cpp = describe_cpp_exception(error);
        if (cpp) console.error("[user-exec] " + cpp);
        console.error(
          "[user-exec] Wasm crash: " + error.toString() + (error.stack ? "\n" + error.stack : ""),
        );
        log("Wasm crash: " + error.toString());
        console.error(error);

        if (vmlinux_instance) {
          vmlinux_instance.exports.raise_exception();
          throw new Error("raise_exception() returned");
        } else {
          // Only log stack if vmlinux is not up already - it will dump stacks itself.
          log(error.stack);
          throw error;
        }
      };

      const vmlinux_setup = () => {
        // Instantiate a vmlinux Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Copy all passive data segments into their (static) position.
        // * Clear BSS (in its static position).
        // * Drop all passive data segments.
        // An in-memory atomic flag ensures this only happens the first time vmlinux is instantiated on the main memory.
        return WebAssembly.instantiate(message.vmlinux, import_object).then((instance) => {
          vmlinux_instance = instance;
        });
      };

      const vmlinux_run = () => {
        if (message.runner_type == "primary_cpu") {
          // Notify the main thread about init task so that it knows where it resides in memory.
          port.postMessage({
            method: "start_primary",
            init_task: vmlinux_instance.exports.init_task.value,
          });

          // Setup the boot command line. We have the luxury to be able to write to it directly. The maximum length is
          // not set here but is set by COMMAND_LINE_SIZE (defaults to 512 bytes).
          const cmdline = message.boot_cmdline + "\0";
          const cmdline_buffer = Number(vmlinux_instance.exports.boot_command_line.value);
          new Uint8Array(memory.buffer).set(text_encoder.encode(cmdline), cmdline_buffer);

          // Grow the memory to fit initrd and copy it.
          //
          // All typed arrays and views on memory.buffer become invalid by growing and need to be re-created. grow()
          // will return the old size, which becomes our base address for initrd.
          if (arch_bits == 64) {
            const initrd_start =
              memory.grow(BigInt(((message.initrd.byteLength + 0xffff) / 0x10000) | 0)) * 0x10000n;
            const initrd_end = initrd_start + BigInt(message.initrd.byteLength);
            new Uint8Array(memory.buffer).set(new Uint8Array(message.initrd), Number(initrd_start));
            new DataView(memory.buffer).setBigUint64(
              Number(vmlinux_instance.exports.initrd_start.value),
              initrd_start,
              true,
            );
            new DataView(memory.buffer).setBigUint64(
              Number(vmlinux_instance.exports.initrd_end.value),
              initrd_end,
              true,
            );
          } else {
            const initrd_start =
              memory.grow(((message.initrd.byteLength + 0xffff) / 0x10000) | 0) * 0x10000;
            const initrd_end = initrd_start + message.initrd.byteLength;
            new Uint8Array(memory.buffer).set(new Uint8Array(message.initrd), initrd_start);
            new DataView(memory.buffer).setUint32(
              vmlinux_instance.exports.initrd_start.value,
              initrd_start,
              true,
            );
            new DataView(memory.buffer).setUint32(
              vmlinux_instance.exports.initrd_end.value,
              initrd_end,
              true,
            );
          }

          // This will boot the maching on the primary CPU. Later on, it will boot secondaries...
          //
          // _start sets up the Wasm global __stack_pointer to init_stack and calls start_kernel(). Note that this will
          // grow the memory and thus all views on memory.buffer become invalid.
          vmlinux_instance.exports._start();

          // _start() will never return, unless it fails to allocate all memoy it wants to.
          throw new Error("_start did not even succeed in allocating 16 pages of RAM, aborting...");
        } else if (message.runner_type == "secondary_cpu") {
          // start_secondary() will never return. It can be killed by terminate() on this Worker.
          vmlinux_instance.exports._start_secondary(Ulong(message.idle_task));

          throw new Error("start_secondary returned");
        } else if (message.runner_type == "task") {
          // A fresh task, possibly serialized on CPU 0 before secondaries are brought up.
          should_call_clone_callback = vmlinux_instance.exports.ret_from_fork(
            Ulong(message.prev_task),
            Ulong(message.new_task),
          );

          // Two cases exist when we reach here:
          // 1. The kthread that spawned init retuned.
          // The code will already have been loaded, just execute it.
          //
          // 2. Someone called clone.
          // We should call the clone callback on the user executable, which has already been loaded.
          //
          // Notably, we don't end up here after exec() syscalls. Instead, the user instance is reloaded directly.
          return;
        } else {
          throw new Error("Unknown runner_type: " + message.runner_type);
        }
      };

      const user_executable_setup = () => {
        const stack_pointer = vmlinux_instance.exports.get_user_stack_pointer();
        const tls_base = vmlinux_instance.exports.get_user_tls_base();

        user_executable_imports = {
          env: {
            memory: memory,
            __memory_base: new WebAssembly.Global(
              { value: "i" + arch_bits, mutable: false },
              Ulong(user_executable_params.data_start),
            ),
            __stack_pointer: new WebAssembly.Global(
              { value: "i" + arch_bits, mutable: true },
              stack_pointer,
            ),
            // Sized per-binary from the import section (pc, #139 Gate 0.2) —
            // a table smaller than the binary's declared initial fails
            // instantiate. 4096 remains the floor for safety.
            __indirect_function_table: new WebAssembly.Table({
              initial: Math.max(4096, user_executable_params.table_initial || 0),
              element: "anyfunc",
            }),
            __table_base: new WebAssembly.Global(
              { value: "i" + arch_bits, mutable: false },
              Ulong(user_executable_params.table_start),
            ),
            __table_base32: new WebAssembly.Global(
              { value: "i32", mutable: false },
              Number(user_executable_params.table_start),
            ),

            // To be correct, we should save AND restore these globals between the user instance and vmlinux instance:
            // __stack_pointer <-> __user_stack_pointer
            // __tls_base <-> __user_tls_base
            // The kernel interacts with them in the following ways:
            // * Diagnostics (reading them and displaying them in informational messages).
            // * ret_from_fork: writes stack and tls. We have to deal with it, but not here, as this is not a syscall!
            // * syscall exec: tls should be kept even if the process image is replaced (probably has no real use case).
            // * syscall clone: stack and tls should be transfered to the new instance, unless overridden.
            // * signal handlers: also not a syscall - vmlinux calls the host, perhaps during syscall return!
            // The kernel never modifies neither of them for the task that makes a syscall.
            //
            // To make syscalls faster (allowing them to not go through a slow JavaScript wrapper), we skip transferring
            // them back to the user instance. They always have to be transferred to vmlinux at syscall sites, as a
            // signal being handled in its return path would need to save (and restore) them on its signal stack.
            __wasm_syscall_0: syscall_logged(vmlinux_instance.exports.wasm_syscall_0),
            __wasm_syscall_1: syscall_logged(vmlinux_instance.exports.wasm_syscall_1),
            __wasm_syscall_2: syscall_logged(vmlinux_instance.exports.wasm_syscall_2),
            __wasm_syscall_3: syscall_logged(vmlinux_instance.exports.wasm_syscall_3),
            // pc: futex_time64 (nr=422) split-arity shim — see patch 0015.
            // glib's g_futex_simple calls __NR_futex_time64 with 4 args
            // (uaddr, op, val, utime) via __wasm_syscall_4.  The kernel's
            // wasm_syscall_4 dispatch does a 4-arg call_indirect but
            // sys_call_table[422] = sys_futex which is 6-arg → type mismatch
            // trap.  Intercept here: when nr=422 forward to wasm_syscall_6
            // with two extra zero args (uaddr2=0, val3=0), which FUTEX_WAIT/
            // WAKE ignore.  nix.wasm's musl pthread uses __wasm_syscall_6 for
            // nr=422 directly, so it never hits this path.
            __wasm_syscall_4: syscall_logged((sp, tp, nr, a0, a1, a2, a3) => {
              // nr is a Number (wasm32) or BigInt (wasm64); compare both
              if (nr == 422) {
                return vmlinux_instance.exports.wasm_syscall_6(sp, tp, nr, a0, a1, a2, a3, 0, 0);
              }
              return vmlinux_instance.exports.wasm_syscall_4(sp, tp, nr, a0, a1, a2, a3);
            }),
            __wasm_syscall_5: syscall_logged(vmlinux_instance.exports.wasm_syscall_5),
            __wasm_syscall_6: syscall_logged(vmlinux_instance.exports.wasm_syscall_6),

            __wasm_abort: () => {
              debugger;
              throw WebAssembly.RuntimeError("abort");
            },

            // pc (#129 MMU fork): the asyncify fork seam (musl patch 0010's
            // _Fork -> capture_stack). Only fork-built binaries import it;
            // providing it unconditionally is harmless (wasm wires only the
            // imports a module asks for). One fn per worker, late-binding the
            // instance; ctlPtr is recorded per call for the run loop's rewind.
            capture_stack: (capture_stack_fn ||= makeCaptureStack(
              () => user_executable_instance,
              () => fork_result,
            )),

            // pc additions (#139 Gate 0.1 — C++ programs in-guest):
            // * __cpp_exception — wasm-ld links guest programs with -shared
            //   (dylink), which IMPORTS the C++ wasm-EH exception tag instead
            //   of defining it. Provide one per task worker; throw/catch
            //   within a program instance share tag identity. (Exceptions
            //   never cross instances, so per-worker identity is enough.)
            // * logAPIs — debug-logging hook referenced by some objects from
            //   the linux-wasm musl hacks; harmless no-op.
            __cpp_exception: new WebAssembly.Tag({ parameters: ["i" + arch_bits] }),
            logAPIs: () => {},
            // pc additions (#139 Gate 0.2 — clang/lld-sized programs):
            // * __dlsym_time64 — musl's dlsym(3) time64 redirector; only
            //   meaningful under a dynamic linker. A weak undefined that
            //   wasm-ld -shared turns into an import. NULL = "not found",
            //   which is the correct static-link answer.
            // * __cxa_thread_atexit_impl — glibc-style hook libc++abi
            //   prefers for thread_local destructors (weak undefined →
            //   import, same mechanism). Stub returns 0 ("registered"):
            //   thread_local dtors don't run at THREAD exit; process-exit
            //   cleanup is unaffected. Fine for Gate 0.2 (--version runs);
            //   revisit if in-guest tools start leaking per-thread state.
            __dlsym_time64: () => 0,
            __cxa_thread_atexit_impl: () => 0,

            // pc (#126 Track C / #130): the dlopen/dlsym host surface (ENGINE_ABI
            // 8). The guest musl's wasm dlopen port drives these:
            //   1. it reads the whole .so file into its own memory (the guest FS
            //      just works — 9P/squashfs/initramfs alike),
            //   2. __wasm_dl_probe parses the image's dylink.0 requirements so
            //      the guest can malloc the module's data region itself (the
            //      guest allocator owns the arena),
            //   3. __wasm_dlopen instantiates the side module at that memoryBase
            //      against this process's Memory + shared table (runtime/
            //      dylink.js — GOT resolution, elem-slot dlsym, fpcast rule).
            // dlopen(NULL) is __wasm_dlopen(0,0,0,flags) → handle 1 (the main
            // program); dlsym handle 0 = RTLD_DEFAULT (global scope).
            __wasm_dl_probe: (bufPtr, bufLen, outPtr) => {
              const b = new Uint8Array(memory.buffer).subarray(
                Number(bufPtr),
                Number(bufPtr) + Number(bufLen),
              );
              const r = ensure_dyn_loader().probe(b);
              if (typeof r === "number") return r;
              const dv = new DataView(memory.buffer);
              dv.setUint32(Number(outPtr), r.memSize, true);
              dv.setUint32(Number(outPtr) + 4, r.memAlign, true); // log2, as in dylink.0
              dv.setUint32(Number(outPtr) + 8, r.tableSize, true);
              return 0;
            },
            __wasm_dlopen: (bufPtr, bufLen, memoryBase, flags) => {
              if (Number(bufPtr) === 0) return 1; // dlopen(NULL) → the main program
              const b = new Uint8Array(memory.buffer).subarray(
                Number(bufPtr),
                Number(bufPtr) + Number(bufLen),
              );
              // musl RTLD_GLOBAL = 0x100; default (RTLD_LOCAL) modules don't
              // serve symbols to later loads or RTLD_DEFAULT searches.
              return ensure_dyn_loader().load(b, Number(memoryBase), {
                name: `dlopen@${Number(bufPtr)}`,
                global: (Number(flags) & 0x100) !== 0,
              });
            },
            __wasm_dlsym: (handle, namePtr) => {
              return ensure_dyn_loader().dlsym(
                Number(handle),
                get_cstring(memory, Number(namePtr)),
              );
            },

            // pc (#126 Track C / #130): runtime libffi. The in-tree
            // wasm32-raw-ffi.c backend enumerates call signatures at BUILD time
            // (a fixed trampoline table, bounded K=24/M=2, no structs/varargs);
            // a call whose signature falls outside that table lands here. We
            // generate + cache a wasm trampoline module for the EXACT signature
            // (runtime/ffi-codegen.js — the same runtime-instantiation primitive
            // dlopen uses) and invoke it. The signature is a byte descriptor at
            // sigPtr: [nparams, retcode, p0code, …] where a code is 0=void
            // (ret only), 1=i32, 2=i64, 3=f32, 4=f64. argPtr/retPtr are the
            // 8-byte-slotted arg buffer + result slot the C backend prepared.
            // Canonical-thunk targets (fpcast'd modules) get the (i64×128)->i64
            // ABI; the loader decides from which module owns table[funcIndex].
            __wasm_ffi_call: (funcIndex, argPtr, retPtr, sigPtr, sigLen) => {
              const u8 = new Uint8Array(memory.buffer);
              const base = Number(sigPtr);
              const CODES = [null, "i32", "i64", "f32", "f64"];
              const np = u8[base];
              const ret = CODES[u8[base + 1]];
              const params = [];
              for (let i = 0; i < np; i++) params.push(CODES[u8[base + 2 + i]]);
              const canonical = ensure_dyn_loader().isCanonicalSlot(Number(funcIndex));
              ensure_ffi().call(
                { params, result: ret },
                canonical,
                Number(funcIndex),
                Number(argPtr),
                Number(retPtr),
              );
              return 0;
            },

            // __lsan_disable / __lsan_enable / __lsan_ignore_object — glib's
            // LeakSanitizer hooks, declared weak-undefined and called behind a
            // `&sym != NULL` guard (glib/glib-private.h). wasm-ld -shared turns a
            // weak-undefined FUNCTION into BOTH a `GOT.func.<sym>` address import
            // (resolved to 0 below → the guard is false) AND a callable
            // `env.<sym>` function import that must exist for the module to
            // instantiate even though the guard means it's never actually called.
            // Provide no-op stubs so instantiation succeeds; the NULL GOT address
            // keeps the lsan path disabled, which is the correct answer with no
            // LeakSanitizer linked. (__lsan_disable surfaced with M3b GTK: the
            // 14.6MB libgtk references the full disable/enable bracket pair, not
            // just glib's enable/ignore_object — same weak-undef mechanism.)
            __lsan_disable: () => {},
            __lsan_enable: () => {},
            __lsan_ignore_object: () => {},
          },

          // GOT.func / GOT.mem — wasm-ld emits a `GOT.func.<sym>` (or
          // `GOT.mem.<sym>`) mutable-global import whenever a -shared (dylink)
          // module takes the *address* of a WEAK-UNDEFINED function (or data)
          // symbol: code under a dynamic linker expects the loader to patch the
          // global with the symbol's resolved table-index / data-address. A
          // genuinely-absent weak symbol has address 0 (NULL) — exactly what the
          // referencing C code's `&sym != NULL` guard tests for. We don't have a
          // dynamic linker; the static-link answer is NULL. So resolve every
          // GOT.func/GOT.mem request to a fresh i{arch_bits} global of 0.
          //
          // First triggered by glib (M3a): glib's slice allocator references
          // `__lsan_enable`/`__lsan_ignore_object` as weak-undefined (its
          // LeakSanitizer integration), gated behind `sym != NULL`. With no
          // LeakSanitizer linked the addresses are NULL → the guard is false →
          // the lsan path is skipped, which is correct. Shared across the whole
          // glib/GTK stack (and any future weak-undefined-address consumer);
          // mirrors the env.* weak-undefined-function stubs above.
          "GOT.func": new Proxy(
            {},
            {
              get: (_target, prop) =>
                typeof prop === "string"
                  ? new WebAssembly.Global({ value: "i" + arch_bits, mutable: true }, Ulong(0))
                  : undefined,
            },
          ),
          "GOT.mem": new Proxy(
            {},
            {
              get: (_target, prop) =>
                typeof prop === "string"
                  ? new WebAssembly.Global({ value: "i" + arch_bits, mutable: true }, Ulong(0))
                  : undefined,
            },
          ),
        };

        // Instantiate a user Wasm Module. This will implicitly run __wasm_init_memory, which will effectively:
        // * Initialize the TLS pointer (to a data_start-relocated static area, for the first thread).
        // * Copy all passive data segments into their (data_start-relocated) position.
        // * Clear BSS (data_start-relocated).
        // * Drop all passive data segments (except the TLS region, which is saved, but unused in the musl case).
        // An atomic flag ensures this only happens for the first thread to be started (using instantiate).
        //
        // The TLS pointer will be initialized in the following way ways:
        // * kthread-returns-to-init: __user_tls_base would be 0 as it's zero-initialized on the kthreads switch_stack.
        //   (We are ignoring it.) __wasm_init_memory() would initialize it to the static area as described above.
        //
        // * exec: __user_tls_base should have been the value of the process calling exec (during the syscall). However,
        //   we would want to restore it as part of initializing the runtime, which is exactly what __wasm_init_memory()
        //   does. This also means that whatever value the task calling exec() supplied for tls is ignored.
        //
        // * clone: clone explicitly passes its tls pointer to the kernel as part of the syscall. Unless the tls pointer
        //   has been overridden with CLONE_SETTLS, it will be copied from the old task to the new one. This is mostly
        //   useful when CLONE_VFORK is used, in which case the new task can borrow the TLS until it calls exec or exit.
        let woken = user_executable.then((user_module) =>
          WebAssembly.instantiate(user_module, user_executable_imports),
        );

        woken = woken.then((instance) => {
          // pc (#128 software MMU): a softmmu-instrumented image exports the
          // mutable __mmu_pt_base global its inlined translate reads — point
          // it at this task's page-table root BEFORE any of the module's own
          // code (start, relocs) runs. Per-task instances each carry their own
          // root, so context switches swap nothing. The pass also STRIPS the
          // wasm start section (__wasm_init_memory would run during
          // instantiate, before pt_base could be set, and place data through a
          // zero table) and re-exports it as __mmu_start — run it now, after
          // pt_base and before relocs.
          if (instance.exports.__mmu_pt_base && user_executable_params.pt_base) {
            instance.exports.__mmu_pt_base.value = user_executable_params.pt_base;
            // pc (#128/#129): remember OUR immutable root so serialize_me can
            // restore it after a context switch clobbers the instance global
            // with a foreign pgd (see own_pt_base's declaration).
            own_pt_base = user_executable_params.pt_base;
          }
          if (instance.exports.__mmu_start) {
            instance.exports.__mmu_start();
          }
          // wasm-ld only emits __wasm_apply_data_relocs when the module actually has
          // data relocations to apply. A program that references no relocatable data
          // (e.g. `int main(void){return 0;}` — no libc objects pulled, no embedded
          // pointers) has none, so the export is absent. Calling it unconditionally
          // would throw and kill the process at startup. Guard it exactly like the
          // __wasm_call_ctors call below (an optional dylink-module startup export).
          if (instance.exports.__wasm_apply_data_relocs) {
            instance.exports.__wasm_apply_data_relocs();
          }
          if (should_call_clone_callback) {
            // Note: __wasm_init_tls cannot be used as it would also re-initilize the _Thread_local variables' data. But
            // on a clone(), it is none of our business to do that. It's up to the libc to do that as part of pthreads.
            // Indeed, for example on a clone with CLONE_VFORK, the right thing to do may be to borrow the parent's TLS.
            // Unfortunately, LLVM does not export __tls_base directly on dynamic libraries, so we go through a wrapper.
            instance.exports.__set_tls_base(tls_base);
          }
          user_executable_instance = instance;

          // pc (#130): a cloning parent had dlopen'd side modules / handed out
          // dynamic table slots — replay them into this child NOW, before any
          // user code runs, so every function-pointer value in the (shared)
          // memory resolves identically here (Track 0 §4 step 3). Relocs and
          // ctors are skipped by the replay path — the shared memory already
          // holds the parent's initialized data.
          if (dyn_replay) {
            const snap = dyn_replay;
            dyn_replay = null;
            ensure_dyn_loader().replay(snap);
          }
          return instance;
        });

        return woken;
      };

      // pc (#129 MMU fork): drive a user entry export, orchestrating forks.
      // An entry export returns ONLY when a fork() unwound it (asyncify parks
      // the instance mid-unwind); anything else is the legacy "should never
      // return" error. On an unwind: finish it, drive the kernel clone
      // (wasm_fork_current — the generic COW mm dup; the child task spawns
      // lazily with fork_ctl and rewinds in ITS worker), then REWIND this
      // (parent) instance so capture_stack returns the child pid, re-entering
      // through the SAME export. Loops so nested forks just work.
      const run_user_entry = (instance, enter, label) => {
        for (;;) {
          enter();
          if (!isPendingUnwind(instance)) {
            throw new Error("Wasm function " + label + " returned (it should never return)!");
          }
          stopUnwind(instance);
          const ctl = capture_stack_fn.ctlPtr;
          // The true fork-time user SP/TLS — fork bypasses syscall entry (the
          // unwind returned out of the entry export), so the kernel's pt_regs
          // still hold the LAST syscall's stale values; wasm_fork_current
          // stamps these before kernel_clone so the child resumes correctly.
          const sp = user_executable_imports.env.__stack_pointer.value;
          const tls = instance.exports.__get_tls_base ? instance.exports.__get_tls_base() : 0;
          const pid = vmlinux_instance.exports.wasm_fork_current(Ulong(sp), Ulong(tls), Ulong(ctl));
          fork_result = Number(pid); // -errno on failure; musl __syscall_ret handles it
          startRewind(instance, ctl);
          // loop: re-enter the same export; asyncify fast-forwards to the
          // fork() call site, where capture_stack (REWINDING) returns the pid.
        }
      };

      const user_executable_run = (instance) => {
        if (fork_rewind_ctl) {
          // pc (#129 MMU fork): this task IS a fork child. Its memory image is
          // the parent's via the kernel's COW page tables (same shared arena,
          // own pt_base — applied at instantiation), including the captured
          // fork() stack at the ctl. Rewind it: fork() returns 0 here. SP/TLS
          // were stamped by wasm_fork_current and already restored by the
          // standard setup (get_user_stack_pointer / __set_tls_base via the
          // clone-callback path — ret_from_fork returns 1 for fork children
          // too, which is why this check PRECEDES the clone-callback branch).
          // NOTE: re-entry is via _start — a fork from inside a clone-with-fn
          // child (__libc_clone_callback) is NOT supported (the captured image
          // would not match _start's frame); posix_spawn children exec
          // immediately, so that path has no fork.
          const ctl = fork_rewind_ctl;
          fork_rewind_ctl = 0; // consume-once: a later exec must _start fresh
          should_call_clone_callback = false;
          fork_result = 0;
          startRewind(instance, ctl);
          run_user_entry(instance, () => instance.exports._start(), "_start (fork rewind)");
        } else if (should_call_clone_callback) {
          // We have to reset this state, because if the clone callback calls exec, we have to run _start() instead!
          should_call_clone_callback = false;

          if (instance.exports.__libc_clone_callback) {
            run_user_entry(
              instance,
              () => instance.exports.__libc_clone_callback(),
              "__libc_clone_callback()",
            );
          } else {
            throw new Error("Wasm function __libc_clone_callback() not defined!");
          }
        } else {
          if (instance.exports._start) {
            // Ideally libc would do this instead of the usual __init_array stuff (e.g. override __libc_start_init in
            // musl). However, a reference to __wasm_call_ctors becomes a GOT import in -fPIC code, perhaps rightfully
            // so with the current implementation and use case on LLVM. Anyway, we do it here, slightly early on...
            if (instance.exports.__wasm_call_ctors) {
              instance.exports.__wasm_call_ctors();
            }

            // TLS: somewhat incorrectly contains 0 instead of the TP before exec(). Since we will anyway not care about
            // its value (__wasm_apply_data_relocs() called would have overwritten it in this case) it does not matter.
            run_user_entry(instance, () => instance.exports._start(), "_start()");
          } else {
            throw new Error("Wasm function _start() not defined!");
          }
        }
      };

      const user_executable_error = (error) => {
        if (error instanceof Trap) {
          if (error.kind == "reload_program") {
            // Someone called exec and the currently executing code should stop. We should run the new user code already
            // loaded by wasm_load_executable().
            return user_executable_chain();
          } else if (error.kind == "panic") {
            // This has already been handled - just swallow it. This Worker will be done - but kept for later debugging.
          } else {
            throw new Error("Unexpected Wasm host Trap " + error.kind);
          }
        } else {
          wasm_error(error);
        }
      };

      const user_executable_chain = () => {
        // user_executable_error() may deal with an exec() trap and recursively call run_chain() again.
        return user_executable_setup().then(user_executable_run).catch(user_executable_error);
      };

      // All tasks start in the kernel, some return to userland, where they should never return. If they return, we
      // handle this as an error and wait. Our life ends when the kernel kills us by terminating the whole Worker. Oh,
      // and exex() can trap us, in which case we have to circle back to loading new user code and executing it agian.
      vmlinux_setup().then(vmlinux_run).catch(wasm_error).then(user_executable_chain);
    },
    // Wayland Phase 4f: there is intentionally NO `wayland_in` handler here. ALL
    // server→client events — replies, xdg_surface.configure, pointer/keyboard,
    // frame callbacks, the keymap fd — are injected DIRECTLY by the main thread
    // (kernel-host wayland_push_in → host WlDevice over the shared queue SAB),
    // which wakes the parked idle CPU by replicating raise_interrupt() on
    // raised_irqs[0]. The worker only services OUT (it writes each SEND's
    // synchronous ack); IN is the host's. This unifies the two old paths (the
    // synchronous SAB reply + the async wayland_in postMessage) onto one async
    // route, fixing both the cursor-not-tracking bug (4e) and the lost steady-state
    // frame callbacks (4f). The worker forwards VQ_IN refills via wayland_in_refill.
  };

  self.onmessage = (message_event) => {
    const data = message_event.data;
    message_callbacks[data.method](data);
  };

  self.onmessageerror = (error) => {
    throw error;
  };
})(console);
