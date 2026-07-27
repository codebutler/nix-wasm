// blk-disk.js — sparse dirty-sector journal for the RW state virtio-blk.
//
// Same CBHD wire format Machines uses (pc js/apps/machines/disk-overlay.ts):
//   magic "CBHD", version u32=1, blockSize u32, count u32,
//   entries { u32 blockIndex; u8[blockSize] data } × count
//
// Sector size is always 512 (virtio-blk). Pure + bun-testable.
export const BLK_SECTOR = 512;
export const DISK_OVERLAY_MAGIC = "CBHD";
export const DISK_OVERLAY_VERSION = 1;

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
    if (dirtyBitmap[s >> 3] & (1 << (s & 7))) dirty.push(s);
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
  if (opts.clear) dirtyBitmap.fill(0);
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
 * Mark sectors [sector, sector+count) dirty in a bitmap.
 * @param {Uint8Array} dirtyBitmap
 * @param {number} sector
 * @param {number} count
 */
export function markDirty(dirtyBitmap, sector, count) {
  for (let i = 0; i < count; i++) {
    const s = sector + i;
    dirtyBitmap[s >> 3] |= 1 << (s & 7);
  }
}

/** @param {Uint8Array} dirtyBitmap */
export function dirtySectorCount(dirtyBitmap) {
  let n = 0;
  for (let i = 0; i < dirtyBitmap.length; i++) {
    let b = dirtyBitmap[i];
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}
