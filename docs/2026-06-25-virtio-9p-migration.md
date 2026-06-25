# 9P → virtio-9p migration (issue #10) — implementation + validation

Status: **code complete, boot-validation pending on a nix host.** This moves the
guest's 9P mounts off the bespoke `trans_cb` SAB-ring transport onto the stock
mainline 9P-over-virtio transport (`CONFIG_NET_9P_VIRTIO`, `net/9p/trans_virtio.c`)
riding the existing `virtio_wasm` transport — the load-bearing step of the
"everything is a virtio device" consolidation. The guest now looks like a
standard virtualized Linux at the 9P layer (stock `v9fs` over a stock carrier).

## What changed

- **Kernel** — `patches/kernel/0018-wasm-virtio-9p-device.patch`: register two
  virtio-9p channels on the wasm transport, `VW_DEV_9P_ROOT` (index 4, tag
  `pcroot`) and `VW_DEV_9P_NIXCACHE` (index 5, tag `nixcache`), both with
  `VIRTIO_ID_9P` (9), AND give `VIRTIO_ID_9P` devices a **128-entry virtqueue**
  (vs the default 64). `kernel.nix` enables `CONFIG_NET_9P_VIRTIO` (keeps
  `NET_9P_CB` built so the two transports can still be A/B'd). No custom 9P
  transport code — the stock driver does the rest; the kernel side is just
  device registration + the vq sizing.
  - **Why 128, not "benchmark later":** mainline `9pnet_virtio` sets
    `.maxsize = PAGE_SIZE*(VIRTQUEUE_NUM-3)` with `VIRTQUEUE_NUM` a fixed
    compile-time **128**, so msize ≈ 500 KB *regardless of vq size* — already on
    par with `trans_cb`'s 512 KB (no msize regression to tune). But the driver
    packs up to `VIRTQUEUE_NUM` (128) scatter-gather entries into ONE request
    chain, so a 64-entry ring **overflows (`-ENOSPC` in `virtqueue_add`) on any
    large transfer** — e.g. a nix-env NAR read. That's a correctness floor, not a
    perf knob, so the vq is sized to 128 up front (what QEMU's virtio-9p uses).
- **Runtime** — `runtime/virtio/ninep-device.js` (`NinePVirtioDevice`): host
  model of a virtio-9p device. Serves the mount tag in config space
  (`struct virtio_9p_config`) + `VIRTIO_9P_MOUNT_TAG`/`VIRTIO_F_VERSION_1`
  features; drives the "requests" vq through the existing 9P server
  (`server.handle(frame, cid)`), one device per connection (distinct `cid` for
  per-connection isolation, exactly as `trans_cb`'s cid did).
  - **Worker→main inversion** (the reason this isn't a free swap): the 9P server
    is async + main-thread-bound (the VFS), but the vq kick lands on a task
    worker. So the worker-side instance only answers the synchronous transport
    probes (features/config/setup) and FORWARDS the notify (`virtio9p_notify`) to
    the main thread; the main-thread instance does the async drain → `handle` →
    reply → IRQ. The completion IRQ uses the SAME `raised_irqs` self-wake path as
    virtio-wl/net (`raiseHostWlIrq`): the guest task parks in `p9_client_rpc`,
    CPU 0's idle task parks in `arch_cpu_idle`'s `wait64` on `raised_irqs[0]`, and
    OR-ing the irq bit + notifying wakes it (OR before notify ⇒ no lost wakeup).
- **Wiring** — `kernel-worker.js` (forwarding device + publish `raised_irqs`
  addr for 9P even with no wayland device), `kernel-host.js` (host devices +
  `virtio9p_notify` handler + `ninep_server` opt), `boot.js` (share one server
  instance across both transports), `shared-queues.js` (`MAX_DEVS` 4→8 to cover
  device indices 4/5), `userspace/bootstrap.nix` (`trans=cb`→`trans=virtio`,
  device names → mount tags `pcroot`/`nixcache`; `aname` still selects the export).

## Validated here (no nix in this env)

- `bun test virtio/ ninep/` → 95 pass (incl. 7 new `NinePVirtioDevice` tests:
  features, config-space tag, server round-trip writes reply + raises IRQ +
  passes cid, concurrent in-flight chains, worker-mode forwarding, server-throw
  completes the chain).
- `oxlint` / `oxfmt --check` / `tsc` clean on the new + edited files
  (`kernel-host.js`/`kernel-worker.js` are `@ts-nocheck`+`oxlint-disable`).

## Boot-validation TODO (run on a nix host)

1. `sudo -E nix build .#kernel .#wasm-initramfs --print-out-paths`
   (also `.#wasm-base-squashfs` / `.#wasm-binary-cache` for the full smoke).
2. Re-run **`runtime/sync-to-pc.sh <pc-checkout>`** — `kernel-worker.js`,
   `kernel-host.js`, `boot.js`, `shared-queues.js` and the new
   `virtio/ninep-device.js` are engine files; pc boots a stale engine otherwise.
3. `LINUX_WASM_ARTIFACTS=file:///…/artifacts/ node runtime/demo/node/smoke.mjs`
   — boot → 9P read/write/ls → `nix-env -iA sl` must PASS over virtio-9p.
   Boot log should show `virtio_wasm: registered dev=4 id=0x9` / `dev=5 id=0x9`
   and `9pnet_virtio` binding tags `pcroot`/`nixcache`.

## Perf parity & retiring trans_cb

msize is ≈ 500 KB (the driver's fixed `VIRTQUEUE_NUM`-derived cap), on par with
`trans_cb`'s 512 KB, and the 9P vq is sized to 128 so large transfers don't
overflow — so there's no known regression baked in; the round-trip-bound nix
path should perform comparably. A confirming benchmark (`nix-env -iA` wall-clock,
IRQ round-trip latency) is still worth running once it boots, but it's a
*confirmation*, not a gate hiding a known handicap. Retire `NET_9P_CB` (drop the
`trans_cb` transport + `runtime/ninep/{ring,host-call,transport}.js`) once the
boot smoke passes and the benchmark confirms parity.
