// @ts-nocheck
// Deterministic transport tests: exercise the ring ABI + the serviceOnce()
// drain loop in-process (no threads), so they're flake-free. The real
// cross-thread futex round-trip lives in transport.worker.test.js.
import { test, expect, describe, beforeEach } from "bun:test";
import { Ring } from "./ring.js";
import { createNinePTransport } from "./transport.js";
import { createNinePServer } from "./server.js";
import { MemVfs } from "./mem-vfs.js";
import { P9, QT, DOTL_VERSION, NOFID, NOTAG, encode, decode } from "./protocol.js";

const dec = (b) => new TextDecoder().decode(b);

describe("ring ABI", () => {
  test("sizing accounts for header + N (request + reply) slots", () => {
    const r = Ring.create(4, 1024);
    expect(r.nslots).toBe(4);
    expect(r.msize).toBe(1024);
    expect(r.buffer.byteLength).toBe(Ring.bytes(4, 1024));
  });

  test("a posted request is seen FILLED, read back byte-exact, replied to", () => {
    const r = Ring.create(2, 4096);
    const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const slot = r.clientPost(frame);
    expect(slot).toBe(0);
    // Server claims FILLED slots and reads the frame back.
    const claimed = r.serverScan();
    expect(claimed).toEqual([0]);
    expect(Array.from(r.serverReadRequest(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // A second scan finds nothing (slot is INFLIGHT now).
    expect(r.serverScan()).toEqual([]);
    // Reply round-trips back to the client.
    r.serverWriteReply(0, new Uint8Array([9, 9, 9]));
    expect(Array.from(r.clientPoll(0))).toEqual([9, 9, 9]);
  });

  test("the tag is lifted from the frame into the slot header", () => {
    const r = Ring.create(1, 256);
    // size[4] type[1] tag[2]=0xBEEF …
    const frame = encode({ type: P9.Tclunk, tag: 0xbeef, fid: 0 });
    r.clientPost(frame);
    expect(r.i32[r._reqWord(0, 1)]).toBe(0xbeef); // REQ_TAG
  });

  test("clientPost throws when the ring is full, and slots free for reuse", () => {
    const r = Ring.create(1, 64);
    const f = new Uint8Array([0, 0, 0, 0, 0, 0, 0]);
    const slot = r.clientPost(f);
    expect(() => r.clientPost(f)).toThrow(/no free slot/);
    // Service + take frees the slot.
    r.serverScan();
    r.serverWriteReply(slot, new Uint8Array([1]));
    r.clientPoll(slot);
    expect(r.clientPost(f)).toBe(0); // reused
  });

  test("clientPoll returns null until the reply is ready", () => {
    const r = Ring.create(1, 64);
    const i = r.clientPost(new Uint8Array([0, 0, 0, 0, 0, 0, 0]));
    expect(r.clientPoll(i)).toBeNull();
    r.serverScan();
    r.serverWriteReply(i, new Uint8Array([7]));
    expect(Array.from(r.clientPoll(i))).toEqual([7]);
  });

  test("frame larger than msize is rejected", () => {
    const r = Ring.create(1, 16);
    expect(() => r.clientPost(new Uint8Array(64))).toThrow(/msize/);
  });
});

describe("serviceOnce drains the ring against a real server", () => {
  let ring, transport, vfs;
  beforeEach(() => {
    ring = Ring.create(8, 65536);
    vfs = MemVfs.from({ Home: { "hi.txt": "hello", Docs: {} } });
    transport = createNinePTransport({ ring, server: createNinePServer({ vfs }) });
  });

  // Drive a request through the ring + one serviceOnce pass.
  async function rpc(msg) {
    const i = ring.clientPost(encode(msg));
    await transport.serviceOnce();
    return decode(ring.clientPoll(i));
  }

  test("serviceOnce returns 0 with an empty ring", async () => {
    expect(await transport.serviceOnce()).toBe(0);
  });

  test("version → attach → walk → read across the ring", async () => {
    const v = await rpc({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
    expect(v.type).toBe(P9.Rversion);
    expect(v.version).toBe(DOTL_VERSION);

    const a = await rpc({
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

    const w = await rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 2, wnames: ["Home", "hi.txt"] });
    expect(w.qids.length).toBe(2);
    expect(w.qids[1].type).toBe(QT.FILE);

    await rpc({ type: P9.Tlopen, tag: 3, fid: 2, flags: 0 });
    const rd = await rpc({ type: P9.Tread, tag: 4, fid: 2, offset: 0, count: 100 });
    expect(dec(rd.data)).toBe("hello");
  });

  test("a write through the ring lands in the VFS", async () => {
    await rpc({
      type: P9.Tattach,
      tag: 1,
      fid: 1,
      afid: NOFID,
      uname: "e",
      aname: "/",
      n_uname: 0,
    });
    await rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 2, wnames: ["Home", "hi.txt"] });
    await rpc({ type: P9.Tlopen, tag: 3, fid: 2, flags: 0 });
    const w = await rpc({
      type: P9.Twrite,
      tag: 4,
      fid: 2,
      offset: 0,
      data: new TextEncoder().encode("HELLO"),
    });
    expect(w.type).toBe(P9.Rwrite);
    const blob = await vfs.readBlob("/Home/hi.txt");
    expect(dec(new Uint8Array(await blob.arrayBuffer()))).toBe("HELLO");
  });

  test("concurrent requests in distinct slots drain in one serviceOnce", async () => {
    // Post two independent attaches (different fids) before servicing.
    const i1 = ring.clientPost(
      encode({
        type: P9.Tattach,
        tag: 10,
        fid: 1,
        afid: NOFID,
        uname: "a",
        aname: "/",
        n_uname: 0,
      }),
    );
    const i2 = ring.clientPost(
      encode({
        type: P9.Tattach,
        tag: 11,
        fid: 2,
        afid: NOFID,
        uname: "b",
        aname: "/",
        n_uname: 0,
      }),
    );
    expect(i1).not.toBe(i2);
    const drained = await transport.serviceOnce();
    expect(drained).toBe(2);
    const r1 = decode(ring.clientPoll(i1));
    const r2 = decode(ring.clientPoll(i2));
    expect(r1.type).toBe(P9.Rattach);
    expect(r2.type).toBe(P9.Rattach);
    expect(r1.tag).toBe(10); // replies carry the right tags
    expect(r2.tag).toBe(11);
  });

  test("an errored op replies Rlerror without disturbing the ring", async () => {
    await rpc({
      type: P9.Tattach,
      tag: 1,
      fid: 1,
      afid: NOFID,
      uname: "e",
      aname: "/",
      n_uname: 0,
    });
    const r = await rpc({ type: P9.Twalk, tag: 2, fid: 1, newfid: 2, wnames: ["ghost"] });
    expect(r.type).toBe(P9.Rlerror);
    // Ring still works afterwards.
    const v = await rpc({ type: P9.Tstatfs, tag: 3, fid: 1 });
    expect(v.type).toBe(P9.Rstatfs);
  });
});
