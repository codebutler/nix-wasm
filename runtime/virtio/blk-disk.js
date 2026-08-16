// blk-disk.js — sparse dirty-sector journal for the RW state virtio-blk.
//
// Same CBHD wire format Machines uses (pc js/apps/machines/disk-overlay.ts):
//   magic "CBHD", version u32=1, blockSize u32, count u32,
//   entries { u32 blockIndex; u8[blockSize] data } × count
//
// Sector size is always 512 (virtio-blk). Pure + bun-testable.
//
// Dirty bits live in a SharedArrayBuffer shared across task workers: mark and
// clear with Atomics so concurrent virtio kicks cannot lose a dirty bit via
// non-atomic read/modify/write (which previously produced mountable-but-corrupt
// ext2 images after saveDisk → apply → reboot).
export const BLK_SECTOR = 512;
export const DISK_OVERLAY_MAGIC = "CBHD";
export const DISK_OVERLAY_VERSION = 1;
// Small compatibility images (tests, recovery tools) may arrive as ordinary
// ArrayBuffers.  Production state disks are 1-2 GiB and must already be shared:
// copying one beside the guest's ~2 GiB WebAssembly.Memory can OOM the host.
export const STATE_DISK_COPY_MAX_BYTES = 64 * 1024 * 1024;

function isShared(bitmap) {
  return typeof SharedArrayBuffer !== "undefined" && bitmap.buffer instanceof SharedArrayBuffer;
}

function loadByte(bitmap, i) {
  return isShared(bitmap) ? Atomics.load(bitmap, i) : bitmap[i];
}

function orByte(bitmap, i, mask) {
  if (isShared(bitmap)) Atomics.or(bitmap, i, mask);
  else bitmap[i] |= mask;
}

function andByte(bitmap, i, mask) {
  if (isShared(bitmap)) Atomics.and(bitmap, i, mask);
  else bitmap[i] &= mask;
}

/**
 * @param {Uint8Array} image
 * @param {Uint8Array} dirtyBitmap  bit i set ⇒ sector i dirty
 * @param {{ clear?: boolean }} [opts]
 * @returns {Uint8Array} CBHD bytes (empty overlay when no dirties)
 */
export function packDirtySectors(image, dirtyBitmap, opts = {}) {
  const sectors = Math.floor(image.length / BLK_SECTOR);
  /** @type {number[]} */
  const dirty = [];
  for (let s = 0; s < sectors; s++) {
    const bi = s >> 3;
    const bit = 1 << (s & 7);
    if (loadByte(dirtyBitmap, bi) & bit) {
      dirty.push(s);
      // Clear bit-by-bit (not fill(0)) so a concurrent markDirty of another
      // sector in the same byte is not wiped after we sampled it.
      if (opts.clear) andByte(dirtyBitmap, bi, ~bit & 0xff);
    }
  }
  const header = 16;
  const out = new Uint8Array(header + dirty.length * (4 + BLK_SECTOR));
  const view = new DataView(out.buffer);
  out[0] = 0x43;
  out[1] = 0x42;
  out[2] = 0x48;
  out[3] = 0x44;
  view.setUint32(4, DISK_OVERLAY_VERSION, true);
  view.setUint32(8, BLK_SECTOR, true);
  view.setUint32(12, dirty.length, true);
  let off = header;
  for (const s of dirty) {
    view.setUint32(off, s >>> 0, true);
    out.set(image.subarray(s * BLK_SECTOR, s * BLK_SECTOR + BLK_SECTOR), off + 4);
    off += 4 + BLK_SECTOR;
  }
  return out;
}

/**
 * Apply a CBHD overlay onto a (usually zeroed) image. Mutates `image`.
 * @param {Uint8Array} image
 * @param {Uint8Array} overlay
 */
export function applyDirtyOverlay(image, overlay) {
  if (overlay.byteLength < 16) throw new Error("blk overlay: truncated header");
  if (overlay[0] !== 0x43 || overlay[1] !== 0x42 || overlay[2] !== 0x48 || overlay[3] !== 0x44) {
    throw new Error("blk overlay: bad magic");
  }
  const view = new DataView(overlay.buffer, overlay.byteOffset, overlay.byteLength);
  const version = view.getUint32(4, true);
  if (version !== DISK_OVERLAY_VERSION) {
    throw new Error(`blk overlay: unsupported version ${version}`);
  }
  const blockSize = view.getUint32(8, true);
  if (blockSize !== BLK_SECTOR) {
    throw new Error(`blk overlay: expected ${BLK_SECTOR}-byte blocks, got ${blockSize}`);
  }
  const count = view.getUint32(12, true);
  const need = 16 + count * (4 + BLK_SECTOR);
  if (overlay.byteLength < need) throw new Error("blk overlay: truncated body");
  let off = 16;
  for (let i = 0; i < count; i++) {
    const index = view.getUint32(off, true);
    const pos = index * BLK_SECTOR;
    if (pos + BLK_SECTOR > image.length) {
      throw new Error(`blk overlay: sector ${index} past end of image`);
    }
    image.set(overlay.subarray(off + 4, off + 4 + BLK_SECTOR), pos);
    off += 4 + BLK_SECTOR;
  }
}

