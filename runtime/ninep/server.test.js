// @ts-nocheck
// End-to-end 9P server tests: drive createNinePServer() with real encoded
// frames against a seeded in-memory VFS — the headless harness from
// docs/linux.md §9.4 step 1 / §16.1 ("drive the server with canned frames
// against a Bun vfs.* adapter"). No kernel, no browser.
import { test, expect, describe, beforeEach } from "bun:test";
import { P9, QT, E, DOTL_VERSION, NOFID, NOTAG, encode, decode } from "./protocol.js";
import { createNinePServer } from "./server.js";
import { MemVfs } from "./mem-vfs.js";

const dec = (b) => new TextDecoder().decode(b);

// Minimal 9P client: a fid allocator + an rpc() that frames a request,
// hands the bytes to the server, and decodes the reply.
function client(srv) {
  let tag = 0;
  let nextFid = 1;
  return {
    fid: () => nextFid++,
    async rpc(msg) {
      const reply = decode(await srv.handle(encode({ tag: ++tag, ...msg })));
      return reply;
    },
  };
}

// Common bring-up: Tversion + Tattach, returning the root fid.
async function mount(c) {
  const v = await c.rpc({ type: P9.Tversion, tag: NOTAG, msize: 65536, version: DOTL_VERSION });
  expect(v.type).toBe(P9.Rversion);
  expect(v.version).toBe(DOTL_VERSION);
  expect(v.msize).toBeLessThanOrEqual(65536);
  const rootFid = c.fid();
  const a = await c.rpc({
    type: P9.Tattach,
    fid: rootFid,
    afid: NOFID,
    uname: "eric",
    aname: "/",
    n_uname: 0,
  });
  expect(a.type).toBe(P9.Rattach);
  expect(a.qid.type & QT.DIR).toBe(QT.DIR);
  return rootFid;
}

// Walk from `fromFid` along `names`, returning the new fid (asserts success).
async function walk(c, fromFid, names) {
  const newFid = c.fid();
  const r = await c.rpc({ type: P9.Twalk, fid: fromFid, newfid: newFid, wnames: names });
  expect(r.type).toBe(P9.Rwalk);
  expect(r.qids.length).toBe(names.length);
  return { fid: newFid, qids: r.qids };
}

let vfs, srv, c;
beforeEach(() => {
  vfs = MemVfs.from({
    Home: {
      "notes.txt": "hello world",
      Docs: { "a.md": "# A" },
    },
  });
  srv = createNinePServer({ vfs });
  c = client(srv);
});

describe("version + attach", () => {
  test("negotiates msize down to the server cap", async () => {
    const v = await c.rpc({ type: P9.Tversion, tag: NOTAG, msize: 1 << 20, version: DOTL_VERSION });
    expect(v.msize).toBe(65536);
  });

  test("rejects an unknown version with 'unknown'", async () => {
    const v = await c.rpc({ type: P9.Tversion, tag: NOTAG, msize: 4096, version: "9P2000" });
    expect(v.version).toBe("unknown");
  });

  test("attach yields a directory qid for the root", async () => {
    await mount(c);
  });
});

describe("walk", () => {
  test("walks to a nested file and reports a file qid", async () => {
    const root = await mount(c);
    const { qids } = await walk(c, root, ["Home", "notes.txt"]);
    expect(qids[0].type & QT.DIR).toBe(QT.DIR); // Home
    expect(qids[1].type).toBe(QT.FILE); // notes.txt
  });

  test("zero-name walk clones the fid", async () => {
    const root = await mount(c);
    const r = await c.rpc({ type: P9.Twalk, fid: root, newfid: c.fid(), wnames: [] });
    expect(r.type).toBe(P9.Rwalk);
    expect(r.qids).toEqual([]);
  });

  test("walk to a missing first element → Rlerror ENOENT", async () => {
    const root = await mount(c);
    const r = await c.rpc({ type: P9.Twalk, fid: root, newfid: c.fid(), wnames: ["nope"] });
    expect(r.type).toBe(P9.Rlerror);
    expect(r.ecode).toBe(E.NOENT);
  });

  test("partial walk returns collected qids without binding newfid", async () => {
    const root = await mount(c);
    const newFid = c.fid();
    const r = await c.rpc({ type: P9.Twalk, fid: root, newfid: newFid, wnames: ["Home", "ghost"] });
    expect(r.type).toBe(P9.Rwalk);
    expect(r.qids.length).toBe(1); // only Home resolved
    // newFid must be unbound → getattr on it fails EBADF
    const g = await c.rpc({ type: P9.Tgetattr, fid: newFid, request_mask: 0x7ff });
    expect(g.type).toBe(P9.Rlerror);
    expect(g.ecode).toBe(E.BADF);
  });

  test("qid.path is stable across re-walks of the same inode", async () => {
    const root = await mount(c);
    const a = await walk(c, root, ["Home", "notes.txt"]);
    const b = await walk(c, root, ["Home", "notes.txt"]);
    expect(a.qids[1].path).toBe(b.qids[1].path);
  });
});

