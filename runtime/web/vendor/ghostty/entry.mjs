// ghostty-web — Ghostty's VT100 parser (Zig → WASM) wrapped in an
// xterm.js-API-compatible Canvas terminal. The optional second renderer for
// the Terminal app (xterm.js stays the default); selected from the "+" menu.
//
// The ESM build INLINES the WASM as a base64 data: URL, so the bundled
// ghostty.mjs is fully self-contained — no sidecar .wasm fetch, no CDN, COEP-
// safe. `init()` (async, idempotent) compiles that WASM once before any
// Terminal is constructed. MIT. Bundled by vendor/build.sh.
export { init, Terminal, FitAddon } from "ghostty-web";
