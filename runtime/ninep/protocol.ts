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
} as const;

/** Reverse map: type number → name (handy for logs/tests). */
export const MSG_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(P9).map(([k, v]) => [v, k]),
);

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

// ── Per-message types ──────────────────────────────────────────────────────
// Field kinds on the wire: u8 u16 u32 u64 str qid data | wname (u16-counted
// str[]) | qids (u16-counted qid[]). Each message is one interface below and
// one case in `encode`/`decode`, which read and write its fields in wire
// order. u64 fields are typed `number` (see the header note on precision).

/** A 9P qid: type[1] version[4] path[8]. */
export interface Qid {
  type: number;
  version: number;
  path: number;
}

/** One Treaddir directory entry, as packed by `packDirent`. */
export interface Dirent {
  qid: Qid;
  offset: number;
  type: number;
  name: string;
}

export interface Tversion {
  type: typeof P9.Tversion;
  tag?: number;
  msize: number;
  version: string;
}
export interface Rversion {
  type: typeof P9.Rversion;
  tag?: number;
  msize: number;
  version: string;
}
export interface Tauth {
  type: typeof P9.Tauth;
  tag?: number;
  afid: number;
  uname: string;
  aname: string;
  n_uname: number;
}
export interface Rauth {
  type: typeof P9.Rauth;
  tag?: number;
  aqid: Qid;
}
export interface Tattach {
  type: typeof P9.Tattach;
  tag?: number;
  fid: number;
  afid: number;
  uname: string;
  aname: string;
  n_uname: number;
}
export interface Rattach {
  type: typeof P9.Rattach;
  tag?: number;
  qid: Qid;
}
export interface Rlerror {
  type: typeof P9.Rlerror;
  tag?: number;
  ecode: number;
}
export interface Tstatfs {
  type: typeof P9.Tstatfs;
  tag?: number;
  fid: number;
}
// `fstype` is the wire's f_type; named to avoid colliding with the message
// `type` discriminator the codec switches on.
export interface Rstatfs {
  type: typeof P9.Rstatfs;
  tag?: number;
  fstype: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  fsid: number;
  namelen: number;
}
export interface Tlopen {
  type: typeof P9.Tlopen;
  tag?: number;
  fid: number;
  flags: number;
}
export interface Rlopen {
  type: typeof P9.Rlopen;
  tag?: number;
  qid: Qid;
  iounit: number;
}
export interface Tlcreate {
  type: typeof P9.Tlcreate;
  tag?: number;
  fid: number;
  name: string;
  flags: number;
  mode: number;
  gid: number;
}
export interface Rlcreate {
  type: typeof P9.Rlcreate;
  tag?: number;
  qid: Qid;
  iounit: number;
}
export interface Tsymlink {
  type: typeof P9.Tsymlink;
  tag?: number;
  fid: number;
  name: string;
  symtgt: string;
  gid: number;
}
export interface Rsymlink {
  type: typeof P9.Rsymlink;
  tag?: number;
  qid: Qid;
}
export interface Tmknod {
  type: typeof P9.Tmknod;
  tag?: number;
  dfid: number;
  name: string;
  mode: number;
  major: number;
  minor: number;
  gid: number;
}
export interface Rmknod {
  type: typeof P9.Rmknod;
  tag?: number;
  qid: Qid;
}
export interface Trename {
  type: typeof P9.Trename;
  tag?: number;
  fid: number;
  dfid: number;
  name: string;
}
export interface Rrename {
  type: typeof P9.Rrename;
  tag?: number;
}
export interface Treadlink {
  type: typeof P9.Treadlink;
  tag?: number;
  fid: number;
}
export interface Rreadlink {
  type: typeof P9.Rreadlink;
  tag?: number;
  target: string;
}
export interface Tgetattr {
  type: typeof P9.Tgetattr;
  tag?: number;
  fid: number;
  request_mask: number;
}
export interface Rgetattr {
  type: typeof P9.Rgetattr;
  tag?: number;
  valid: number;
  qid: Qid;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atime_sec: number;
  atime_nsec: number;
  mtime_sec: number;
  mtime_nsec: number;
  ctime_sec: number;
  ctime_nsec: number;
  btime_sec: number;
  btime_nsec: number;
  gen: number;
  data_version: number;
}
export interface Tsetattr {
  type: typeof P9.Tsetattr;
  tag?: number;
  fid: number;
  valid: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime_sec: number;
  atime_nsec: number;
  mtime_sec: number;
  mtime_nsec: number;
}
export interface Rsetattr {
  type: typeof P9.Rsetattr;
  tag?: number;
}
export interface Txattrwalk {
  type: typeof P9.Txattrwalk;
  tag?: number;
  fid: number;
  newfid: number;
  name: string;
}
export interface Treaddir {
  type: typeof P9.Treaddir;
  tag?: number;
  fid: number;
  offset: number;
  count: number;
}
export interface Rreaddir {
  type: typeof P9.Rreaddir;
  tag?: number;
  data: Uint8Array;
}
export interface Tfsync {
  type: typeof P9.Tfsync;
  tag?: number;
  fid: number;
  datasync: number;
}
export interface Rfsync {
  type: typeof P9.Rfsync;
  tag?: number;
}
// Byte-range locks (net/9p TLOCK "dbdqqds" / TGETLOCK "dbqqds"). v9fs keeps
// local lock state (locks_lock_file_wait) before consulting the server, so a
// single-client server can always grant (see server.js).
export interface Tlock {
  type: typeof P9.Tlock;
  tag?: number;
  fid: number;
  locktype: number;
  flags: number;
  start: number;
  length: number;
  proc_id: number;
  client_id: string;
}
export interface Rlock {
  type: typeof P9.Rlock;
  tag?: number;
  status: number;
}
export interface Tgetlock {
  type: typeof P9.Tgetlock;
  tag?: number;
  fid: number;
  locktype: number;
  start: number;
  length: number;
  proc_id: number;
  client_id: string;
}
export interface Rgetlock {
  type: typeof P9.Rgetlock;
  tag?: number;
  locktype: number;
  start: number;
  length: number;
  proc_id: number;
  client_id: string;
}
export interface Tmkdir {
  type: typeof P9.Tmkdir;
  tag?: number;
  dfid: number;
  name: string;
  mode: number;
  gid: number;
}
export interface Rmkdir {
  type: typeof P9.Rmkdir;
  tag?: number;
  qid: Qid;
}
export interface Trenameat {
  type: typeof P9.Trenameat;
  tag?: number;
  olddirfid: number;
  oldname: string;
  newdirfid: number;
  newname: string;
}
export interface Rrenameat {
  type: typeof P9.Rrenameat;
  tag?: number;
}
export interface Tunlinkat {
  type: typeof P9.Tunlinkat;
  tag?: number;
  dirfid: number;
  name: string;
  flags: number;
}
export interface Runlinkat {
  type: typeof P9.Runlinkat;
  tag?: number;
}
export interface Tflush {
  type: typeof P9.Tflush;
  tag?: number;
  oldtag: number;
}
export interface Rflush {
  type: typeof P9.Rflush;
  tag?: number;
}
export interface Twalk {
  type: typeof P9.Twalk;
  tag?: number;
  fid: number;
  newfid: number;
  wnames: string[];
}
export interface Rwalk {
  type: typeof P9.Rwalk;
  tag?: number;
  qids: Qid[];
}
export interface Tread {
  type: typeof P9.Tread;
  tag?: number;
  fid: number;
  offset: number;
  count: number;
}
export interface Rread {
  type: typeof P9.Rread;
  tag?: number;
  data: Uint8Array;
}
export interface Twrite {
  type: typeof P9.Twrite;
  tag?: number;
  fid: number;
  offset: number;
  data: Uint8Array;
}
export interface Rwrite {
  type: typeof P9.Rwrite;
  tag?: number;
  count: number;
}
export interface Tclunk {
  type: typeof P9.Tclunk;
  tag?: number;
  fid: number;
}
export interface Rclunk {
  type: typeof P9.Rclunk;
  tag?: number;
}
export interface Tremove {
  type: typeof P9.Tremove;
  tag?: number;
  fid: number;
}
export interface Rremove {
  type: typeof P9.Rremove;
  tag?: number;
}

