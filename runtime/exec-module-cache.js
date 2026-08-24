// Software-MMU exec modules expand substantially during instrumentation and
// V8 compilation. The cross-worker cache exists to avoid repeatedly paying
// that cost for large, shared executables (busybox, nix, clang, wasm-ld), not
// for one-shot configure probes. Keeping every tiny conftest module alive while
// clang is resident can exhaust the host even though the cache's entry count is
// bounded.
//
// Very large executables also bypass the pass's inline translation entirely.
// Clang (57 MiB) and wasm-ld (32 MiB) otherwise push process RSS past 25 GiB
// under the checked software MMU, exceeding the CI/browser memory envelope.
// The existing helper-call translation is smaller and keeps
// identical MMU/fault semantics at the cost of execution speed.
export const EXEC_MODULE_CACHE_MIN_BYTES = 1024 * 1024;
export const EXEC_MODULE_FORCE_HELPER_MIN_BYTES = 24 * 1024 * 1024;

export function shouldCacheExecModule(byteLength) {
  return Number.isSafeInteger(byteLength) && byteLength >= EXEC_MODULE_CACHE_MIN_BYTES;
}

export function shouldForceHelperExecModule(byteLength) {
  return Number.isSafeInteger(byteLength) && byteLength >= EXEC_MODULE_FORCE_HELPER_MIN_BYTES;
}
