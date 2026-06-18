// @ts-nocheck
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { makeWasm9pRequest } from "./host-call.js";
import { Ring } from "./ring.js";
import { P9, QT, DOTL_VERSION, NOFID, NOTAG, encode, decode } from "./protocol.js";

const dec = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);

describe("marshalling (fake ring, deterministic)", () => {
  test("copies the request frame out and the reply back in", () => {
    let captured = null;
    const reply = enc("REPLY-BYTES");
    const ring = {
      clientRequest(frame) {
        captured = frame;
        return reply;
      },
    };
    const memory = { buffer: new ArrayBuffer(4096) };
    const u8 = new Uint8Array(memory.buffer);
    const frame = enc("REQUEST-FRAME");
    u8.set(frame, 100); // request at offset 100
    const req = makeWasm9pRequest({ memory, ring });

    const n = req(0, 100, frame.length, 2000, 4096); // cid 0; rc at offset 2000
    expect(dec(captured)).toBe("REQUEST-FRAME"); // copied out exactly
    expect(n).toBe(reply.length);
    expect(dec(u8.subarray(2000, 2000 + n))).toBe("REPLY-BYTES"); // copied in
  });

  test("clamps the reply to rc_cap", () => {
    const ring = { clientRequest: () => enc("0123456789") };
    const memory = { buffer: new ArrayBuffer(1024) };
    const req = makeWasm9pRequest({ memory, ring });
    const n = req(0, 0, 0, 500, 4); // cid 0; capacity 4
    expect(n).toBe(4);
    expect(dec(new Uint8Array(memory.buffer).subarray(500, 504))).toBe("0123");
  });

  test("a thrown transport error becomes -EIO", () => {
    const ring = {
      clientRequest() {
        throw new Error("9p ring: no free slot");
      },
    };
    const memory = { buffer: new ArrayBuffer(64) };
    const req = makeWasm9pRequest({ memory, ring });
    expect(req(0, 0, 0, 0, 64)).toBe(-5);
  });

  test("writes the reply into the post-grow buffer (memory.grow safety)", () => {
    const memory = { buffer: new ArrayBuffer(64) };
    const reply = enc("AFTER-GROW");
    const ring = {
      clientRequest() {
        memory.buffer = new ArrayBuffer(8192); // simulate a concurrent grow()
        return reply;
      },
    };
    const req = makeWasm9pRequest({ memory, ring });
    const n = req(0, 0, 0, 1000, 4096);
    expect(dec(new Uint8Array(memory.buffer).subarray(1000, 1000 + n))).toBe("AFTER-GROW");
  });
});

describe("end-to-end: kernel import → ring → 9P server → MemVfs", () => {
  let worker, ring, memory, req;
  beforeAll(async () => {
    ring = Ring.create(8, 65536);
    worker = new Worker(new URL("./transport.worker.fixture.js", import.meta.url));
    await new Promise((resolve) => {
      worker.onmessage = (e) => e.data === "ready" && resolve();
      worker.postMessage({ buffer: ring.buffer, seed: { Home: { "hi.txt": "hello" } } });
    });
    memory = { buffer: new ArrayBuffer(1 << 18) }; // stand-in for kernel linear memory
    req = makeWasm9pRequest({ memory, ring });
  });
  afterAll(() => worker && worker.terminate());

  // Issue a 9P message the way trans_cb does: stage the request frame in
  // "kernel memory", call the host import, read the reply frame back out.
  const TC = 0x1000,
    RC = 0x2000,
    RC_CAP = 0x10000;
  function rpc(msg) {
    const frame = encode(msg);
    new Uint8Array(memory.buffer).set(frame, TC);
    const n = req(0, TC, frame.length, RC, RC_CAP); // cid 0 (single connection)
    if (n < 0) throw new Error("host call returned errno " + n);
    return decode(new Uint8Array(memory.buffer).slice(RC, RC + n));
  }

  test("version + attach + walk + read flow through the host import", () => {
    const v = rpc({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
    expect(v.type).toBe(P9.Rversion);
    expect(v.version).toBe(DOTL_VERSION);

    const a = rpc({
      type: P9.Tattach,
      tag: 1,
      fid: 1,
      afid: NOFID,
      uname: "e",
      aname: "/",
      n_uname: 0,
    });
    expect(a.type).toBe(P9.Rattach);
    expect(a.qid.type & QT.DIR).toBe(QT.DIR);

    const w = rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 2, wnames: ["Home", "hi.txt"] });
    expect(w.qids.length).toBe(2);
    expect(w.qids[1].type).toBe(QT.FILE);

    rpc({ type: P9.Tlopen, tag: 3, fid: 2, flags: 0 });
    const rd = rpc({ type: P9.Tread, tag: 4, fid: 2, offset: 0, count: 4096 });
    expect(dec(rd.data)).toBe("hello");
  });
});
