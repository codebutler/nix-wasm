// 9P2000.L wire codec — pure, dependency-free, headless-testable (`bun test`).
//
// This is the "lift the protocol engine, re-back it on our VFS" half of the
// design (docs/linux.md §9.3 / §19): no standalone JS 9P library exists, so we
// own a small, schema-driven marshaller for the Linux-extended dialect
// (9P2000.L) and feed it to a VFS-backed server (server.js). The kernel's own
// in-tree `v9fs` client speaks this on the other end of the stock virtio-9p
// transport (§9.1); here we only encode/decode frames.
//
// Wire format (little-endian throughout):
//   message: size[4] type[1] tag[2] body…     (size counts the whole message)
//   string : len[2] utf8[len]
//   qid    : type[1] version[4] path[8]        (13 bytes)
//   data   : count[4] bytes[count]
//
// u64 fields are read back as JS Numbers — every 64-bit value we exchange
// (interned qid paths, file sizes, second/nanosecond times, attr masks) is well
// under 2^53 for a PoC, so the precision loss never bites. Encoding accepts a
// Number or BigInt.
//
// Everything here is a pure function of its arguments — it must import cleanly
// with no DOM/IDB so the codec round-trips under `bun test`.

// ── Message type numbers (T = request, R = reply) ────────────────────────
export const P9 = {
  Rlerror: 7,
  Tstatfs: 8,
  Rstatfs: 9,
  Tlopen: 12,
  Rlopen: 13,
  Tlcreate: 14,
  Rlcreate: 15,
  Tsymlink: 16,
  Rsymlink: 17,
  Tmknod: 18,
  Rmknod: 19,
  Trename: 20,
  Rrename: 21,
  Treadlink: 22,
  Rreadlink: 23,
  Tgetattr: 24,
  Rgetattr: 25,
  Tsetattr: 26,
  Rsetattr: 27,
  Txattrwalk: 30,
  Rxattrwalk: 31,
  Treaddir: 40,
  Rreaddir: 41,
  Tfsync: 50,
  Rfsync: 51,
  Tlock: 52,
  Rlock: 53,
  Tgetlock: 54,
  Rgetlock: 55,
  Tmkdir: 72,
  Rmkdir: 73,
  Trenameat: 74,
  Rrenameat: 75,
  Tunlinkat: 76,
  Runlinkat: 77,
  Tversion: 100,
  Rversion: 101,
  Tauth: 102,
  Rauth: 103,
  Tattach: 104,
  Rattach: 105,
  Tflush: 108,
  Rflush: 109,
  Twalk: 110,
  Rwalk: 111,
  Tread: 116,
  Rread: 117,
  Twrite: 118,
  Rwrite: 119,
  Tclunk: 120,
  Rclunk: 121,
  Tremove: 122,
  Rremove: 123,
};

/** Reverse map: type number → name (handy for logs/tests). */
export const MSG_NAME = Object.fromEntries(Object.entries(P9).map(([k, v]) => [v, k]));

// ── qid.type bits ────────────────────────────────────────────────────────
export const QT = {
  DIR: 0x80,
  APPEND: 0x40,
  EXCL: 0x20,
  MOUNT: 0x10,
  AUTH: 0x08,
  TMP: 0x04,
  SYMLINK: 0x02,
  LINK: 0x01,
  FILE: 0x00,
};

// ── dirent d_type values (Treaddir) ────────────────────────────────────────
export const DT = { UNKNOWN: 0, DIR: 4, REG: 8, LNK: 10 };

// ── Linux errnos surfaced via Rlerror (subset we map from VFS errors) ──────
export const E = {
  PERM: 1,
  NOENT: 2,
  IO: 5,
  BADF: 9,
  NOMEM: 12,
  ACCES: 13,
  EXIST: 17,
  XDEV: 18,
  NODEV: 19,
  NOTDIR: 20,
  ISDIR: 21,
  INVAL: 22,
  FBIG: 27,
  ROFS: 30,
  NAMETOOLONG: 36,
  NOSYS: 38,
  NOTEMPTY: 39,
  NODATA: 61, // ENODATA — "no such xattr" (overlayfs treats this as "not set")
};

