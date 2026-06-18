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
  // Wayland Phase 2 (2b inversion): optional host hook for the worker→main
  // Greenfield bridge. `onOut(clientId, buffer, fds)` is called when a guest
  // VFD_SEND posts wayland bytes out of the worker; the host feeds them into the
  // main-thread compositor. Replies come back through `os.wayland_in(...)`,
  // which routes to the worker that owns that client.
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

  /// Wayland Phase 2 (2b inversion): clientId (ctx vfd_id) → the task worker that
  /// posted the OUT, so a compositor reply (wayland_in) routes back to the worker
  /// that owns that virtio_wl device instance (and can inject into its IN vring).
  const wayland_client_worker = new Map();

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

  /// Callbacks from Web Workers (each one representing one task).
  const message_callbacks = {
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

    // Wayland Phase 2 (2b inversion): a guest VFD_SEND's wayland bytes posted
    // out of a task worker. Remember which worker owns this client so replies
    // (os.wayland_in) route back to it, re-view the shm fds over the SHARED
    // memory, and hand it all to the host bridge → main-thread Greenfield.
    wayland_out: (message, worker) => {
      const clientId = message.clientId >>> 0;
      wayland_client_worker.set(clientId, { worker, dev: message.dev });
      const fds = (message.fds || []).map(
        (f) => new Uint8Array(memory.buffer, f.byteOffset, f.length),
      );
      if (wayland && typeof wayland.onOut === "function") {
        wayland.onOut(clientId, new Uint8Array(message.buffer), fds);
      } else {
        log(`[wayland] OUT for client ${clientId} but no host bridge wired`);
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

    // Wayland Phase 2 (2b inversion): deliver a server→client reply from the
    // main-thread Greenfield compositor back to the guest. Routes to the task
    // worker that owns the client; the worker injects it into the IN vring.
    // `buffer` may be a Uint8Array or ArrayBuffer.
    wayland_in: (clientId, buffer) => {
      const cid = clientId >>> 0;
      const ref = wayland_client_worker.get(cid);
      if (!ref) {
        log(`[wayland] IN for unknown client ${cid} (no owning worker)`);
        return;
      }
      const ab =
        buffer instanceof ArrayBuffer
          ? buffer
          : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      ref.worker.postMessage({ method: "wayland_in", dev: ref.dev, clientId: cid, buffer: ab }, [
        ab,
      ]);
    },
  };
};
