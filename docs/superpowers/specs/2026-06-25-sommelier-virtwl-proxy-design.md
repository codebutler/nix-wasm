# Sommelier on virtwl — the protocol-aware guest Wayland proxy (issue #7)

**Date:** 2026-06-25
**Issue:** #7 (harden waylandproxyd into a protocol-aware proxy)
**Status:** design approved, ready for implementation plan

## Problem

The guest-side Wayland proxy `userspace/waylandproxyd.c` is a thin byte-splice MVP:
it moves wire bytes + SCM_RIGHTS fds between a guest `wayland-0` AF_UNIX socket and
the host compositor over the `virtwl` transport (`/dev/wl0`), and translates each
client shm fd into a `virtwl` vfd (`VIRTWL_IOCTL_NEW` / `NEW_ALLOC`). It holds **no
Wayland object state**.

This works for a single static window (`wl-eyes`) but **crashes real toolkit apps**.
Observed with `gtk3-widget-factory` in pc: the window renders, then quickly dies with

```
waylandproxyd: page allocation failure: order:11, mode:0xdc0(GFP_KERNEL|__GFP_ZERO)
Normal: ... 231*2048kB (UM) 29*4096kB (UME) 0*8192kB ...   # ~1 GB free, ZERO 8 MB blocks
waylandproxyd: fd_to_vfd failed for fd 9
forwarded 432B + 0 fd(s) client->host                       # message stripped of its fd
→ greenfield: "Not enough file descriptors in message object" → client torn down
```

### Root cause (two coupled defects, both in `waylandproxyd.c`)

1. **Resource leak / no lifecycle.** Each `wl_shm` pool is backed by a kernel
   `alloc_pages_exact()` buffer; a 4.4 MB pool needs an **order-11 (8 MB) physically
   contiguous** block (`get_order(4415488)=11`, matching the panic). Because the proxy
   parses no protocol, it never sees `wl_shm_pool.destroy` / `wl_buffer.destroy`, so it
   **never frees vfds**. It also caps mirrors at `MAX_POOLS=16` and *deliberately does
   not close* vfds past that (`waylandproxyd.c:357`), permanently leaking 8 MB kernel
   buffers per pool. GTK re-creates pools per frame/resize → the NOMMU buddy heap
   fragments → no order-11 block remains (≈1 GB free, but `0*8192kB`) →
   `alloc_pages_exact` returns NULL.
2. **Fragile failure path.** On `fd_to_vfd` failure the proxy `continue`s — it drops
   the fd but **still forwards the wire message** (`waylandproxyd.c:344`). The
   create_pool/buffer request reaches Greenfield missing its mandatory fd → fatal
   protocol desync → the whole client is destroyed.

This is exactly the failure issue #7 anticipated ("robust buffer/shm lifecycle … the
current `wl_shm` path does an mmap+copy resync per pool"; "does not parse the Wayland
object protocol or hold any object state").

## Strategy: use the real Sommelier (issue #7 Approach C)

Rather than hand-grow `waylandproxyd` into protocol-awareness (Approach A), build the
**real upstream Sommelier** (chromiumos `vm_tools/sommelier`) cross-compiled to
`wasm32-nommu`, running in its native **virtual-context (virtwl) mode**. Sommelier *is*
a mature, protocol-aware Wayland proxy built on libwayland-server's object model — so
`wl_shm_pool`/`wl_buffer` destruction frees the backing virtwl allocation through the
resource destructors. **The order-11 leak becomes structurally impossible, not patched.**

This was filed in #7 as the higher-up-front-cost / lower-correctness-risk path
("reuse battle-tested Wayland proxying"). Research (below) shows it is far more
tractable than #7's pessimistic framing: the GPU/X11 wall only blocks the
dmabuf/virtio-gpu and Xwayland paths, **neither of which we use**.

Secondary goal (explicit): treat this as an investment in a **reusable C++ guest
cross-toolchain + Wayland/X library closure** that future guest packages can use —
not a throwaway.