// Sentinels + version string.
export const NOTAG = 0xffff;
export const NOFID = 0xffffffff;
export const DOTL_VERSION = "9P2000.L";

// The "basic" getattr field mask (P9_GETATTR_BASIC): mode, nlink, uid, gid,
// rdev, atime, mtime, ctime, ino, size, blocks. We always fill these.
export const GETATTR_BASIC = 0x000007ff;

// ── Per-message field schema ───────────────────────────────────────────────
// Field kinds: u8 u16 u32 u64 str qid data | wname (u16-counted str[]) |
// qids (u16-counted qid[]). The generic encoder/decoder walks these so each
// message is one table row, not a bespoke function.
const SCHEMA = {
  [P9.Tversion]: [
    ["msize", "u32"],
    ["version", "str"],
  ],
  [P9.Rversion]: [
    ["msize", "u32"],
    ["version", "str"],
  ],
  [P9.Tauth]: [
    ["afid", "u32"],
    ["uname", "str"],
    ["aname", "str"],
    ["n_uname", "u32"],
  ],
  [P9.Rauth]: [["aqid", "qid"]],
  [P9.Tattach]: [
    ["fid", "u32"],
    ["afid", "u32"],
    ["uname", "str"],
    ["aname", "str"],
    ["n_uname", "u32"],
  ],
  [P9.Rattach]: [["qid", "qid"]],
  [P9.Rlerror]: [["ecode", "u32"]],
  [P9.Tstatfs]: [["fid", "u32"]],
  // `fstype` is the wire's f_type; named to avoid colliding with the message
  // `type` discriminator the schema dispatch keys on.
  [P9.Rstatfs]: [
    ["fstype", "u32"],
    ["bsize", "u32"],
    ["blocks", "u64"],
    ["bfree", "u64"],
    ["bavail", "u64"],
    ["files", "u64"],
    ["ffree", "u64"],
    ["fsid", "u64"],
    ["namelen", "u32"],
  ],
  [P9.Tlopen]: [
    ["fid", "u32"],
    ["flags", "u32"],
  ],
  [P9.Rlopen]: [
    ["qid", "qid"],
    ["iounit", "u32"],
  ],
  [P9.Tlcreate]: [
    ["fid", "u32"],
    ["name", "str"],
    ["flags", "u32"],
    ["mode", "u32"],
    ["gid", "u32"],
  ],
  [P9.Rlcreate]: [
    ["qid", "qid"],
    ["iounit", "u32"],
  ],
  [P9.Tsymlink]: [
    ["fid", "u32"],
    ["name", "str"],
    ["symtgt", "str"],
    ["gid", "u32"],
  ],
  [P9.Rsymlink]: [["qid", "qid"]],
  [P9.Tmknod]: [
    ["dfid", "u32"],
    ["name", "str"],
    ["mode", "u32"],
    ["major", "u32"],
    ["minor", "u32"],
    ["gid", "u32"],
  ],
  [P9.Rmknod]: [["qid", "qid"]],
  [P9.Trename]: [
    ["fid", "u32"],
    ["dfid", "u32"],
    ["name", "str"],
  ],
  [P9.Rrename]: [],
  [P9.Treadlink]: [["fid", "u32"]],
  [P9.Rreadlink]: [["target", "str"]],
  [P9.Tgetattr]: [
    ["fid", "u32"],
    ["request_mask", "u64"],
  ],
  [P9.Rgetattr]: [
    ["valid", "u64"],
    ["qid", "qid"],
    ["mode", "u32"],
    ["uid", "u32"],
    ["gid", "u32"],
    ["nlink", "u64"],
    ["rdev", "u64"],
    ["size", "u64"],
    ["blksize", "u64"],
    ["blocks", "u64"],
    ["atime_sec", "u64"],
    ["atime_nsec", "u64"],
    ["mtime_sec", "u64"],
    ["mtime_nsec", "u64"],
    ["ctime_sec", "u64"],
    ["ctime_nsec", "u64"],
    ["btime_sec", "u64"],
    ["btime_nsec", "u64"],
    ["gen", "u64"],
    ["data_version", "u64"],
  ],
  [P9.Tsetattr]: [
    ["fid", "u32"],
    ["valid", "u32"],
    ["mode", "u32"],
    ["uid", "u32"],
    ["gid", "u32"],
    ["size", "u64"],
    ["atime_sec", "u64"],
    ["atime_nsec", "u64"],
    ["mtime_sec", "u64"],
    ["mtime_nsec", "u64"],
  ],
  [P9.Rsetattr]: [],
  [P9.Txattrwalk]: [
    ["fid", "u32"],
    ["newfid", "u32"],
    ["name", "str"],
  ],
  [P9.Treaddir]: [
    ["fid", "u32"],
    ["offset", "u64"],
    ["count", "u32"],
  ],
  [P9.Rreaddir]: [["data", "data"]],
  [P9.Tfsync]: [
    ["fid", "u32"],
    ["datasync", "u32"],
  ],
  [P9.Rfsync]: [],
  // Byte-range locks (net/9p TLOCK "dbdqqds" / TGETLOCK "dbqqds"). v9fs keeps
  // local lock state (locks_lock_file_wait) before consulting the server, so a
  // single-client server can always grant (see server.js).
  [P9.Tlock]: [
    ["fid", "u32"],
    ["locktype", "u8"],
    ["flags", "u32"],
    ["start", "u64"],
    ["length", "u64"],
    ["proc_id", "u32"],
    ["client_id", "str"],
  ],
  [P9.Rlock]: [["status", "u8"]],
  [P9.Tgetlock]: [
    ["fid", "u32"],
    ["locktype", "u8"],
    ["start", "u64"],
    ["length", "u64"],
    ["proc_id", "u32"],
    ["client_id", "str"],
  ],
  [P9.Rgetlock]: [
    ["locktype", "u8"],
    ["start", "u64"],
    ["length", "u64"],
    ["proc_id", "u32"],
    ["client_id", "str"],
  ],
  [P9.Tmkdir]: [
    ["dfid", "u32"],
    ["name", "str"],
    ["mode", "u32"],
    ["gid", "u32"],
  ],
  [P9.Rmkdir]: [["qid", "qid"]],
  [P9.Trenameat]: [
    ["olddirfid", "u32"],
    ["oldname", "str"],
    ["newdirfid", "u32"],
    ["newname", "str"],
  ],
  [P9.Rrenameat]: [],
  [P9.Tunlinkat]: [
    ["dirfid", "u32"],
    ["name", "str"],
    ["flags", "u32"],
  ],
  [P9.Runlinkat]: [],
  [P9.Tflush]: [["oldtag", "u16"]],
  [P9.Rflush]: [],
  [P9.Twalk]: [
    ["fid", "u32"],
    ["newfid", "u32"],
    ["wnames", "wname"],
  ],
  [P9.Rwalk]: [["qids", "qids"]],
  [P9.Tread]: [
    ["fid", "u32"],
    ["offset", "u64"],
    ["count", "u32"],
  ],
  [P9.Rread]: [["data", "data"]],
  [P9.Twrite]: [
    ["fid", "u32"],
    ["offset", "u64"],
    ["data", "data"],
  ],
  [P9.Rwrite]: [["count", "u32"]],
  [P9.Tclunk]: [["fid", "u32"]],
  [P9.Rclunk]: [],
  [P9.Tremove]: [["fid", "u32"]],
  [P9.Rremove]: [],
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Growable little-endian writer ──────────────────────────────────────────
class Writer {
  constructor() {
    this.buf = new Uint8Array(64);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v) {
    this.ensure(1);
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
  }
  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
  }
  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  u64(v) {
    this.ensure(8);
    this.view.setBigUint64(this.pos, BigInt(Math.trunc(Number(v))), true);
    this.pos += 8;
  }
  raw(b) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s) {
    const e = enc.encode(String(s));
    this.u16(e.length);
    this.raw(e);
  }
  qid(q) {
    this.u8(q.type);
    this.u32(q.version);
    this.u64(q.path);
  }
  data(b) {
    this.u32(b.length);
    this.raw(b);
  }
  patchU32(off, v) {
    this.view.setUint32(off, v >>> 0, true);
  }
  out() {
    return this.buf.slice(0, this.pos);
  }
}

