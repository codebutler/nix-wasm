// exec-reject-abi.test.js — pins the load-bearing wasm/JS semantics behind the
// #179 exec-reject hardening AND behind its "this is NOT an ENGINE_ABI bump"
// claim (see abi.js's NOT-A-BUMP note).
//
// THE BUG (#179): an exec'd image the host cannot run — e.g. one the software-MMU
// instrumentation pass refuses because it exports no __get_tls_base — made
// kernel-worker.js's `wasm_load_executable` THROW. The throw escaped into the
// kernel's own wasm frames and only landed later, contextless, in
// raise_exception() -> make_task_dead(), which panics: "Aiee, killing interrupt
// handler!". One unsupported user binary took down the whole guest.
//
// THE FIX: `wasm_load_executable` returns a status instead (0 = loaded, nonzero =
// rejected) and the kernel's start_thread() kills just the execing task
// (kernel.nix postPatch). Changing an existing import's RESULT type — rather than
// adding an import — is what keeps the wire compatible in both directions, so the
// fix ships without raising the published image's minEngine. That argument rests
// entirely on the two coercion rules below, so pin them:
//
//   1. new kernel + OLD engine: the kernel declares the import `() -> i32` while
//      the old JS returns nothing. ToWebAssemblyValue(undefined, i32) must be 0 —
//      i.e. "loaded", exactly the pre-fix behaviour.
//   2. OLD kernel + new engine: the kernel declares the import `() -> ()` while
//      the new JS returns a number. wasm must DISCARD it rather than trap — again
//      exactly the pre-fix behaviour.
//
// If either rule ever changed, the fix would silently turn into an incompatible
// ABI change and strand deployed engines/images. The modules are hand-encoded
// here (a few dozen bytes each) so the test needs no wasm toolchain.
import { describe, test, expect } from "bun:test";

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const name = (s) => [s.length, ...enc(s)];
const section = (id, body) => [id, body.length, ...body];
const HEADER = [...enc("\0asm"), 0x01, 0x00, 0x00, 0x00]; // magic + version 1

/** A module importing `env.load` and re-exporting it as `run`. `result`: with or
 *  without an i32 result. */
function moduleImporting({ result }) {
  const functype = result ? [0x60, 0x00, 0x01, 0x7f] : [0x60, 0x00, 0x00];
  return Uint8Array.from([
    ...HEADER,
    ...section(1, [0x01, ...functype]), // type: () -> i32  |  () -> ()
    ...section(2, [0x01, ...name("env"), ...name("load"), 0x00, 0x00]), // import env.load
    ...section(3, [0x01, 0x00]), // one defined func, same type
    ...section(7, [0x01, ...name("run"), 0x00, 0x01]), // export "run" = func 1
    ...section(10, [0x01, 0x04, 0x00, 0x10, 0x00, 0x0b]), // body: call 0; end
  ]);
}

const run = (bytes, load) =>
  new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { load } }).exports.run();

describe("#179 exec-reject wire compatibility", () => {
  test("rule 1: an i32-result import returning `undefined` reads as 0 (= image loaded)", () => {
    // A NEW kernel (declares `extern int wasm_load_executable`) running on an OLD
    // engine whose wasm_load_executable is void. It must NOT be read as a
    // rejection, or every exec would die on a stale engine.
    expect(run(moduleImporting({ result: true }), () => undefined)).toBe(0);
  });

  test("rule 1b: the same import returning a nonzero status reads as that status", () => {
    // The actual fix path: the engine says "rejected" and the kernel sees it.
    expect(run(moduleImporting({ result: true }), () => 1)).toBe(1);
    expect(run(moduleImporting({ result: true }), () => 0)).toBe(0);
  });

  test("rule 2: a void-result import DISCARDS a returned value instead of trapping", () => {
    // An OLD kernel (declares `extern void wasm_load_executable`) running on the
    // NEW engine, which now returns 0/1. Must be a silent no-op.
    expect(() => run(moduleImporting({ result: false }), () => 1)).not.toThrow();
    expect(() => run(moduleImporting({ result: false }), () => 0)).not.toThrow();
  });
});
