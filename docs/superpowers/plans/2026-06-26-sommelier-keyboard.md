# Keyboard input (guest-backed keymap fd) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the host→guest `wl_keyboard` keymap fd mmappable on the NOMMU wasm guest, so GTK apps through Sommelier receive a working xkb keymap and keyboard input produces characters.

**Architecture:** A new `VIRTIO_WL_VFD_FILL` flag tells the kernel virtwl driver to back a host→guest vfd with **guest-allocated** RAM (`alloc_pages_exact`, mmappable via the existing `remap_pfn_range` path) and to **copy** streamed `VFD_RECV` chunks into that backing instead of queuing them for `read()`. The device (`wl-device.js`) sets the flag and streams the real keymap bytes in ≤page-sized chunks (IN buffers are `PAGE_SIZE`; keymaps are larger). Sommelier is unchanged — it already passes the fd through to its client and mmaps it; both now succeed.

**Tech Stack:** Linux kernel C (a unified-diff patch file), JavaScript (the virtio_wl device + bun unit tests), Nix builds (`.#kernel`, `.#linux-image`), Playwright/Chrome e2e smoke.

## Global Constraints

- **PRIME DIRECTIVE:** maximally correct, no shortcuts/stubs. The fix lives in the **shared transport** (kernel + device), never in Sommelier (corollary 1).
- **NOMMU mmap rule:** only guest-allocated pages are mmappable; host-injected device memory is not. The keymap backing MUST be guest-allocated (`alloc_pages_exact`), with `vfd->pfn = virt_to_phys(buf) >> PAGE_SHIFT` (identity on this port).
- **ABI-BUMP RULE:** any change to the kernel↔engine contract (the 9P/virtio transport, exec ABI, device models, syscall/loader stubs) MUST bump `ENGINE_ABI` in `runtime/abi.js` **in the same change**. This feature changes the virtwl device↔kernel protocol (a new flag + fill semantics) → bump `ENGINE_ABI`.
- **Engine sync:** any `runtime/` engine-file change (here `wl-device.js`, `abi.js`) needs `runtime/sync-to-pc.sh` before pc can use it — flagged as a pc follow-up, NOT done in this plan.
- **FILL flag value:** `VIRTIO_WL_VFD_FILL = 0x1000` — a private bit, distinct from the real `VIRTIO_WL_VFD_WRITE = 0x1` / `VIRTIO_WL_VFD_READ = 0x2`. Use this exact value in BOTH the kernel enum and the device.
- **Chunk size:** `MAX_FILL_CHUNK = 4096 - 16 = 4080` bytes (IN buffer is `PAGE_SIZE`; the `virtio_wl_ctrl_vfd_recv` header is 16 bytes: `hdr(8)+vfd_id(4)+vfd_count(4)`).
- **Fill-size cap:** reject `new->size > 4*1024*1024` at the kernel (`VIRTWL_MAX_FILL_SIZE`), degrading to `pfn=0` (graceful, no crash).
- **Runtime CI gates** (run from `runtime/`, all must pass before finishing): `bun run test`, `bun run lint`, `bun run format:check`, `bun run typecheck`.

## File Structure

- `runtime/virtio/wl-device.js` (modify) — the virtio_wl device. Add the `VIRTIO_WL_VFD_FILL` const, set it in `_vfdNewHost`, stream keymap bytes as chunked `VFD_RECV` fills in `_buildFdDelivery`, update the stale comment.
- `runtime/virtio/wl-device.test.js` (modify) — bun unit tests for the new delivery sequence + chunking + payload round-trip.
- `runtime/abi.js` (modify) — bump `ENGINE_ABI`.
- `patches/kernel/0013-wasm-virtio-wasm-transport.patch` (modify) — the `VIRTIO_WL_VFD_FILL` enum value; `struct virtwl_vfd` fill fields; `vq_handle_new` fill-alloc; `vq_handle_recv` fill-copy.
- `runtime/demo/node/sommelier-keyboard-smoke.mjs` (create) — the end-to-end gate: boot → gtk3-widget-factory → type into an entry → assert characters render.

