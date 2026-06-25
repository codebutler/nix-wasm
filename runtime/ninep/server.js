// 9P2000.L server — a pure VFS↔9P bridge (docs/linux.md §9.3).
//
// Answers decoded 9P request frames against injected backends (the async,
// typed-record `js/vfs` API in production; an in-memory MemVfs under `bun
// test`). One handler per message type, each mapping straight onto a `vfs.*`
// call — there is deliberately NO app-specific special-casing here (the Nix
// cache fault-fetch §11.6 and the desktop control files §10 live in their own
// VFS backends, transparent to this server).
//
// Multi-mount (Phase E/N1): the server exports one or more backends, selected
// at Tattach time by `aname` (what `aname` is for). Multiple guest mounts share
// ONE 9P server, so each `p9_client` is tagged with a connection id (`cid`) —
// supplied by the caller (the virtio-9p host device passes one per device, #10)
// and threaded through `handle(bytes, cid)`. Per-connection state (negotiated
// msize + the fid namespace) is keyed by `cid`, so a second mount no longer
// clobbers the first's msize (Tversion) or collides on fid numbers (both clients
// allocate low fids). `cid` defaults to 0, so a single mount behaves exactly as
// before and existing callers/tests are unaffected.
//
// Identity: the VFS already has stable string inodes (`rec.id`, used elsewhere
// as window instanceKeys). We intern each into a small integer qid.path, so the
// guest kernel's dcache gets identity that survives rename/move for free
// (§9.2). qid.version comes from the record mtime; qid.type from dir/file/link.
//
// This module is dependency-injected and DOM/IDB-free, so the whole request
// path round-trips headless. It speaks bytes in / bytes out via `handle()`; a
// transport (SAB ring in the browser, a fake loopback in tests) feeds it.

import {
  P9,
  QT,
  DT,
  E,
  GETATTR_BASIC,
  DOTL_VERSION,
  encode,
  decode,
  peekTag,
  makeQid,
  packDirent,
} from "./protocol.js";

// Linux V9FS_MAGIC, reported by Tstatfs.
const V9FS_MAGIC = 0x01021997;
// Tsetattr.valid bit for "set size" (truncate).
const SETATTR_SIZE = 0x00000008;
// open(2) O_TRUNC flag (Linux value), honored on Tlopen.
const O_TRUNC = 0x200;

// Map a thrown VFS error to a Linux errno for Rlerror. Server-originated
// errors carry `.p9errno` directly; VFS errors carry `.code` (or a
// "CODE: msg" string), matching js/vfs/index.js.
const CODE_TO_ERRNO = {
  EPERM: E.PERM,
  ENOENT: E.NOENT,
  EIO: E.IO,
  EBADF: E.BADF,
  EACCES: E.ACCES,
  EEXIST: E.EXIST,
  EXDEV: E.XDEV,
  ENODEV: E.NODEV,
  ENOTDIR: E.NOTDIR,
  EISDIR: E.ISDIR,
  EINVAL: E.INVAL,
  EROFS: E.ROFS,
  ENOTEMPTY: E.NOTEMPTY,
  ENOSYS: E.NOSYS,
  ENAMETOOLONG: E.NAMETOOLONG,
};

function p9err(errno) {
  const e = new Error("9p errno " + errno);
  // @ts-ignore
  e.p9errno = errno;
  return e;
}

function errnoFromError(e) {
  if (e && typeof e.p9errno === "number") return e.p9errno;
  let code = e && e.code;
  if (!code && e && typeof e.message === "string") {
    const m = e.message.match(/^([A-Z]+):/);
    if (m) code = m[1];
  }
  if (code && CODE_TO_ERRNO[code] != null) return CODE_TO_ERRNO[code];
  return E.IO;
}

