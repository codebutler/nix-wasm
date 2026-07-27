import { describe, it, expect } from "bun:test";
import {
  BLK_SECTOR,
  packDirtySectors,
  applyDirtyOverlay,
  dirtyBitmapBytes,
  markDirty,
  dirtySectorCount,
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
});