---

### Task 1: Device — FILL flag + chunked keymap byte delivery

**Files:**
- Modify: `runtime/virtio/wl-device.js` (the `VIRTIO_WL_VFD_*` consts near line 47; `_vfdNewHost` ~line 423; `_buildFdDelivery` ~line 407; the comment block ~line 390)
- Test: `runtime/virtio/wl-device.test.js` (the `injectIn with server→client fds…` test ~line 137)

**Interfaces:**
- Consumes: existing `_vfdNewHost(id, size)`, `_vfdRecv(vfdId, data)`, `_vfdRecvWithFds(ctxVfdId, data, ids)`, `injectIn(vfdId, bytes, fds?)`, `dev._pendingIn` (array of `{raw}|{vfdId,data}` entries), consts `VIRTIO_WL_VFD_READ=0x2`, `VFD_HOST_ID_BIT`, `SEND_HDR_SIZE=16`.
- Produces: `VIRTIO_WL_VFD_FILL = 0x1000`; `MAX_FILL_CHUNK = 4080`; `_buildFdDelivery` now emits, per fd payload, `[VFD_NEW(READ|FILL), VFD_RECV(id, chunk)…]` then one trailing `_vfdRecvWithFds(ctx, bytes, ids)`. `_vfdNewHost` sets flags `READ|FILL`.

- [ ] **Step 1: Update the existing fd-delivery test to expect the fill sequence**

In `runtime/virtio/wl-device.test.js`, replace the `injectIn with server→client fds builds VFD_NEW(host-id) per fd + one VFD_RECV` test body (and rename it) with:

```js
test("injectIn with a server→client fd: VFD_NEW(FILL) + chunked fill VFD_RECVs + trailing VFD_RECV", () => {
  const dev = makeDevice();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  // A keymap payload whose CONTENT now matters (the kernel copies it into the
  // guest-allocated backing). 1234 B < MAX_FILL_CHUNK → exactly one fill recv.
  const keymap = new Uint8Array(1234).map((_, i) => (i * 7) & 0xff);
  dev.injectIn(7, bytes, [keymap]);
  // → [VFD_NEW(FILL), VFD_RECV(fill chunk0), VFD_RECV(ctx + vfd id)]
  expect(dev._pendingIn.length).toBe(3);

  // 1) host→guest VFD_NEW with HOST id bit, READ|FILL flags, keymap length.
  const newMsg = dev._pendingIn[0].raw;
  const ndv = new DataView(newMsg.buffer, newMsg.byteOffset, newMsg.byteLength);
  expect(ndv.getUint32(0, true)).toBe(VFD_NEW);
  const newVfdId = ndv.getUint32(8, true);
  expect(newVfdId & VFD_HOST_ID_BIT).toBe(VFD_HOST_ID_BIT);
  expect(ndv.getUint32(12, true)).toBe(0x2 | 0x1000); // READ | FILL
  expect(ndv.getUint32(24, true)).toBe(keymap.length); // size = keymap length

  // 2) a fill VFD_RECV on the keymap vfd (vfd_count=0) carrying the bytes.
  const fillMsg = dev._pendingIn[1].raw;
  const fdv = new DataView(fillMsg.buffer, fillMsg.byteOffset, fillMsg.byteLength);
  expect(fdv.getUint32(0, true)).toBe(VFD_RECV);
  expect(fdv.getUint32(8, true)).toBe(newVfdId); // targets the keymap vfd
  expect(fdv.getUint32(12, true)).toBe(0); // vfd_count = 0 (pure data)
  expect([...fillMsg.subarray(SEND_HDR)]).toEqual([...keymap]);

  // 3) trailing VFD_RECV on the ctx referencing the keymap vfd, then the bytes.
  const recvMsg = dev._pendingIn[2].raw;
  const rdv = new DataView(recvMsg.buffer, recvMsg.byteOffset, recvMsg.byteLength);
  expect(rdv.getUint32(0, true)).toBe(VFD_RECV);
  expect(rdv.getUint32(8, true)).toBe(7); // ctx vfd_id
  expect(rdv.getUint32(12, true)).toBe(1); // vfd_count
  expect(rdv.getUint32(SEND_HDR, true)).toBe(newVfdId);
  expect([...recvMsg.subarray(SEND_HDR + 4)]).toEqual([...bytes]);
});

test("a keymap larger than MAX_FILL_CHUNK is split into multiple fill VFD_RECVs that reassemble", () => {
  const dev = makeDevice();
  const keymap = new Uint8Array(4080 * 2 + 100).map((_, i) => (i * 13) & 0xff);
  dev.injectIn(9, new Uint8Array(0), [keymap]);
  // VFD_NEW + ceil(8260/4080)=3 fill recvs + 1 trailing recv = 5
  expect(dev._pendingIn.length).toBe(5);
  const newVfdId = new DataView(dev._pendingIn[0].raw.buffer).getUint32(8, true);
  // Reassemble the fill chunks (entries 1..3) and compare to the payload.
  const chunks = [];
  for (let i = 1; i <= 3; i++) {
    const m = dev._pendingIn[i].raw;
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    expect(dv.getUint32(0, true)).toBe(VFD_RECV);
    expect(dv.getUint32(8, true)).toBe(newVfdId);
    expect(dv.getUint32(12, true)).toBe(0);
    chunks.push(m.subarray(SEND_HDR));
  }
  const reassembled = new Uint8Array(keymap.length);
  let off = 0;
  for (const c of chunks) {
    reassembled.set(c, off);
    off += c.length;
  }
  expect(off).toBe(keymap.length);
  expect([...reassembled]).toEqual([...keymap]);
});
```

