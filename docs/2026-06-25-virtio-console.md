# hvc → virtio-console (issue #10, option 2) — implementation + validation

Status: **code complete, boot-validation pending on a nix host.** This adds a
stock mainline virtio-console TTY path to the guest, riding the existing
`virtio_wasm` transport, as a NEW host↔guest console alongside the bespoke
`hvc_wasm` backend — the console edition of the "everything is a virtio device"
consolidation. It does NOT remove `hvc_wasm`: the two paths coexist so they can
be A/B'd, and deleting `hvc_wasm` (patches 0002/0003) is a separate follow-up
gated on boot-validating virtio-console. At the console layer the guest now also
looks like a standard virtualized Linux (stock `virtio_console` over a stock
carrier).

## Single port vs multiport (design decision)

**Single port.** Mainline `virtio_console` binds a port to a (receiveq,
transmitq) virtqueue pair; a **featureless** device gets exactly ONE port
(port 0) which the driver wires to hvc as a console line — the hvc-equivalent of
one console. We offer **no feature bits**: no `VIRTIO_CONSOLE_F_SIZE` (cols/rows
in config space; the TIOCSWINSZ path stays on `hvc_wasm`'s
`wasm_driver_hvc_winsize` for now) and no `VIRTIO_CONSOLE_F_MULTIPORT` (the
control vq + N extra ports = the hvc0..hvc7 model). `VIRTIO_F_VERSION_1` is OR'd
in by the transport itself (`vw_get_features` in `virtio_wasm.c`).

**MULTIPORT GAP (documented, not stubbed):** the existing `hvc_wasm` path
exposes 8 consoles (hvc0..hvc7, `HVC_WASM_NR`); this single-port virtio-console
exposes ONE. Closing the gap is future work: the host device model
(`runtime/virtio/console-device.js`) would grow a control vq + per-port queues
and the kernel registration (patch 0019) would offer
`VIRTIO_CONSOLE_F_MULTIPORT`. Until then, a single port is the correct, complete
minimal console for the A/B — not a stub.

## What changed

- **Kernel** — `patches/kernel/0019-wasm-virtio-console-device.patch`: register
  one virtio-console device on the wasm transport, `VW_DEV_CONSOLE` (index 6,
  after the 9P channels), `VIRTIO_ID_CONSOLE` (3). `kernel.nix` enables
  `CONFIG_VIRTIO_CONSOLE` (selects `HVC_DRIVER`, already on for `hvc_wasm`;
  depends on `VIRTIO` + `TTY`). Guarded by `IS_ENABLED(CONFIG_VIRTIO_CONSOLE)`
  so the enum slot + init call are a no-op when the stock driver isn't built.
  - **Why index 6:** the device enum is positional (WL=0, ECHO=1, NET=2, BLK=3,
    9P_ROOT=4, 9P_NIXCACHE=5), so CONSOLE registers after the 9P block → 6, irq
    = `VIRTIO_WASM_IRQ_BASE(8) + 6 = 14`. Like the 9P channels, the index assumes
    the preceding NET/BLK/9P slots are built (the production config enables all).
  - **No per-id vq sizing:** unlike `VIRTIO_ID_9P` (patch 0018 bumps it to 128
    for the 128-page msize chain), virtio-console moves a TTY byte stream in
    small page-sized chunks, so the default 64-entry ring is correct.
- **Runtime** — `runtime/virtio/console-device.js` (`ConsoleVirtioDevice`): host
  model of the device. Two vqs, mirroring virtio-net's directionality:
  - vq[0] = **receiveq** (host→guest): the guest posts WRITABLE inbufs; the host
    fills them with input bytes (`pushRx`/`flushRx`) and pushes them used. Input
    that arrives before an inbuf is posted is held **pending** (a byte stream, so
    leftovers are kept and split across inbufs as they come) and flushed on the
    next receiveq refill — input is never dropped.
  - vq[1] = **transmitq** (guest→host): the guest posts READABLE outbufs of
    console output; the host drains them to the `sink` (`drainTx`) and pushes
    them used (len 0 — transmit buffers are read-only).
  Offers no features; `configRead` keeps the base zero-fill (config space is
  unread without `F_SIZE`/`F_MULTIPORT`).
  - **Worker→main inversion** (same reason as virtio-9p/wl/net): the console sink
    (guest output) + input buffer (host input) are MAIN-thread-bound, but the
    guest's vq kick lands on a task worker. So the worker-side instance only
    answers the synchronous transport probes (features/config/setup) and FORWARDS
    the notify (`virtioconsole_notify`) to the main thread; the main-thread
    instance (given a `sink`) drains TX / delivers RX. The completion IRQ uses the
    SAME `raised_irqs` self-wake path virtio-wl/net/9P use (`raiseHostWlIrq`): the
    OR-into-`raised_irqs[0]` + notify happens after the vring write, so there is
    no lost-wakeup race — host input can wake a fully idle guest.