### Why C, not Rust (Approach B is reference-only)

`google/sommelier-rs` cannot be a code path: Rust has no std target for
`wasm32-linux-musl` NOMMU, and it relies on virtio-gpu cross-domain + GBM (the exact
GPU stack that won't cross). It informs *design* only.

### Decision: do C now, then (separately) keep the door open

This spec delivers Approach C as one PR. Approach A (hand-grown proxy) is dropped —
C subsumes it.

## Research findings that shape the design (upstream HEAD, evidence-based)

1. **virtwl is native.** Sommelier builds both `virtualization/virtwl_channel.cc` and
   `virtgpu_channel.cc`; the transport is a runtime-selected `WaylandChannel` ABC.
   With no `--display` and no `--virtgpu-channel` (defaults), it opens `/dev/wl0` via
   `VirtWaylandChannel` — **no new transport glue needed**.
2. **The shm path is gbm-free, but shm-selection must be forced.**
   `VirtWaylandChannel::init()` probes dmabuf with a `VIRTWL_IOCTL_NEW_DMABUF` allocate
   and flips `supports_dmabuf_=false` **only when `errno == ENOTTY`**
   (`virtwl_channel.cc:42-47`); any other error (or success) leaves dmabuf *enabled* →
   the gbm/dmabuf buffer path → runtime gbm. Our kernel's `NEW_DMABUF` case
   (`patches/kernel/0013` ~line 1878) forwards a `VFD_NEW_DMABUF` command to the host
   and returns the host's error verdict — **not** `ENOTTY` — so shm is **not** selected
   automatically. **Fix: a one-line kernel patch — the virtwl driver returns `-ENOTTY`
   for `NEW_DMABUF`** (it genuinely has no dmabuf driver; this is the honest device
   capability and exactly what Sommelier's probe was written to detect). Then
   `supports_dmabuf_=false` and **every** buffer goes through `wl_shm_create_pool` on a
   plain `VIRTWL_IOCTL_NEW_ALLOC` vfd (`sommelier-compositor.cc:275-305`,
   `virtwl_channel.cc:183-191`); `ctx->gbm` stays null → the 25 gbm sites in
   `sommelier-mmap.cc` are dead at runtime. (Fallback if the kernel route is undesirable:
   a 1-line Sommelier patch forcing `supports_dmabuf_=false`.)
3. **xcb is 100% Xwayland-gated.** `ctx->connection` is null until `sl_connect()` →
   `xcb_connect_to_fd()`, which is reached only from the Xwayland-ready event, set only
   by `-X` / `--x-display`. Without those, all ~227 `xcb_*` sites are unreachable. We
   **link libxcb and never execute it** — zero source patches for X11.
4. **libdrm is GPU/dmabuf-only** (`drm_fourcc.h` constants are header-only). Dead at
   runtime on the shm path.
5. **Sommelier owns the `wayland-0` socket** (`sl_open_wayland_socket`,
   `sommelier.cc:3864`): it `bind()`/`listen()`s `$XDG_RUNTIME_DIR/$socket_name`
   (`socket_name` defaults to `wayland-0`, `--socket=` overrides) under a `.lock`.
6. **Only three ioctls needed for our path:** `VIRTWL_IOCTL_NEW` (with `NEW_CTX` +
   `NEW_ALLOC`), `VIRTWL_IOCTL_SEND`, `VIRTWL_IOCTL_RECV`. (`NEW_PIPE_READ`,
   `NEW_DMABUF`, `DMABUF_SYNC` are clipboard/dmabuf-only.) Our kernel virtwl driver
   already implements all three.
7. **fork is the one real wall.** Spawn sites in `sommelier.cc`: a central
   `sl_execvp` (3492) + `fork()` at 3627, 3935, 3972→4019 (`sl_run_parent` per-client
   worker re-exec), 4056 (Xwayland), 4607 (single-client). Our musl has **no `fork`
   symbol**, so every site must be ported even if unreachable — but our no-fork link
   contract makes this *loud and exhaustive*.

## Architecture

```
guest GTK app ──AF_UNIX wayland-0──▶ sommelier (--parent)
                                       │  per accepted client: posix_spawn
                                       ▼
                                     sommelier --client-fd=N  (one per client)
                                       │  libwayland-server object model
                                       │  VIRTWL_IOCTL_NEW_CTX → own ctx
                                       ▼
                              /dev/wl0 (virtwl) ──SEND/RECV──▶ pc host / Greenfield
```

Each guest client → its own Sommelier worker → its own virtwl ctx → its own Greenfield
client/window (the existing per-ctx isolation model; object-ID remapping is unnecessary
because Greenfield owns each client's id space).

### Components

**1. Library closure (`deps-overlay.nix` + new derivations), exposed as flake attrs:**

| Lib | Status | Role |
|---|---|---|
| `wayland` (client+server+util) | already cross | proxy core (server presents wayland-0; client talks to host) |
| `libxkbcommon` | already cross | keymap |
| `pixman` | already cross | buffer/format helpers |
| `wayland-protocols` | native XML | extra protocol XML (scanner from buildPackages) |
| `libffi` (raw wasm backend) | already cross | **libwayland-server `wl_closure_invoke` dispatch** (new server-side use — risk B) |
| `libxcb` + `libXau` + `libXdmcp` + `xcb-proto` | **new cross** | link-only (Xwayland-gated, never runs) |
| `libdrm` | **new cross** | link-only (dmabuf-gated, never runs) |
| `gbm` = **minigbm** | **new cross** | link-only (`ctx->gbm` null, never runs) |

**2. `userspace/sommelier.nix`** — cross derivation: fetch the pinned platform2
`vm_tools/sommelier` subtree, apply the spawn patch (below), meson cross-build with the
`cross` cc-wrapper, options `tracing`/`gamepad`/`quirks`/`with_tests` off. No
`--fpcast-emu` (Sommelier uses no glib/gobject). Installs `/bin/sommelier`.

**3. `patches/sommelier/0001-posix-spawn.patch`** — the **only** functional source
patch: a `sl_spawn()` helper using `posix_spawn` (fork+exec atomically) replacing each
`fork()+sl_execvp()`; Xwayland spawn sites `#if 0`'d out (we never pass `-X`). Mirrors
the busybox/ash/glib spawn ports and satisfies the no-fork link contract.

**3b. `patches/kernel/00NN-virtwl-dmabuf-enotty.patch`** — the virtwl driver returns
`-ENOTTY` for `NEW_DMABUF` (no dmabuf driver on this device) so Sommelier's probe
cleanly selects the shm path. Shared kernel-source fix (vmlinux-only rebuild), honest
about device capability — not a package workaround.

**4. Integration:** add `/bin/sommelier` to the initramfs/system; switch the Wayland
autostart (inittab, from #53) from `waylandproxyd` to
`sommelier --parent` with `XDG_RUNTIME_DIR` set. `waylandproxyd` stays in-tree until
Sommelier validates end-to-end, then is retired in the same PR.

## Data flow (shm frame)

1. Guest GTK client `wl_shm.create_pool(fd, size)` on `wayland-0`.
2. Sommelier worker (libwayland-server) receives it; its compositor proxy allocates a
   host buffer: `channel->allocate()` → `VIRTWL_IOCTL_NEW_ALLOC` (size) → a virtwl vfd
   it mmaps; binds a host `wl_shm` pool on that vfd.
3. On surface commit, Sommelier `memcpy`s the damaged region client-buffer → virtwl
   vfd, then forwards the commit over `VIRTWL_IOCTL_SEND`. Host reads pixels from the
   vfd's guest RAM (identity pfn) — same host contract as `waylandproxyd`.
4. On `wl_buffer.destroy` / `wl_shm_pool.destroy`, the libwayland-server **resource
   destructor frees the virtwl allocation** (closes the vfd → kernel `free_pages_exact`)
   → **no leak, no fragmentation**.

## Error handling

- Allocation failure (`NEW_ALLOC` returns ENOMEM): Sommelier's buffer path surfaces a
  protocol error / posts no buffer — it does **not** forward an fd-stripped message
  (defect 2 cannot recur; Sommelier is fd-count-correct per interface).
- Worker death: a per-client worker crash tears down only that client; `--parent`
  survives. `waylandproxyd`'s "one bad message kills the client via the host" path is
  gone.

## Testing

1. **Cross-build gates:** each new lib (`libxcb`, `libdrm`, `minigbm`) and
   `.#sommelier` build via `nix build`. Exposed as flake attrs.
2. **libffi server-dispatch de-risk (early):** a minimal libwayland-**server** program
   cross-built + run in the node harness that registers a global and dispatches a
   request through `wl_closure_invoke` (proves our raw FFI backend covers server
   handler signatures). Gate before investing in the full Sommelier build.
3. **Registry handshake through Sommelier:** boot guest, run `sommelier --parent`, run
   a stock-libwayland client (`wl-eyes` / the #1d handshake client) → registry round
   trips. Replaces `waylandproxyd-spike.mjs`.
4. **Leak regression (the bug's failing test):** a guest client that creates+destroys
   N (≫16) `wl_shm` pools through Sommelier; assert guest `MemFree`
   (`/proc/meminfo`) stays bounded and an order-11 allocation still succeeds afterward.
   This fails on `waylandproxyd`, passes on Sommelier. New `runtime/demo/node/` smoke.
5. **Visual (manual browser):** `gtk3-widget-factory` renders **and survives** (the
   original crash) via Greenfield. Note in `docs/superpowers/notes/`.

## Risks / open de-risking order

- **A — minigbm cross-build (linchpin of "build gbm").** minigbm is small C + DRM
  ioctls, link-only for us. *First implementation step.* Fallback: a minimal
  header+symbol `libgbm` shim (symbols provably never called) — honors "provide a lib
  over stripping code." Mesa's gbm is explicitly **not** attempted.
- **B — libffi for libwayland-server dispatch.** New server-side `wl_closure_invoke`
  use of our raw wasm FFI backend; wayland handler sigs are mostly i32/ptr (in
  coverage) but server dispatch is unproven. De-risked by test 2 before the full build.
- **C — host transparency.** Sommelier must present to pc/Greenfield the same virtwl
  SEND/RECV stream `waylandproxyd` did. Same ioctls + same vfd-pfn buffer model suggest
  no pc change; **validate** the registry handshake (test 3) reaches Greenfield before
  assuming pc is untouched. If pc needs a tweak, that's a separate pc PR.
- **D — fork ports.** Contained to the central spawn helper; the no-fork link contract
  guarantees completeness.
- **E — platform2 subtree fetch.** platform2 is a large monorepo; pin a rev and fetch
  only `vm_tools/sommelier` (sparse/subtree) to keep the source derivation lean.

## Decisions (defaults chosen; revisit if wrong)

- **Retire `waylandproxyd`** after Sommelier validates end-to-end (same PR), not before.
- **`--parent` + `posix_spawn` worker** model (single binary, smallest patch), over an
  external acceptor driving `sommelier --client-fd`.
- **Scope:** wl_shm + virtwl + no-Xwayland only. dmabuf/virtio-gpu/Xwayland/clipboard
  are out of scope (libs linked, code dead). Extend later as separate work.

## Out of scope

- Zero-copy shm (needs dmabuf/GPU we don't have — Sommelier's per-commit copy stays).
- Xwayland, clipboard/`wl_data_device`, dmabuf, multi-output scaling.
- Approach C-for-pc / any host-side rewrite (separate repo).