export type P9Request =
  | Tversion
  | Tauth
  | Tattach
  | Tstatfs
  | Tlopen
  | Tlcreate
  | Tsymlink
  | Tmknod
  | Trename
  | Treadlink
  | Tgetattr
  | Tsetattr
  | Txattrwalk
  | Treaddir
  | Tfsync
  | Tlock
  | Tgetlock
  | Tmkdir
  | Trenameat
  | Tunlinkat
  | Tflush
  | Twalk
  | Tread
  | Twrite
  | Tclunk
  | Tremove;

export type P9Reply =
  | Rversion
  | Rauth
  | Rattach
  | Rlerror
  | Rstatfs
  | Rlopen
  | Rlcreate
  | Rsymlink
  | Rmknod
  | Rrename
  | Rreadlink
  | Rgetattr
  | Rsetattr
  | Rreaddir
  | Rfsync
  | Rlock
  | Rgetlock
  | Rmkdir
  | Rrenameat
  | Runlinkat
  | Rflush
  | Rwalk
  | Rread
  | Rwrite
  | Rclunk
  | Rremove;

/** Any 9P2000.L message this codec can encode or decode. */
export type P9Message = P9Request | P9Reply;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Growable little-endian writer ──────────────────────────────────────────
class Writer {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  constructor() {
    this.buf = new Uint8Array(64);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  u64(v: number | bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.pos, BigInt(Math.trunc(Number(v))), true);
    this.pos += 8;
  }
  raw(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string): void {
    const e = enc.encode(String(s));
    this.u16(e.length);
    this.raw(e);
  }
  qid(q: Qid): void {
    this.u8(q.type);
    this.u32(q.version);
    this.u64(q.path);
  }
  data(b: Uint8Array): void {
    this.u32(b.length);
    this.raw(b);
  }
  wnames(v: string[]): void {
    this.u16(v.length);
    for (const s of v) this.str(s);
  }
  qids(v: Qid[]): void {
    this.u16(v.length);
    for (const q of v) this.qid(q);
  }
  patchU32(off: number, v: number): void {
    this.view.setUint32(off, v >>> 0, true);
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ── Little-endian reader over a Uint8Array ─────────────────────────────────
class Reader {
  buf: Uint8Array;
  view: DataView;
  pos: number;
  constructor(input: Uint8Array) {
    this.buf = input;
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): number {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  raw(n: number): Uint8Array {
    const b = this.buf.subarray(this.pos, this.pos + n).slice();
    this.pos += n;
    return b;
  }
  str(): string {
    return dec.decode(this.raw(this.u16()));
  }
  qid(): Qid {
    return { type: this.u8(), version: this.u32(), path: this.u64() };
  }
  data(): Uint8Array {
    return this.raw(this.u32());
  }
  wnames(): string[] {
    const n = this.u16();
    const a: string[] = [];
    for (let i = 0; i < n; i++) a.push(this.str());
    return a;
  }
  qids(): Qid[] {
    const n = this.u16();
    const a: Qid[] = [];
    for (let i = 0; i < n; i++) a.push(this.qid());
    return a;
  }
}

// ── Public codec ───────────────────────────────────────────────────────────

/**
 * Encode a message object → framed bytes. `msg.type` selects the body layout;
 * `msg.tag` defaults to 0; remaining keys are the body fields.
 */
export function encode(msg: P9Message): Uint8Array {
  const type: number = msg.type;
  const w = new Writer();
  w.u32(0); // size placeholder, backpatched below
  w.u8(type);
  w.u16(msg.tag ?? 0);
  switch (msg.type) {
    case P9.Tversion:
      w.u32(msg.msize);
      w.str(msg.version);
      break;
    case P9.Rversion:
      w.u32(msg.msize);
      w.str(msg.version);
      break;
    case P9.Tauth:
      w.u32(msg.afid);
      w.str(msg.uname);
      w.str(msg.aname);
      w.u32(msg.n_uname);
      break;
    case P9.Rauth:
      w.qid(msg.aqid);
      break;
    case P9.Tattach:
      w.u32(msg.fid);
      w.u32(msg.afid);
      w.str(msg.uname);
      w.str(msg.aname);
      w.u32(msg.n_uname);
      break;
    case P9.Rattach:
      w.qid(msg.qid);
      break;
    case P9.Rlerror:
      w.u32(msg.ecode);
      break;
    case P9.Tstatfs:
      w.u32(msg.fid);
      break;
    case P9.Rstatfs:
      w.u32(msg.fstype);
      w.u32(msg.bsize);
      w.u64(msg.blocks);
      w.u64(msg.bfree);
      w.u64(msg.bavail);
      w.u64(msg.files);
      w.u64(msg.ffree);
      w.u64(msg.fsid);
      w.u32(msg.namelen);
      break;
    case P9.Tlopen:
      w.u32(msg.fid);
      w.u32(msg.flags);
      break;
    case P9.Rlopen:
      w.qid(msg.qid);
      w.u32(msg.iounit);
      break;
    case P9.Tlcreate:
      w.u32(msg.fid);
      w.str(msg.name);
      w.u32(msg.flags);
      w.u32(msg.mode);
      w.u32(msg.gid);
      break;
    case P9.Rlcreate:
      w.qid(msg.qid);
      w.u32(msg.iounit);
      break;
    case P9.Tsymlink:
      w.u32(msg.fid);
      w.str(msg.name);
      w.str(msg.symtgt);
      w.u32(msg.gid);
      break;
    case P9.Rsymlink:
      w.qid(msg.qid);
      break;
    case P9.Tmknod:
      w.u32(msg.dfid);
      w.str(msg.name);
      w.u32(msg.mode);
      w.u32(msg.major);
      w.u32(msg.minor);
      w.u32(msg.gid);
      break;
    case P9.Rmknod:
      w.qid(msg.qid);
      break;
    case P9.Trename:
      w.u32(msg.fid);
      w.u32(msg.dfid);
      w.str(msg.name);
      break;
    case P9.Rrename:
      break;
    case P9.Treadlink:
      w.u32(msg.fid);
      break;
    case P9.Rreadlink:
      w.str(msg.target);
      break;
    case P9.Tgetattr:
      w.u32(msg.fid);
      w.u64(msg.request_mask);
      break;
    case P9.Rgetattr:
      w.u64(msg.valid);
      w.qid(msg.qid);
      w.u32(msg.mode);
      w.u32(msg.uid);
      w.u32(msg.gid);
      w.u64(msg.nlink);
      w.u64(msg.rdev);
      w.u64(msg.size);
      w.u64(msg.blksize);
      w.u64(msg.blocks);
      w.u64(msg.atime_sec);
      w.u64(msg.atime_nsec);
      w.u64(msg.mtime_sec);
      w.u64(msg.mtime_nsec);
      w.u64(msg.ctime_sec);
      w.u64(msg.ctime_nsec);
      w.u64(msg.btime_sec);
      w.u64(msg.btime_nsec);
      w.u64(msg.gen);
      w.u64(msg.data_version);
      break;
    case P9.Tsetattr:
      w.u32(msg.fid);
      w.u32(msg.valid);
      w.u32(msg.mode);
      w.u32(msg.uid);
      w.u32(msg.gid);
      w.u64(msg.size);
      w.u64(msg.atime_sec);
      w.u64(msg.atime_nsec);
      w.u64(msg.mtime_sec);
      w.u64(msg.mtime_nsec);
      break;
    case P9.Rsetattr:
      break;
    case P9.Txattrwalk:
      w.u32(msg.fid);
      w.u32(msg.newfid);
      w.str(msg.name);
      break;
    case P9.Treaddir:
      w.u32(msg.fid);
      w.u64(msg.offset);
      w.u32(msg.count);
      break;
    case P9.Rreaddir:
      w.data(msg.data);
      break;
    case P9.Tfsync:
      w.u32(msg.fid);
      w.u32(msg.datasync);
      break;
    case P9.Rfsync:
      break;
    case P9.Tlock:
      w.u32(msg.fid);
      w.u8(msg.locktype);
      w.u32(msg.flags);
      w.u64(msg.start);
      w.u64(msg.length);
      w.u32(msg.proc_id);
      w.str(msg.client_id);
      break;
    case P9.Rlock:
      w.u8(msg.status);
      break;
    case P9.Tgetlock:
      w.u32(msg.fid);
      w.u8(msg.locktype);
      w.u64(msg.start);
      w.u64(msg.length);
      w.u32(msg.proc_id);
      w.str(msg.client_id);
      break;
    case P9.Rgetlock:
      w.u8(msg.locktype);
      w.u64(msg.start);
      w.u64(msg.length);
      w.u32(msg.proc_id);
      w.str(msg.client_id);
      break;
    case P9.Tmkdir:
      w.u32(msg.dfid);
      w.str(msg.name);
      w.u32(msg.mode);
      w.u32(msg.gid);
      break;
    case P9.Rmkdir:
      w.qid(msg.qid);
      break;
    case P9.Trenameat:
      w.u32(msg.olddirfid);
      w.str(msg.oldname);
      w.u32(msg.newdirfid);
      w.str(msg.newname);
      break;
    case P9.Rrenameat:
      break;
    case P9.Tunlinkat:
      w.u32(msg.dirfid);
      w.str(msg.name);
      w.u32(msg.flags);
      break;
    case P9.Runlinkat:
      break;
    case P9.Tflush:
      w.u16(msg.oldtag);
      break;
    case P9.Rflush:
      break;
    case P9.Twalk:
      w.u32(msg.fid);
      w.u32(msg.newfid);
      w.wnames(msg.wnames);
      break;
    case P9.Rwalk:
      w.qids(msg.qids);
      break;
    case P9.Tread:
      w.u32(msg.fid);
      w.u64(msg.offset);
      w.u32(msg.count);
      break;
    case P9.Rread:
      w.data(msg.data);
      break;
    case P9.Twrite:
      w.u32(msg.fid);
      w.u64(msg.offset);
      w.data(msg.data);
      break;
    case P9.Rwrite:
      w.u32(msg.count);
      break;
    case P9.Tclunk:
      w.u32(msg.fid);
      break;
    case P9.Rclunk:
      break;
    case P9.Tremove:
      w.u32(msg.fid);
      break;
    case P9.Rremove:
      break;
    default:
      throw new Error("9p encode: unknown type " + type);
  }
  w.patchU32(0, w.pos);
  return w.out();
}

/**
 * Decode framed bytes → a message object `{ type, tag, …fields }`. The leading
 * size[4] is consumed but not surfaced — it's redundant (a body field can also
 * be named `size`, e.g. Rgetattr), and the transport already read it to size
 * the frame slice it hands us.
 */
export function decode(input: Uint8Array): P9Message {
  const r = new Reader(input);
  r.u32(); // size — consumed; see doc comment
  const type = r.u8();
  const tag = r.u16();
  switch (type) {
    case P9.Tversion:
      return {
        type: P9.Tversion,
        tag,
        msize: r.u32(),
        version: r.str(),
      };
    case P9.Rversion:
      return {
        type: P9.Rversion,
        tag,
        msize: r.u32(),
        version: r.str(),
      };
    case P9.Tauth:
      return {
        type: P9.Tauth,
        tag,
        afid: r.u32(),
        uname: r.str(),
        aname: r.str(),
        n_uname: r.u32(),
      };
    case P9.Rauth:
      return {
        type: P9.Rauth,
        tag,
        aqid: r.qid(),
      };
    case P9.Tattach:
      return {
        type: P9.Tattach,
        tag,
        fid: r.u32(),
        afid: r.u32(),
        uname: r.str(),
        aname: r.str(),
        n_uname: r.u32(),
      };
    case P9.Rattach:
      return {
        type: P9.Rattach,
        tag,
        qid: r.qid(),
      };
    case P9.Rlerror:
      return {
        type: P9.Rlerror,
        tag,
        ecode: r.u32(),
      };
    case P9.Tstatfs:
      return {
        type: P9.Tstatfs,
        tag,
        fid: r.u32(),
      };
    case P9.Rstatfs:
      return {
        type: P9.Rstatfs,
        tag,
        fstype: r.u32(),
        bsize: r.u32(),
        blocks: r.u64(),
        bfree: r.u64(),
        bavail: r.u64(),
        files: r.u64(),
        ffree: r.u64(),
        fsid: r.u64(),
        namelen: r.u32(),
      };
    case P9.Tlopen:
      return {
        type: P9.Tlopen,
        tag,
        fid: r.u32(),
        flags: r.u32(),
      };
    case P9.Rlopen:
      return {
        type: P9.Rlopen,
        tag,
        qid: r.qid(),
        iounit: r.u32(),
      };
    case P9.Tlcreate:
      return {
        type: P9.Tlcreate,
        tag,
        fid: r.u32(),
        name: r.str(),
        flags: r.u32(),
        mode: r.u32(),
        gid: r.u32(),
      };
    case P9.Rlcreate:
      return {
        type: P9.Rlcreate,
        tag,
        qid: r.qid(),
        iounit: r.u32(),
      };
    case P9.Tsymlink:
      return {
        type: P9.Tsymlink,
        tag,
        fid: r.u32(),
        name: r.str(),
        symtgt: r.str(),
        gid: r.u32(),
      };
    case P9.Rsymlink:
      return {
        type: P9.Rsymlink,
        tag,
        qid: r.qid(),
      };
    case P9.Tmknod:
      return {
        type: P9.Tmknod,
        tag,
        dfid: r.u32(),
        name: r.str(),
        mode: r.u32(),
        major: r.u32(),
        minor: r.u32(),
        gid: r.u32(),
      };
    case P9.Rmknod:
      return {
        type: P9.Rmknod,
        tag,
        qid: r.qid(),
      };
    case P9.Trename:
      return {
        type: P9.Trename,
        tag,
        fid: r.u32(),
        dfid: r.u32(),
        name: r.str(),
      };
    case P9.Rrename:
      return {
        type: P9.Rrename,
        tag,
      };
    case P9.Treadlink:
      return {
        type: P9.Treadlink,
        tag,
        fid: r.u32(),
      };
    case P9.Rreadlink:
      return {
        type: P9.Rreadlink,
        tag,
        target: r.str(),
      };
    case P9.Tgetattr:
      return {
        type: P9.Tgetattr,
        tag,
        fid: r.u32(),
        request_mask: r.u64(),
      };
    case P9.Rgetattr:
      return {
        type: P9.Rgetattr,
        tag,
        valid: r.u64(),
        qid: r.qid(),
        mode: r.u32(),
        uid: r.u32(),
        gid: r.u32(),
        nlink: r.u64(),
        rdev: r.u64(),
        size: r.u64(),
        blksize: r.u64(),
        blocks: r.u64(),
        atime_sec: r.u64(),
        atime_nsec: r.u64(),
        mtime_sec: r.u64(),
        mtime_nsec: r.u64(),
        ctime_sec: r.u64(),
        ctime_nsec: r.u64(),
        btime_sec: r.u64(),
        btime_nsec: r.u64(),
        gen: r.u64(),
        data_version: r.u64(),
      };
    case P9.Tsetattr:
      return {
        type: P9.Tsetattr,
        tag,
        fid: r.u32(),
        valid: r.u32(),
        mode: r.u32(),
        uid: r.u32(),
        gid: r.u32(),
        size: r.u64(),
        atime_sec: r.u64(),
        atime_nsec: r.u64(),
        mtime_sec: r.u64(),
        mtime_nsec: r.u64(),
      };
    case P9.Rsetattr:
      return {
        type: P9.Rsetattr,
        tag,
      };
    case P9.Txattrwalk:
      return {
        type: P9.Txattrwalk,
        tag,
        fid: r.u32(),
        newfid: r.u32(),
        name: r.str(),
      };
    case P9.Treaddir:
      return {
        type: P9.Treaddir,
        tag,
        fid: r.u32(),
        offset: r.u64(),
        count: r.u32(),
      };
    case P9.Rreaddir:
      return {
        type: P9.Rreaddir,
        tag,
        data: r.data(),
      };
    case P9.Tfsync:
      return {
        type: P9.Tfsync,
        tag,
        fid: r.u32(),
        datasync: r.u32(),
      };
    case P9.Rfsync:
      return {
        type: P9.Rfsync,
        tag,
      };
    case P9.Tlock:
      return {
        type: P9.Tlock,
        tag,
        fid: r.u32(),
        locktype: r.u8(),
        flags: r.u32(),
        start: r.u64(),
        length: r.u64(),
        proc_id: r.u32(),
        client_id: r.str(),
      };
    case P9.Rlock:
      return {
        type: P9.Rlock,
        tag,
        status: r.u8(),
      };
    case P9.Tgetlock:
      return {
        type: P9.Tgetlock,
        tag,
        fid: r.u32(),
        locktype: r.u8(),
        start: r.u64(),
        length: r.u64(),
        proc_id: r.u32(),
        client_id: r.str(),
      };
    case P9.Rgetlock:
      return {
        type: P9.Rgetlock,
        tag,
        locktype: r.u8(),
        start: r.u64(),
        length: r.u64(),
        proc_id: r.u32(),
        client_id: r.str(),
      };
    case P9.Tmkdir:
      return {
        type: P9.Tmkdir,
        tag,
        dfid: r.u32(),
        name: r.str(),
        mode: r.u32(),
        gid: r.u32(),
      };
    case P9.Rmkdir:
      return {
        type: P9.Rmkdir,
        tag,
        qid: r.qid(),
      };
    case P9.Trenameat:
      return {
        type: P9.Trenameat,
        tag,
        olddirfid: r.u32(),
        oldname: r.str(),
        newdirfid: r.u32(),
        newname: r.str(),
      };
    case P9.Rrenameat:
      return {
        type: P9.Rrenameat,
        tag,
      };
    case P9.Tunlinkat:
      return {
        type: P9.Tunlinkat,
        tag,
        dirfid: r.u32(),
        name: r.str(),
        flags: r.u32(),
      };
    case P9.Runlinkat:
      return {
        type: P9.Runlinkat,
        tag,
      };
    case P9.Tflush:
      return {
        type: P9.Tflush,
        tag,
        oldtag: r.u16(),
      };
    case P9.Rflush:
      return {
        type: P9.Rflush,
        tag,
      };
    case P9.Twalk:
      return {
        type: P9.Twalk,
        tag,
        fid: r.u32(),
        newfid: r.u32(),
        wnames: r.wnames(),
      };
    case P9.Rwalk:
      return {
        type: P9.Rwalk,
        tag,
        qids: r.qids(),
      };
    case P9.Tread:
      return {
        type: P9.Tread,
        tag,
        fid: r.u32(),
        offset: r.u64(),
        count: r.u32(),
      };
    case P9.Rread:
      return {
        type: P9.Rread,
        tag,
        data: r.data(),
      };
    case P9.Twrite:
      return {
        type: P9.Twrite,
        tag,
        fid: r.u32(),
        offset: r.u64(),
        data: r.data(),
      };
    case P9.Rwrite:
      return {
        type: P9.Rwrite,
        tag,
        count: r.u32(),
      };
    case P9.Tclunk:
      return {
        type: P9.Tclunk,
        tag,
        fid: r.u32(),
      };
    case P9.Rclunk:
      return {
        type: P9.Rclunk,
        tag,
      };
    case P9.Tremove:
      return {
        type: P9.Tremove,
        tag,
        fid: r.u32(),
      };
    case P9.Rremove:
      return {
        type: P9.Rremove,
        tag,
      };

    default:
      throw new Error("9p decode: unknown type " + type);
  }
}

/** Read just the tag from a frame (used to reply Rlerror to an undecodable msg). */
export function peekTag(input: Uint8Array): number {
  if (input.length < 7) return NOTAG;
  return new DataView(input.buffer, input.byteOffset, input.byteLength).getUint16(5, true);
}

/** Build a qid record. */
export function makeQid(type: number, version: number, path: number): Qid {
  return { type, version, path };
}

/**
 * Pack one Treaddir dirent: qid[13] offset[8] type[1] name[s].
 * The server concatenates these into the Rreaddir `data` blob.
 */
export function packDirent({ qid, offset, type, name }: Dirent): Uint8Array {
  const w = new Writer();
  w.qid(qid);
  w.u64(offset);
  w.u8(type);
  w.str(name);
  return w.out();
}

/** Byte length of a packed dirent without allocating (for msize budgeting). */
export function direntSize(name: string): number {
  return 13 + 8 + 1 + 2 + enc.encode(String(name)).length;
}