(`VFD_NEW`, `VFD_RECV`, `VFD_HOST_ID_BIT`, `SEND_HDR` consts already exist at the top of the test file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd runtime && bun test ./virtio/wl-device.test.js`
Expected: FAIL — `_pendingIn.length` is 2 not 3 (no fill recv yet); the flags assertion expects `0x1002` but gets `0x2`.

- [ ] **Step 3: Add the FILL const and the chunk size**

In `runtime/virtio/wl-device.js`, after the `VIRTIO_WL_VFD_READ` const (~line 48) add:

```js
// Private flag (NOT in the upstream virtio_wl ABI): tells the kernel virtwl
// driver to back this host→guest vfd with GUEST-allocated RAM and copy the
// streamed VFD_RECV chunks into it, so the client's mmap works on NOMMU (host
// pages can't be mmapped). Keep in sync with VIRTIO_WL_VFD_FILL in patch 0013.
const VIRTIO_WL_VFD_FILL = 0x1000;
// IN buffers are PAGE_SIZE; a fill VFD_RECV is SEND_HDR_SIZE(16) + data, so a
// single chunk's data is capped at 4080 B. Keymaps (~30–64 KiB) span several.
const MAX_FILL_CHUNK = 4096 - SEND_HDR_SIZE;
```

- [ ] **Step 4: Set the FILL flag in `_vfdNewHost`**

Replace the flags + pfn lines in `_vfdNewHost` (~line 429-430):

```js
    // READ (the client reads the keymap) | FILL (the guest allocates the
    // backing; the kernel copies the streamed bytes into it so mmap succeeds).
    dv.setUint32(12, VIRTIO_WL_VFD_READ | VIRTIO_WL_VFD_FILL, true);
    dv.setBigUint64(16, 0n, true); // pfn=0: the GUEST allocates (host pages aren't mmappable)
```

- [ ] **Step 5: Stream the payload bytes as chunked fills in `_buildFdDelivery`**

Replace the `for (const payload of fdPayloads)` loop body in `_buildFdDelivery` (~line 410-416):

```js
    for (const payload of fdPayloads) {
      const id =
        (VFD_HOST_ID_BIT | (this._nextHostVfdId++ & ~(VFD_HOST_ID_BIT | VFD_ILLEGAL_SIGN_BIT))) >>>
        0;
      ids.push(id);
      msgs.push(this._vfdNewHost(id, payload.length));
      // Stream the fd's bytes into the guest-allocated backing in ≤PAGE_SIZE
      // chunks; the kernel copies each into shm_buf (see VIRTIO_WL_VFD_FILL).
      for (let off = 0; off < payload.length; off += MAX_FILL_CHUNK) {
        msgs.push(this._vfdRecv(id, payload.subarray(off, off + MAX_FILL_CHUNK)));
      }
    }
```

- [ ] **Step 6: Update the stale comment block**

Replace the `--- server→client fd delivery (the keymap path) ---` comment paragraph (~line 390-403) so it describes the fill path:

```js
  // --- server→client fd delivery (the keymap path) -------------------------
  //
  // Greenfield ships some events with an fd (wl_keyboard.keymap carries the xkb
  // keymap). On a guest connection that fd must become a virtio_wl vfd the client
  // receives over SCM_RIGHTS. The protocol: emit a host→guest VFD_NEW(READ|FILL)
  // for each fd (the FILL flag makes the kernel allocate GUEST-owned backing —
  // host pages aren't mmappable on NOMMU), then stream the fd's bytes as chunked
  // VFD_RECV messages the kernel copies INTO that backing, then a final VFD_RECV
  // whose trailing vfd ids reference the now-filled fds. The client's mmap of the
  // keymap then SUCCEEDS (guest RAM via remap_pfn_range), so Sommelier builds xkb
  // and its GTK client gets a working keymap → keyboard input produces characters.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd runtime && bun test ./virtio/wl-device.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 8: Run the full runtime static gates**

Run: `cd runtime && bun run test && bun run lint && bun run format:check && bun run typecheck`
Expected: all PASS. (If `format:check` flags the edits, run `bun run format` and re-stage.)

- [ ] **Step 9: Commit**

```bash
git add runtime/virtio/wl-device.js runtime/virtio/wl-device.test.js
git commit -m "feat(#7): device streams keymap bytes into a FILL-backed vfd"
```

---

### Task 2: Kernel — guest-allocated, fill-copied keymap backing

**Files:**
- Modify: `patches/kernel/0013-wasm-virtio-wasm-transport.patch` — the `enum virtio_wl_vfd_flags` (~patch line 2353); `struct virtwl_vfd` (~patch line 745); `vq_handle_new` (~patch line 890); `vq_handle_recv` (~patch line 927).

**Interfaces:**
- Consumes: `struct virtwl_vfd { … void *shm_buf; size_t shm_size; uint64_t pfn; … }`; `alloc_pages_exact`/`free_pages_exact` (teardown at the existing `if (vfd->shm_buf) free_pages_exact(vfd->shm_buf, vfd->shm_size)`); the mmap path `if (!vfd->shm_buf || !vfd->pfn) …` + `remap_pfn_range`; `struct virtio_wl_ctrl_vfd_recv { hdr; __le32 vfd_id; __le32 vfd_count; /* + data */ }`; `struct virtio_wl_ctrl_vfd_new { … __le32 flags; __le64 pfn; __le32 size; }`.
- Produces: `VIRTIO_WL_VFD_FILL = 0x1000` (must equal the device const); `vfd->fill_backing` (bool) + `vfd->fill_offset` (size_t); `vq_handle_new` allocates backing when `new->flags & VIRTIO_WL_VFD_FILL`; `vq_handle_recv` copies into the backing for fill-mode vfds and returns the inbuf.

**Note on editing a unified-diff patch file:** the two affected hunks are *new-file* hunks (`@@ -0,0 +1,N @@`). After adding/removing `+` lines you MUST update each hunk's `N` to equal the exact number of `+` lines in that hunk, or the kernel build's patch phase fails. Recompute with the Step 7 command. Every code line you add inside these files begins with a literal `+`.

- [ ] **Step 1: Add the FILL flag to the kernel enum**

In `patches/kernel/0013-wasm-virtio-wasm-transport.patch`, in the `virtio_wl.h` hunk (`@@ -0,0 +1,154 @@`, ~patch line 2292), change the enum:

```
+enum virtio_wl_vfd_flags {
+	VIRTIO_WL_VFD_WRITE = 0x1, /* intended to be written by guest */
+	VIRTIO_WL_VFD_READ = 0x2, /* intended to be read by guest */
+	/*
+	 * Private to this NOMMU/Wasm port (NOT upstream virtio_wl): a host→guest
+	 * VFD_NEW with this flag makes the guest driver allocate the vfd's backing
+	 * in its OWN RAM (alloc_pages_exact) and copy subsequent VFD_RECV data into
+	 * it, so the vfd is mmappable (host-injected pages are not, on nommu). Used
+	 * for the wl_keyboard keymap fd.
+	 */
+	VIRTIO_WL_VFD_FILL = 0x1000,
+};
```

(That replaces the existing 4-line enum with this 12-line block: **+8 lines** in this hunk.)

- [ ] **Step 2: Add fill fields to `struct virtwl_vfd`**

In the `virtio_wl.c` hunk (`@@ -0,0 +1,1616 @@`, ~patch line 658), after `+	size_t shm_size;` in `struct virtwl_vfd`, add:

```
+
+	/*
+	 * Fill-backing (keymap path): set when this host→guest vfd was created with
+	 * VIRTIO_WL_VFD_FILL. The backing is shm_buf/shm_size (guest RAM, mmappable);
+	 * incoming VFD_RECV data is memcpy'd into it at fill_offset instead of being
+	 * queued for read().
+	 */
+	bool fill_backing;
+	size_t fill_offset;
```

(**+9 lines** in this hunk.)

- [ ] **Step 3: Allocate guest backing in `vq_handle_new` for FILL vfds**

In the same hunk, in `vq_handle_new`, replace the tail (the four assignment lines + return):

```
+	vfd->id = id;
+	vfd->size = new->size;
+	vfd->pfn = new->pfn;
+	vfd->flags = new->flags;
+
+	return true; /* return the inbuf to vq */
+}
```

with:

```
+	vfd->id = id;
+	vfd->size = new->size;
+	vfd->pfn = new->pfn;
+	vfd->flags = new->flags;
+
+	/*
+	 * FILL: back the vfd with GUEST RAM so mmap works on nommu (host pages can't
+	 * be mapped). The host streams the fd's bytes as VFD_RECV chunks that
+	 * vq_handle_recv copies into shm_buf. On failure leave pfn=0 → mmap fails
+	 * gracefully (no keymap, no crash). shm_buf is freed in virtwl_vfd teardown.
+	 */
+	if (new->flags & VIRTIO_WL_VFD_FILL) {
+		size_t alloc_size = PAGE_ALIGN(new->size);
+
+		if (alloc_size && new->size <= VIRTWL_MAX_FILL_SIZE) {
+			vfd->shm_buf = alloc_pages_exact(alloc_size,
+							 GFP_KERNEL | __GFP_ZERO);
+			if (vfd->shm_buf) {
+				vfd->shm_size = alloc_size;
+				vfd->pfn = (u64)virt_to_phys(vfd->shm_buf) >>
+					   PAGE_SHIFT;
+				vfd->fill_backing = true;
+				vfd->fill_offset = 0;
+			} else {
+				pr_warn("virtwl: fill backing alloc failed (size=%u)\n",
+					new->size);
+				vfd->pfn = 0;
+			}
+		} else {
+			pr_warn("virtwl: fill size %u rejected\n", new->size);
+			vfd->pfn = 0;
+		}
+	}
+
+	return true; /* return the inbuf to vq */
+}
```

(**+29 lines** in this hunk.) Also add the cap macro near the top of the driver file, right after the `#include`s / existing `#define`s — find the existing `#define VFD_HOST_VFD_ID_BIT 0x40000000` line (~patch line 735) and add directly after it:

```
+/* Cap a FILL vfd's guest-allocated backing (keymap is ~tens of KiB). */
+#define VIRTWL_MAX_FILL_SIZE (4 * 1024 * 1024)
```

(**+2 lines** in this hunk.)

- [ ] **Step 4: Copy fill data into the backing in `vq_handle_recv`**

In the same hunk, in `vq_handle_recv`, after the `if (vfd) mutex_lock(&vfd->lock);` / `mutex_unlock(&vi->vfds_lock);` / `if (!vfd) { … return true; }` preamble and BEFORE the `qentry = kzalloc(...)` line, insert:

```
+	/*
+	 * Fill-backing vfd (keymap): copy this chunk into the guest RAM backing at
+	 * the running offset (clamped to the allocation) instead of queuing it for
+	 * read(). The data is the mmap backing, not a stream. Return the inbuf.
+	 */
+	if (vfd->fill_backing) {
+		size_t hdr_sz = sizeof(*recv) +
+				(size_t)recv->vfd_count * sizeof(__le32);
+
+		if (vfd->shm_buf && len > hdr_sz) {
+			size_t data_len = len - hdr_sz;
+			size_t space = vfd->shm_size - vfd->fill_offset;
+			size_t n = min(data_len, space);
+
+			memcpy((u8 *)vfd->shm_buf + vfd->fill_offset,
+			       (u8 *)recv + hdr_sz, n);
+			vfd->fill_offset += n;
+		}
+		mutex_unlock(&vfd->lock);
+		return true; /* return the inbuf to vq */
+	}
+
```

(**+19 lines** in this hunk.)

- [ ] **Step 5: Update the two affected hunk headers' line counts**

The `virtio_wl.h` hunk gained **+8** lines: `@@ -0,0 +1,154 @@` → `@@ -0,0 +1,162 @@`.
The `virtio_wl.c` hunk gained **+9 +29 +2 +19 = +59** lines: `@@ -0,0 +1,1616 @@` → `@@ -0,0 +1,1675 @@`.

- [ ] **Step 6: Verify the hunk counts are exactly right (no hand-math errors)**

Run this from the repo root — it prints each new-file hunk's declared header line followed by the ACTUAL count of `+` body lines in that hunk (portable awk, no gawk extensions; the `+++` file-header line precedes the `@@` so it is NOT inside the hunk and is NOT counted):

```bash
awk '
  /^@@ -0,0 \+1,/ { if (h) print "  actual + lines = " cnt; cnt=0; h=1; print $0; next }
  /^diff --git/  { if (h) { print "  actual + lines = " cnt; h=0 } }
  h && /^\+/     { cnt++ }
  END { if (h) print "  actual + lines = " cnt }
' patches/kernel/0013-wasm-virtio-wasm-transport.patch
```

Expected: under each `@@ -0,0 +1,N @@` line, `actual + lines` equals that `N` (so `162` for the `virtio_wl.h` hunk and `1675` for the `virtio_wl.c` hunk). If any differ, set that hunk's `+1,N` to the printed actual. (Step 7's kernel build is the hard gate — a malformed new-file hunk fails the patch phase loudly.)