describe("getattr", () => {
  test("reports size + file mode for a regular file", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    const g = await c.rpc({ type: P9.Tgetattr, fid, request_mask: 0x7ff });
    expect(g.type).toBe(P9.Rgetattr);
    expect(g.size).toBe("hello world".length);
    expect(g.mode & 0o170000).toBe(0o100000); // S_IFREG
    expect(g.qid.type).toBe(QT.FILE);
  });

  test("reports directory mode for a folder", async () => {
    const root = await mount(c);
    const g = await c.rpc({ type: P9.Tgetattr, fid: root, request_mask: 0x7ff });
    expect(g.mode & 0o170000).toBe(0o040000); // S_IFDIR
    expect(g.nlink).toBe(2);
  });
});

describe("read", () => {
  test("reads whole-file and byte ranges", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    await c.rpc({ type: P9.Tlopen, fid, flags: 0 });
    const all = await c.rpc({ type: P9.Tread, fid, offset: 0, count: 4096 });
    expect(dec(all.data)).toBe("hello world");
    const mid = await c.rpc({ type: P9.Tread, fid, offset: 6, count: 5 });
    expect(dec(mid.data)).toBe("world");
    const eof = await c.rpc({ type: P9.Tread, fid, offset: 100, count: 5 });
    expect(eof.data.length).toBe(0);
  });

  test("reading a directory with Tread → Rlerror EISDIR", async () => {
    const root = await mount(c);
    const r = await c.rpc({ type: P9.Tread, fid: root, offset: 0, count: 10 });
    expect(r.type).toBe(P9.Rlerror);
    expect(r.ecode).toBe(E.ISDIR);
  });
});

describe("write round-trips to the VFS", () => {
  test("overwrite is visible to a plain vfs.readBlob", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    await c.rpc({ type: P9.Tlopen, fid, flags: 0 });
    const data = new TextEncoder().encode("HELLO");
    const w = await c.rpc({ type: P9.Twrite, fid, offset: 0, data });
    expect(w.type).toBe(P9.Rwrite);
    expect(w.count).toBe(5);
    // Same bytes seen through the VFS directly (what Filer/V1 terminal see).
    const blob = await vfs.readBlob("/Home/notes.txt");
    expect(dec(new Uint8Array(await blob.arrayBuffer()))).toBe("HELLO world");
  });

  test("Tlcreate makes a new file under a directory fid", async () => {
    const root = await mount(c);
    const { fid: homeFid } = await walk(c, root, ["Home"]);
    const r = await c.rpc({
      type: P9.Tlcreate,
      fid: homeFid,
      name: "new.txt",
      flags: 0,
      mode: 0o644,
      gid: 0,
    });
    expect(r.type).toBe(P9.Rlcreate);
    expect(r.qid.type).toBe(QT.FILE);
    // fid now points at the new file → write goes there
    await c.rpc({
      type: P9.Twrite,
      fid: homeFid,
      offset: 0,
      data: new TextEncoder().encode("fresh"),
    });
    const blob = await vfs.readBlob("/Home/new.txt");
    expect(dec(new Uint8Array(await blob.arrayBuffer()))).toBe("fresh");
  });
});

describe("O_TRUNC on open", () => {
  const O_TRUNC = 0x200;
  test("opening with O_TRUNC empties the file before the first write", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    await c.rpc({ type: P9.Tlopen, fid, flags: O_TRUNC });
    // Truncated immediately — a read sees nothing.
    const rd = await c.rpc({ type: P9.Tread, fid, offset: 0, count: 100 });
    expect(rd.data.length).toBe(0);
    // A fresh write at 0 doesn't pick up the old "hello world" tail.
    await c.rpc({ type: P9.Twrite, fid, offset: 0, data: new TextEncoder().encode("hi") });
    const blob = await vfs.readBlob("/Home/notes.txt");
    expect(dec(new Uint8Array(await blob.arrayBuffer()))).toBe("hi");
  });
});

