// exec-collapse-trap.test.js — guards the load-bearing V8 semantic behind the
// #175 exec/signal-return stack-collapse fix (kernel-worker.js wasm_user_mode_tail
// + the MMU-fork kernel's wasm_collapse export, patches/kernel/0026).
//
// THE BUG (#175): the engine collapsed the user call stack after exec() by having
// the wasm_user_mode_tail host IMPORT `throw new Trap(...)` (a JS exception). A JS
// throw that crosses back into wasm is a FOREIGN exception, and wasm-EH catch_all
// CATCHES foreign exceptions. nix's real-fork child wraps execve in catch (...)
// (compiled to catch_all under -fwasm-exceptions), so the collapse was SWALLOWED
// and stale nix code ran on the freshly-exec'd (busybox) address space -> SIGSEGV.
//
// THE FIX: MMU-fork kernels export wasm_collapse(), a `__builtin_trap()` ->
// `unreachable`. A GENUINE wasm trap is NOT catchable by catch/catch_all, and —
// crucially — it STAYS uncatchable even after propagating back through one or more
// JS import frames (the real stack has two: __wasm_syscall_N and
// wasm_user_mode_tail). This test pins exactly that V8 behavior so a future engine
// change can't silently regress it back to the catchable JS-throw.
//
// The two fixtures are hand-checked wasm (assembled once with binaryen wasm-as,
// exception-handling enabled), embedded as base64 so the test needs no toolchain:
//   kernel:  (func (export "ktrap") unreachable)
//   user:    (func (export "run") (result i32)
//              (try (result i32) (do (call $syscall) (i32.const 0))
//                                 (catch_all (i32.const 1))))
//            — imports env.syscall; returns 1 iff catch_all caught, else the trap
//              escapes (run never returns 0 after a trap).
import { describe, test, expect } from "bun:test";

const KERNEL_WASM = Uint8Array.from(atob("AGFzbQEAAAABBAFgAAADAgEABwkBBWt0cmFwAAAKBQEDAAAL"), (c) =>
  c.charCodeAt(0),
);
const USER_WASM = Uint8Array.from(
  atob("AGFzbQEAAAABCAJgAABgAAF/Ag8BA2VudgdzeXNjYWxsAAADAgEBBwcBA3J1bgABCg4BDAAGfxAAQQAZQQELCw=="),
  (c) => c.charCodeAt(0),
);

const userModule = new WebAssembly.Module(USER_WASM);
const kernelInstance = new WebAssembly.Instance(new WebAssembly.Module(KERNEL_WASM), {});

// Run user.run() with the given env.syscall implementation.
// Returns { caught: true } if the user's catch_all caught, or { escaped: <ctor> }
// if it propagated out to the host (uncatchable).
function runWith(syscall) {
  const inst = new WebAssembly.Instance(userModule, { env: { syscall } });
  try {
    return { caught: inst.exports.run() === 1 };
  } catch (e) {
    return { escaped: e.constructor.name };
  }
}

describe("#175 exec-collapse: wasm trap vs JS throw across a JS import boundary", () => {
  test("a genuine wasm trap (unreachable) is NOT caught by the caller's catch_all", () => {
    // This is the wasm_collapse() path: the kernel export traps; the trap crosses
    // the JS import frame and must escape the user's catch_all uncaught.
    const r = runWith(() => kernelInstance.exports.ktrap());
    expect(r.escaped).toBe("RuntimeError");
    expect(r.caught).toBeUndefined();
  });

  test("a plain JS throw from the import IS caught by catch_all (the old #175 bug)", () => {
    // This is the legacy `throw new Trap(...)` path — a foreign exception that
    // catch_all swallows. Kept as the control that proves the fix is necessary.
    const r = runWith(() => {
      throw new Error("host throw (legacy Trap analog)");
    });
    expect(r.caught).toBe(true);
    expect(r.escaped).toBeUndefined();
  });

  test("a manually-constructed RuntimeError from JS IS caught (only a real trap is uncatchable)", () => {
    // Guards the subtlety that it is trap-ORIGIN, not the RuntimeError type, that
    // makes it uncatchable — so the fix must trap in wasm, never `throw new
    // WebAssembly.RuntimeError()` from JS.
    const r = runWith(() => {
      throw new WebAssembly.RuntimeError("manual");
    });
    expect(r.caught).toBe(true);
  });

  test("catching a real trap's RuntimeError in JS and re-throwing it keeps it uncatchable", () => {
    // The exec-inside-a-signal-handler path: wasm_user_mode_tail catches the
    // collapse RuntimeError at the __libc_handle_signal boundary and re-throws it
    // to continue the collapse. The re-thrown object must STAY uncatchable.
    const r = runWith(() => {
      try {
        kernelInstance.exports.ktrap();
      } catch (e) {
        // Mirror wasm_user_mode_tail's signal-path branch: inspect, then re-throw
        // the SAME object (a genuine signal_return would be handled here instead).
        if (e instanceof WebAssembly.RuntimeError) throw e;
        throw new Error("unexpected non-trap error");
      }
    });
    expect(r.escaped).toBe("RuntimeError");
    expect(r.caught).toBeUndefined();
  });
});
