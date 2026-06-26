// @ts-nocheck
// oxlint-disable -- vendored upstream linux-wasm host runtime (adapted from linux.js/linux-worker.js); exempt from our lint rules, like pc's vendor/ tree
// SPDX-License-Identifier: GPL-2.0-only
// @ts-nocheck — vendored upstream glue (wasm/BigInt browser-isms; not pc-typed)
//
// Adapted from linux-wasm's runtime/linux.js (Joel Severin, GPL-2.0) — the
// main-thread orchestrator that creates the shared memory and spawns a Web
// Worker per CPU/task. pc additions (ticket #74) are marked "pc:": the 9P
// filesystem rides the stock virtio-9p transport (issue #10) — `ninep_server`
// is serviced by the main-thread virtio-9p host devices — and workers are
// module-type so they can import the 9P glue. (pc also took the upstream
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
import { NinePVirtioDevice } from "./virtio/ninep-device.js";
import { ConsoleVirtioDevice, CONSOLE_PORTS } from "./virtio/console-device.js";
import { VsockVirtioDevice } from "./virtio/vsock-device.js";

/// Create a Linux machine and run it.
// The guest console is the stock MULTIPORT virtio-console device (issue #83):
// `console_sink(port, bytes)` receives each console port's output (port = hvc
// index), and the returned `console_input(port, data)` / `console_resize(port,
// cols, rows)` feed input + window size to that port.
export const linux = async ({
  worker_url,
  variant,
  vmlinux,
  boot_cmdline,
  initrd,
  log,
  // Issue #10: the 9P server (createNinePServer) the main-thread virtio-9p
  // devices service. The server is transport-agnostic (bytes-in/bytes-out via
  // handle(frame, cid)); the per-connection cid keeps each mount's state
  // isolated. Absent → no virtio-9p host servicing.
  ninep_server,
  // Issue #83: per-port sink for the MULTIPORT virtio-console's guest output.
  // The main-thread ConsoleVirtioDevice drains each console port's transmitq and
  // calls this as (port, bytes) — port = hvc/vtermno index, bytes = Uint8Array.
  // This is the guest's SOLE console path (the bespoke hvc_wasm backend is
  // retired). Absent → guest console output is dropped and no input is delivered.
  console_sink,
  // Issue #10 option 3: optional host hook for the virtio-vsock /Ctl bridge.
  // `onReady(device)` is called once with the main-thread VsockVirtioDevice so a
  // caller (the future pc /Ctl consumer) can `device.listen(port, conn => …)`.
  // Absent → the vsock device still exists (config/features answered) but no
  // host listener is registered, so guest connect attempts are RST'd.
  vsock,
  // Wayland Phase 1 (1b): cross-worker virtio queue-layout store (SAB).
  virtio_queues,
  // #43: read-only base-system squashfs image (ArrayBuffer) served as /dev/vdX
  // over virtio-blk. The BlkDevice is built lazily in WHICHEVER task worker
  // first services the virtio-blk vring (not necessarily the boot worker), so —
  // exactly like the 9P ring and the virtio queue-layout store — the image must
  // be a SharedArrayBuffer handed to EVERY worker, not a per-worker copy. We
  // copy the caller's ArrayBuffer into a SAB once here. Undefined on --no-nix.
  squashfs,
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

  // #43: copy the squashfs ArrayBuffer into a SharedArrayBuffer ONCE so every
  // task worker (any of which may end up servicing the virtio-blk vring) sees
  // the same read-only image — the per-worker JS heaps are otherwise isolated.
  // Undefined on a --no-nix boot → no blk image (the device mounts empty).
  let squashfs_sab = null;
  if (squashfs && squashfs.byteLength) {
    squashfs_sab = new SharedArrayBuffer(squashfs.byteLength);
    new Uint8Array(squashfs_sab).set(new Uint8Array(squashfs));
    squashfs = null; // copied into the SAB; allow gc of the caller's buffer
  }

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

  // Issue #10: virtio-9p — MAIN-thread devices that service the 9P "requests"
  // vqs through the shared 9P server. The guest's vq kick lands on a task worker
  // (which forwards it here as virtio9p_notify); the worker can't run the async
  // server.handle (the VFS is main-thread-bound), so the host drains the vring,
  // awaits the reply, writes it back, and raises the completion IRQ via the SAME
  // raised_irqs self-wake virtio-wl/net use (raiseHostWlIrq) — waking the guest
  // task parked in p9_client_rpc. dev/cid MUST match kernel-worker's VW_DEV_9P +
  // kernel patch 0018: 9P_ROOT=dev4/cid1, 9P_NIXCACHE=dev5/cid2.
  const VW_DEV_9P = [
    { dev: 4, cid: 1 },
    { dev: 5, cid: 2 },
  ];
  const hostNinePByDev = new Map(VW_DEV_9P.map((d) => [d.dev, d]));
  const hostNinePDevices = new Map();
  const hostNineP = (dev) => {
    const id = dev >>> 0;
    const spec = hostNinePByDev.get(id);
    if (!spec || !ninep_server || wlRaisedIrqsAddr == null) return null;
    let d = hostNinePDevices.get(id);
    if (!d) {
      d = new NinePVirtioDevice({
        dev: id,
        irq: VIRTIO_WASM_IRQ_BASE + id,
        memory,
        raiseInterrupt: raiseHostWlIrq, // same idle-wake OR/notify path as wl/net
        onlineCpus: [0], // maxcpus=1
        sharedQueues: hostWlQueues, // shared queue-layout SAB (consistent vring state)
        log,
        cid: spec.cid,
        server: ninep_server,
      });
      hostNinePDevices.set(id, d);
    }
    return d;
  };

  // Issue #83: MULTIPORT virtio-console — a MAIN-thread device that runs the
  // control-plane handshake, drains each console port's transmitq (output) to
  // console_sink(port, bytes), and delivers host input on each port's receiveq.
  // The guest's vq kick lands on a task worker (which forwards it here as
  // virtioconsole_notify); the sink + input buffers are main-thread-bound, so the
  // host services the vrings here and raises the completion IRQ via the SAME
  // raised_irqs self-wake virtio-wl/net/9P/vsock use (raiseHostWlIrq) — waking a
  // parked idle CPU for host->guest input/control. dev MUST match kernel-worker's
  // VW_DEV_CONSOLE + kernel patch 0019: index 6, irq 14. Built lazily once the
  // self-wake addr is published (and only if a console_sink was provided).
  const VW_DEV_CONSOLE = 6;
  let hostConsoleDevice = null;
  const hostConsole = () => {
    if (!hostConsoleDevice && console_sink && wlRaisedIrqsAddr != null) {
      hostConsoleDevice = new ConsoleVirtioDevice({
        dev: VW_DEV_CONSOLE,
        irq: VIRTIO_WASM_IRQ_BASE + VW_DEV_CONSOLE,
        memory,
        raiseInterrupt: raiseHostWlIrq, // same idle-wake OR/notify path as wl/net/9P
        onlineCpus: [0], // maxcpus=1
        sharedQueues: hostWlQueues, // shared queue-layout SAB (consistent vring state)
        log,
        ports: CONSOLE_PORTS,
        sink: (port, bytes) => console_sink(port, bytes),
      });
    }
    return hostConsoleDevice;
  };

  // Issue #10 option 3: virtio-vsock — a MAIN-thread device that runs the vsock
  // protocol (handshake / RW / credit / shutdown) and exposes the host socket
  // API for the /Ctl bridge. The guest's vq kick lands on a task worker (which
  // forwards it here as virtiovsock_notify); the worker can't run the async
  // socket callbacks. The completion/host→guest IRQ uses the SAME raised_irqs
  // self-wake virtio-wl/net/9p use (raiseHostWlIrq). dev MUST match
  // kernel-worker's VW_DEV_VSOCK + kernel patch 0020: index 7.
  const VW_DEV_VSOCK = 7;
  let hostVsockDevice = null;
  let vsockReadyFired = false;
  const hostVsock = () => {
    if (wlRaisedIrqsAddr == null) return null;
    if (!hostVsockDevice) {
      hostVsockDevice = new VsockVirtioDevice({
        dev: VW_DEV_VSOCK,
        irq: VIRTIO_WASM_IRQ_BASE + VW_DEV_VSOCK,
        memory,
        raiseInterrupt: raiseHostWlIrq, // same idle-wake OR/notify path as wl/net/9p
        onlineCpus: [0], // maxcpus=1
        sharedQueues: hostWlQueues, // shared queue-layout SAB (consistent vring state)
        log,
      });
      // Hand the device to the caller (pc /Ctl consumer) so it can listen().
      if (!vsockReadyFired && vsock && typeof vsock.onReady === "function") {
        vsockReadyFired = true;
        try {
          vsock.onReady(hostVsockDevice);
        } catch (e) {
          log("[vsock] onReady threw: " + (e && e.stack ? e.stack : e));
        }
      }
    }
    return hostVsockDevice;
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
        // No external compositor bridge (the node smoke harness): serve the SEND
        // with the in-process WlServer registry-handshake stub on the host-side
        // WlDevice, which injects the reply over the SAME IN vring + raised_irqs
        // self-wake the compositor path uses. This is what makes wl-handshake a
        // real host→guest regression gate. fds (shm) are unused by the handshake.
        hostWl()?.serveLocal(clientId, new Uint8Array(message.buffer));
      }
    },

    // Wayland Phase 4f: the guest refilled the IN avail ring; flush any IN
    // messages the host deferred for lack of a free inbuf. The VQ_IN kick lands
    // on the worker, which forwards it here (the host owns the IN vring).
    wayland_in_refill: (_message) => {
      hostWl()?.flushIn();
    },

    // Issue #10: a guest virtio-9p kick the task worker forwarded. The 9P server
    // is async + main-thread, so the worker can't service it — the host drains
    // the device's "requests" vq, runs each T-message through the server, writes
    // the R-message back, and raises the completion IRQ (raised_irqs self-wake).
    virtio9p_notify: (message) => {
      void hostNineP(message.dev)?.service(message.q >>> 0);
    },

    // Issue #10 (option 2): a guest virtio-console kick the task worker
    // forwarded. The console sink + input buffer are main-thread-bound, so the
    // worker can't service it — the host drains the transmitq to console_sink
    // (q1) or flushes pending host input into the receiveq (q0), then raises the
    // completion IRQ (raised_irqs self-wake). The device routes the queue index.
    virtioconsole_notify: (message) => {
      hostConsole()?.onNotify(message.q >>> 0);
    },

    // Issue #10 option 3: a guest virtio-vsock kick the task worker forwarded.
    // The vsock protocol + host socket callbacks are main-thread-bound, so the
    // worker can't service it — the host drives the kicked vq (tx drain / rx
    // refill / event) and raises the IRQ via the raised_irqs self-wake.
    virtiovsock_notify: (message) => {
      hostVsock()?.onNotify(message.q >>> 0);
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

    const init_msg = {
      ...options,
      method: "init",
      variant: variant,
      vmlinux: vmlinux,
      memory: memory,
      locks: locks,
      last_task: last_task,
      runner_name: name,
      virtio_queues: virtio_queues, // Wayland 1b: shared virtio queue layouts (SAB)
      squashfs: squashfs_sab, // #43: read-only base-system squashfs image (SAB), served as /dev/vdX
    };
    worker.postMessage(init_msg);

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
    // Issue #83: feed host input bytes to one console port's tty (stdin) over its
    // virtio-console receiveq. `port` selects the hvc line (which window/shell);
    // queued + flushed via the main-thread ConsoleVirtioDevice (raised_irqs
    // self-wake), so bytes posted before the guest sets up the receiveq stay
    // pending and are delivered on the next refill.
    console_input: (port, data) => {
      const bytes = data instanceof Uint8Array ? data : text_encoder.encode(data);
      hostConsole()?.pushRx(port | 0, bytes);
    },

    // Issue #83: set a console port's window size — a virtio-console RESIZE
    // control message → the guest's hvc_resize → TIOCSWINSZ/SIGWINCH on the tty.
    console_resize: (port, cols, rows) => {
      hostConsole()?.resize(port | 0, cols | 0, rows | 0);
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
      const fdBufs =
        fds && fds.length
          ? fds.map((f) => (f instanceof Uint8Array ? f : new Uint8Array(f)))
          : null;
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
