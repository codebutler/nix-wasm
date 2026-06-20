// web-shims.mjs — install the browser globals the linux-wasm runtime expects
// (Worker over node:worker_threads, fetch over file://) so js/linux/boot.js runs
// unchanged under Node. Side-effect import installs everything; explicit
// installFetchShim() is used by worker-bootstrap.mjs.
import { Worker as NodeWorker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BOOTSTRAP = new URL("./worker-bootstrap.mjs", import.meta.url);

// Registry of all live WebWorker instances so terminateAllWorkers() can sweep them.
const _liveWorkers = new Set();

// boot.js → make-worker.js calls `new Worker(url, {type:"module"})`; we spawn
// worker-bootstrap.mjs which installs a `self` shim then imports the real worker.
class WebWorker {
  constructor(url /* , _opts */) {
    this.onmessage = null;
    this.onmessageerror = null;
    this.onerror = null;
    this._w = new NodeWorker(fileURLToPath(BOOTSTRAP), {
      workerData: { realUrl: String(url) },
    });
    this._w.on("message", (data) => this.onmessage?.({ data }));
    this._w.on("messageerror", (e) => this.onmessageerror?.(e));
    this._w.on("error", (err) =>
      this.onerror?.({
        message: err?.message ?? String(err),
        filename: "",
        lineno: 0,
        colno: 0,
        error: err,
      }),
    );
    _liveWorkers.add(this);
  }
  // Host posts Module + shared Memory + SAB arrays — all cloneable, no transfer.
  postMessage(msg, transfer) {
    this._w.postMessage(msg, transfer);
  }
  terminate() {
    _liveWorkers.delete(this);
    return this._w.terminate();
  }
}
export { WebWorker };

/**
 * Terminate all live WebWorker instances and clear the registry.
 * Returns a Promise that resolves when all workers have exited.
 * Call this after handle.kill() to ensure the Node process can exit.
 */
export function terminateAllWorkers() {
  const promises = [..._liveWorkers].map((w) => w.terminate());
  _liveWorkers.clear();
  return Promise.all(promises);
}

/**
 * The number of live Web Workers (kernel CPUs + per-task runners). Used by the
 * fork stress test to assert task workers are reclaimed after their tasks exit
 * (no per-fork worker leak). A node Worker is removed from `_liveWorkers` only on
 * terminate(), which the host calls from kill_task when a task is reaped.
 */
export function liveWorkerCount() {
  return _liveWorkers.size;
}

export function installFetchShim() {
  if (globalThis.__fileFetchInstalled) return;
  const native = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? input?.href ?? String(input));
    if (url.startsWith("file:")) return fileResponse(url);
    return native(input, init);
  };
  globalThis.__fileFetchInstalled = true;
}

async function fileResponse(url) {
  const path = fileURLToPath(url);
  let buf;
  try {
    buf = await readFile(path);
  } catch (e) {
    if (e.code === "ENOENT")
      return {
        ok: false,
        status: 404,
        url,
        arrayBuffer: async () => {
          throw new Error("404 " + url);
        },
        text: async () => "",
        json: async () => {
          throw new Error("404 " + url);
        },
        body: null,
      };
    throw e;
  }
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    ok: true,
    status: 200,
    url,
    arrayBuffer: async () => u8.slice().buffer,
    blob: async () => new Blob([u8]),
    text: async () => buf.toString("utf8"),
    json: async () => JSON.parse(buf.toString("utf8")),
    // nix-closure-store streams via r.body.getReader() when present; body:null
    // makes it fall back to arrayBuffer().
    body: null,
  };
}

export function installWebShims() {
  if (globalThis.Worker !== WebWorker) globalThis.Worker = WebWorker;
  installFetchShim();
}

installWebShims();