// ── Little-endian reader over a Uint8Array ─────────────────────────────────
class Reader {
  /** @param {Uint8Array|ArrayBuffer} input */
  constructor(input) {
    this.buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  u8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  raw(n) {
    const b = this.buf.subarray(this.pos, this.pos + n).slice();
    this.pos += n;
    return b;
  }
  str() {
    return dec.decode(this.raw(this.u16()));
  }
  qid() {
    return { type: this.u8(), version: this.u32(), path: this.u64() };
  }
  data() {
    return this.raw(this.u32());
  }
}

function writeField(w, kind, v) {
  switch (kind) {
    case "u8":
      w.u8(v);
      break;
    case "u16":
      w.u16(v);
      break;
    case "u32":
      w.u32(v);
      break;
    case "u64":
      w.u64(v);
      break;
    case "str":
      w.str(v);
      break;
    case "qid":
      w.qid(v);
      break;
    case "data":
      w.data(v);
      break;
    case "wname":
      w.u16(v.length);
      for (const s of v) w.str(s);
      break;
    case "qids":
      w.u16(v.length);
      for (const q of v) w.qid(q);
      break;
    default:
      throw new Error("9p encode: bad field kind " + kind);
  }
}

function readField(r, kind) {
  switch (kind) {
    case "u8":
      return r.u8();
    case "u16":
      return r.u16();
    case "u32":
      return r.u32();
    case "u64":
      return r.u64();
    case "str":
      return r.str();
    case "qid":
      return r.qid();
    case "data":
      return r.data();
    case "wname": {
      const n = r.u16();
      const a = [];
      for (let i = 0; i < n; i++) a.push(r.str());
      return a;
    }
    case "qids": {
      const n = r.u16();
      const a = [];
      for (let i = 0; i < n; i++) a.push(r.qid());
      return a;
    }
    default:
      throw new Error("9p decode: bad field kind " + kind);
  }
}

// ── Public codec ───────────────────────────────────────────────────────────

/**
 * Encode a message object → framed bytes. `msg.type` selects the schema;
 * `msg.tag` defaults to 0; remaining keys are the body fields.
 * @param {Record<string, any>} msg
 * @returns {Uint8Array}
 */
export function encode(msg) {
  const fields = SCHEMA[msg.type];
  if (!fields) throw new Error("9p encode: unknown type " + msg.type);
  const w = new Writer();
  w.u32(0); // size placeholder, backpatched below
  w.u8(msg.type);
  w.u16(msg.tag ?? 0);
  for (const [name, kind] of fields) writeField(w, kind, msg[name]);
  w.patchU32(0, w.pos);
  return w.out();
}

/**
 * Decode framed bytes → a message object `{ type, tag, …fields }`. The leading
 * size[4] is consumed but not surfaced — it's redundant (a body field can also
 * be named `size`, e.g. Rgetattr), and the transport already read it to size
 * the frame slice it hands us.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Record<string, any>}
 */
export function decode(input) {
  const r = new Reader(input);
  r.u32(); // size — consumed; see doc comment
  const type = r.u8();
  const tag = r.u16();
  const fields = SCHEMA[type];
  if (!fields) throw new Error("9p decode: unknown type " + type);
  /** @type {Record<string, any>} */
  const msg = { type, tag };
  for (const [name, kind] of fields) msg[name] = readField(r, kind);
  return msg;
}

/** Read just the tag from a frame (used to reply Rlerror to an undecodable msg). */
export function peekTag(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 7) return NOTAG;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(5, true);
}

/** Build a qid record. */
export function makeQid(type, version, path) {
  return { type, version, path };
}

/**
 * Pack one Treaddir dirent: qid[13] offset[8] type[1] name[s].
 * The server concatenates these into the Rreaddir `data` blob.
 */
export function packDirent({ qid, offset, type, name }) {
  const w = new Writer();
  w.qid(qid);
  w.u64(offset);
  w.u8(type);
  w.str(name);
  return w.out();
}

/** Byte length of a packed dirent without allocating (for msize budgeting). */
export function direntSize(name) {
  return 13 + 8 + 1 + 2 + enc.encode(String(name)).length;
}
