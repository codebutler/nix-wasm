# Host↔guest bridge consolidation onto virtio — exploration (issue #10)

**Type:** exploration / RFC. Enumerates the landscape, verifies the inventory
against the code, evaluates the options, and gives a recommendation. It does
**not** land a migration — the pilot benchmark (option 1) gates that decision.

**Date:** 2026-06-25
**Builds on:** #8 (`virtio_wasm` transport + `virtio_wl`), #7 (waylandproxyd).

## TL;DR / recommendation

- **Start with option 4 (shared plumbing), not option 1 (9P→virtio-9p).** The
  two transports already converge on one foundation — shared `WebAssembly.Memory`
  + `Atomics.wait/notify` for the worker→main inversion — but implement it twice.
  Factoring that out is low-risk, sheds duplicated SAB code, and is a prerequisite
  for *any* later transport unification. It touches no working protocol path.
- **Treat 9P→`9pnet_virtio` (option 1) as a *benchmarked spike*, not a commitment.**
  It is the only change that can retire `trans_cb`, but it inherits the
  worker→main inversion already solved for Wayland **and** must re-clear the perf
  bar `trans_cb` is tuned to (512 KB msize → ~2.4× on nix). Build it behind a
  config flag, A/B it against `trans_cb`, and only retire the custom transport if
  it wins or ties. The issue's own open question ("benchmark before committing")
  is the gate.
- **Skip option 2 (console→virtio-console).** Confirmed low value below.
- **Defer option 3 ("everything a virtio device").** It is the *sum* of 1+2+vsock,
  justified only if running unmodified standard-VM guest software becomes a goal.
  Nothing on the roadmap needs it today.

## Inventory — verified against the code

The issue's inventory table is **accurate**. Confirmed against the tree:

