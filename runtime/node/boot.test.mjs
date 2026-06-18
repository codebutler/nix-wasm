// boot.test.mjs — boots the real guest to a shell from Node using the shims,
// MemVfs, and the high-level bootNixSystem. node:test (NOT bun test).
//
// Artifact source:
//   Default (local dev): pc's vendored set at file:///home/vbvntv/Code/pc/vendor/linux-wasm/
//   Override: LINUX_WASM_ARTIFACTS env var (absolute file:// or http(s):// URL, trailing slash optional)
//   CI:       set LINUX_WASM_ARTIFACTS to the dir produced by `nix build .#vmlinux .#wasm-initramfs .#wasm-store-manifest`
//
// The local-dev default is a convenience — CI must always set LINUX_WASM_ARTIFACTS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../index.js";
import { MemVfs } from "../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || "file:///home/vbvntv/Code/pc/vendor/linux-wasm/";

test("boots busybox to a shell prompt from Node", { timeout: 120000 }, async () => {
  installWebShims();
  const vfs = MemVfs.from({ Home: {} });
  const handle = await bootNixSystem({
    vfs,
    baseUrl: ARTIFACTS,
    nix: false, // busybox-only: fast, no /nix closure needed for the smoke
  });
  let out = "";
  handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
  // wait up to 90s for a shell prompt
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !/[#$]\s*$/.test(out.trimEnd())) {
    if (/panic/i.test(out)) throw new Error("KERNEL_PANIC:\n" + out);
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(out, /[#$]\s*$/, "expected a shell prompt");
  handle.console(0).write("echo NIXWASM_OK\n");
  const t1 = Date.now();
  while (Date.now() - t1 < 10000 && !/NIXWASM_OK/.test(out)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.match(out, /NIXWASM_OK/);
  handle.kill();
  await terminateAllWorkers();
});
