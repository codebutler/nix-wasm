# Keyboard input for guest Wayland clients (guest-backed keymap fd)

**Date:** 2026-06-26
**Follows:** #7 (Sommelier on virtwl) + #81 (pointer-button). Input follow-up #2 of 2.
**Status:** design approved, ready for implementation plan

## Problem

Pointer input now works through Sommelier (#81), but **keyboard input does not**.
The wayland `wl_keyboard.keymap(format, fd, size)` event delivers the xkb keymap
as a **file descriptor the receiver `mmap`s**. On our NOMMU wasm guest that mmap
currently fails, so no client ever gets a working keymap.

Trace (host → guest):

1. Greenfield emits `wl_keyboard.keymap` with an fd whose backing is the real xkb
   keymap bytes (the browser bridge has them: `wayland-compositor.js`
   `makeGuestInputOutput().mkstempMmap(blob)` reads the keymap `Blob` into a
   `Uint8Array` carrier; `guestFdPayload()` returns those bytes).
2. `runtime/virtio/wl-device.js` turns each server→client fd into a host→guest
   `VFD_NEW` (registering a vfd under a HOST-bit id) followed by a `VFD_RECV`
   referencing it, so the client receives the fd over SCM_RIGHTS.
3. **Today** `_vfdNewHost(id, size)` sends `pfn = 0` — *no backing* — and the real
   keymap bytes are discarded (only `payload.length` is used as `size`). The vfd
   has no memory, so `mmap` returns `MAP_FAILED`. This was deliberate for the
   weston-flowers bring-up (no keyboard needed); the device comment says so.
4. In the guest, **Sommelier passes the same fd straight through** to its GTK
   client — `sommelier-seat.cc:302 wl_keyboard_send_keymap(host->resource, format,
   fd, size)` — *and* mmaps it itself to build its xkb state (`:305`). Both mmaps
   hit the empty vfd. Sommelier's was made non-fatal by the #7 graceful patch
   (`0002-keymap-mmap-graceful.patch`: skip xkb on `MAP_FAILED`); the **client's**
   mmap (libxkbcommon inside GTK) still fails, so GTK has no keymap and key events
   are never translated to characters.

**NOMMU constraint (the crux):** only **guest-allocated** pages are mmappable on
this port — `virt_to_phys` is identity, so the guest can `remap_pfn_range` its own
RAM. Host-*injected* device memory has no MMU mapping and cannot be mmapped (the
earlier "host-arena" attempt failed exactly here, recorded in `wl-device.js`). So
the keymap fd must be backed by **guest** RAM that the kernel fills with the host's
keymap bytes.

## Approach (chosen: A — kernel guest-allocated keymap backing)

Make the host→guest keymap vfd backed by a **guest-allocated** page the kernel
fills with the keymap bytes, so `mmap` works through the standard
`remap_pfn_range` path the existing NEW_ALLOC shm buffers already use.

This is the **correct, general** fix (PRIME DIRECTIVE corollary 1): it lives in the
shared virtwl transport (kernel + device), not in Sommelier. It faithfully
implements what real virtwl/crosvm does (crosvm backs keymap vfds with shared
memory), needs **no Sommelier change** (the existing pass-through + the graceful
patch as a safety net both keep working), and generalizes to any future host→guest
fd whose content a guest must mmap. The rejected alternative — patching Sommelier to
copy the keymap into a fresh in-guest fd — is a package-private workaround that
fixes only the keymap case and leaves the transport unable to deliver a mmappable
host fd.

### Why chunked delivery (not a single inline message)

The guest posts the virtwl IN queue with **`PAGE_SIZE` (4 KiB) buffers**
(`0013-…patch`: `kmalloc(PAGE_SIZE)` + `sg_init_one(sg, buffer, PAGE_SIZE)`), and
the host cannot enlarge a buffer the guest owns. A full xkb keymap is ~30–64 KiB,
so it cannot ride in one host→guest message. The keymap bytes are therefore
**streamed in ≤4 KiB chunks** that the kernel copies into the guest-allocated
backing at an accumulating offset. (Bumping every IN buffer to keymap size was
rejected — it wastes memory on every inbuf and still has no hard upper bound.)

## Design

### 1. Kernel virtwl (`patches/kernel/0013-wasm-virtio-wasm-transport.patch`)

Two changes, both reusing the existing `vfd->shm_buf` / `vfd->pfn` machinery that
NEW_ALLOC guest buffers already use (so the existing mmap path at `if (vfd->pfn)
remap_pfn_range` and the existing `free_pages_exact` teardown both apply unchanged):

- **`vq_handle_new` — allocate guest backing for a flagged host vfd.** When a
  host→guest `VFD_NEW` carries a new **`VIRTIO_WL_VFD_FILL`** flag (a kernel/device
  agreed bit, distinct from READ/WRITE), allocate `alloc_pages_exact(PAGE_ALIGN(
  size), GFP_KERNEL)`, set `vfd->shm_buf` and `vfd->pfn = virt_to_phys(buf) >>
  PAGE_SHIFT`, mark the vfd "fill-mode", and init `vfd->fill_offset = 0`. The vfd is
  READ-only and now has real, mmappable guest backing. On allocation failure, leave
  `vfd->pfn = 0` (degrades to today's graceful no-keymap behavior — no crash).

- **`vq_handle_recv` — copy into the backing instead of queuing.** When a `VFD_RECV`
  targets a fill-mode vfd, `memcpy` its data payload into `vfd->shm_buf +
  vfd->fill_offset` (clamped to the allocated size), advance `fill_offset`, and
  **return the inbuf to the vq** (`return true`) — do *not* allocate a `qentry` or
  queue it for a `read()` (the data is the mmap backing, not a stream). Normal (non
  fill-mode) recv is unchanged.

`vfd->fill_offset` and a `fill_backing` bool are new `struct virtwl_vfd` fields.
vmlinux rebuild.

### 2. Device (`runtime/virtio/wl-device.js`) — engine file, needs pc sync

- **`_vfdNewHost(id, size)`** — set the `VIRTIO_WL_VFD_FILL` flag (alongside
  `VIRTIO_WL_VFD_READ`); keep `pfn = 0` (the *guest* now allocates).
- **`_buildFdDelivery(ctxVfdId, bytes, fdPayloads)`** — for each fd payload, after
  the `VFD_NEW(FILL)`, emit one or more `VFD_RECV(keymap_vfd_id, chunk)` messages
  carrying the **real payload bytes** in ≤ (`PAGE_SIZE − recv-header`) chunks (the
  kernel copies them into the backing), *then* the existing `VFD_RECV(ctxVfdId,
  event_bytes, [keymap_vfd_id])` that hands the now-filled fd to the client. The IN
  queue is processed in order, so the fd is fully populated before the client sees
  it.
- Update the stale comment block (the "we do NOT inject a backing pfn … mmap fails
  gracefully" paragraph) to describe the guest-backed fill path.

### 3. Sommelier — no change

`sommelier-seat.cc` already passes the fd through to the client and mmaps it; with
a real backing both succeed and it builds genuine xkb state. The graceful
`MAP_FAILED` patch stays as a safety net (it only triggers if allocation failed).

## Data flow

```
Greenfield wl_keyboard.keymap(fd=keymap-bytes, size)
 └▶ wl-device.js: VFD_NEW(host-id, size, flags=READ|FILL)        [guest allocates]
                  VFD_RECV(host-id, keymap chunk 0)  ┐
                  VFD_RECV(host-id, keymap chunk 1)  ├ kernel memcpy → backing
                  …                                   ┘
                  VFD_RECV(ctx, event_bytes, [host-id])           [hand fd to client]
 └▶ kernel vq_handle_new: alloc_pages_exact(size); vfd->pfn set   [mmappable guest RAM]
    kernel vq_handle_recv (fill-mode): memcpy chunks into backing
 └▶ guest: Sommelier receives fd → mmap SUCCEEDS → builds xkb; forwards SAME fd
 └▶ GTK client: mmap SUCCEEDS → libxkbcommon builds keymap → keys → characters
```

## Error handling

- `alloc_pages_exact` failure → `vfd->pfn = 0`; mmap fails gracefully (today's
  behavior, no keyboard, no crash). Logged.
- Chunk copy clamps to the allocated size (a malformed over-long stream cannot
  overflow the backing).
- Reject an absurd keymap `size` (cap, e.g. a few MiB) at `vq_handle_new` rather
  than attempting a huge contiguous allocation.
- The device keeps its existing delivery path resilient (a missing payload logs and
  is skipped, as today).

## Testing / verification

- **Must actually run, not claim** (behavioral rule from #7/#81): headless
  Playwright + Chrome (`--enable-unsafe-swiftshader`) → boot the full nix system →
  `gtk3-widget-factory` → focus its text entry → `page.keyboard.type("hello")` →
  screenshot/pixel-diff to confirm the typed characters render in the entry. This is
  the pass criterion.
- **In-guest assertion:** a smoke that confirms the keymap fd `mmap` now succeeds
  in the guest (no `MAP_FAILED`) — e.g. Sommelier builds xkb (no graceful-skip log),
  or a minimal in-guest mmap check on a fill-mode vfd.
- **Regression:** `sommelier-smoke.mjs` / `sommelier-leak-smoke.mjs` still pass
  (weston-flowers uses no keyboard; the fill path is only taken for keymap fds), and
  the 4 runtime CI gates pass. Re-run `runtime/sync-to-pc.sh` is required for any
  `wl-device.js` change before pc can use it (flagged as a pc follow-up, not done
  here).

## Components (boundaries)

- **kernel `vq_handle_new` fill-alloc** — input: a `VFD_NEW` with `FILL`; effect:
  guest-allocated, mmappable backing on the vfd. Depends on the existing
  `alloc_pages_exact` / `vfd->pfn` / `remap_pfn_range` machinery.
- **kernel `vq_handle_recv` fill-copy** — input: a `VFD_RECV` to a fill-mode vfd;
  effect: bytes copied into the backing at `fill_offset`. Self-contained; normal
  recv untouched.
- **`wl-device.js` keymap delivery** — input: keymap `payload` bytes; effect: the
  `VFD_NEW(FILL)` + chunked `VFD_RECV` fills + the fd hand-off. The only host-side
  logic; mirrors the existing `_buildFdDelivery` shape.

## Non-goals

- **Key repeat / xkb compose / layout switching** — whatever GTK + libxkbcommon do
  with a correct keymap is in scope; no extra host logic.
- **pc's own compositor wiring** — pc vendors the engine; it needs the
  `sync-to-pc.sh` re-vendor (+ any wiring), flagged as a pc follow-up, NOT done here.
- **A generic host→guest large-fd channel beyond keymaps** — the fill mechanism is
  general, but only the keymap path is wired and tested here.
