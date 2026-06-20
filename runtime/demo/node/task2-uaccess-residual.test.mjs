// task2-uaccess-residual.test.mjs — Task 2.0: close the residual direct-deref
// uaccess holes (__clear_user, strnlen_user, create_wasm_tables auxv memcpy) by
// routing them through the host-bridge. No behavior change on the shared
// resolver; the imports must be present so the Task 2 memory split can resolve
// them per-pid.
//
// Asserts:
//   (a) the bridge gains wasm_user_memzero and it zero-fills the resolved buffer
//       (ABI still pinned to 1 — the bump to 2 belongs to Task 2.1, not here);
//   (b) the kernel module statically IMPORTS wasm_user_memzero (it no longer
//       memset()s a user pointer directly);
//   (c) the existing boot still reaches a shell AND user-string syscalls work:
//       running a command exercises strnlen_user on every execve path arg, and
//       exec's create_wasm_tables copies argv/env + the auxv via the bridge.
//       (RED before the patch: __clear_user/strnlen_user/auxv deref the user
//       pointer directly — works only while user==kernel; this test pins the
//       routing so it survives the split.)
//
// (b)/(c) gate on the nix-built artifacts being present (LINUX_WASM_ARTIFACTS or
// runtime/web/artifacts symlink): they SKIP, not fail, when artifacts are
// absent, matching hostbridge.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

// (a) the memzero op (forward-declared at v1 in T2.0) zero-fills correctly. The
// ABI itself was bumped 1 → 2 in Task 2.1 (the memory-lifecycle ABI); memzero's
// semantics this file pins are unchanged across that bump.
test("WASM_HOSTBRIDGE_ABI is at least 2 (memzero forward-declared at v1, bumped in T2.1)", () => {
  assert.ok(WASM_HOSTBRIDGE_ABI >= 2, `expected ABI >= 2, got ${WASM_HOSTBRIDGE_ABI}`);
});

test("makeHostBridge.wasm_user_memzero zero-fills the resolved buffer", () => {
  const mem = new WebAssembly.Memory({ initial: 1 }); // 64 KiB
  const bridge = makeHostBridge(mem, (_pid) => ({ u8: () => new Uint8Array(mem.buffer) }));
  const u8 = () => new Uint8Array(mem.buffer);

  assert.equal(typeof bridge.wasm_user_memzero, "function", "bridge must expose wasm_user_memzero");

  // Pre-fill a region, zero a sub-range, assert exactly that range is cleared
  // and the surrounding bytes are untouched. Returns bytes NOT zeroed (0 = ok).
  u8().fill(0xaa, 100, 120);
  assert.equal(bridge.wasm_user_memzero(7 /*pid ignored*/, 104, 8), 0);
  assert.deepEqual([...u8().subarray(100, 120)], [
    0xaa, 0xaa, 0xaa, 0xaa, 0, 0, 0, 0, 0, 0, 0, 0, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
  ]);
});

// (b) static import scan of the real kernel artifact — the residual sites no
// longer deref a user pointer, so the kernel imports wasm_user_memzero (and
// still imports the Task 1 trio).
test(
  "vmlinux.wasm statically imports wasm_user_memzero (residual holes closed)",
  { skip: skipArtifacts },
  () => {
    const mod = new WebAssembly.Module(readFileSync(vmlinuxPath));
    const names = new Set(WebAssembly.Module.imports(mod).map((i) => i.name));
    for (const fn of [
      "wasm_user_copy_to",
      "wasm_user_copy_from",
      "wasm_user_strncpy",
      "wasm_user_memzero",
    ]) {
      assert.ok(names.has(fn), `kernel must import ${fn} (host-bridge, Task 2.0)`);
    }
  },
);

// (c) boot to a shell unchanged AND user-string syscalls (strnlen_user on the
// execve path; create_wasm_tables auxv via copy_to_user) still work.
test(
  "guest boots to a shell and runs commands over the bridged uaccess",
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

    // Running a command spawns a fresh exec: create_wasm_tables builds argv/env
    // + the auxv (now via copy_to_user, not a raw memcpy), and every path arg is
    // measured with strnlen_user. A distinctive multi-arg echo proves the round
    // trip end to end.
    handle.console(0).write("echo T20_UACCESS_RESIDUAL_OK alpha beta\n");
    const t1 = Date.now();
    while (Date.now() - t1 < 15000 && !/T20_UACCESS_RESIDUAL_OK alpha beta/.test(out)) {
      if (/panic/i.test(out)) throw new Error("KERNEL_PANIC:\n" + out);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(
      out,
      /T20_UACCESS_RESIDUAL_OK alpha beta/,
      "exec argv/auxv + strnlen_user round trip over the bridge",
    );

    // Hole #4 (futex): a multi-stage pipeline spawns processes whose musl
    // locking + spawn synchronization drive arch_futex_atomic_op_inuser /
    // futex_atomic_cmpxchg_inatomic — now a get_user/put_user RMW over the
    // bridge, not __atomic_* on the raw user pointer. If the bridged futex
    // RMW were wrong, the pipeline would wedge or miscount; assert the exact
    // result. (seq+wc exercise spawn + waitpid + per-process musl init locks.)
    handle.console(0).write("seq 1 50 | wc -l | sed 's/^ *//'\n");
    const t2 = Date.now();
    while (Date.now() - t2 < 20000 && !/(^|\n)50(\r|\n)/.test(out)) {
      if (/panic/i.test(out)) throw new Error("KERNEL_PANIC:\n" + out);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(
      out,
      /(^|\n)50(\r|\n)/,
      "futex-backed multi-process pipeline completes correctly over the bridged RMW",
    );
    handle.kill();
    await terminateAllWorkers();
  },
);
