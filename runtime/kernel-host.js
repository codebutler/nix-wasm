// @ts-nocheck
// oxlint-disable -- vendored upstream linux-wasm host runtime (adapted from linux.js/linux-worker.js); exempt from our lint rules, like pc's vendor/ tree
// SPDX-License-Identifier: GPL-2.0-only
// @ts-nocheck — vendored upstream glue (wasm/BigInt browser-isms; not pc-typed)
//
// Adapted from linux-wasm's runtime/linux.js (Joel Severin, GPL-2.0) — the
// main-thread orchestrator that creates the shared memory and spawns a Web
// Worker per CPU/task. pc additions (ticket #74) are marked "pc:": the
// `ninep_ring` option threads our SAB 9P ring into each task worker, and workers
// are module-type so they can import the 9P glue. (pc also took the upstream
// positional args into a single options object — `on_module_cached` (#141) made
// it 9, which was unwieldy.) See SOURCE.md.
//
// pc: module workers are spawned via createModuleWorker (a Blob shim under
// coi-serviceworker) so they actually load on GitHub Pages — Chromium otherwise
// blocks the top-level module-worker script served through the SW's
// reconstructed COEP response (net::ERR_BLOCKED_BY_RESPONSE → opaque ErrorEvent).
import { createModuleWorker } from "./make-worker.js";
// Wayland (idle wake): the main thread injects unsolicited server→client events
// into the guest's virtio_wl IN vring itself (the worker is parked in
// arch_cpu_idle's wait64 and can't service a postMessage). It reuses the worker's
// device model over the shared queue-layout SAB so vring + avail-cursor state stay
// consistent across the two writers. See wayland_push_in below + kernel patch 0014.
import { SharedQueues } from "./virtio/shared-queues.js";
import { WlDevice } from "./virtio/wl-device.js";
import { NetDevice } from "./virtio/net-device.js";

