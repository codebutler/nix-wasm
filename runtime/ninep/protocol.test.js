// @ts-nocheck
import { test, expect, describe } from "bun:test";
import {
  P9,
  QT,
  DT,
  E,
  NOTAG,
  DOTL_VERSION,
  encode,
  decode,
  peekTag,
  makeQid,
  packDirent,
  direntSize,
} from "./protocol.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// Round-trip helper: encode then decode. decode() doesn't surface the frame
// size, so the result compares clean against the input message.
function roundtrip(msg) {
  return decode(encode(msg));
}

describe("framing", () => {
  test("size header counts the whole message and is little-endian", () => {
    const bytes = encode({ type: P9.Tclunk, tag: 7, fid: 0x11223344 });
    // size[4] type[1] tag[2] fid[4] = 11 bytes
    expect(bytes.length).toBe(11);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(11); // size = full length
    expect(dv.getUint8(4)).toBe(P9.Tclunk);
    expect(dv.getUint16(5, true)).toBe(7); // tag
    expect(dv.getUint32(7, true)).toBe(0x11223344); // fid, LE
  });

  test("decode recovers type + tag + fields", () => {
    const m = decode(encode({ type: P9.Tclunk, tag: 7, fid: 42 }));
    expect(m.type).toBe(P9.Tclunk);
    expect(m.tag).toBe(7);
    expect(m.fid).toBe(42);
  });

  test("peekTag reads the tag without a full decode", () => {
    expect(peekTag(encode({ type: P9.Tclunk, tag: 1234, fid: 0 }))).toBe(1234);
    expect(peekTag(new Uint8Array(3))).toBe(NOTAG);
  });

  test("unknown type throws on encode and decode", () => {
    expect(() => encode({ type: 254, tag: 0 })).toThrow(/unknown type/);
    const bad = new Uint8Array([7, 0, 0, 0, 254, 0, 0]);
    expect(() => decode(bad)).toThrow(/unknown type/);
  });
});

describe("version / attach", () => {
  test("Tversion / Rversion round-trip", () => {
    expect(
      roundtrip({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION }),
    ).toEqual({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
    expect(
      roundtrip({ type: P9.Rversion, tag: NOTAG, msize: 8192, version: DOTL_VERSION }),
    ).toEqual({ type: P9.Rversion, tag: NOTAG, msize: 8192, version: DOTL_VERSION });
  });

  test("Tattach carries the dotL n_uname; Rattach carries a qid", () => {
    const t = roundtrip({
      type: P9.Tattach,
      tag: 1,
      fid: 1,
      afid: 0xffffffff,
      uname: "eric",
      aname: "/",
      n_uname: 0,
    });
    expect(t).toEqual({
      type: P9.Tattach,
      tag: 1,
      fid: 1,
      afid: 0xffffffff,
      uname: "eric",
      aname: "/",
      n_uname: 0,
    });
    const q = makeQid(QT.DIR, 3, 1);
    expect(roundtrip({ type: P9.Rattach, tag: 1, qid: q }).qid).toEqual(q);
  });
});

describe("qid encoding", () => {
  test("a qid is exactly 13 bytes: type[1] version[4] path[8]", () => {
    // Rattach body is just a qid → frame is 7 (header) + 13 = 20 bytes.
    const bytes = encode({
      type: P9.Rattach,
      tag: 0,
      qid: makeQid(QT.DIR, 0xaabbccdd, 0x0102030405),
    });
    expect(bytes.length).toBe(20);
    const m = decode(bytes);
    expect(m.qid.type).toBe(QT.DIR);
    expect(m.qid.version).toBe(0xaabbccdd);
    expect(m.qid.path).toBe(0x0102030405);
  });
});

describe("walk (variable-length name + qid arrays)", () => {
  test("Twalk names round-trip, including the empty (clone) walk", () => {
    expect(
      roundtrip({ type: P9.Twalk, tag: 1, fid: 1, newfid: 2, wnames: ["Home", "notes.txt"] })
        .wnames,
    ).toEqual(["Home", "notes.txt"]);
    expect(roundtrip({ type: P9.Twalk, tag: 1, fid: 1, newfid: 2, wnames: [] }).wnames).toEqual([]);
  });

  test("Rwalk qid array round-trips", () => {
    const qids = [makeQid(QT.DIR, 1, 10), makeQid(QT.FILE, 2, 20)];
    expect(roundtrip({ type: P9.Rwalk, tag: 1, qids }).qids).toEqual(qids);
  });
});

describe("read / write data blobs", () => {
  test("Rread carries an opaque byte count + payload", () => {
    const payload = enc("hello world");
    const m = roundtrip({ type: P9.Rread, tag: 1, data: payload });
    expect(dec(m.data)).toBe("hello world");
  });

  test("Twrite offset + data round-trip", () => {
    const m = roundtrip({ type: P9.Twrite, tag: 1, fid: 3, offset: 4096, data: enc("xyz") });
    expect(m.fid).toBe(3);
    expect(m.offset).toBe(4096);
    expect(dec(m.data)).toBe("xyz");
    expect(roundtrip({ type: P9.Rwrite, tag: 1, count: 3 }).count).toBe(3);
  });
});

describe("getattr (the wide fixed struct)", () => {
  test("every field survives the round-trip", () => {
    const msg = {
      type: P9.Rgetattr,
      tag: 1,
      valid: 0x7ff,
      qid: makeQid(QT.FILE, 5, 99),
      mode: 0o100644,
      uid: 0,
      gid: 0,
      nlink: 1,
      rdev: 0,
      size: 12345,
      blksize: 4096,
      blocks: 25,
      atime_sec: 1700000000,
      atime_nsec: 0,
      mtime_sec: 1700000001,
      mtime_nsec: 500000000,
      ctime_sec: 1700000002,
      ctime_nsec: 0,
      btime_sec: 0,
      btime_nsec: 0,
      gen: 0,
      data_version: 0,
    };
    expect(roundtrip(msg)).toEqual(msg);
  });
});

describe("Rlerror + errno table", () => {
  test("Rlerror carries a Linux errno", () => {
    expect(roundtrip({ type: P9.Rlerror, tag: 9, ecode: E.ROFS })).toEqual({
      type: P9.Rlerror,
      tag: 9,
      ecode: 30,
    });
    expect(E.NOENT).toBe(2);
    expect(E.ISDIR).toBe(21);
  });
});

describe("dirents", () => {
  test("packDirent layout matches direntSize and decodes back", () => {
    const qid = makeQid(QT.DIR, 0, 7);
    const buf = packDirent({ qid, offset: 1, type: DT.DIR, name: "Docs" });
    expect(buf.length).toBe(direntSize("Docs"));
    // Manually decode: qid[13] offset[8] type[1] name(len[2]+bytes)
    const r = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(r.getUint8(0)).toBe(QT.DIR); // qid.type
    expect(Number(r.getBigUint64(13, true))).toBe(1); // offset cookie
    expect(r.getUint8(21)).toBe(DT.DIR); // d_type
    expect(r.getUint16(22, true)).toBe(4); // name length
    expect(dec(buf.subarray(24))).toBe("Docs");
  });
});

describe("unicode strings", () => {
  test("multi-byte names survive encode/decode", () => {
    const name = "café—日本語";
    const m = roundtrip({ type: P9.Tmkdir, tag: 1, dfid: 1, name, mode: 0o755, gid: 0 });
    expect(m.name).toBe(name);
  });
});
