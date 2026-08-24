// Software-MMU exec modules expand substantially during instrumentation and
// V8 compilation. The cross-worker cache exists to avoid repeatedly paying
// that cost for large, shared executables (busybox, nix, clang, wasm-ld), not
// for one-shot configure probes. Keeping every tiny conftest module alive while
// clang is resident can exhaust the host even though the cache's entry count is
// bounded.
export const EXEC_MODULE_CACHE_MIN_BYTES = 1024 * 1024;

export function shouldCacheExecModule(byteLength) {
  return Number.isSafeInteger(byteLength) && byteLength >= EXEC_MODULE_CACHE_MIN_BYTES;
}
