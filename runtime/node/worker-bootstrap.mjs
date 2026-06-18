// worker-bootstrap.mjs — Node worker entry. Installs the `self` shim the
// linux-wasm kernel-worker expects, re-applies the file:// fetch shim, then
// imports the real worker module passed as workerData.realUrl.
import { parentPort, workerData } from "node:worker_threads";
import { installFetchShim } from "./web-shims.mjs";

installFetchShim();

const self = {
  onmessage: null,
  onmessageerror: null,
  postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer),
};
globalThis.self = self;

parentPort.on("message", (data) => self.onmessage?.({ data }));
parentPort.on("messageerror", (e) => self.onmessageerror?.({ data: e }));

await import(workerData.realUrl);
