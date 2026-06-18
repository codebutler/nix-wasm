// @ts-nocheck
// Real cross-thread futex round-trip (docs/linux.md §16.1: "a fake kernel-side
// writes frames + blocks; full round-trip"). The 9P server runs the service
// loop in a Worker (Atomics.waitAsync on the doorbell); this main thread plays
// a kernel task-worker, issuing *blocking* 9P requests (Atomics.wait on the
// reply slot) over the shared ring. Headless — Bun has Workers + SAB + Atomics,
// no COOP/COEP needed.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Ring } from "./ring.js";
import { P9, QT, DOTL_VERSION, NOFID, NOTAG, encode, decode } from "./protocol.js";

const dec = (b) => new TextDecoder().decode(b);

let worker;
let ring;

beforeAll(async () => {
  ring = Ring.create(8, 65536);
  worker = new Worker(new URL("./transport.worker.fixture.js", import.meta.url));
  await new Promise((resolve) => {
    worker.onmessage = (e) => {
      if (e.data === "ready") resolve();
    };
    worker.postMessage({
      buffer: ring.buffer,
      seed: { Home: { "hi.txt": "hello", Docs: { "a.md": "# A" } } },
    });
  });
});

afterAll(() => worker && worker.terminate());

// A blocking request issued the way the real kernel's trans_cb.request() does:
// post the frame, block on the reply slot, decode. The worker services it on
// its own thread and wakes us.
function rpc(msg) {
  return decode(ring.clientRequest(encode(msg)));
}

test("version + attach over the live ring", () => {
  const v = rpc({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
  expect(v.type).toBe(P9.Rversion);
  expect(v.version).toBe(DOTL_VERSION);
  const a = rpc({
    type: P9.Tattach,
    tag: 1,
    fid: 1,
    afid: NOFID,
    uname: "eric",
    aname: "/",
    n_uname: 0,
  });
  expect(a.type).toBe(P9.Rattach);
  expect(a.qid.type & QT.DIR).toBe(QT.DIR);
});

test("walk + open + read a real file across the wasm boundary", () => {
  rpc({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
  rpc({ type: P9.Tattach, tag: 1, fid: 1, afid: NOFID, uname: "eric", aname: "/", n_uname: 0 });
  const w = rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 2, wnames: ["Home", "hi.txt"] });
  expect(w.qids.length).toBe(2);
  expect(w.qids[1].type).toBe(QT.FILE);
  rpc({ type: P9.Tlopen, tag: 3, fid: 2, flags: 0 });
  const rd = rpc({ type: P9.Tread, tag: 4, fid: 2, offset: 0, count: 4096 });
  expect(dec(rd.data)).toBe("hello");
});

test("write through the ring is visible on a later read", () => {
  rpc({ type: P9.Tattach, tag: 1, fid: 1, afid: NOFID, uname: "eric", aname: "/", n_uname: 0 });
  rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 3, wnames: ["Home", "hi.txt"] });
  rpc({ type: P9.Tlopen, tag: 3, fid: 3, flags: 0 });
  const w = rpc({
    type: P9.Twrite,
    tag: 4,
    fid: 3,
    offset: 0,
    data: new TextEncoder().encode("HELLO"),
  });
  expect(w.type).toBe(P9.Rwrite);
  expect(w.count).toBe(5);
  // Re-open + read to confirm it persisted in the worker's VFS.
  rpc({ type: P9.Twalk, tag: 5, fid: 1, newfid: 4, wnames: ["Home", "hi.txt"] });
  rpc({ type: P9.Tlopen, tag: 6, fid: 4, flags: 0 });
  const rd = rpc({ type: P9.Tread, tag: 7, fid: 4, offset: 0, count: 4096 });
  expect(dec(rd.data)).toBe("HELLO");
});

test("many sequential requests stay correct (slot reuse under churn)", () => {
  rpc({ type: P9.Tattach, tag: 1, fid: 1, afid: NOFID, uname: "eric", aname: "/", n_uname: 0 });
  for (let i = 0; i < 50; i++) {
    const r = rpc({ type: P9.Tstatfs, tag: (i % 60000) + 100, fid: 1 });
    expect(r.type).toBe(P9.Rstatfs);
    expect(r.fstype).toBe(0x01021997);
  }
});
