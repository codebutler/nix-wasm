// index.js — public API of the linux-wasm runtime.
export { bootLinux, HVC_CONSOLES, DEFAULT_CMDLINE } from "./boot.ts";
export { bootNixSystem } from "./boot-nix-system.ts";
export { ENGINE_ABI } from "./abi.js";
export { makeConsoleSession } from "./session.ts";
export { createNixCacheExport } from "./nix-cache.ts";
export { createNixStore } from "./nix-store.ts";
export { MemVfs } from "./ninep/mem-vfs.ts";
export {
  BLK_SECTOR,
  packDirtySectors,
  applyDirtyOverlay,
  dirtyBitmapBytes,
} from "./virtio/blk-disk.ts";
