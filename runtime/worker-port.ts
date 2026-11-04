// worker-port.ts — the worker handles the engine drives, described without the
// DOM. kernel-host and kernel-worker run in a browser, under Node's
// worker_threads shims, and in hosts with no DOM types at all, so they depend
// on these shapes rather than on lib.dom's Worker and
// DedicatedWorkerGlobalScope (both of which satisfy them).

/** A handler slot written with method syntax so its parameter is checked
 *  bivariantly: a browser Worker's `(ev: MessageEvent) => any` fits a slot
 *  that only promises `{ data }`. */
type Handler<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

/** What a worker reports when it fails: an ErrorEvent in a browser. */
export interface WorkerErrorEvent {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
}

/** kernel-host's handle on one worker. */
export interface RuntimeWorker {
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  terminate(): void;
  onmessage: Handler<{ data: unknown }> | null;
  onerror: Handler<WorkerErrorEvent> | null;
  onmessageerror: Handler<unknown> | null;
}

/** A worker's own end of the channel (`self` in a dedicated worker). */
export interface WorkerScope {
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  onmessage: Handler<{ data: unknown }> | null;
  onmessageerror: Handler<unknown> | null;
  /** A browser worker's; a shimmed `self` may not have it. */
  addEventListener?: WorkerScopeListen;
}

interface WorkerScopeListen {
  (type: "error", listener: Handler<WorkerErrorEvent & { preventDefault(): void }>): void;
  (type: "unhandledrejection", listener: Handler<{ reason: unknown }>): void;
}