describe("readdir", () => {
  test("lists children plus synthetic . and ..", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home"]);
    await c.rpc({ type: P9.Tlopen, fid, flags: 0 });
    const r = await c.rpc({ type: P9.Treaddir, fid, offset: 0, count: 8192 });
    expect(r.type).toBe(P9.Rreaddir);
    const names = parseDirents(r.data);
    expect(names).toContain(".");
    expect(names).toContain("..");
    expect(names).toContain("notes.txt");
    expect(names).toContain("Docs");
  });

  test("paginates: a second call resumes after the returned cookie", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home"]);
    await c.rpc({ type: P9.Tlopen, fid, flags: 0 });
    // Tiny count → only the first dirent fits.
    const first = await c.rpc({ type: P9.Treaddir, fid, offset: 0, count: 30 });
    const firstEntries = parseDirentsFull(first.data);
    expect(firstEntries.length).toBe(1);
    const cookie = firstEntries[0].offset;
    // Resume from the cookie, large count → the rest.
    const rest = await c.rpc({ type: P9.Treaddir, fid, offset: cookie, count: 8192 });
    const restNames = parseDirents(rest.data);
    expect(restNames).not.toContain(firstEntries[0].name);
    expect(restNames.length).toBeGreaterThan(0);
  });
});

describe("mkdir / rename / remove", () => {
  test("mkdir creates a directory visible to the VFS", async () => {
    const root = await mount(c);
    const { fid: homeFid } = await walk(c, root, ["Home"]);
    const r = await c.rpc({ type: P9.Tmkdir, dfid: homeFid, name: "New", mode: 0o755, gid: 0 });
    expect(r.type).toBe(P9.Rmkdir);
    expect((await vfs.stat("/Home/New")).type).toBe("folder");
  });

  test("renameat moves a file between directories", async () => {
    const root = await mount(c);
    const { fid: homeFid } = await walk(c, root, ["Home"]);
    const { fid: docsFid } = await walk(c, root, ["Home", "Docs"]);
    const r = await c.rpc({
      type: P9.Trenameat,
      olddirfid: homeFid,
      oldname: "notes.txt",
      newdirfid: docsFid,
      newname: "moved.txt",
    });
    expect(r.type).toBe(P9.Rrenameat);
    expect(await vfs.stat("/Home/notes.txt")).toBeNull();
    expect((await vfs.stat("/Home/Docs/moved.txt")).type).toBe("file");
  });

  test("unlinkat removes a file", async () => {
    const root = await mount(c);
    const { fid: docsFid } = await walk(c, root, ["Home", "Docs"]);
    const r = await c.rpc({ type: P9.Tunlinkat, dirfid: docsFid, name: "a.md", flags: 0 });
    expect(r.type).toBe(P9.Runlinkat);
    expect(await vfs.stat("/Home/Docs/a.md")).toBeNull();
  });

  test("Tremove deletes and clunks the fid", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    const r = await c.rpc({ type: P9.Tremove, fid });
    expect(r.type).toBe(P9.Rremove);
    expect(await vfs.stat("/Home/notes.txt")).toBeNull();
    // fid is gone now
    const g = await c.rpc({ type: P9.Tgetattr, fid, request_mask: 0x7ff });
    expect(g.ecode).toBe(E.BADF);
  });
});

describe("symlink", () => {
  test("symlink + readlink round-trip via VFS aliases", async () => {
    const root = await mount(c);
    const { fid: homeFid } = await walk(c, root, ["Home"]);
    const s = await c.rpc({
      type: P9.Tsymlink,
      fid: homeFid,
      name: "link",
      symtgt: "/Home/notes.txt",
      gid: 0,
    });
    expect(s.type).toBe(P9.Rsymlink);
    expect(s.qid.type & QT.SYMLINK).toBe(QT.SYMLINK);
    const { fid: linkFid } = await walk(c, root, ["Home", "link"]);
    const rl = await c.rpc({ type: P9.Treadlink, fid: linkFid });
    expect(rl.type).toBe(P9.Rreadlink);
    expect(rl.target).toBe("/Home/notes.txt");
  });
});