- **Wiring** — `kernel-worker.js` (`VW_DEV_CONSOLE=6` device + forwarding notify
  + publish `raised_irqs` addr), `kernel-host.js` (main-thread `hostConsole()`
  device + `virtioconsole_notify` handler analogous to `virtio9p_notify` + a
  `console_sink` opt + a `virtio_console_input` handle method), `boot.js`
  (`console_sink` wired to an optional `onVirtioConsole` opt — else the host log
  — and a `virtioConsoleInput(data)` handle method for host→guest input),
  `abi.js` (`ENGINE_ABI` 2→**3** per the ABI-BUMP RULE — the virtio device set is
  part of the kernel↔engine contract), `sync-to-pc.sh` (sync the new
  `virtio/console-device.js` engine file).
- **NOT changed / NOT deleted:** `hvc_wasm` (patches 0002/0003), its host
  callbacks (`wasm_driver_hvc_put`/`_get`/`_winsize`), and `boot.js`'s per-hvc
  `console(vtermno)` duplex all stay. This is an additive A/B path.

## Validated here (no nix in this env)

- `bun test virtio/ ninep/` → 83 pass (incl. 8 new `ConsoleVirtioDevice` tests:
  no-features, TX drain→sink + used(len 0) + IRQ, RX inject→inbuf + IRQ, RX held
  pending then flushed on refill, RX spread across multiple inbufs, worker-mode
  forwarding of both queues, re-entrant TX drain across kicks, TX no-op before
  queue setup). `bun run test` (the ninep/nix-store gate set) → 52 pass.
- `oxfmt --check` clean on the new + edited files; `oxlint` clean on the new +
  edited files (the repo-wide `bun run lint` has pre-existing warnings only in
  the vendored `demo/web/vendor/greenfield/` tree — red on clean master too,
  unrelated to this change).
- `tsc` clean on the edited NON-test source (`boot.js` opts/return typedef
  extended for `onVirtioConsole`/`virtioConsoleInput`; `kernel-host.js`/
  `kernel-worker.js` are `@ts-nocheck`). The remaining `tsc` errors are all in
  `.test.js` files and match the pre-existing master baseline (`bun:test` module
  + the `{buffer: ArrayBuffer}` Memory-shape + the device-ctor opt-typedef
  pattern — identical to `ninep-device.test.js`).

## Boot-validation TODO (run on a nix host)

1. `sudo -E nix build .#kernel .#wasm-initramfs --print-out-paths`
   (also `.#wasm-base-squashfs` / `.#wasm-binary-cache` for the full smoke).
2. Re-run **`runtime/sync-to-pc.sh <pc-checkout>`** — `kernel-worker.js`,
   `kernel-host.js`, `boot.js`, `abi.js` and the new `virtio/console-device.js`
   are engine files; pc boots a stale engine otherwise. Note `ENGINE_ABI` is now
   3 → a `master`-based `linux` channel can only ship AFTER the synced engine is
   deployed to pc (else pc correctly shows "reload pc").
3. Boot the guest and confirm the device probes: the boot log should show
   `virtio_wasm: registered dev=6 id=0x3 irq=14` and `virtio_console` binding a
   console port (hvc line). Drive the A/B by wiring `onVirtioConsole` (guest
   output) + `virtioConsoleInput` (host input) on the boot handle and exchanging
   bytes over the new path while the existing `hvc_wasm` console keeps working.
   To make virtio-console the guest's console line, append `console=hvc0` (the
   stock driver registers its port as an hvc console) — but keep `hvc_wasm`'s
   console too until the A/B is confirmed.

## Follow-up (separate change)

Once virtio-console is boot-validated as the guest console, retire `hvc_wasm`:
drop patches 0002/0003, the `wasm_driver_hvc_*` host callbacks, and the per-hvc
`console(vtermno)` duplex, collapsing onto the virtio path. That likely needs the
MULTIPORT gap closed first (to keep the hvc0..hvc7 multi-terminal model), or an
explicit decision to ship a single guest console. Tracked under issue #10.
