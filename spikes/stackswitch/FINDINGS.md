# WasmFX (core stack-switching) is ONE-SHOT — empirically verified

Engine: Chromium 149.0.7827.0 (Playwright), flag `--js-flags=--experimental-wasm-wasmfx`
(chrome://flags/#enable-experimental-webassembly-stack-switching). Module:
`multishot.wat` — captures a continuation, resumes it once (it suspends), then resumes
the SAME (now-consumed) continuation a second time.

Result:
- NO flag  -> CompileError: "core stack switching not enabled (enable with --experimental-wasm-wasmfx)".
- WITH flag -> module compiles; FIRST resume works (coro suspends to handler);
  SECOND resume -> **RuntimeError: "WasmFX: resuming an invalid continuation"**.

CONCLUSION: WasmFX continuations are one-shot. A continuation resumes exactly once;
the second resume traps. There is no continuation-copy/duplicate primitive
(multi-shot is the open, NOT-adopted ask: WebAssembly/stack-switching#110).

IMPLICATION for fork/vfork: real fork()/vfork() "return twice" == re-entering the
call frame == resuming the captured continuation TWICE == multi-shot. One-shot
WasmFX (and one-shot JSPI) cannot express it. Only asyncify can, because it
serializes the stack into COPYABLE linear memory (Phase 2 used it for exactly this).
=> Stack-switching does NOT enable fork/vfork. The clean-NOMMU design stands:
posix_spawn contract, fork/vfork link-time-absent. The only future that changes this
is MULTI-SHOT continuations shipping (#110), not one-shot stack-switching.