describe("error mapping", () => {
  test("writing under a read-only prefix → Rlerror EROFS", async () => {
    vfs = MemVfs.from(
      { System: { "ro.txt": "locked" }, Home: {} },
      { readOnlyPrefixes: ["/System"] },
    );
    srv = createNinePServer({ vfs });
    c = client(srv);
    const root = await mount(c);
    const { fid } = await walk(c, root, ["System", "ro.txt"]);
    const w = await c.rpc({ type: P9.Twrite, fid, offset: 0, data: new TextEncoder().encode("x") });
    expect(w.type).toBe(P9.Rlerror);
    expect(w.ecode).toBe(E.ROFS);
  });

  test("Tgetattr on a bogus fid → Rlerror EBADF", async () => {
    await mount(c);
    const g = await c.rpc({ type: P9.Tgetattr, fid: 9999, request_mask: 0x7ff });
    expect(g.ecode).toBe(E.BADF);
  });

  test("statfs reports the v9fs magic", async () => {
    const root = await mount(c);
    const r = await c.rpc({ type: P9.Tstatfs, fid: root });
    expect(r.type).toBe(P9.Rstatfs);
    expect(r.fstype).toBe(0x01021997);
    expect(r.namelen).toBe(255);
  });
});

describe("reply tag echoing", () => {
  test("every reply carries the request's tag", async () => {
    const reply = decode(
      await srv.handle(
        encode({ type: P9.Tversion, tag: 0x4242, msize: 4096, version: DOTL_VERSION }),
      ),
    );
    expect(reply.tag).toBe(0x4242);
  });
});

// ── dirent parsing helpers (mirror packDirent's layout) ────────────────────
function parseDirentsFull(buf) {
  const out = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (p < buf.length) {
    const offset = Number(dv.getBigUint64(p + 13, true));
    const type = dv.getUint8(p + 21);
    const nameLen = dv.getUint16(p + 22, true);
    const name = dec(buf.subarray(p + 24, p + 24 + nameLen));
    out.push({ offset, type, name });
    p += 24 + nameLen;
  }
  return out;
}
function parseDirents(buf) {
  return parseDirentsFull(buf).map((d) => d.name);
}

// A client bound to a specific connection id (cid) — the per-mount channel the
// transport supplies. Two clientOn(srv, 0/1) model two guest mounts sharing one
// server (Phase E/N1: /mnt/pc + /nix over one trans_cb ring).
function clientOn(srv, cid) {
  let tag = 0;
  let nextFid = 1;
  return {
    fid: () => nextFid++,
    async rpc(msg) {
      return decode(await srv.handle(encode({ tag: ++tag, ...msg }), cid));
    },
  };
}

describe("export registration (addExport duck-typing)", () => {
  test("a backend that itself has a .vfs property is used as the backend", async () => {
    // The real js/vfs module namespace exports a `vfs` symbol; registering it
    // must use the MODULE (which has stat/readBlob), not its inner .vfs.
    const real = MemVfs.from({ Home: { "a.txt": "abc" } });
    real.vfs = { somethingElse: true }; // mimic `export const vfs = {...}`
    const srv2 = createNinePServer({ exports: { "/": real } });
    const c2 = client(srv2);
    const root = await mount(c2);
    const { fid } = await walk(c2, root, ["Home", "a.txt"]);
    await c2.rpc({ type: P9.Tlopen, fid, flags: 0 });
    const r = await c2.rpc({ type: P9.Tread, fid, offset: 0, count: 16 });
    expect(dec(r.data)).toBe("abc"); // readBlob worked → right object picked
  });
});

describe("byte-range locks (Tlock/Tgetlock)", () => {
  test("Tlock always grants; Tgetlock reports no conflict", async () => {
    const root = await mount(c);
    const { fid } = await walk(c, root, ["Home", "notes.txt"]);
    const l = await c.rpc({
      type: P9.Tlock,
      fid,
      locktype: 1, // WRLCK
      flags: 0,
      start: 0,
      length: 0,
      proc_id: 42,
      client_id: "cb",
    });
    expect(l.type).toBe(P9.Rlock);
    expect(l.status).toBe(0); // P9_LOCK_SUCCESS
    const g = await c.rpc({
      type: P9.Tgetlock,
      fid,
      locktype: 1,
      start: 0,
      length: 0,
      proc_id: 42,
      client_id: "cb",
    });
    expect(g.type).toBe(P9.Rgetlock);
    expect(g.locktype).toBe(2); // P9_LOCK_TYPE_UNLCK = no conflict
  });

  test("lock on an unknown fid → Rlerror EBADF", async () => {
    await mount(c);
    const l = await c.rpc({
      type: P9.Tlock,
      fid: 9999,
      locktype: 1,
      flags: 0,
      start: 0,
      length: 0,
      proc_id: 1,
      client_id: "cb",
    });
    expect(l.type).toBe(P9.Rlerror);
    expect(l.ecode).toBe(E.BADF);
  });
});

