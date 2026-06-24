# virtio_net probe spike — VERDICT: **PASS**

**Task:** 1.3 — confirm stock `drivers/net/virtio_net.c` probes on the wasm32
nommu no-DMA `virtio_wasm` transport and creates `eth0`.

**Date:** 2026-06-21
**Path chosen for the rest of Phase 1:** **STOCK driver** (`drivers/net/virtio_net.c`).
No minimal `virtio_wasm_net.c` fallback is needed.

## How it was run

- Kernel: built from this branch with `CONFIG_VIRTIO_NET` + `CONFIG_INET` +
  `CONFIG_PACKET` (+ `CONFIG_NETDEVICES`, the gate — see below).
  `nix build .#kernel` → `vmlinux.wasm` (6.4 MB).
- Initramfs: `nix build .#wasm-initramfs` → `initramfs.cpio.gz` (busybox-only).
- Boot: `runtime/demo/node/net-spike.mjs` via `bootNode({ nix:false })`, then
  `waitForPrompt`, then `ls /sys/class/net` / `ip link` / `cat /proc/net/dev`.
  `LINUX_WASM_ARTIFACTS=file:///…/net-spike-artifacts/`.

Note: at spike time the host net model is wired (Task 1.5) but nothing drives
the link, so `eth0` comes up **link DOWN** — which is all the spike needs to
confirm a clean probe.

## Acceptance evidence (boot log)

```
virtio_net virtio2: vq[0]=input.0  ready: desc=d880000 avail=d880400 used=d881000 num=64 irq=10
virtio_net virtio2: vq[1]=output.0 ready: desc=d882000 avail=d882400 used=d883000 num=64 irq=10
virtio_wasm: registered dev=2 id=0x1 irq=10        # VIRTIO_ID_NET=1, host dev index 2
...
Run /init as init process
~ # ls /sys/class/net
eth0  lo  sit0
~ # ip link
3: eth0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN qlen 1000
    link/ether 52:54:00:cb:00:02 brd ff:ff:ff:ff:ff:ff
~ # cat /proc/net/dev
  eth0:  0  0  0 ...
```

- `virtio_net` driver registers against `virtio2` (the dev-index-2 transport
  device), creating both vqs (input.0 / output.0) at identity nommu offsets,
  sharing the per-device IRQ 10 — the standard split-ring layout, no DMA.
- `eth0` is present with our configured MAC `52:54:00:cb:00:02` (the
  `VIRTIO_NET_F_MAC` config space read worked).
- **No probe oops, no feature-negotiation hang, no panic.** Boot reaches the
  shell prompt normally; the pre-existing echo self-test still PASSes
  (`RESULT virtio_wasm PASS 2vq …`), so dev 0/1 are unaffected.

## Why it works (the de-risked unknowns)

- **No `VIRTIO_F_ACCESS_PLATFORM`** — the transport masks it off
  (`vw_get_features`), so virtio_ring takes the `!vring_use_map_api()` no-DMA
  path; the kmalloc'd ring buffers sit at identity nommu offsets the host model
  reads directly. virtio_net never needed DMA-coherent allocs.
- **Feature negotiation** — the host model
  (`runtime/virtio/net-device.js`) offers only `VIRTIO_NET_F_MAC |
  VIRTIO_NET_F_STATUS`; it does **not** offer MQ / mergeable-rxbuf / checksum
  offload / NAPI-affecting features, so virtio_net brings up the simplest
  1-RX/1-TX configuration and the negotiation that "could fault" per the spec
  simply does not arise.
- **`VIRTIO_NET_HDR_LEN = 12`** (modern header, no `num_buffers`) matches what
  the driver writes/expects when mergeable rxbufs are off.

## Build gotcha recorded (for whoever rebuilds)

`drivers/net/Kconfig` wraps `config VIRTIO_NET` inside `if NETDEVICES … endif`.
Without `CONFIG_NETDEVICES=y`, `olddefconfig` **silently drops** `VIRTIO_NET`
and `virtio_net.o` never compiles (the first kernel build here exhibited
exactly this — `eth0` would not have appeared). `kernel.nix` now enables
`CONFIG_NETDEVICES` alongside the three requested flags.

## Recommendation

Proceed with the **stock** `virtio_net.c`. Tasks 1.4–1.6 (host model + link-up +
tcpip.js tap wiring) are on the stock path; no `0017-wasm-virtio-net-minimal.patch`
is required.
