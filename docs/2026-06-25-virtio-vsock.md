# virtio-vsock transport for the /Ctl bridge (issue #10, option 3) — implementation + validation

Status: **code complete, boot-validation pending on a nix host.** This lands the
**virtio-vsock transport substrate** — the stock mainline AF_VSOCK socket
channel (`CONFIG_VSOCKETS` + `CONFIG_VIRTIO_VSOCKETS`,
`net/vmw_vsock/virtio_transport.c`) riding the existing `virtio_wasm` transport —
so the guest→host `/Ctl` desktop-control bridge (launch pc app, clipboard,
notify) can move off the 9P `aname` mount onto a standard socket. It mirrors the
9P→virtio-9p migration (PR #59, `docs/2026-06-25-virtio-9p-migration.md`): one
more stock virtio driver on the no-DMA shared-memory carrier, with the same
worker→main inversion the Wayland/9P paths already solved.

**Scope (important):** this is the transport SUBSTRATE only. The `/Ctl` protocol
*consumer* — the code that interprets launch-app/clipboard/notify messages —
lives downstream in the **pc** repo and is OUT OF SCOPE here. This change exposes
a clean host-side socket API (`listen`/`connect`, per-connection
`write`/`onData`/`onClose`) that the future pc `/Ctl` consumer plugs into; it does
**not** define or implement the `/Ctl` message protocol. The existing 9P-based
`/Ctl` path is **left intact** (this adds a parallel transport, it does not retire
the 9P one).

## Why vsock (not a bespoke virtio control device)

vsock is the right primitive for `/Ctl`. `/Ctl` is a guest→host **stream** of
control messages from a small number of long-lived agents; AF_VSOCK gives that a
standard, mainline-supported socket abstraction (no custom kernel driver, no
custom guest userspace API — guest code just `socket(AF_VSOCK, SOCK_STREAM)` +
`connect(cid=2, port)`), which is exactly the "everything is a virtio device"
end-state issue #10 option 3 describes. A bespoke virtio control device would
re-introduce a custom kernel driver + a custom host protocol for no benefit over
the standard socket. We implement vsock as asked.

## What changed

- **Kernel** — `patches/kernel/0020-wasm-virtio-vsock-device.patch`: register one
  virtio-vsock device on the wasm transport, `VW_DEV_VSOCK` at host **index 7**
  (pinned with an explicit `= 7` so it is stable regardless of which
  CONFIG-guarded earlier slots are built), with `VIRTIO_ID_VSOCK` (19). Guarded
  by `IS_ENABLED(CONFIG_VIRTIO_VSOCKETS)` so the enum slot + init call are a
  no-op when the stock virtio-vsock transport is not built. `kernel.nix` enables
  `CONFIG_VSOCKETS` (the AF_VSOCK core, depends on `CONFIG_NET` — already on),
  `CONFIG_VIRTIO_VSOCKETS` (the guest driver, depends on `CONFIG_VSOCKETS` +
  `CONFIG_VIRTIO` — both on), and `CONFIG_VIRTIO_VSOCKETS_COMMON` (the shared
  transport helper the driver selects). No custom vsock transport code; the stock
  driver does the rest. The default 64-entry virtqueue is kept (vsock posts one
  bounded packet per chain — unlike 9P's 128-sg msize chains, so 64 is correct;
  it is what QEMU's virtio-vsock uses).
- **Runtime** — `runtime/virtio/vsock-device.js` (`VsockVirtioDevice`): host model
  of a virtio-vsock device. Serves the **guest CID** (3) in config space
  (`struct virtio_vsock_config { __le64 guest_cid; }`) + `VIRTIO_F_VERSION_1`;
  drives the three vqs (rx=q0 host→guest, tx=q1 guest→host, event=q2). It runs the
  virtio-vsock STREAM protocol over the packet framing
  (`struct virtio_vsock_hdr` + payload): the OP_REQUEST→OP_RESPONSE connect
  handshake, OP_RW data both ways, OP_CREDIT_UPDATE/OP_CREDIT_REQUEST flow control
  (honors the guest's advertised window on host→guest writes; acks consumption on
  guest→host RW), and OP_SHUTDOWN/OP_RST teardown. It is correct-in-general — a
  connection request to a port with no listener is RST'd, credit is accounted
  both ways, and partial writes are queued and flushed on the next credit update
  / rx-ring refill — not a stub.
  - **CID choice:** guest CID = **3** (the first guest CID;
    `VMADDR_CID_HYPERVISOR`=0, `VMADDR_CID_LOCAL`=1, `VMADDR_CID_HOST`=2). The host
    is CID 2 and addresses the guest as CID 3. Documented in the device + the
    kernel patch.
  - **Host API surface (for the future pc /Ctl consumer):**
    `device.listen(port, conn => …)` accepts a guest-initiated stream connection
    (invoked after the OP_REQUEST→OP_RESPONSE handshake) and yields a
    `VsockConnection` with `write(bytes)`, `onData(cb)`, `onClose(cb)`, `close()`.
    `device.connect(guestPort)` is the symmetric host-initiated path (mostly for
    tests — `/Ctl` is guest-initiated). The device is handed to the caller once,
    via the `vsock.onReady(device)` boot hook (`boot.js` → `kernel-host.js`).
  - **Worker→main inversion** (same reason the 9P swap wasn't free): the host
    socket callbacks are main-thread-bound but the vq kick lands on a task worker.
    So the worker-side instance only answers the synchronous transport probes
    (features/config/setup) and FORWARDS the notify (`virtiovsock_notify`) to the
    main thread; the main-thread instance runs the protocol and raises the device
    IRQ via the SAME `raised_irqs` self-wake path virtio-wl/net/9p use
    (`raiseHostWlIrq`, OR-before-notify ⇒ no lost wakeup).
- **Wiring** — `kernel-worker.js` (`VW_DEV_VSOCK = 7` + the forwarding device
  branch + publish `raised_irqs` addr), `kernel-host.js` (the main-thread
  `VsockVirtioDevice` + the `virtiovsock_notify` handler + the `vsock` opt +
  `vsock.onReady`), `boot.js` (passes the `vsock` hook through), `shared-queues.js`
  (`MAX_DEVS` already 8 → covers index 7; comment updated), `abi.js`
  (`ENGINE_ABI` **2 → 3**), `sync-to-pc.sh` (sync the new `vsock-device.js`
  engine file). `package.json`'s `test` script now also globs `./virtio/*.test.js`
  so the engine device tests (9P + vsock) are in the CI gate.

**ABI bump:** `ENGINE_ABI` is bumped to **3** per the ABI-BUMP RULE — the
kernel↔engine contract gains a new virtio device (index 7) + a new
worker→main message (`virtiovsock_notify`). A `master`-based `linux` channel can
only ship after the matching engine is synced into pc (`sync-to-pc.sh`) and pc is
deployed; until then a higher `minEngine` correctly shows "reload pc".
**Note:** a sibling change (the virtio-console device, index 6) also bumps
`ENGINE_ABI`; whoever lands second must reconcile to a single increment.

## Validated here (no nix in this env)

- `bun run test` → 92 pass across 9 files, incl. **12 new `VsockVirtioDevice`
  tests**: features (VIRTIO_F_VERSION_1), config-space guest_cid (default 3 +
  custom + zero-pad), REQUEST→RESPONSE handshake (+ IRQ + listener credit
  mirroring), no-listener RST, guest OP_RW → host delivery + CREDIT_UPDATE ack,
  host `write` → guest OP_RW packet over rx, credit-window throttling +
  flush-on-credit-update, full SHUTDOWN teardown + onClose, worker-mode
  forwarding, tx-queue re-entrancy, event-queue buffers left parked.
- `oxlint` / `oxfmt --check` / `tsc` clean on the new + edited engine files
  (`vsock-device.js`, `boot.js`, `abi.js`, `shared-queues.js`, `package.json`,
  `sync-to-pc.sh`); the new test file's only residual `tsc` note is the
  `bun:test` module resolution (resolved by the installed `bun-types` on a
  configured dev box — `ninep-device.test.js`/`wl-device.test.js` share it).
  `kernel-host.js`/`kernel-worker.js` are `@ts-nocheck`+`oxlint-disable`.

## Boot-validation TODO (run on a nix host)

1. `sudo -E nix build .#kernel .#wasm-initramfs --print-out-paths`
   (also `.#wasm-base-squashfs` / `.#wasm-binary-cache` for a full smoke).
   Boot log should show `virtio_wasm: registered dev=7 id=0x13` and the
   `vmw_vsock_virtio_transport` driver binding (guest CID 3).
2. Re-run **`runtime/sync-to-pc.sh <pc-checkout>`** — `kernel-worker.js`,
   `kernel-host.js`, `boot.js`, `abi.js`, `shared-queues.js`, and the new
   `virtio/vsock-device.js` are engine files; pc boots a stale engine otherwise.
3. In-guest smoke: a tiny guest program `socket(AF_VSOCK, SOCK_STREAM, 0)` +
   `connect({.svm_cid=2 (VMADDR_CID_HOST), .svm_port=<P>})`, with the harness
   registering `device.listen(P, conn => conn.onData(echo))` — assert a byte
   round-trip both ways. (No existing demo harness wires `vsock.onReady` yet; a
   `demo/node/vsock-smoke.mjs` is the natural place, paired with the in-guest
   client. Deferred to the pc-side follow-up since the consumer lives there.)

## pc-side /Ctl follow-up (downstream, OUT OF SCOPE here)

The remaining work is in **pc**, not this repo:

1. pc passes a `vsock: { onReady(device) }` hook into `bootLinux(...)` and, in
   `onReady`, calls `device.listen(CTL_PORT, conn => …)` to accept the guest's
   `/Ctl` stream.
2. pc moves its `/Ctl` protocol parser (launch-app / clipboard / notify) off the
   9P `aname` reader and onto the `VsockConnection` (`conn.onData` for
   guest→host messages, `conn.write` for host→guest replies/events).
3. The guest `/Ctl` agent opens `AF_VSOCK` to `(VMADDR_CID_HOST=2, CTL_PORT)`
   instead of writing the 9P control file. The 9P `/Ctl` path stays as the
   fallback until the vsock path is proven in the browser, then is retired in a
   follow-up (mirroring how `trans_cb` was retired only after virtio-9p booted).

Pick `CTL_PORT` on the pc side (a fixed well-known vsock port); this repo imposes
no port — the host API accepts any.
