// task2.1-abi-v2-scaffold.test.mjs — Task 2.1: ABI v2 scaffolding.
//
// Stands up the memory-lifecycle ABI (wasm_user_mem_create/grow/free), the
// per-pid `userMems` registry, and the pid-keyed resolver with a SHARED
// fallback — WITHOUT yet wiring private memory into user instantiation, so boot
// is unaffected (the registry stays empty until the kernel calls create, which
// is T2.2).
//
// Asserts:
//   (a) WASM_HOSTBRIDGE_ABI === 2 (bumped from 1);
//   (b) the bridge exposes wasm_user_mem_{create,grow,free};
//   (c) create grows the registry (mints + registers a per-pid memory) and the
//       pid-keyed resolver then returns THAT memory's buffer; an un-registered
//       pid falls back to the SHARED kernel buffer (Task 1 behavior preserved);
//   (d) grow invokes memory.grow on the per-pid memory and returns the new page
//       count; free shrinks the registry back to baseline;
//   (e) the existing boot still reaches a shell — zero behavior change — with
//       the extra (currently unused) lifecycle imports provided to vmlinux and
//       the resolver swapped for the pid-keyed-with-fallback variant.
//
// (e) gates on the nix-built artifacts being present (LINUX_WASM_ARTIFACTS or
// runtime/web/artifacts symlink): it SKIPs, not fails, when absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WASM_HOSTBRIDGE_ABI, makeHostBridge } from "../../hostbridge.js";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const vmlinuxPath = fileURLToPath(new URL("vmlinux.wasm", ARTIFACTS));
const haveArtifacts = !ARTIFACTS.startsWith("file:") || existsSync(vmlinuxPath);
const skipArtifacts = haveArtifacts
  ? false
  : "set LINUX_WASM_ARTIFACTS or symlink runtime/web/artifacts to a `nix build` output";

// (a) ABI is AT LEAST 2 — the memory-lifecycle ABI (create/grow/free) is present.
// Pinned to 2 when this milestone landed; Phase-2 fork bumps it to 3 (adds
// wasm_user_mem_dup), so assert the floor the T2.1 scaffold actually requires.
test("WASM_HOSTBRIDGE_ABI is at least 2 (memory-lifecycle ABI)", () => {
  assert.ok(WASM_HOSTBRIDGE_ABI >= 2, `expected ABI >= 2, got ${WASM_HOSTBRIDGE_ABI}`);
});

// (b)+(c)+(d) drive the lifecycle ops + the pid-keyed resolver directly. This
// models the worker's wiring: a `userMems` Map, a `mintUserMem` callback (the
// real one bounces to the main thread; here we mint inline), and the resolver
// `userMems.get(pid)?.memory ?? sharedMemory`.
test("wasm_user_mem_create/grow/free drive the per-pid registry; resolver falls back to shared", () => {
  const shared = new WebAssembly.Memory({ initial: 4 }); // the kernel/shared buffer
  const userMems = new Map();
  // mintUserMem stands in for the main-thread mint+transfer; record the args so
  // we can assert create requested the right initial page count.
  const mintCalls = [];
  const mintUserMem = (pid, initPages) => {
    mintCalls.push({ pid, initPages });
    return new WebAssembly.Memory({ initial: initPages, maximum: initPages + 1000, shared: false });
  };
  const resolveMem = (pid) => {
    const e = userMems.get(pid);
    const buf = e ? e.memory.buffer : shared.buffer;
    return { u8: () => new Uint8Array(buf) };
  };
  const bridge = makeHostBridge(shared, resolveMem, { userMems, mintUserMem });

  assert.equal(typeof bridge.wasm_user_mem_create, "function", "exposes wasm_user_mem_create");
  assert.equal(typeof bridge.wasm_user_mem_grow, "function", "exposes wasm_user_mem_grow");
  assert.equal(typeof bridge.wasm_user_mem_free, "function", "exposes wasm_user_mem_free");

  // Before create: pid resolves to the SHARED buffer (Task 1 fallback).
  assert.equal(resolveMem(42).u8().buffer, shared.buffer, "unregistered pid -> shared buffer");
  assert.equal(userMems.size, 0, "registry starts empty");

  // create: 0 = ok, the registry gains an entry, mint was asked for the pages.
  assert.equal(bridge.wasm_user_mem_create(42, 8), 0, "create returns 0 (ok)");
  assert.equal(userMems.size, 1, "create grows the registry");
  assert.deepEqual(mintCalls, [{ pid: 42, initPages: 8 }], "create mints with init_pages");
  const priv = userMems.get(42).memory;
  assert.ok(priv instanceof WebAssembly.Memory, "registry holds a WebAssembly.Memory");
  assert.notEqual(priv.buffer, shared.buffer, "the per-pid memory is NOT the shared buffer");

  // resolver now returns the per-pid buffer for pid 42, still shared for others.
  assert.equal(resolveMem(42).u8().buffer, priv.buffer, "registered pid -> per-pid buffer");
  assert.equal(resolveMem(99).u8().buffer, shared.buffer, "other pid still -> shared buffer");

  // grow: invokes memory.grow on the per-pid memory, returns the NEW page count.
  const before = priv.buffer.byteLength / 65536;
  const newPages = bridge.wasm_user_mem_grow(42, 3);
  assert.equal(newPages, before + 3, "grow returns the new page count (old + delta)");
  assert.equal(priv.buffer.byteLength / 65536, before + 3, "the per-pid memory actually grew");

  // grow on an unknown pid fails loud (-1), no mint.
  assert.equal(bridge.wasm_user_mem_grow(7777, 1), -1, "grow on unknown pid -> -1");

  // free: drops the registry entry; the pid falls back to shared again.
  bridge.wasm_user_mem_free(42);
  assert.equal(userMems.size, 0, "free shrinks the registry back to baseline");
  assert.equal(resolveMem(42).u8().buffer, shared.buffer, "freed pid -> shared buffer again");
});

// (e) the existing boot still reaches a shell — the runtime now PROVIDES the
// three extra lifecycle imports (unused by the current vmlinux, which doesn't
// declare them yet — that's T2.2) and uses the pid-keyed resolver. Both must be
// behaviorally a no-op: providing unused imports is fine, and the registry is
// empty so every pid resolves to the shared buffer exactly as before.
test(
  "guest still boots to a shell with the extra lifecycle imports + pid-keyed resolver",
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
    handle.console(0).write("echo ABI_V2_SCAFFOLD_OK\n");
    const t1 = Date.now();
    while (Date.now() - t1 < 10000 && !/ABI_V2_SCAFFOLD_OK/.test(out)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(out, /ABI_V2_SCAFFOLD_OK/, "command runs over the pid-keyed resolver");
    handle.kill();
    await terminateAllWorkers();
  },
);
