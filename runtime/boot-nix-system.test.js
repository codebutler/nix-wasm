// @ts-nocheck
import { test, expect } from "bun:test";
import { bootNixSystem } from "./boot-nix-system.js";

test("bytes-mode: vmlinux/initramfs become blob URLs; nixCacheBaseUrl drives the cache", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return { ok: true };
  };
  await bootNixSystem({
    vfs: {},
    vmlinux: new Uint8Array([0, 1, 2]),
    initramfs: new Uint8Array([3, 4, 5]),
    squashfs: new ArrayBuffer(8),
    nixCacheBaseUrl: "https://example.test/nc",
    _bootLinux,
  });
  expect(captured.vmlinuxUrl.startsWith("blob:")).toBe(true);
  expect(captured.initrdUrl.startsWith("blob:")).toBe(true);
  expect(captured.squashfs.byteLength).toBe(8);
  expect(typeof captured.nixCache.readBlob).toBe("function");
});

test("baseUrl-mode still derives artifact URLs from baseUrl", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return {};
  };
  await bootNixSystem({
    vfs: {},
    baseUrl: "https://x.test/art",
    squashfs: new ArrayBuffer(1),
    _bootLinux,
  });
  expect(captured.vmlinuxUrl).toBe("https://x.test/art/vmlinux.wasm");
  expect(captured.initrdUrl).toBe("https://x.test/art/initramfs.cpio.gz");
});

test("nix:false skips squashfs + nixCache", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return {};
  };
  await bootNixSystem({
    vfs: {},
    vmlinux: new Uint8Array([1]),
    initramfs: new Uint8Array([2]),
    nix: false,
    _bootLinux,
  });
  expect(captured.squashfs).toBeUndefined();
  expect(captured.nixCache).toBeUndefined();
});