describe("multi-connection (multi-mount, Phase E/N1)", () => {
  const attach = (c, fid, aname) =>
    c.rpc({ type: P9.Tattach, fid, afid: NOFID, uname: "eric", aname, n_uname: 0 });
  const version = (c, msize = 65536) =>
    c.rpc({ type: P9.Tversion, tag: NOTAG, msize, version: DOTL_VERSION });

  test("aname selects the backend; two mounts get isolated fid spaces", async () => {
    const user = MemVfs.from({ Home: { "u.txt": "user" } });
    const store = MemVfs.from({ "abc-pkg": { marker: "STORE" } });
    const srv2 = createNinePServer({ exports: { "/": user, nix: store } });
    const c0 = clientOn(srv2, 0); // mount 1 → user VFS
    const c1 = clientOn(srv2, 1); // mount 2 → store

    await version(c0);
    await version(c1);
    // Both connections reuse the SAME low fid number — only cid disambiguates.
    const f0 = c0.fid();
    const f1 = c1.fid();
    expect(f0).toBe(f1);
    expect((await attach(c0, f0, "/")).type).toBe(P9.Rattach);
    expect((await attach(c1, f1, "nix")).type).toBe(P9.Rattach);

    // Each fid1 walks within ITS backend.
    const w0 = await c0.rpc({
      type: P9.Twalk,
      fid: f0,
      newfid: c0.fid(),
      wnames: ["Home", "u.txt"],
    });
    expect(w0.type).toBe(P9.Rwalk);
    expect(w0.qids.length).toBe(2);
    const w1 = await c1.rpc({
      type: P9.Twalk,
      fid: f1,
      newfid: c1.fid(),
      wnames: ["abc-pkg", "marker"],
    });
    expect(w1.type).toBe(P9.Rwalk);
    expect(w1.qids.length).toBe(2);

    // Cross-check: neither mount can see the other's tree.
    const x0 = await c0.rpc({ type: P9.Twalk, fid: f0, newfid: c0.fid(), wnames: ["abc-pkg"] });
    expect(x0.type).toBe(P9.Rlerror);
    const x1 = await c1.rpc({ type: P9.Twalk, fid: f1, newfid: c1.fid(), wnames: ["Home"] });
    expect(x1.type).toBe(P9.Rlerror);
  });

  test("a second mount's Tversion does not clobber the first's fids", async () => {
    const user = MemVfs.from({ Home: { "u.txt": "user" } });
    const store = MemVfs.from({ "abc-pkg": { marker: "STORE" } });
    const srv2 = createNinePServer({ exports: { "/": user, nix: store } });
    const c0 = clientOn(srv2, 0);
    const c1 = clientOn(srv2, 1);

    await version(c0);
    const f0 = c0.fid();
    await attach(c0, f0, "/");
    // Second mount versions (which resets ITS state) AFTER c0 has a live fid.
    await version(c1, 8192);
    await attach(c1, c1.fid(), "nix");
    // c0's fid is still valid — the shared-msize/shared-fids bug the spike hit
    // would have cleared it.
    const r = await c0.rpc({
      type: P9.Twalk,
      fid: f0,
      newfid: c0.fid(),
      wnames: ["Home", "u.txt"],
    });
    expect(r.type).toBe(P9.Rwalk);
    expect(r.qids.length).toBe(2);
  });

  test("a backend that itself carries a .vfs property is NOT mistaken for a {vfs,root} wrapper", async () => {
    // Regression: js/vfs/index.js's module namespace exports a `vfs` aggregate,
    // so `exports: { "/": vfsModule }` used to silently swap in the aggregate
    // as the backend — which (then) lacked readBlob, turning every Tread into
    // an empty read (cat: ENODATA; appends zero-filled the existing bytes).
    const backend = MemVfs.from({ Home: { "u.txt": "real backend" } });
    backend.vfs = { stat: async () => null }; // decoy aggregate, like the module namespace
    const srv2 = createNinePServer({ exports: { "/": backend } });
    const c0 = clientOn(srv2, 0);
    await version(c0);
    const root = c0.fid();
    await attach(c0, root, "/");
    const w = await c0.rpc({
      type: P9.Twalk,
      fid: root,
      newfid: c0.fid(),
      wnames: ["Home", "u.txt"],
    });
    expect(w.type).toBe(P9.Rwalk);
    const fid = c0.fid();
    await c0.rpc({ type: P9.Twalk, fid: root, newfid: fid, wnames: ["Home", "u.txt"] });
    await c0.rpc({ type: P9.Tlopen, fid, flags: 0 });
    const r = await c0.rpc({ type: P9.Tread, fid, offset: 0, count: 4096 });
    expect(r.type).toBe(P9.Rread);
    expect(dec(r.data)).toBe("real backend");
  });
});
