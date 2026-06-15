/* misc-stubs.c — #139 fail-soft stubs for the wasm32 Nix port.
 *
 * Three symbols Nix's link pulls in but a local in-guest `nix build` never
 * exercises, so they are stubbed rather than provided by a real library:
 *   - _Unwind_Backtrace   — libunwind backtrace (diagnostics only).
 *   - lzma_stream_encoder_mt / lzma_cputhreads — liblzma's MULTITHREADED xz
 *     encoder. Our liblzma is built `--disable-threads` (the threaded path
 *     pulls pthread/static-init code the NOMMU guest traps on at startup), so
 *     the mt API is absent; single-threaded xz (the path Nix actually uses) is
 *     unaffected.
 * Compiled into libmiscstub.a and linked last (see build-nix-wasm.sh). */
int _Unwind_Backtrace(void *fn, void *arg) {
  (void) fn;
  (void) arg;
  return 0;
}
int lzma_stream_encoder_mt(void *strm, const void *options) {
  (void) strm;
  (void) options;
  return 11; /* LZMA_OPTIONS_ERROR */
}
unsigned lzma_cputhreads(void) { return 1; }
