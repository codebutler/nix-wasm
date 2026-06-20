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

  /// Phase 2 fork: fork-time memory snapshots for lazily-spawned fork children,
  /// keyed by child pid (child_pid -> { snapshot, ctlPtr, cloneCallback }). The
  /// forking worker stages them here (stage_fork_snapshot) because a lazy child's
  /// create_and_run_task may run in a DIFFERENT worker than the one that forked.
  const pendingForks = new Map();

  /// CONFIG_WASM_TRACE: location of the kernel's shared-memory trace ringbuffer
  /// ({ring, head, slots_addr} BSS addresses), published by the CPU-0 worker at
  /// boot. Read OUT-OF-BAND by dumpWtrace() (below) straight from the shared
  /// `memory`, independent of console flush / which worker is wedged.
  let wtrace_info = null;

  // CONFIG_WASM_TRACE event-id → name map (asm/wtrace.h enum wtrace_event),
  // shared by dumpWtrace() and the WT_DUMP_AT one-shot dumper.
  const _wtEV = {
    1: "MMAP_ENTER",
    2: "MMAP_SEM_GET",
    3: "MMAP_SEM_HELD",
    4: "MMAP_SHARE_SCAN",
    5: "MMAP_SHARE_ITER",
    6: "MMAP_SHARE_HIT",
    7: "MMAP_PRIVATE",
    8: "MMAP_ADDREGION",
    9: "MMAP_ADDREGION_DONE",
    10: "MMAP_ZERO",
    11: "MMAP_SEM_PUT",
    12: "MMAP_DONE",
    13: "ADDREG_ENTER",
    14: "ADDREG_LOOP",
    15: "ADDREG_BUG",
    16: "ALLOC_ENTER",
    17: "ALLOC_FREELIST",
    18: "ALLOC_GROW",
    19: "ALLOC_DONE",
    20: "PUTREG_ENTER",
    21: "PUTREG_DONE",
    106: "MMAP_VMA_STORE",
  };
  // Read the kernel trace ringbuffer out-of-band from the shared `memory`
  // (referenced lazily — declared below; only ever called post-boot). Returns
  // the last `n` records, decoded. [] without CONFIG_WASM_TRACE (wtrace_info
  // stays null). Exposed via the handle's dumpWtrace().
  const handleDumpWtrace = (n = 256) => {
    if (!wtrace_info) return [];
    const REC = 56; // sizeof(struct wtrace_rec)
    const dv = new DataView(memory.buffer);
    const slots = dv.getUint32(wtrace_info.slots_addr, true);
    const head = dv.getUint32(wtrace_info.head, true); /* unsigned long = 4 bytes on wasm32 */
    if (!head) return [];
    const out = [];
    const start = Math.max(1, head - Math.min(n, slots) + 1);
    for (let seq = start; seq <= head; seq++) {
      const idx = (seq - 1) & (slots - 1);
      const base = wtrace_info.ring + idx * REC;
      const s0 = Number(dv.getBigUint64(base, true));
      if (s0 === 0) continue;
      const ts = Number(dv.getBigUint64(base + 8, true));
      const pid = dv.getUint32(base + 16, true);
      const cpu = dv.getUint32(base + 20, true);
      const event = dv.getUint32(base + 24, true);
      const a0 = Number(dv.getBigUint64(base + 32, true));
      const a1 = Number(dv.getBigUint64(base + 40, true));
      const a2 = Number(dv.getBigUint64(base + 48, true));
      const s1 = Number(dv.getBigUint64(base, true));
      if (s1 !== s0) continue;
      out.push({ seq: s0, ts, pid, cpu, event, a0, a1, a2 });
    }
    out.sort((x, y) => x.seq - y.seq);
    return out;
  };

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
      // CONFIG_WASM_TRACE: remember the trace ringbuffer location for dumpWtrace().
      if (message.wtrace) wtrace_info = message.wtrace;
      // WT_DUMP_AT=<ms>: one-shot self-contained dump of the trace ring to a
      // file at a fixed wall-clock delay, then exit. Runs entirely on the main
      // thread with direct `memory`+`wtrace_info` access (no test await chain),
      // so it captures a quiet wedge before V8's shared-Memory external-memory
      // accounting OOMs a long-lived harness. Diagnostic only (WT_DUMP_AT unset
      // in normal use).
      if (typeof process !== "undefined" && process.env && process.env.WT_DUMP_AT) {
        const fs = require("fs");
        const delay = Number(process.env.WT_DUMP_AT);
        const file = process.env.WT_DUMP_FILE || "/tmp/wt-oneshot.txt";
        const t = setTimeout(() => {
          // Stream straight to an fd, reading one record at a time (no big
          // arrays) — at the dump moment the process is near V8's limit from
          // the workers' shared Memories, so allocate as little as possible.
          let fd = -1;
          try {
            fd = fs.openSync(file, "w");
            const dv = new DataView(memory.buffer);
            const slots = dv.getUint32(wtrace_info.slots_addr, true);
            const head = dv.getUint32(
              wtrace_info.head,
              true,
            ); /* unsigned long = 4 bytes on wasm32 */
            const REC = 56;
            const rd = (seq) => {
              const idx = (seq - 1) & (slots - 1);
              const b = wtrace_info.ring + idx * REC;
              return {
                seq: Number(dv.getBigUint64(b, true)),
                pid: dv.getUint32(b + 16, true),
                cpu: dv.getUint32(b + 20, true),
                ev: dv.getUint32(b + 24, true),
                a0: Number(dv.getBigUint64(b + 32, true)),
                a1: Number(dv.getBigUint64(b + 40, true)),
                a2: Number(dv.getBigUint64(b + 48, true)),
              };
            };
            fs.writeSync(fd, `WT_DUMP_AT=${delay} head=${head} slots=${slots}\n`);
            // last event per pid (single scan over the live window)
            const N = Math.min(slots, head);
            const lastByPid = new Map();
            for (let seq = head - N + 1; seq <= head; seq++) {
              if (seq < 1) continue;
              const r = rd(seq);
              if (r.seq === seq) lastByPid.set(r.pid, r);
            }
            fs.writeSync(fd, "=== last event per pid ===\n");
            for (const [p, r] of [...lastByPid].sort((a, b) => a[0] - b[0]))
              fs.writeSync(
                fd,
                `pid ${p}: ${_wtEV[r.ev] || r.ev} @${r.seq} a0=0x${(r.a0 >>> 0).toString(16)} a1=0x${(r.a1 >>> 0).toString(16)} a2=0x${(r.a2 >>> 0).toString(16)}\n`,
              );
            // tail 250
            fs.writeSync(fd, "=== tail 250 ===\n");
            for (let seq = Math.max(1, head - 250 + 1); seq <= head; seq++) {
              const r = rd(seq);
              if (r.seq !== seq) continue;
              fs.writeSync(
                fd,
                `${r.seq} p${r.pid}/c${r.cpu} ${_wtEV[r.ev] || r.ev} a0=0x${(r.a0 >>> 0).toString(16)} a1=0x${(r.a1 >>> 0).toString(16)} a2=0x${(r.a2 >>> 0).toString(16)}\n`,
              );
            }
            fs.closeSync(fd);
            console.error(`[WT_DUMP_AT] wrote ${file} head=${head}`);
          } catch (e) {
            try {
              if (fd >= 0) fs.closeSync(fd);
            } catch {}
            console.error("[WT_DUMP_AT] failed", String(e).slice(0, 120));
          }
          process.exit(0);
        }, delay);
        if (t.unref) t.unref();
      }
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
      // Task 2.3: `clone_vm` (if present) carries the parent's private Memory +
      // owner pid for a CLONE_VM child sharing the parent's address space.
      // Phase 2: `fork` carries a fork child's fork-time memory snapshot + ctl
      // pointer. It's attached directly only for a SYNCHRONOUS same-worker spawn;
      // a LAZY child's create_and_run_task may run in a different worker that
      // can't see the staging slot, so the forking worker routed the snapshot
      // here (stage_fork_snapshot, keyed by child pid). Fill it from pendingForks.
      let fork = message.fork;
      if (!fork && message.fork_child_pid) {
        fork = pendingForks.get(message.fork_child_pid) || null;
        if (fork) pendingForks.delete(message.fork_child_pid);
      }
      make_task(
        message.prev_task,
        message.new_task,
        message.name,
        message.user_executable,
        message.clone_vm,
        fork,
      );
    },

    // Phase 2 fork: a forking worker routes a lazily-spawned child's fork-time
    // snapshot here (keyed by child pid) so whichever worker later runs that
    // child's create_and_run_task can pick it up (cross-worker — see
    // kernel-worker.js). The snapshot ArrayBuffer was transferred in.
    stage_fork_snapshot: (message) => {
      pendingForks.set(message.child_pid, message.fork);
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

    // Task 2.3: DEAD PATH (kept inert). T2.1 minted a process's private base-0
    // memory HERE on the main thread and transferred it to the requesting
    // worker. The T2.3 correction mints the private memory WORKER-LOCAL +
    // SYNCHRONOUSLY inside wasm_user_mem_create (kernel-worker.js mintUserMem),
    // because a transferred Memory can never arrive in time (the worker runs
    // exec → instantiation without yielding) and can't be transferred to a
    // worker parked in Atomics.wait. R1 never needs main to hold a private
    // Memory: uaccess + instantiation are in-worker; main-thread host callbacks
    // touch only the shared KERNEL `memory`. The worker no longer posts
    // `create_user_mem`, so this handler is unreachable; left inert (harmless if
    // a stale path ever fired) rather than deleted.
    create_user_mem: (message, worker) => {
      // `WebAssembly.Memory` descriptors take PLAIN Numbers for initial/maximum
      // (even on a wasm64 / "i64" address memory). These page counts originate
      // from the kernel's i64 `wasm_user_mem_create(pid, init_pages)` arg, so on
      // a 64-bit arch they may arrive as BigInt — `Number(...)` coerces them; the
      // old `Ulong(...)` wrapped them back to BigInt on wasm64 (`Ulong === BigInt`
      // there), which `WebAssembly.Memory` rejects. (T2.1 Minor fix.)
      const mem = new WebAssembly.Memory({
        initial: Number(message.init_pages),
        maximum: Number(message.max_pages),
        shared: false,
        address: "i" + arch_bits,
      });
      worker.postMessage({ method: "user_mem_ready", pid: message.pid, memory: mem }, [mem]);
    },

    // Wayland Phase 4f: the guest refilled the IN avail ring; flush any IN
    // messages the host deferred for lack of a free inbuf. The VQ_IN kick lands
    // on the worker, which forwards it here (the host owns the IN vring).
    wayland_in_refill: (_message) => {
      hostWl()?.flushIn();
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
  const make_task = (prev_task, new_task, name, user_executable, clone_vm, fork) => {
    // pc (new exec ABI): user_executable is the binary's byte range
    // ({bin_start,bin_end,data_start,table_start}) in the SHARED kernel memory.
    // Pass it straight to the new worker, which compiles it from shared memory.
    const options = {
      runner_type: "task",
      prev_task: prev_task,
      new_task: new_task,
      user_executable: user_executable,
      // Task 2.3: for a CLONE_VM child, the parent's private Memory + owner pid
      // (structured-cloned in the init message — shared:true Memory is
      // cross-worker shareable). The child registers + instantiates against it.
      clone_vm: clone_vm || null,
      // Phase 2: for a fork child, its fork-time memory snapshot + asyncify ctl
      // pointer. The snapshot ArrayBuffer is TRANSFERRED to the child worker (it
      // is a one-shot fork-time copy; the host no longer needs it).
      fork: fork || null,
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

    // Phase 2: transfer a fork child's fork-time snapshot ArrayBuffer (one-shot)
    // into the child worker rather than structured-cloning it.
    const initTransfer = options.fork ? [options.fork.snapshot] : [];
    worker.postMessage(
      {
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
      },
      initTransfer,
    );

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

    // CONFIG_WASM_TRACE: read the kernel trace ringbuffer out-of-band from the
    // shared memory. Returns the last `n` records (chronological), decoded. Safe
    // to call at any time — even while a worker is wedged — because the main
    // thread holds the same shared `memory` and never blocks. Returns [] when
    // the kernel was built without CONFIG_WASM_TRACE (wtrace_info stays null).
    dumpWtrace: (n = 256) => handleDumpWtrace(n),

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
  };
};
