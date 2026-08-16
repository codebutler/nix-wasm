import { describe, it, expect } from "bun:test";
import {
  BLK_SECTOR,
  packDirtySectors,
  applyDirtyOverlay,
  dirtyBitmapBytes,
  markDirty,
  dirtySectorCount,
  createStateDiskBacking,
  STATE_DISK_COPY_MAX_BYTES,
} from "./blk-disk.js";

describe("blk-disk journal", () => {
  it("packs and applies dirty sectors round-trip", () => {
    const image = new Uint8Array(BLK_SECTOR * 4);
    image[BLK_SECTOR] = 0xab;
    image[BLK_SECTOR * 2 + 1] = 0xcd;
    const bitmap = new Uint8Array(dirtyBitmapBytes(image.length));
    markDirty(bitmap, 1, 1);
    markDirty(bitmap, 2, 1);
    expect(dirtySectorCount(bitmap)).toBe(2);

    const overlay = packDirtySectors(image, bitmap, { clear: true });
    expect(dirtySectorCount(bitmap)).toBe(0);

    const restored = new Uint8Array(image.length);
    applyDirtyOverlay(restored, overlay);
    expect(restored[BLK_SECTOR]).toBe(0xab);
    expect(restored[BLK_SECTOR * 2 + 1]).toBe(0xcd);
    expect(restored[0]).toBe(0);
  });

  it("rejects bad magic", () => {
    const image = new Uint8Array(BLK_SECTOR);
    expect(() => applyDirtyOverlay(image, new Uint8Array(16))).toThrow(/bad magic/);
  });

  it("pack clear is bit-wise (sibling dirty bits in the same byte survive)", () => {
    const image = new Uint8Array(BLK_SECTOR * 16);
    image[0] = 1;
    image[BLK_SECTOR] = 2;
    const bitmap = new Uint8Array(dirtyBitmapBytes(image.length));
    markDirty(bitmap, 0, 1);
    // Simulate mid-pack: sector 0 already sampled+cleared, sector 1 marked after.
    bitmap[0] &= ~1;
    markDirty(bitmap, 1, 1);
    const overlay = packDirtySectors(image, bitmap, { clear: true });
    expect(new DataView(overlay.buffer).getUint32(12, true)).toBe(1);
    expect(dirtySectorCount(bitmap)).toBe(0);
    const restored = new Uint8Array(image.length);
    applyDirtyOverlay(restored, overlay);
    expect(restored[BLK_SECTOR]).toBe(2);
  });

  it("treats a populated attached image as the clean baseline", () => {
    const baseline = new Uint8Array(BLK_SECTOR * 2);
    baseline[0] = 0xaa;
    const backing = createStateDiskBacking(baseline);
    const image = new Uint8Array(backing.imageBuffer);
    const bitmap = new Uint8Array(backing.dirtyBuffer);

    const clean = packDirtySectors(image, bitmap, { clear: true });
    expect(new DataView(clean.buffer).getUint32(12, true)).toBe(0);

    // A dirty sector must be journaled even when its current content is zero.
    image.fill(0, BLK_SECTOR, BLK_SECTOR * 2);
    markDirty(bitmap, 1, 1);
    const changed = packDirtySectors(image, bitmap, { clear: true });
    expect(new DataView(changed.buffer).getUint32(12, true)).toBe(1);
  });

  it("reuses a full aligned SharedArrayBuffer", () => {
    const image = new SharedArrayBuffer(BLK_SECTOR * 2);
    const backing = createStateDiskBacking(image);
    expect(backing.imageBuffer).toBe(image);
    expect(backing.persistable).toBe(true);
  });

  it("copies small compatibility images into shared memory", () => {
    const image = new Uint8Array(BLK_SECTOR * 2);
    image[3] = 0x7a;
    const backing = createStateDiskBacking(image);
    expect(backing.imageBuffer).not.toBe(image.buffer);
    expect(new Uint8Array(backing.imageBuffer)[3]).toBe(0x7a);
  });

  it("rejects a large non-shared image instead of duplicating it", () => {
    const image = new Uint8Array(BLK_SECTOR * 2);
    expect(() => createStateDiskBacking(image, { maxCopyBytes: BLK_SECTOR })).toThrow(
      /must be supplied as a full SharedArrayBuffer/,
    );
    expect(STATE_DISK_COPY_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("rejects misaligned images instead of silently truncating them", () => {
    expect(() => createStateDiskBacking(new Uint8Array(BLK_SECTOR + 1))).toThrow(
      /multiple of 512 bytes/,
    );
  });
});