/** Bytes needed for a dirty bitmap covering `capacityBytes`. */
export function dirtyBitmapBytes(capacityBytes) {
  const sectors = Math.floor(capacityBytes / BLK_SECTOR);
  return (sectors + 7) >> 3;
}

/**
 * Prepare the shared backing used by the RW virtio-blk state device.
 *
 * The returned dirty bitmap starts empty: `image` is the caller-owned baseline,
 * and saveDisk() journals only guest T_OUT writes made after attachment.  This
 * is what keeps autosaves incremental even when the baseline is populated.
 *
 * @param {ArrayBuffer|SharedArrayBuffer|Uint8Array|null|undefined} image
 * @param {{ stubBytes?: number, maxCopyBytes?: number }} [opts]
 * @returns {{ imageBuffer: SharedArrayBuffer, dirtyBuffer: SharedArrayBuffer, persistable: boolean }}
 */
export function createStateDiskBacking(image, opts = {}) {
  const stubBytes = opts.stubBytes ?? 1024 * 1024;
  const maxCopyBytes = opts.maxCopyBytes ?? STATE_DISK_COPY_MAX_BYTES;

  if (image == null) {
    if (!Number.isSafeInteger(stubBytes) || stubBytes <= 0 || stubBytes % BLK_SECTOR !== 0) {
      throw new RangeError(`state disk stub must be a positive multiple of ${BLK_SECTOR} bytes`);
    }
    const imageBuffer = new SharedArrayBuffer(stubBytes);
    return {
      imageBuffer,
      dirtyBuffer: new SharedArrayBuffer(dirtyBitmapBytes(stubBytes)),
      persistable: false,
    };
  }

  let source;
  let reusable = null;
  if (image instanceof SharedArrayBuffer) {
    source = new Uint8Array(image);
    reusable = image;
  } else if (image instanceof Uint8Array) {
    source = image;
    if (
      image.buffer instanceof SharedArrayBuffer &&
      image.byteOffset === 0 &&
      image.byteLength === image.buffer.byteLength
    ) {
      reusable = image.buffer;
    }
  } else if (image instanceof ArrayBuffer) {
    source = new Uint8Array(image);
  } else {
    throw new TypeError("stateDisk.image must be an ArrayBuffer, SharedArrayBuffer, or Uint8Array");
  }

  if (source.byteLength === 0 || source.byteLength % BLK_SECTOR !== 0) {
    throw new RangeError(`stateDisk.image must be a non-empty multiple of ${BLK_SECTOR} bytes`);
  }

  let imageBuffer = reusable;
  if (!imageBuffer) {
    if (source.byteLength > maxCopyBytes) {
      throw new RangeError(
        `stateDisk.image is ${source.byteLength} bytes; images larger than ${maxCopyBytes} bytes must be supplied as a full SharedArrayBuffer to avoid duplicating the disk`,
      );
    }
    imageBuffer = new SharedArrayBuffer(source.byteLength);
    new Uint8Array(imageBuffer).set(source);
  }

  return {
    imageBuffer,
    dirtyBuffer: new SharedArrayBuffer(dirtyBitmapBytes(imageBuffer.byteLength)),
    persistable: true,
  };
}

/**
 * Mark sectors [sector, sector+count) dirty in a bitmap.
 * @param {Uint8Array} dirtyBitmap
 * @param {number} sector
 * @param {number} count
 */
export function markDirty(dirtyBitmap, sector, count) {
  for (let i = 0; i < count; i++) {
    const s = sector + i;
    orByte(dirtyBitmap, s >> 3, 1 << (s & 7));
  }
}

/** @param {Uint8Array} dirtyBitmap */
export function dirtySectorCount(dirtyBitmap) {
  let n = 0;
  for (let i = 0; i < dirtyBitmap.length; i++) {
    let b = loadByte(dirtyBitmap, i);
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}