/// Create a Linux machine and run it.
// pc (ticket #74, multi-tty): `console_write` is now called `(vtermno, text)` —
// output is tagged with its hvc console index — and the returned
// `key_input(vtermno, data)` takes the same index.
export const linux = async ({
  worker_url,
  variant,
  vmlinux,
  boot_cmdline,
  initrd,
  log,
  console_write,
  ninep_ring,
  // Wayland Phase 1 (1b): cross-worker virtio queue-layout store (SAB).
  virtio_queues,
  // Wayland Phase 4f: optional host hook for the worker→main Greenfield bridge.
  // `sendOut(clientId, buffer, fds)` is called FIRE-AND-FORGET when a guest
  // VFD_SEND posts wayland bytes out of the worker; the host feeds them into the
  // main-thread compositor and the response returns asynchronously over the IN
  // queue via wayland_push_in (no SAB reply channel).
  wayland,
  // pc: accepted for caller API stability but now a no-op — the new exec ABI
  // compiles user binaries from shared memory per-exec, so there is no
  // host-side streamed-Module cache whose completion this would signal.
  on_module_cached,
}) => {
  const arch_bits = variant.startsWith("wasm32_") ? 32 : 64;
  const Ulong = arch_bits == 32 ? Number : BigInt;

  /// Dict of online CPUs.
  const cpus = {};

  /// Dict of tasks.
  const tasks = {};

  /// pc (new exec ABI): the host-side compiled-Module cache (keyed by an opaque
  /// per-inode token) is GONE. binfmt_wasm now places the user binary as a byte
  /// range in the SHARED kernel memory; each task worker compiles it directly
  /// from that range (see kernel-worker.js wasm_load_executable). exec reloads
  /// and clone()'d workers both read the same shared range, so there is nothing
  /// to cache or marshal across workers here.

  /// Per-console input buffers (keyboard → tty), keyed by hvc vtermno. pc
  /// (ticket #74, multi-tty): one buffer per console so N terminals can each
  /// feed their own shell on hvc0..hvcN.
  const input_buffers = Object.create(null); // vtermno → ArrayBuffer
  const inbuf = (vt) => input_buffers[vt] || (input_buffers[vt] = new ArrayBuffer(0));

  /// Per-console window size, packed (rows<<16)|cols, shared with the task
  /// workers so the hvc driver can poll it (wasm_driver_hvc_winsize) and
  /// __hvc_resize the tty. pc (ticket #74, TIOCSWINSZ). 16 = max hvc consoles.
  const winsizes = new Int32Array(new SharedArrayBuffer(16 * 4));

  const text_decoder = new TextDecoder("utf-8");
  const text_encoder = new TextEncoder();

  const lock_notify = (locks, lock, count) => {
    Atomics.store(locks._memory, locks[lock], 1);
    Atomics.notify(locks._memory, locks[lock], count || 1);
  };

  const lock_wait = (locks, lock) => {
    Atomics.wait(locks._memory, locks[lock], 0);
    Atomics.store(locks._memory, locks[lock], 0);
  };

  // Wayland (idle wake): host-side virtio_wl IN-injector. An unsolicited
  // server→client event (cursor motion, frame callback) arriving while the guest
  // is FULLY IDLE can't be delivered through the worker — its Worker is parked in
  // arch_cpu_idle()'s memory.atomic.wait64 and never runs JS to service a
  // postMessage (the 2c/4e finding). So the MAIN thread injects directly: a
  // host-side WlDevice over the SAME cross-worker queue-layout SAB (so the IN
  // vring + its avail cursor stay consistent with the worker's instance) whose
  // raiseInterrupt replicates the kernel's raise_interrupt() on shared memory —
  // OR the irq bit into raised_irqs[0] + memory.atomic.notify on it, waking the
  // parked wait64. The worker publishes raised_irqs[0]'s address post-boot
  // (wayland_irq_addr); patch 0014 exports wasm_raised_irqs_ptr() for it.
  //
  // Concurrency: the worker only touches the IN vring when IT has replies to push
  // (during a guest SEND), and the compositor routes events to the SAB reply path
  // (not push_in) while a SEND is in flight — so host and worker are not concurrent
  // IN-vring writers in practice. An idle guest's wake is the LAST step here, after
  // the vring write, so the guest can't kick before the buffer is published.
  const VW_DEV_WL = 0;
  const VIRTIO_WASM_IRQ_BASE = 8; // matches drivers/virtio/virtio_wasm.c + kernel-worker
  const hostWlQueues = new SharedQueues(virtio_queues);
  let wlRaisedIrqsAddr = null; // byte offset of raised_irqs[0].counter (8-byte aligned)
  let hostWlDevice = null;
  const raiseHostWlIrq = (_cpu, irq) => {
    if (wlRaisedIrqsAddr == null) return;
    // Re-view each time: memory.grow() detaches the prior ArrayBuffer.
    const i32 = new Int32Array(memory.buffer);
    const word = wlRaisedIrqsAddr >>> 2; // counter at offset 0; irq (8) < 32 → low word
    Atomics.or(i32, word, 1 << irq);
    Atomics.notify(i32, word, 1);
  };
  const hostWl = () => {
    if (!hostWlDevice && wlRaisedIrqsAddr != null) {
      hostWlDevice = new WlDevice({
        dev: VW_DEV_WL,
        irq: VIRTIO_WASM_IRQ_BASE + VW_DEV_WL,
        memory,
        raiseInterrupt: raiseHostWlIrq,
        onlineCpus: [0], // maxcpus=1
        sharedQueues: hostWlQueues,
        log,
      });
    }
    return hostWlDevice;
  };

  // virtio-net (guest networking): a MAIN-thread NetDevice mirrors the worker's,
  // driving the RX queue (host→guest). It reuses the wl idle-wake machinery —
  // the same raised_irqs[0] address (wlRaisedIrqsAddr, armed by wayland_irq_addr)
  // and raiseHostWlIrq — so writing an inbound frame to the RX vring wakes a
  // parked idle CPU directly, without postMessaging a worker that can't run JS.
  // It shares hostWlQueues (the cross-worker queue-layout SAB) so the RX vring +
  // its avail cursor stay consistent with the worker's instance. dev=2, irq=10.
  const VW_DEV_NET = 2;
  let hostNetDevice = null;
  const hostNet = () => {
    if (!hostNetDevice && wlRaisedIrqsAddr != null) {
      hostNetDevice = new NetDevice({
        dev: VW_DEV_NET,
        irq: VIRTIO_WASM_IRQ_BASE + VW_DEV_NET,
        memory,
        raiseInterrupt: raiseHostWlIrq, // same idle-wake OR/notify path as wl
        onlineCpus: [0], // maxcpus=1
        sharedQueues: hostWlQueues,
        log,
        mac: [0x52, 0x54, 0x00, 0xcb, 0x00, 0x02],
      });
    }
    return hostNetDevice;
  };

  // handle.net.readable: guest-egress ethernet frames. The worker posts each TX
  // frame as { method: "net_out", frame } and we enqueue it here.
  let netController = null;
  let netLinkUp = false;
  const netReadable = new ReadableStream({
    start: (c) => {
      netController = c;
    },
  });
  // handle.net.writable: inbound ethernet frames. Each write is delivered to the
  // guest via the main-thread NetDevice's RX vring (pushRx).
  const netWritable = new WritableStream({
    write: (frame) => {
      hostNet()?.pushRx(frame instanceof Uint8Array ? frame : new Uint8Array(frame));
    },
  });

  /// Callbacks from Web Workers (each one representing one task).
  const message_callbacks = {
    // Wayland (idle wake): the worker hands us raised_irqs[0]'s address once,
    // post-boot, so raiseHostWlIrq can wake the parked idle CPU directly.
    wayland_irq_addr: (message) => {
      wlRaisedIrqsAddr = message.addr >>> 0;
      log(`[wayland] host idle-wake armed: raised_irqs[0] @0x${wlRaisedIrqsAddr.toString(16)}`);
    },
    start_primary: (message) => {
      // CPU 0 has init_task which sits in static storage. After booting it becomes CPU 0's idle task. The runner will
      // in this special case tell us where it is so that we can register it.
      log("Starting cpu 0 with init_task " + message.init_task);
      tasks[message.init_task] = cpus[0];
    },

    start_secondary: (message) => {
      if (message.cpu <= 0) {
        throw new Error("Trying to start secondary cpu with ID <= 0");
      }

      log("Starting cpu " + message.cpu + " (" + message.idle_task + ")");
      make_cpu(message.cpu, message.idle_task);
    },

    stop_secondary: (message) => {
      if (message.cpu <= 0) {
        // If you arrive here, you probably got panic():ed with a broken stack.
        if (
          !confirm(
            "Trying to stop secondary cpu with ID 0.\n\n" +
              "You probably got panic():ed with a broken stack. Continue?\n\n" +
              " (Say ok if you know what you are doing and want to catch the panic, otherwise cancel.)",
          )
        ) {
          throw new Error("Trying to stop secondary cpu with ID 0");
        }
      }

      if (cpus[message.cpu]) {
        log("[Main]: Stopping CPU " + message.cpu);
        cpus[message.cpu].worker.terminate();
        delete cpus[message.cpu];
      } else {
        log(
          "[Main]: Tried to stop CPU " +
            message.cpu +
            " but it was already stopped (broken system)!",
        );
      }
    },

    create_and_run_task: (message) => {
      // ret_from_fork will make sure the task switch finishes.
      make_task(message.prev_task, message.new_task, message.name, message.user_executable);
    },

    release_task: (message) => {
      kill_task(message.dead_task);
    },

    serialize_tasks: (message) => {
      // next_task was previously suspended, wake it up.

      // Tell the next task where we switched from, so that it can finish the task switch.
      tasks[message.next_task].last_task[0] = message.prev_task;

      tasks[message.prev_task].running = false;
      tasks[message.next_task].running = true;

      // Release the above write of last_task and wake up the task.
      lock_notify(tasks[message.next_task].locks, "serialize");

      // In case the task was dying, we're now done. prev_task will wait in serialize_me() but never be scheduled again.
      if (tasks[message.prev_task].kill) {
        kill_task(message.prev_task);
      }
    },

    // Wayland Phase 4f: a guest VFD_SEND's wayland bytes posted out of a task
    // worker, FIRE-AND-FORGET (the worker does not block — it already wrote the
    // SEND's synchronous OUT ack). Re-view the shm fds over the SHARED memory and
    // hand them to the host bridge → main-thread Greenfield. Greenfield's
    // server→client response comes back asynchronously over the IN queue via
    // wayland_push_in (host-side WlDevice + self-wake), NOT as a reply here.
    wayland_out: (message, _worker) => {
      const clientId = message.clientId >>> 0;
      const fds = (message.fds || []).map(
        (f) => new Uint8Array(memory.buffer, f.byteOffset, f.length),
      );
      if (wayland && typeof wayland.sendOut === "function") {
        Promise.resolve(wayland.sendOut(clientId, new Uint8Array(message.buffer), fds)).catch((e) =>
          log("[wayland] sendOut rejected: " + (e && e.stack ? e.stack : e)),
        );
      } else {
        log(`[wayland] OUT for client ${clientId} but no host bridge wired`);
      }
    },

    // Wayland Phase 4f: the guest refilled the IN avail ring; flush any IN
    // messages the host deferred for lack of a free inbuf. The VQ_IN kick lands
    // on the worker, which forwards it here (the host owns the IN vring).
    wayland_in_refill: (_message) => {
      hostWl()?.flushIn();
    },

    // virtio-net: a frame the guest transmitted (worker owns TX). Enqueue it on
    // handle.net.readable for the pc-side tap. `frame` is a transferred
    // ArrayBuffer (the worker posted it with a transfer list).
    net_out: (message) => {
      // Gate: only forward guest-egress frames once the link is up AND a reader
      // is keeping up (desiredSize > 0). Before a tap attaches, frames would
      // buffer unbounded; after close/error, enqueue would throw in this handler.
      if (!netLinkUp || netController == null) return;
      if (!(netController.desiredSize > 0)) return; // queue full — drop rather than buffer unbounded
      try {
        netController.enqueue(new Uint8Array(message.frame));
      } catch {
        // controller closed or errored — drop the frame rather than throw here
      }
    },

    // Wayland: the guest closed a ctx vfd (its Wayland client exited) — forward to
    // the host bridge so the compositor can tear down the matching server-side
    // client immediately (close its window, stop pumping events to a dead ctx).
    wayland_close: (message) => {
      const clientId = message.clientId >>> 0;
      if (wayland && typeof wayland.onClose === "function") {
        Promise.resolve(wayland.onClose(clientId)).catch((e) =>
          log("[wayland] onClose rejected: " + (e && e.stack ? e.stack : e)),
        );
      }
    },

    console_read: (message, worker) => {
      const memory_u8 = new Uint8Array(memory.buffer);
      const vt = message.vtermno | 0;
      const buffer = new Uint8Array(inbuf(vt));

      const used = buffer.slice(0, message.count);
      memory_u8.set(used, message.buffer);

      input_buffers[vt] = buffer.slice(message.count).buffer;

      // Tell the Worker that asked for input how many bytes (perhaps 0) were actually written.
      Atomics.store(message.console_read_messenger, 0, used.length);
      Atomics.notify(message.console_read_messenger, 0, 1);
    },

    console_write: (message) => {
      console_write(message.vtermno | 0, message.message);
    },

    log: (message) => {
      log(message.message);
    },
  };

  /// Memory shared between all CPUs.
  const memory = new WebAssembly.Memory({
    initial: Ulong(30), // TODO: extract this automatically from vmlinux.
    maximum: Ulong(0x10000), // Allow the full 32-bit address space to be allocated.
    shared: true,
    address: "i" + arch_bits,
  });

  /**
   * Create and run one CPU in a background thread (a Web Worker).
   *
   * This will run boot code for the CPU, and then drop to run the idle task. For CPU 0 this involves booting the entire
   * system, including bringing up secondary CPUs at the end, while for secondary CPUs, this just means some
   * book-keeping before dropping into their own idle tasks.
   */
  const make_cpu = (cpu, idle_task) => {
    const options = {
      runner_type: cpu == 0 ? "primary_cpu" : "secondary_cpu",
      idle_task: idle_task,
    };

    if (cpu == 0) {
      options.boot_cmdline = boot_cmdline;
      options.initrd = initrd;
      initrd = null; // allow gc
    }

    // idle_task is undefined for cpu 0, we will know it first when start_primary notifies us.
    const name = "CPU " + cpu + " [boot+idle]" + (cpu != 0 ? " (" + idle_task + ")" : "");

    const runner = make_vmlinux_runner(name, options);
    cpus[cpu] = runner;
    if (cpu != 0) {
      tasks[idle_task] = runner; // For CPU 0, start_primary does this registration for us.
    }
  };

  /**
   * Create and run one task. This task has been switch_to():ed by the scheduler for the first time.
   *
   * In the beginning, all tasks are serialized and have to cooperate to schedule eachother, but after secondary CPUs
   * are brought up, they can run concurrently (and will effectively be managed by the Wasm host OS). While we are not
   * able to suspend them from JS, the host OS will do that.
   */
  const make_task = (prev_task, new_task, name, user_executable) => {
    // pc (new exec ABI): user_executable is the binary's byte range
    // ({bin_start,bin_end,data_start,table_start}) in the SHARED kernel memory.
    // Pass it straight to the new worker, which compiles it from shared memory.
    const options = {
      runner_type: "task",
      prev_task: prev_task,
      new_task: new_task,
      user_executable: user_executable,
    };
    tasks[new_task] = make_vmlinux_runner(name + " (" + new_task + ")", options);
  };

  const kill_task = (dead_task) => {
    const task = tasks[dead_task];
    if (task.running) {
      // Case 1: current task is killing itself => we know that the reaped task is currently running (probably kthread).
      //
      // We need to delay killing the worker as it's still running. There is still some code for it to run, and
      // importantly, it needs to notify the next task to run on the CPU in serialize_me(). If the worker was
      // terminated before it was scheduled out, the dead task could deadlock its CPU on tasks[???].locks["serialize"].
      task.kill = true;
    } else {
      // Case 2: current task reaped another task => we know that the reaped task is not running. (kill == false).
      // Case 3: we get here from Case 1 as it eventually scheduled out, calling serialize_me(). (kill == true).
      task.worker.terminate();
      delete tasks[dead_task];
    }
  };

  /// Create a runner for vmlinux. It will run in a Web Worker and execute some specified code.
  const make_vmlinux_runner = (name, options) => {
    // Note: SharedWorker does not seem to allow WebAssembly Module or Memory instances posted.
    const worker = createModuleWorker(worker_url); // name dropped (Blob-shim path can't set it)

    let locks = {
      serialize: 0,
    };
    locks._memory = new Int32Array(new SharedArrayBuffer(Object.keys(locks).length * 4));

    // Store for last task when wasm_serialize() returns in switch_to(). Needed for each task, both normal ones and each
    // CPUs idle tasks (first called init_task (PID 0), not to be confused with init (PID 1) which is a normal task).
    const last_task = new Uint32Array(new SharedArrayBuffer(4));

    worker.onerror = (e) => {
      // pc: surface the real cause instead of re-throwing the opaque Event.
      const detail = `${e?.message || e} @ ${e?.filename || "?"}:${e?.lineno || 0}:${e?.colno || 0}`;
      console.error("[kernel worker error]", detail, e?.error || e);
      log("[worker error] " + detail);
    };

    worker.onmessage = (message_event) => {
      const data = message_event.data;
      message_callbacks[data.method](data, worker);
    };

    worker.onmessageerror = (e) => {
      console.error("[kernel worker messageerror]", e);
      log("[worker messageerror]");
    };

    worker.postMessage({
      ...options,
      method: "init",
      variant: variant,
      vmlinux: vmlinux,
      memory: memory,
      locks: locks,
      last_task: last_task,
      runner_name: name,
      ninep_ring: ninep_ring, // ticket #74: shared 9P transport ring (SAB)
      virtio_queues: virtio_queues, // Wayland 1b: shared virtio queue layouts (SAB)
      winsize_buf: winsizes.buffer, // ticket #74: per-console winsize (SAB)
    });

    return {
      worker: worker,
      locks: locks,
      last_task: last_task,
      running: true,
      kill: false,
    };
  };

  // Create the primary cpu, it will later on callback to us and we start secondaries.
  make_cpu(0);

  return {
    // pc (ticket #74, multi-tty): feed bytes to one console's tty. `vtermno`
    // selects the hvc line (which window/shell); defaults are the caller's job.
    key_input: (vtermno, data) => {
      const vt = vtermno | 0;
      const key_buffer = text_encoder.encode(data); // Possibly UTF-8 (up to 16 bits).

      // Append key_buffer to the end of this console's input buffer.
      const old = inbuf(vt);
      const merged = new Uint8Array(old.byteLength + key_buffer.byteLength);
      merged.set(new Uint8Array(old), 0);
      merged.set(key_buffer, old.byteLength);
      input_buffers[vt] = merged.buffer;
    },

    // pc (ticket #74, TIOCSWINSZ): record a console's window size; the hvc
    // driver polls it via wasm_driver_hvc_winsize and __hvc_resize's the tty.
    set_winsize: (vtermno, cols, rows) => {
      const packed = (((rows | 0) & 0xffff) << 16) | ((cols | 0) & 0xffff);
      Atomics.store(winsizes, vtermno | 0, packed);
    },

    // Wayland Phase 4f: the SINGLE host→guest delivery path. The main-thread
    // compositor calls this for EVERY server→client event — replies,
    // xdg_surface.configure, wl_pointer/keyboard, frame callbacks, wl_buffer.release,
    // and server→client fds (the wl_keyboard keymap, passed in `fds`).
    //
    // Injected DIRECTLY on this (main) thread, NOT posted to the worker: when the
    // guest is idle its Worker is parked in arch_cpu_idle's wait64 and never
    // dequeues a postMessage (the 4e finding). The host WlDevice writes the IN
    // vring over the shared queue SAB and raiseHostWlIrq wakes the parked CPU —
    // this is also why no synchronous SAB reply is needed for SENDs (4f). injectIn
    // no-ops cleanly (logs "deferred") if the IN queue isn't set up yet
    // (pre-handshake) or the wake addr hasn't been published yet.
    // @param {number} clientId  ctx vfd_id
    // @param {Uint8Array} bytes  wire bytes
    // @param {Uint8Array[]} [fds]  server→client fd payloads (keymap)
    wayland_push_in: (clientId, bytes, fds) => {
      const dev = hostWl();
      if (!dev) {
        log("[wayland] push_in dropped: host idle-wake not armed yet");
        return;
      }
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const fdBufs = fds && fds.length ? fds.map((f) => (f instanceof Uint8Array ? f : new Uint8Array(f))) : null;
      dev.injectIn(clientId >>> 0, buf, fdBufs);
    },

    // virtio-net guest networking. `readable` emits guest-egress ethernet
    // frames; writing a frame to `writable` injects it into the guest's RX vring.
    // `setLinkUp(up)` flips the reported VIRTIO_NET_S_LINK_UP config bit.
    net: {
      readable: netReadable,
      writable: netWritable,
      setLinkUp: (up) => {
        netLinkUp = !!up;
        hostNet()?.setLinkUp(up);
      },
    },
  };
};
