// echo-fixture.worker.mjs — a tiny worker written against the Web-Worker `self`
// API (no node:worker_threads import), to prove worker-bootstrap.mjs provides it.
self.onmessage = (e) => {
  const { method, memory, value } = e.data;
  if (method === "poke") {
    new Int32Array(memory.buffer)[0] = value; // shared-memory write
    self.postMessage({ method: "ack" });
  }
};