- [ ] **Step 7: Build the patched kernel**

Run: `echo <sudo-pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#kernel --no-link --print-out-paths`
Expected: the patch applies cleanly and `vmlinux.wasm` builds (prints a store path). A malformed hunk fails the patch phase loudly; a C error fails compilation — fix and rebuild. (First build may be long if the patched LLVM isn't cached; leave it running — do NOT kill it.)

- [ ] **Step 8: Commit**

```bash
git add patches/kernel/0013-wasm-virtio-wasm-transport.patch
git commit -m "feat(#7): virtwl FILL flag — guest-allocated, kernel-filled keymap vfd"
```

---

### Task 3: End-to-end — bump ABI, build artifacts, verify typing works

**Files:**
- Modify: `runtime/abi.js` (the `ENGINE_ABI` constant)
- Create: `runtime/demo/node/sommelier-keyboard-smoke.mjs`

**Interfaces:**
- Consumes: the built artifacts (`vmlinux.wasm`, `initramfs.cpio.gz`, `base.squashfs`, `nix-cache/`) under an artifacts dir; the demo web server (`runtime/demo/web/serve.mjs`); `window._termLog`; the `.wl-win`/`canvas` DOM from `wayland-compositor.js`.
- Produces: `sommelier-keyboard-smoke.mjs` (exit 0 PASS / 1 FAIL / 2 INCONCLUSIVE); a bumped `ENGINE_ABI`.

- [ ] **Step 1: Bump the engine ABI**

In `runtime/abi.js`, increment the `ENGINE_ABI` integer by 1 (the virtwl device↔kernel protocol changed — new flag + fill semantics). Read the file first to get the current value; change only that number and update any adjacent comment that records "what changed in this bump" to mention `VIRTIO_WL_VFD_FILL` (keymap fd backing).

- [ ] **Step 2: Commit the ABI bump**

```bash
git add runtime/abi.js
git commit -m "chore(#7): bump ENGINE_ABI — virtwl VFD_FILL keymap protocol"
```

- [ ] **Step 3: Write the keyboard e2e smoke**

Create `runtime/demo/node/sommelier-keyboard-smoke.mjs`:

```js
// sommelier-keyboard-smoke.mjs — verifies keyboard input end-to-end:
// boots headless Chrome, launches gtk3-widget-factory, focuses a text entry,
// types, and asserts the canvas pixels change (the typed text renders). Proves
// the guest-backed keymap fd (VIRTIO_WL_VFD_FILL) makes libxkbcommon's mmap
// succeed so key events become characters.
//
// Exit 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE (boot panic — re-run).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8121,
  RT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [RT + "/demo/web/serve.mjs", String(PORT)], {
  cwd: RT,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((res, rej) => {
  server.stdout.on("data", (c) => {
    if (String(c).includes("localhost")) res();
  });
  server.on("exit", (c) => rej(new Error("srv " + c)));
});

const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

let code = 2;
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/demo/web/`, { waitUntil: "domcontentloaded" });

  let up = false;
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    up = await page.evaluate(() => /[#$%]/.test(window._termLog || ""));
    if (up) break;
    console.log(`[kbd-smoke] waiting for prompt (${(i + 1) * 15}s)…`);
  }
  if (!up) {
    console.log("[kbd-smoke] INCONCLUSIVE — no prompt");
    process.exit(2);
  }
  console.log("[kbd-smoke] shell prompt detected");

  await page.click("#term");
  await page.keyboard.type("gtk3-widget-factory >/tmp/wf.log 2>&1 &");
  await page.keyboard.press("Enter");
  console.log("[kbd-smoke] launched gtk3-widget-factory");

  let box = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    box = await page.evaluate(() => {
      const wins = [...document.querySelectorAll(".wl-win")];
      const pick =
        wins.find((w) => {
          const t = w.querySelector(".wl-win-title")?.textContent || "";
          return t.includes("widget-factory") || t.includes("gtk3");
        }) ||
        wins.find((w) => {
          const c = w.querySelector("canvas");
          return c && c.width > 200 && c.height > 200;
        });
      if (!pick) return null;
      const canvas = pick.querySelector("canvas");
      if (!canvas || canvas.width <= 200) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (box) {
      console.log(`[kbd-smoke] GTK window canvas found: ${JSON.stringify(box)}`);
      break;
    }
    if (i % 3 === 0) console.log(`[kbd-smoke] waiting for GTK window (${i * 2}s)…`);
  }

  if (!box) {
    console.log("[kbd-smoke] FAIL — no GTK window canvas appeared");
    code = 1;
  } else {
    // gtk3-widget-factory page 1 has a GtkSearchEntry near the top-left of the
    // content area. Click into it to focus, then type. Canvas-local (~130,90).
    // (If the entry isn't there, the verify step adjusts these coords from the
    // before-screenshot.)
    const entryX = Math.round(box.x + 130);
    const entryY = Math.round(box.y + 90);
    const region = {
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y + 40)),
      width: Math.min(box.w, 1280 - box.x),
      height: Math.min(120, box.h),
    };

    await page.mouse.move(entryX, entryY);
    await sleep(200);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await sleep(400);

    const before = await page.screenshot({ clip: region });
    writeFileSync("/tmp/sommelier-kbd-before.png", before);

    await page.keyboard.type("hello", { delay: 60 });
    await sleep(1500); // GTK repaint + Greenfield canvas update

    const after = await page.screenshot({ clip: region });
    writeFileSync("/tmp/sommelier-kbd-after.png", after);

    const changed = Buffer.compare(before, after) !== 0;
    console.log(
      `[kbd-smoke] entryAt=(${entryX},${entryY}) region=${JSON.stringify(region)} pixelsChanged=${changed}`,
    );
    code = changed ? 0 : 1;
    console.log(
      changed
        ? "[kbd-smoke] PASS — typing rendered characters (keymap fd mmap works)"
        : "[kbd-smoke] FAIL — typing produced no visible change",
    );
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
```

- [ ] **Step 4: Build the boot artifacts (kernel + initramfs + squashfs + cache)**

Run (each as its own `sudo` command; substitute the local sudo password):

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#kernel .#wasm-initramfs .#wasm-base-squashfs .#wasm-binary-cache --print-out-paths
```

Assemble an artifacts dir (symlink the four outputs as `vmlinux.wasm`, `initramfs.cpio.gz`, `base.squashfs`, `nix-cache/`) — reuse the layout under `~/lwbuild/sommelier-artifacts/` (the prior worktree's dir) but **rebuild `vmlinux.wasm` + `initramfs.cpio.gz` from THIS branch** (the kernel patch + the synced engine changed). The squashfs/cache are guest-userspace-only and unchanged by this feature, so they may be reused.

Expected: all four build (store paths printed).

- [ ] **Step 5: Sync the engine into the demo and run the keyboard smoke**

The demo web frontend reads the engine from `runtime/`; no pc sync is needed to run the in-repo smoke (that's `serve.mjs` serving `runtime/`). Point the smoke at the artifacts and run it:

```bash
cd runtime
ln -sfn /path/to/artifacts demo/web/artifacts
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/sommelier-keyboard-smoke.mjs
```

Expected: `[kbd-smoke] PASS — typing rendered characters (keymap fd mmap works)` and exit 0.

- [ ] **Step 6: If FAIL, diagnose with the screenshots (verification iteration, not a placeholder)**

Inspect `/tmp/sommelier-kbd-before.png` / `-after.png`. If the before-shot shows the entry is NOT at (~130,90) canvas-local, set `entryX`/`entryY` to the entry's actual location visible in the shot and re-run Step 5. If the guest log (`window._termLog`, or `/tmp/wf.log` inside the guest via `attach.mjs`) shows the keymap mmap still failing, re-check Task 2 (the kernel patch applied; `vfd->pfn` set; the fill copy ran) and Task 1 (the device actually streamed the bytes). Only mark this task done on a real PASS.

- [ ] **Step 7: Regression — the existing Sommelier smokes still pass**

Run:

```bash
cd runtime
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/sommelier-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/sommelier-leak-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/sommelier-click-smoke.mjs
```

Expected: all exit 0 (weston-flowers needs no keyboard; pointer clicks still work; the fill path is taken only for keymap fds).

- [ ] **Step 8: Commit the smoke**

```bash
git add runtime/demo/node/sommelier-keyboard-smoke.mjs
git commit -m "test(#7): end-to-end keyboard smoke (type into gtk3-widget-factory)"
```

---

## Notes for the executor

- **pc follow-up (NOT in this plan):** after merge, `runtime/sync-to-pc.sh <pc-checkout>` re-vendors the engine (`wl-device.js`, `abi.js`) into pc; pc may need its own keyboard wiring. Flag it; don't do it here.
- **CI:** the existing `nix-wasm.yml` `boot-smoke` job boots the guest on x86_64. Wiring `sommelier-keyboard-smoke.mjs` into CI is optional and out of scope (it needs a GPU/swiftshader browser, unlike the headless boot smokes) — leave it as a local gate.
- **Don't kill long kernel builds** (PRIME DIRECTIVE corollary 3).