| Bridge | Code | Sync? | Notes |
|---|---|---|---|
| **Exec + sched** | `runtime/kernel-worker.js:347-443` (`wasm_create_and_run_task`, `wasm_load_executable`, `wasm_serialize_tasks`) | n/a | One Worker per task over shared memory. **The substrate** — see below. |
| **9P (`trans_cb`)** | kernel `patches/kernel/0001-9p-trans_cb.patch`; host `runtime/ninep/{ring,host-call}.js`; `runtime/boot.js:113-131` | **yes** (`Atomics.wait`) | `9pnet_cb`, `CONFIG_NET_9P_CB`. msize 512 KB, 8 slots, per-mount `cid`. |
| **hvc consoles** | kernel `patches/kernel/0002`,`0003`; host `runtime/kernel-worker.js:520-572` | yes | `HVC_WASM`, 8 consoles, winsize-polled. |
| **/Ctl** | rides `trans_cb` as a 9P `aname` | yes | No device of its own — a 9P mount. |
| **virtio_wl** (#8) | kernel `patches/kernel/0013`; host `runtime/virtio/{device,vring}.js`, `runtime/kernel-worker.js:574-605` | **async** (IRQ) | `virtio_wasm`, `CONFIG_VIRTIO_WASM`. |

Key facts that shape the options:

1. **`trans_cb` is synchronous by construction.** `p9_cb_request()` blocks the
   task-worker inside the call (`0001-9p-trans_cb.patch`); the host
   `wasm_driver_9p_request` (`runtime/ninep/host-call.js:37-53`) copies the frame
   out, calls `ring.clientRequest()` which **blocks on `Atomics.wait`**
   (`runtime/ninep/ring.js:154-176`), then copies the reply back. There is no IRQ;
   the reply slot's `ready` word is the wakeup target.

2. **`virtio_wasm` is asynchronous by construction.** Guest→host kick is
   `wasm_virtio_notify(dev, q)`; host→guest is a per-device shared IRQ
   (`VIRTIO_WASM_IRQ_BASE + dev_index`) dispatched to every vq via
   `vring_interrupt` (`0013`). The vrings live at raw `WebAssembly.Memory` offsets
   — `VIRTIO_F_ACCESS_PLATFORM` is masked off so virtio_ring never does DMA
   translation (nommu identity phys). This is the same no-DMA shared-memory trick
   `trans_cb` uses; the difference is the *signalling shape* (IRQ vs. blocking
   reply slot), not the memory model.

3. **The two transports already share a foundation, duplicated.** Both are:
   shared `WebAssembly.Memory` + a kernel-side blocking primitive + a main-thread
   server, with the worker→main inversion handled by `Atomics`. `trans_cb` open-codes
   a request/reply ring (`ring.js`); `virtio_wasm` open-codes split-vring access
   (`vring.js`). This duplication is exactly what option 4 targets.

4. **Exec/sched cannot move to virtio** — confirmed. virtio drivers run *on top
   of* this ABI: `wasm_virtio_notify`'s kick is an exec-context host call and the
   IRQ is `raise_interrupt`. You cannot put the substrate on a bus that the
   substrate implements. The issue's verdict ("No") stands.

## Option-by-option evaluation

### Option 1 — 9P → `9pnet_virtio`, retire `trans_cb`

**Feasible, highest payoff, highest churn.** `CONFIG_NET_9P_VIRTIO` is stock
mainline and `9pnet_virtio` already speaks 9P2000.L over split virtqueues — the
same vrings `virtio_wasm` exposes. `virtio_net` and `virtio_blk` already ride
`virtio_wasm` with **stock drivers** (`docs/2026-06-21-virtio-net-spike.md`), so a
stock `9pnet_virtio` on the same transport is a credible bet, not a research leap.

What it buys: drop the entire custom kernel transport (`0001`), the host ring
(`ninep/ring.js`, `ninep/host-call.js`), and the per-mount `cid` multiplexing —
`v9fs` over a standard carrier. `/Ctl` rides along (it is a 9P `aname`, transport-
agnostic).

What it costs — the two things the issue flags, both real:

- **Worker→main inversion.** `9pnet_virtio` is async: it kicks the TX vq and the
  reply arrives later via IRQ. But the host 9P server is main-thread-bound (VFS),
  and the task-worker that issued the syscall must block until the reply lands.
  This is the *exact* inversion already solved for `virtio_wl` (#8) with the
  SAB-futex — a bare async path deadlocks. So the inversion is **already solved in
  principle**; this is a re-plumb of a known pattern onto the 9P server, not new
  research. The 9P server stays (it still services the vrings); only the carrier
  changes.

- **Perf re-tuning.** `trans_cb` is tuned: 512 KB msize, 8 slots, one copy each
  way, one `Atomics.wait` per request. virtio adds vring descriptor management +
  an IRQ round-trip per request. The ~2.4×-on-nix headline must be re-cleared.
  This is **the** gating risk and the reason this is a benchmarked spike: build it
  behind a config flag alongside `trans_cb`, A/B `nix-env -iA` install latency and
  large-file throughput, and only retire `trans_cb` if virtio-9p wins or ties.

**Recommendation:** pursue, but as a *flagged, benchmarked pilot* — not a
straight swap. Decision gate = the benchmark.

### Option 2 — console → `virtio-console`

**Skip.** The hvc backend (`0002`/`0003`) is a simple low-latency byte duplex with
winsize; `virtio-console` (`CONFIG_VIRTIO_CONSOLE`) adds vring + IRQ overhead per
keystroke for zero functional gain. The only upside is "one fewer custom backend,"
which option 4 addresses more cheaply by sharing the plumbing without changing the
protocol. Note for completeness; do not implement.

### Option 3 — "everything a virtio device"

**Defer.** This is option 1 + option 2 + `virtio-vsock` for `/Ctl`, i.e. the end
state where the guest looks like a stock VM. Its sole justification is running
*unmodified* guest software that assumes a standard virtio environment — not a
current roadmap need (the guest userspace is curated and built here). Revisit only
if that goal materializes; until then it is churn without a consumer. If pursued,
it is the natural *sequel* to a successful option 1, not a parallel track.

### Option 4 — unify the plumbing under both upper models

**Do this first.** Both `trans_cb` and `virtio_wasm` independently implement:
shared-memory layout, `Atomics`-based signalling, and the worker→main inversion.
Factor one foundation module (shared SAB allocation + a signalling/inversion
primitive) and re-express `ring.js` (RPC) and `vring.js` (vrings) on top of it.
No protocol changes, no kernel changes, no perf re-tuning — working paths stay
working. It cuts duplicated SAB/Atomics code and, critically, gives option 1 a
ready inversion primitive to reuse instead of re-deriving. Lowest risk, enabling.

### Option 5 — do nothing

The honest baseline. The bridges work and are tuned. If neither mainline-alignment
nor shedding custom-transport maintenance is a near-term goal, option 5 is
defensible. The recommendation above (4 now, 1 as a benchmarked spike) is the
*minimum* investment that moves toward alignment without betting a working path.

## Suggested sequencing

1. **Option 4** — factor the shared shared-memory + inversion foundation under
   `ring.js` and `vring.js`. Low risk; enabling; no protocol/perf change.
2. **Option 1 as a flagged pilot** — `CONFIG_NET_9P_VIRTIO` + a `virtio-9p` host
   device on `virtio_wasm`, reusing the option-4 inversion primitive. Keep
   `trans_cb` selectable. **Benchmark** (msize sweep, IRQ round-trip latency,
   `nix-env -iA` wall-clock, large-file throughput) vs. `trans_cb`.
3. **Decide at the benchmark.** Win/tie → retire `trans_cb`, `/Ctl` rides along.
   Lose → keep `trans_cb`, having banked option 4 regardless.
4. **Options 2 / 3** — only if the "standard VM" goal becomes real.

## Open questions carried forward (for the implementer of step 2)

- Does a stock `9pnet_virtio` probe clean on the no-DMA `virtio_wasm` transport,
  as `virtio_net`/`virtio_blk` did? (Expected yes; confirm — it is the first
  acceptance gate, mirroring the virtio-net spike.)
- Single shared 9P TX/RX vq pair vs. per-mount queues — `trans_cb` multiplexes
  mounts by `cid`; virtio-9p multiplexes by mount tag (one device per mount, or
  one device + `aname`). Which maps cleaner onto the host server?
- Can the option-4 inversion primitive be shared verbatim with the `virtio_wl`
  SAB-futex path, or do RPC (reply-slot) vs. vring (used-ring IRQ) wakeups need
  distinct shapes under one module?