// ── path helpers (single-component walk, like the kernel's per-name walk) ──
function parentOf(p) {
  if (p === "/" || p === "") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function joinName(base, seg) {
  if (seg === "" || seg === ".") return base;
  if (seg === "..") return parentOf(base);
  if (seg.includes("/")) throw p9err(E.INVAL);
  return base === "/" ? "/" + seg : base + "/" + seg;
}
function joinPath(base, rel) {
  let cur = base;
  for (const s of String(rel || "").split("/")) {
    if (s) cur = joinName(cur, s);
  }
  return cur;
}
// Normalize an attach name to an export key: leading slashes stripped, so the
// guest's `aname=/` and `aname=nix` (or `aname=/nix`) match the keys the host
// registers. "/" stays "/" (the default/root export).
function normAname(a) {
  const s = String(a == null ? "/" : a).replace(/^\/+/, "");
  return s === "" ? "/" : s;
}

function concatBytes(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const enc = new TextEncoder();

/**
 * Create a 9P2000.L server bound to one or more VFS backends.
 *
 * Back-compat: `{ vfs, root }` registers a single backend at the root aname.
 * Multi-export: `{ exports: { "/": userVfs, "nix": storeVfs, … } }` registers
 * several; the guest picks one per mount via the 9P `aname` mount option. A
 * value may be a bare VFS or `{ vfs, root }`.
 *
 * @param {{
 *   vfs?: any, root?: string,
 *   exports?: Record<string, any>,
 *   msize?: number, uid?: number, gid?: number,
 * }} opts
 */
export function createNinePServer(opts) {
  const maxMsize = opts.msize || 65536;
  const uid = opts.uid ?? 0;
  const gid = opts.gid ?? 0;

  // aname (normalized) → { vfs, root }. Tattach selects by aname.
  const exportsByName = new Map();
  const addExport = (name, val) => {
    // Detect a backend by its VFS surface (callable stat), NOT by a `.vfs`
    // property: the real js/vfs module namespace itself exports a `vfs` symbol
    // (and withCtlDevice mirrors it), so `.vfs`-presence duck-typing grabbed
    // that inner export as the backend — readBlob broke and 9P writes silently
    // zero-filled (caught by writes.mjs against realvfs.html; MemVfs has no
    // `.vfs`, so unit tests never saw it).
    const isVfs = val && typeof val.stat === "function";
    const e = isVfs ? { vfs: val, root: "/" } : { vfs: val.vfs, root: val.root || "/" };
    exportsByName.set(normAname(name), e);
  };
  if (opts.exports) {
    for (const [name, val] of Object.entries(opts.exports)) addExport(name, val);
  } else {
    addExport("/", { vfs: opts.vfs, root: opts.root || "/" });
  }
  const defaultExport = exportsByName.get("/") || [...exportsByName.values()][0];

  // Pick the backend + its root path for a Tattach `aname`. A registered export
  // wins; otherwise fall back to treating `aname` as a subpath of the default
  // export (the pre-multi-export behavior), so a single-backend server keeps
  // honoring `aname=/sub` mounts.
  function resolveAttach(aname) {
    const exp = exportsByName.get(normAname(aname));
    if (exp) return { vfs: exp.vfs, path: exp.root };
    const base = defaultExport.root || "/";
    const path = !aname || aname === "/" ? base : joinPath(base, aname);
    return { vfs: defaultExport.vfs, path };
  }

  let negotiatedMsize = maxMsize;

  // inode-id (string) → interned qid.path (small int), stable per session.
  // Shared across connections — identity is content/inode-based, so the same
  // file seen through two mounts gets the same qid.path (correct).
  const qidPaths = new Map();
  let qidSeq = 1;
  function qidPathFor(inode) {
    const k = String(inode);
    let v = qidPaths.get(k);
    if (v == null) {
      v = qidSeq++;
      qidPaths.set(k, v);
    }
    return v;
  }

  // Per-connection (cid) state: negotiated msize + the fid namespace. Two guest
  // mounts share one ring but get isolated fid tables here, keyed by cid.
  // fid → { path, vfs, opened?, dirents? } — the fid carries its backend, set
  // at Tattach and inherited through Twalk.
  /** @type {Map<number, { msize: number, fids: Map<number, any> }>} */
  const conns = new Map();
  function conn(cid) {
    let c = conns.get(cid);
    if (!c) {
      c = { msize: maxMsize, fids: new Map() };
      conns.set(cid, c);
    }
    return c;
  }
  function getFid(cid, fid) {
    const f = conn(cid).fids.get(fid);
    if (!f) throw p9err(E.BADF);
    return f;
  }

  function qidOf(rec) {
    const t = rec.type === "folder" ? QT.DIR : rec.type === "alias" ? QT.SYMLINK : QT.FILE;
    const version = Math.floor((rec.modifiedAt ?? 0) / 1000) >>> 0;
    return makeQid(t, version, qidPathFor(rec.id ?? rec.path));
  }
  function dtypeOf(rec) {
    return rec.type === "folder" ? DT.DIR : rec.type === "alias" ? DT.LNK : DT.REG;
  }
  function modeOf(rec) {
    if (rec.type === "folder") return 0o040000 | 0o755;
    if (rec.type === "alias") return 0o120000 | 0o777;
    // Regular files are reported executable (0755). pc's VFS has no per-file
    // exec bit and chmod is a no-op (Tsetattr below), so without this the
    // kernel's MAY_EXEC check rejects every file and programs in the VFS can't
    // be exec'd (`Permission denied`) — the prerequisite for Phase C cb_exec /
    // the Nix store living under /mnt/pc. Cosmetic only for data files.
    return 0o100000 | 0o755;
  }
  async function sizeOf(vfs, rec) {
    if (rec.type === "folder") return 0;
    if (rec.type === "alias") return rec.target ? enc.encode(rec.target).length : 0;
    if (typeof rec.size === "number") return rec.size;
    try {
      return (await vfs.readBlob(rec.path)).size;
    } catch {
      return 0;
    }
  }

  async function readBytes(vfs, path) {
    try {
      const blob = await vfs.readBlob(path);
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return new Uint8Array(0);
    }
  }
  // The VFS has no partial-write API, so writes are read-modify-write of the
  // whole record (same trade V1's vfs-adapter makes). Byte writes from Linux
  // land as a `file` record regardless of the prior type — Linux is
  // byte-oriented; the typed editors own their own save paths.
  async function writeBytes(vfs, path, bytes) {
    await vfs.write(path, {
      type: "file",
      blob: new Blob([bytes]),
      mime: "application/octet-stream",
      size: bytes.length,
    });
  }

  // Build the dirent list for an open directory, including synthetic "." and
  // "..". Offsets are 1-based cookies the client passes back to resume.
  async function loadDirents(vfs, dirPath) {
    const self = await vfs.stat(dirPath);
    if (!self) throw p9err(E.NOENT);
    const parent = (await vfs.stat(parentOf(dirPath))) || self;
    const kids = await vfs.list(dirPath);
    const entries = [
      { name: ".", rec: self },
      { name: "..", rec: parent },
      ...kids.map((k) => ({ name: k.name, rec: k })),
    ];
    return entries.map((e, i) => ({
      qid: qidOf(e.rec),
      type: dtypeOf(e.rec),
      name: e.name,
      offset: i + 1,
    }));
  }

  // ── per-message handlers → { type: R*, …fields } (tag added by handle) ──
  async function dispatch(cid, m) {
    switch (m.type) {
      case P9.Tversion: {
        const c = conn(cid);
        c.msize = Math.min(m.msize || 8192, maxMsize);
        c.fids.clear(); // Tversion resets this connection's state
        negotiatedMsize = c.msize;
        const version = String(m.version || "").startsWith("9P2000.L") ? DOTL_VERSION : "unknown";
        return { type: P9.Rversion, msize: c.msize, version };
      }

      case P9.Tattach: {
        const { vfs, path } = resolveAttach(m.aname);
        const rec = await vfs.stat(path);
        if (!rec) throw p9err(E.NOENT);
        conn(cid).fids.set(m.fid, { path, vfs });
        return { type: P9.Rattach, qid: qidOf(rec) };
      }

      case P9.Twalk: {
        const f = getFid(cid, m.fid);
        const vfs = f.vfs;
        let cur = f.path;
        const qids = [];
        for (let i = 0; i < m.wnames.length; i++) {
          const next = joinName(cur, m.wnames[i]);
          const rec = await vfs.stat(next);
          if (!rec) {
            if (i === 0) throw p9err(E.NOENT);
            break; // partial walk: return collected qids, don't bind newfid
          }
          qids.push(qidOf(rec));
          cur = next;
        }
        // Bind newfid only on a full walk (incl. the nwname===0 clone). The new
        // fid inherits the parent's backend.
        if (qids.length === m.wnames.length) conn(cid).fids.set(m.newfid, { path: cur, vfs });
        return { type: P9.Rwalk, qids };
      }

      case P9.Tgetattr: {
        const f = getFid(cid, m.fid);
        const rec = await f.vfs.stat(f.path);
        if (!rec) throw p9err(E.NOENT);
        const size = await sizeOf(f.vfs, rec);
        const ms = rec.modifiedAt ?? 0;
        const sec = Math.floor(ms / 1000);
        const nsec = (ms % 1000) * 1_000_000;
        return {
          type: P9.Rgetattr,
          valid: GETATTR_BASIC,
          qid: qidOf(rec),
          mode: modeOf(rec),
          uid,
          gid,
          nlink: rec.type === "folder" ? 2 : 1,
          rdev: 0,
          size,
          blksize: 4096,
          blocks: Math.ceil(size / 512),
          atime_sec: sec,
          atime_nsec: nsec,
          mtime_sec: sec,
          mtime_nsec: nsec,
          ctime_sec: sec,
          ctime_nsec: nsec,
          btime_sec: 0,
          btime_nsec: 0,
          gen: 0,
          data_version: 0,
        };
      }

      case P9.Tsetattr: {
        const f = getFid(cid, m.fid);
        if (m.valid & SETATTR_SIZE) {
          const rec = await f.vfs.stat(f.path);
          if (rec && rec.type !== "folder") {
            const cur = await readBytes(f.vfs, f.path);
            const out = new Uint8Array(m.size);
            out.set(cur.subarray(0, Math.min(cur.length, m.size)));
            await writeBytes(f.vfs, f.path, out);
          }
        }
        // mode/uid/gid/times are no-ops for the PoC.
        return { type: P9.Rsetattr };
      }

      case P9.Tlopen: {
        const f = getFid(cid, m.fid);
        const rec = await f.vfs.stat(f.path);
        if (!rec) throw p9err(E.NOENT);
        // Honor O_TRUNC: empty the file on open (what `>` redirection does).
        // Best-effort — a read-only target just stays as-is.
        if (m.flags & O_TRUNC && rec.type !== "folder") {
          try {
            await writeBytes(f.vfs, f.path, new Uint8Array(0));
          } catch {
            /* RO / device */
          }
        }
        f.opened = true;
        f.dirents = rec.type === "folder" ? await loadDirents(f.vfs, f.path) : null;
        return { type: P9.Rlopen, qid: qidOf(rec), iounit: 0 };
      }

      case P9.Tlcreate: {
        const f = getFid(cid, m.fid); // a dir fid; becomes the new file on success
        const path = joinName(f.path, m.name);
        await writeBytes(f.vfs, path, new Uint8Array(0));
        const rec = await f.vfs.stat(path);
        f.path = path;
        f.opened = true;
        f.dirents = null;
        return { type: P9.Rlcreate, qid: qidOf(rec), iounit: 0 };
      }

      case P9.Tmkdir: {
        const f = getFid(cid, m.dfid);
        const path = joinName(f.path, m.name);
        await f.vfs.mkdir(path);
        const rec = await f.vfs.stat(path);
        return { type: P9.Rmkdir, qid: qidOf(rec) };
      }

      case P9.Tsymlink: {
        const f = getFid(cid, m.fid);
        const path = joinName(f.path, m.name);
        await f.vfs.write(path, { type: "alias", target: m.symtgt });
        const rec = await f.vfs.stat(path);
        return { type: P9.Rsymlink, qid: qidOf(rec) };
      }

      case P9.Treadlink: {
        const f = getFid(cid, m.fid);
        const rec = await f.vfs.stat(f.path);
        if (!rec || rec.type !== "alias") throw p9err(E.INVAL);
        return { type: P9.Rreadlink, target: rec.target || "" };
      }

      case P9.Tread: {
        const f = getFid(cid, m.fid);
        const rec = await f.vfs.stat(f.path);
        if (!rec) throw p9err(E.NOENT);
        if (rec.type === "folder") throw p9err(E.ISDIR);
        const buf = await readBytes(f.vfs, f.path);
        const start = Math.min(m.offset, buf.length);
        const end = Math.min(buf.length, start + m.count);
        return { type: P9.Rread, data: buf.subarray(start, end).slice() };
      }

      case P9.Twrite: {
        const f = getFid(cid, m.fid);
        const cur = await readBytes(f.vfs, f.path);
        const data = m.data;
        const out = new Uint8Array(Math.max(cur.length, m.offset + data.length));
        out.set(cur);
        out.set(data, m.offset);
        await writeBytes(f.vfs, f.path, out); // throws EROFS on a read-only path → Rlerror
        return { type: P9.Rwrite, count: data.length };
      }

      case P9.Treaddir: {
        const f = getFid(cid, m.fid);
        if (!f.dirents || m.offset === 0) f.dirents = await loadDirents(f.vfs, f.path);
        const out = [];
        let total = 0;
        for (const d of f.dirents) {
          if (d.offset <= m.offset) continue; // already delivered
          const packed = packDirent(d);
          if (total + packed.length > m.count) break;
          out.push(packed);
          total += packed.length;
        }
        return { type: P9.Rreaddir, data: concatBytes(out) };
      }

      case P9.Tclunk: {
        conn(cid).fids.delete(m.fid);
        return { type: P9.Rclunk };
      }

      case P9.Tremove: {
        const f = getFid(cid, m.fid);
        await f.vfs.remove(f.path);
        conn(cid).fids.delete(m.fid); // remove clunks the fid even on success
        return { type: P9.Rremove };
      }

      case P9.Tunlinkat: {
        const f = getFid(cid, m.dirfid);
        await f.vfs.remove(joinName(f.path, m.name));
        return { type: P9.Runlinkat };
      }

      case P9.Trename: {
        const f = getFid(cid, m.fid);
        const d = getFid(cid, m.dfid);
        const dst = joinName(d.path, m.name);
        await f.vfs.move(f.path, dst);
        f.path = dst;
        return { type: P9.Rrename };
      }

      case P9.Trenameat: {
        const od = getFid(cid, m.olddirfid);
        const nd = getFid(cid, m.newdirfid);
        await od.vfs.move(joinName(od.path, m.oldname), joinName(nd.path, m.newname));
        return { type: P9.Rrenameat };
      }

      case P9.Tstatfs: {
        getFid(cid, m.fid);
        return {
          type: P9.Rstatfs,
          fstype: V9FS_MAGIC,
          bsize: 4096,
          blocks: 1 << 20,
          bfree: 1 << 20,
          bavail: 1 << 20,
          files: 1 << 16,
          ffree: 1 << 16,
          fsid: 0,
          namelen: 255,
        };
      }

      case P9.Tflush:
        return { type: P9.Rflush };

      case P9.Tfsync: {
        getFid(cid, m.fid);
        return { type: P9.Rfsync };
      }

      // Byte-range locks. v9fs arbitrates locks LOCALLY first
      // (locks_lock_file_wait in v9fs_file_do_lock) and then notifies the
      // server, so with one client per export (each guest mount is its own
      // connection) always granting is correct: every real contention is
      // between guest processes, and the guest kernel already resolved it.
      // Without these handlers flock/fcntl on a 9P mount fail outright —
      // which breaks sqlite (the Nix db, Phase E/N2).
      case P9.Tlock: {
        getFid(cid, m.fid);
        return { type: P9.Rlock, status: 0 }; // P9_LOCK_SUCCESS
      }

      case P9.Tgetlock: {
        getFid(cid, m.fid);
        // "No conflicting lock": type F_UNLCK; echo the probe's range back.
        return {
          type: P9.Rgetlock,
          locktype: 2, // P9_LOCK_TYPE_UNLCK
          start: m.start,
          length: m.length,
          proc_id: m.proc_id,
          client_id: m.client_id || "",
        };
      }

      // Txattrwalk: overlayfs probes trusted.overlay.* xattrs on lower files
      // during lookup. MemVfs has no xattrs, so report every attr absent
      // (ENODATA) — overlayfs treats that as "not set" and proceeds. Without
      // this, Txattrwalk falls to the unknown-op path → EINVAL, which overlayfs
      // treats as fatal, breaking reads through a 9P-lowerdir overlay union.
      case P9.Txattrwalk:
        throw p9err(E.NODATA);

      default:
        throw p9err(E.NOSYS);
    }
  }

  /**
   * Service one request frame → one reply frame. Never throws: VFS / handler
   * errors become Rlerror(errno). `cid` is the connection id (one per guest
   * mount, supplied by the transport); it defaults to 0 so a single-mount
   * caller behaves exactly as before.
   * @param {Uint8Array} reqBytes
   * @param {number} [cid]
   * @returns {Promise<Uint8Array>}
   */
  async function handle(reqBytes, cid = 0) {
    let m;
    try {
      m = decode(reqBytes);
    } catch {
      return encode({ type: P9.Rlerror, tag: peekTag(reqBytes), ecode: E.INVAL });
    }
    try {
      const reply = await dispatch(cid, m);
      reply.tag = m.tag;
      return encode(reply);
    } catch (err) {
      return encode({ type: P9.Rlerror, tag: m.tag, ecode: errnoFromError(err) });
    }
  }

  return {
    handle,
    get msize() {
      return negotiatedMsize;
    },
    stats() {
      let fids = 0;
      for (const c of conns.values()) fids += c.fids.size;
      return { fids, qids: qidPaths.size, conns: conns.size };
    },
  };
}
