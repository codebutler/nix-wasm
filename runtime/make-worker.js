// js/make-worker.js — create a module Worker that actually loads under
// cross-origin isolation on GitHub Pages.
//
// Prod (GitHub Pages) can't send COOP/COEP headers, so isolation is provided by
// `coi-serviceworker.js`, which intercepts fetches and re-serves them with COEP.
// Chromium then BLOCKS a top-level module-worker *script* fetched through that
// reconstructed response with `net::ERR_BLOCKED_BY_RESPONSE` — silently breaking
// every wasm worker in production (the Terminal's WASI bridge, Butler's web-llm).
// The worker never starts; you only get a detail-less `ErrorEvent`.
//
// The block is specific to the top-level worker *script*: a module worker's
// `import`s are served fine by the SW, and Blob-URL workers bypass the SW
// entirely while still inheriting cross-origin isolation (so SharedArrayBuffer +
// Atomics work). So when a service worker controls the page, we load the worker
// from a tiny Blob shim that just `import`s the real worker by absolute URL. Off
// the SW path (the dev-server sends real headers; `bun test` has no SW) nothing
// changes — the worker is created directly.

/**
 * @param {string | URL} url absolute URL of the real `{ type: "module" }` worker
 * @returns {Worker}
 */
export function createModuleWorker(url) {
  const swControlled = typeof navigator !== "undefined" && navigator.serviceWorker?.controller;
  if (!swControlled) return new Worker(url, { type: "module" });

  // Blob shim: a module whose only job is to import the real worker. Its imports
  // (host.js, futex.js, …) are normal subresource fetches the SW serves fine.
  const boot = `import ${JSON.stringify(String(url))};`;
  const blobUrl = URL.createObjectURL(new Blob([boot], { type: "text/javascript" }));
  const worker = new Worker(blobUrl, { type: "module" });
  // The blob URL is only needed until the worker script has been fetched.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  return worker;
}
