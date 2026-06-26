# hvc_wasm → stock MULTIPORT virtio-console (issues #10 option 2, #83)

Status: **code complete, boot-validation in CI + PR preview.** The guest console
moved off the bespoke `hvc_wasm` backend onto the stock mainline virtio-console
driver (`drivers/char/virtio_console.c`), riding the existing `virtio_wasm`
transport. This completes the "everything is a stock virtio device" set
(filesystem → virtio-9p, /Ctl → virtio-vsock, console → virtio-console) and
**retires `hvc_wasm`** — virtio-console is now the guest's SOLE console path.

This supersedes the earlier single-port A/B (added in #65, which kept `hvc_wasm`
as primary). The history of that A/B is in git; this doc describes the final
state.

## Multiport (the design that makes the retire possible)

`hvc_wasm` exposed 8 console lines (hvc0..hvc7, `HVC_WASM_NR`), one per pc
Terminal window + the wayland control console. A **single-port** virtio-console
gives only one tty, so retiring `hvc_wasm` without regressing multi-tty requires
**`VIRTIO_CONSOLE_F_MULTIPORT`**: the host device offers the feature and N console
ports, and the stock driver registers one hvc line per console port
(hvc0..hvc{N-1}). The kernel side needs **no new code** — multiport is entirely
host-driven (the feature bit + the control-plane handshake), so the stock
`virtio_console.c` does the rest.

Virtqueue layout for N ports (mainline `init_vqs`): port 0 → rx=vq[0], tx=vq[1];
control → rx=vq[2], tx=vq[3]; port i≥1 → rx=vq[2+2i], tx=vq[3+2i]. With
`CONSOLE_PORTS = 8` that is **18 vqs**, which is why the transport's
`VIRTIO_WASM_MAX_VQS` (patch 0013) and the cross-worker `MAX_QS`
(`shared-queues.js`) were both raised 8/4 → **18**.

## What changed

- **Kernel**
  - `patches/kernel/0019-…`: unchanged in code (registers the
    `VIRTIO_ID_CONSOLE` device at `VW_DEV_CONSOLE=6`, irq 14); comment updated to
    "sole console, multiport offered by the host."
  - `patches/kernel/0013-…`: `VIRTIO_WASM_MAX_VQS` 8 → **18** so the transport
    accepts the console's 18 vqs (`struct virtqueue *vqs[VIRTIO_WASM_MAX_VQS]`
    grows with it).
  - `kernel.nix`: `--disable CONFIG_HVC_WASM` — removes `hvc_wasm`'s
    `device_initcall` (which otherwise claimed hvc0) and its
    `wasm_driver_hvc_*` host imports, so virtio-console's first console port
    becomes **hvc0** and carries `console=hvc`. `HVC_DRIVER` stays on (selected by
    `CONFIG_VIRTIO_CONSOLE`), so the hvc framework remains. Patches **0002/0003
    deleted**.
- **Runtime** — `runtime/virtio/console-device.js` (`ConsoleVirtioDevice`): now a
  MULTIPORT device. Beyond the per-port data queues (drainTx → `sink(port,
  bytes)`; pushRx/flushRx per port, with input held pending until a port posts an
  inbuf) it runs the control-plane handshake on the control vqs:
  - guest→host (control transmitq): `DEVICE_READY`, per-port `PORT_READY`, and
    `PORT_OPEN`;
  - host→guest (control receiveq): per-port `PORT_ADD`, then for each console port
    `CONSOLE_PORT` + `PORT_OPEN(1)`, and `RESIZE` (payload `{cols, rows}`, cols
    first) to drive `hvc_resize` → TIOCSWINSZ/SIGWINCH.
  Host→guest control messages are held pending (FIFO) until a control inbuf is
  free, mirroring the data path. `getFeatures` returns `F_MULTIPORT`; `configRead`
  returns `max_nr_ports = CONSOLE_PORTS`. Ports are added in index order, so the
  guest allocates hvc0..hvc{N-1} to ports 0..N-1 deterministically (port index ===
  hvc index === the engine's `vtermno`).
  - **Worker→main inversion** (unchanged): the worker instance answers the
    synchronous probes (features = MULTIPORT, config = max_nr_ports, queue setup)
    and forwards every notify (`virtioconsole_notify`); the main-thread instance
    services all queues and raises the IRQ via the `raised_irqs` self-wake.
- **Engine wiring** — `boot.js` (`console(vtermno)` handle now drives the
  multiport device: `write`→`console_input(port,bytes)`, `resize`→`console_resize`;
  the per-port `console_sink` fans out to each console's `onData`),
  `kernel-host.js` (multiport `hostConsole()` + `console_input`/`console_resize`
  exports; the hvc `key_input`/`set_winsize`/`console_read`/`console_write`/
  winsize-SAB/input-buffers all removed), `kernel-worker.js` (the
  `wasm_driver_hvc_put`/`_get`/`_winsize` imports + the synchronous
  `console_read_messenger` round-trip removed; device built with `ports:
  CONSOLE_PORTS`). The external `console(vtermno)` handle shape is **unchanged**,
  so pc needs no code change.
- **ABI** — `abi.js` `ENGINE_ABI` 4 → **5** (the hvc host imports are gone and the
  console device model + transport vq cap changed — an incompatible kernel↔engine
  contract change).
- **Guest** — `userspace/init.nix`/`toplevel.nix`: the inittab is unchanged
  (hvc0..hvc7 getty lines — virtio-console registers as hvcN); only the comments
  that named the gone `HVC_WASM_NR_CONSOLES` were updated to point at
  `CONSOLE_PORTS`.

## Early-boot console tradeoff

`hvc_wasm` was also the kernel's **earlycon**. virtio-console only comes up after
the virtio probe + the multiport handshake, so printk before that is buffered by
the kernel log ring and flushed once hvc0 registers — standard for a virtualized
console (qemu `console=hvc0` behaves identically). A panic *before* the virtio
probe would have no console; acceptable, and a future kernel could add a
virtio-console earlycon if needed.

## Validated here (no nix in this env)

- `bun run test` → 117 pass, incl. 13 rewritten `ConsoleVirtioDevice` multiport
  tests (features, max_nr_ports config, DEVICE_READY→PORT_ADD ordering,
  PORT_READY→CONSOLE_PORT+PORT_OPEN, pending control flush on refill, per-port
  TX→sink tagging, per-port RX isolation + pending-until-inbuf, RESIZE cols/rows
  order, resize re-assert on PORT_READY, worker-mode forwarding, TX no-op before
  setup). `oxlint`/`oxfmt`/`tsc` clean.

## Boot-validation (CI + preview — no nix host here)

1. CI `nix-wasm.yml` rebuilds `.#kernel` (the `CONFIG_HVC_WASM` disable + the
   transport vq-cap bump invalidate the kernel derivation; the patched-LLVM pole
   substitutes from Cachix, only the kernel C sources recompile) + the boot
   artifacts, and the `boot-smoke` job boots the guest.
2. The PR preview boots *that PR's* guest in the browser — confirm a shell prompt
   on hvc0 and a second Terminal on hvc1 (multi-tty), plus resize (SIGWINCH).
3. `runtime/sync-to-pc.sh <pc-checkout>` (engine files changed). `ENGINE_ABI` is
   now **5**: a `master`-based `linux` channel can only ship AFTER the synced
   engine is deployed to pc, else pc correctly shows "reload pc".
