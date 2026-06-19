// hostbridge.test.mjs — Phase 1 (Task 1) host-bridge uaccess indirection.
//
// Asserts:
//   (a) the cross-repo ABI is pinned: WASM_HOSTBRIDGE_ABI === 1, and the
//       bridge's copy_to/from/strncpy behave over a (shared) buffer resolver;
//   (b) the kernel module statically IMPORTS the three host-bridge functions
//       wasm_user_copy_to/_from/_strncpy (static WebAssembly.Module.imports scan);
//   (c) the existing boot still reaches a shell unchanged (no behavior change).
//
// (b)/(c) gate on the nix-built artifacts being present (LINUX_WASM_ARTIFACTS
// or runtime/web/artifacts symlink), matching boot.test.mjs — they SKIP, not
// fail, when artifacts are absent (prerequisite gate only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WASM_HOSTBRIDGE_ABI, makeHostBridge } from "../hostbridge.js";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../index.js";
import { MemVfs } from "../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const vmlinuxPath = fileURLToPath(new URL("vmlinux.wasm", ARTIFACTS));
const haveArtifacts = !ARTIFACTS.startsWith("file:") || existsSync(vmlinuxPath);
const skipArtifacts = haveArtifacts
  ? false
  : "set LINUX_WASM_ARTIFACTS or symlink runtime/web/artifacts to a `nix build` output";

// (a) ABI + bridge semantics — pure unit test, no artifacts needed.
test("WASM_HOSTBRIDGE_ABI is pinned to 1", () => {
  assert.equal(WASM_HOSTBRIDGE_ABI, 1);
});

test("makeHostBridge copy_to/from/strncpy operate over the resolved buffer", () => {
  // Task 1: kernel buffer === user buffer (shared). Model that with one buffer.
  const mem = new WebAssembly.Memory({ initial: 1 }); // 64 KiB
  const bridge = makeHostBridge(mem, (_pid) => ({ u8: () => new Uint8Array(mem.buffer) }));
  const u8 = () => new Uint8Array(mem.buffer);

  // copy_to: kernel(src) -> user(dst); returns bytes NOT copied (0 on success).
  u8().set([1, 2, 3, 4], 100); // "kernel" source bytes
  assert.equal(bridge.wasm_user_copy_to(7 /*pid ignored*/, 200, 100, 4), 0);
  assert.deepEqual([...u8().subarray(200, 204)], [1, 2, 3, 4]);

  // copy_from: user(src) -> kernel(dst); returns bytes NOT copied (0).
  u8().set([9, 8, 7], 300);
  assert.equal(bridge.wasm_user_copy_from(7, 400, 300, 3), 0);
  assert.deepEqual([...u8().subarray(400, 403)], [9, 8, 7]);

  // strncpy: bounded NUL-terminated copy; returns length copied (excl. NUL).
  u8().set([0x68, 0x69, 0x00, 0x78], 500); // "hi\0x"
  assert.equal(bridge.wasm_user_strncpy(7, 600, 500, 16), 2);
  assert.deepEqual([...u8().subarray(600, 603)], [0x68, 0x69, 0x00]);

  // strncpy with no NUL within the limit returns `count`.
  u8().set([0x61, 0x61, 0x61, 0x61], 700); // "aaaa", no NUL
  assert.equal(bridge.wasm_user_strncpy(7, 800, 700, 3), 3);
});

// (b) static import scan of the real kernel artifact.
test(
  "vmlinux.wasm statically imports the host-bridge functions",
  { skip: skipArtifacts },
  () => {
    const mod = new WebAssembly.Module(readFileSync(vmlinuxPath));
    const names = new Set(WebAssembly.Module.imports(mod).map((i) => i.name));
    for (const fn of ["wasm_user_copy_to", "wasm_user_copy_from", "wasm_user_strncpy"]) {
      assert.ok(names.has(fn), `kernel must import ${fn} (host-bridge ABI v1)`);
    }
  },
);

// (c) the existing boot still reaches a shell — zero behavior change.
test(
  "guest still boots to a shell prompt with the host-bridge wired",
  { timeout: 120000, skip: skipArtifacts },
  async () => {
    installWebShims();
    const vfs = MemVfs.from({ Home: {} });
    const handle = await bootNixSystem({
      vfs,
      baseUrl: ARTIFACTS,
      nix: false, // busybox-only: fast, no /nix closure needed for the smoke
    });
    let out = "";
    handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
    const t0 = Date.now();
    while (Date.now() - t0 < 90000 && !/[#$]\s*$/.test(out.trimEnd())) {
      if (/panic/i.test(out)) throw new Error("KERNEL_PANIC:\n" + out);
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.match(out, /[#$]\s*$/, "expected a shell prompt");
    handle.console(0).write("echo HOSTBRIDGE_BOOT_OK\n");
    const t1 = Date.now();
    while (Date.now() - t1 < 10000 && !/HOSTBRIDGE_BOOT_OK/.test(out)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(out, /HOSTBRIDGE_BOOT_OK/);
    handle.kill();
    await terminateAllWorkers();
  },
);
