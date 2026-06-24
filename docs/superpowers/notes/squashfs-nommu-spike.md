# Squashfs-on-NOMMU spike (#43 Task 3) — findings

**Status: GATE PASSED.** The NOMMU wasm guest can `mount -t squashfs` a
read-only virtio-blk image, read a file off it, **and mmap-exec a real guest
binary directly off it**. The critical risk (mmap-for-exec off squashfs's
`readpage` on NOMMU) is cleared.

## What was proven

Harness: `runtime/demo/node/blk-spike.mjs` (busybox-only boot, no /nix 9P, the
squashfs is the only block device → `/dev/vda` is unambiguously our image). It
drives the guest console non-interactively and asserts on captured output.

Guest console transcript (block size `-b 131072`, the default):

```
virtio_blk virtio3: [vda] 1120 512-byte logical blocks (573 kB/560 KiB)
~ # ls -l /dev/vd* 2>&1; echo VDLS_DONE
brw-------    1 0        0         254,   0 Jan  1 00:00 /dev/vda
VDLS_DONE
~ # mkdir -p /mnt/sq; mount -t squashfs -o ro /dev/vda /mnt/sq 2>&1; echo MOUNT_RC=$?
MOUNT_RC=0
~ # cat /mnt/sq/store/aaaa-test/data.txt 2>&1; echo CAT_DONE
hello
CAT_DONE
~ # /mnt/sq/store/aaaa-test/busybox echo MMAP_EXEC_OK 2>&1; echo EXEC_RC=$?
MMAP_EXEC_OK
EXEC_RC=0
```

- `mount -t squashfs` → `MOUNT_RC=0`
- `cat .../data.txt` → `hello`
- **mmap-exec**: busybox (the known-good guest wasm binary, 1.38 MB) exec'd
  DIRECTLY off the squashfs prints `MMAP_EXEC_OK`, rc 0. This exercises the
  NOMMU read-only file-mmap-for-exec path (kernel patch 0016,
  `wasm: !MMU read-only MAP_SHARED file mmap falls back to a private copy`)
  against squashfs's `address_space_operations`. No SIGILL / ENOEXEC.

## /dev node

The single virtio-blk device registers as **`/dev/vda`** (block major 254,
minor 0). With one device the guest always sees `vda`; production base-image
serving should not assume more.

## Block-size tuning

All three block sizes mount + read + mmap-exec cleanly. Watched the guest dmesg
during mount/read/exec for `page allocation failure` / `order:N` contiguous-alloc
failures (the NOMMU buddy-allocator risk) — **none observed at any size**.

| `-b`        | image size (bytes) | mount | cat | mmap-exec | alloc failures |
|-------------|--------------------|-------|-----|-----------|----------------|
| 16384 (16K) | 618496             | ok    | ok  | ok        | none           |
| 65536 (64K) | 589824             | ok    | ok  | ok        | none           |
| 131072 (128K, default) | 573440  | ok    | ok  | ok        | none           |

**Chosen default: `-b 131072`** (squashfs's own default). It produces the
smallest image (better compression) and showed no NOMMU page-allocation
pressure on this small test image. NOTE: this test image is tiny (~600 KB); the
production base image (the full /nix closure) is far larger, so Task 4 should
re-confirm there's no order-N alloc failure at scale before locking 128K in. The
data here shows 128K is *safe in principle* on NOMMU — squashfs decompresses a
block into a kmalloc'd buffer, and a 128K block needs an order-5 (32-page)
allocation, which held even after boot fragmentation in this run.

## Kernel configs relied on (Task 1, `kernel.nix`)

```
CONFIG_BLOCK              # gate for VIRTIO_BLK (drivers/block/Kconfig is `if BLOCK`)
CONFIG_VIRTIO_BLK        # the block driver
CONFIG_MISC_FILESYSTEMS  # gate for SQUASHFS (fs/Kconfig wraps it `if MISC_FILESYSTEMS`)
CONFIG_SQUASHFS
CONFIG_SQUASHFS_ZSTD     # the test images use `-comp zstd`
CONFIG_ZSTD_DECOMPRESS
```

Plus kernel patch **0017** (`virtio_wasm: add VW_DEV_BLK`, device index 3,
virtio device id `VIRTIO_ID_BLOCK`=2) registers the device on the wasm virtio
transport, and patch **0016** provides the NOMMU RO-file-mmap path that
mmap-exec depends on.

Boot log confirming the chain comes up: `squashfs: version 4.0 ... Phillip
Lougher`, then `virtio_blk virtio3: [vda] 1120 512-byte logical blocks`.

## Host-side plumbing added in this spike (kept — Task 5 builds on it)

`boot.js` accepts `opts.squashfs` (an `ArrayBuffer`) and threads it through
`linux()` (`kernel-host.js`).

**Key correctness finding — the image must be a SharedArrayBuffer.** The
BlkDevice is built **lazily in whichever task worker first services the
virtio-blk vring** — NOT necessarily the boot/CPU-0 worker. The per-worker JS
heaps are isolated, so a transferred-or-copied-to-CPU-0-only ArrayBuffer left
every *other* worker with a 0-length image → `[vda] 0 512-byte logical blocks`
→ `SQUASHFS error: Failed to read block 0x0: -5` at mount. The fix (mirroring
the 9P ring and the virtio queue-layout store): `kernel-host.js` copies the
caller's ArrayBuffer into a `SharedArrayBuffer` ONCE and hands that same SAB to
**every** worker's init message. A `Uint8Array` view over the SAB drives
`BlkDevice` unchanged (it only reads `image.subarray`/`image.length`).

## Build / repro

```sh
# Artifacts (patched LLVM cached):
sudo nix build .#kernel .#wasm-initramfs --print-out-paths

# Extract busybox (the known-good guest wasm binary) from the initramfs:
mkdir t && cd t && zcat <initramfs>/initramfs.cpio.gz | cpio -idmv 2>/dev/null

# Build the test squashfs:
mkdir -p sqtest/nix/store/aaaa-test
cp t/bin/busybox sqtest/nix/store/aaaa-test/busybox
printf 'hello\n' > sqtest/nix/store/aaaa-test/data.txt
nix shell nixpkgs#squashfsTools -c mksquashfs sqtest/nix base.squashfs \
  -comp zstd -b 131072 -all-root -noappend -no-progress -reproducible \
  -mkfs-time 0 -all-time 0

# Run the gate (artifacts dir needs vmlinux.wasm + initramfs.cpio.gz):
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ \
  node runtime/demo/node/blk-spike.mjs /path/to/base.squashfs
# exit 0 = mount + cat + mmap-exec all pass.  BLK_SPIKE_DUMP=1 dumps the console.
```
