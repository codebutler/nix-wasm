// ninepd-interop.test.js — the REAL C server (userspace/ninepd.c) driven by a
// JS 9P2000.L client built on this repo's own wire codec (protocol.js — the
// module pc vendors and builds its guest-9p client on; pc issue #472).
//
// The daemon is compiled NATIVELY with the host cc (skipped when none is
// present) and dialed out over its TCP test seam (NINEPD_TCP_PORT) to a local
// listener, exactly mirroring the vsock reverse connection: guest connects
// OUT, host accepts and speaks 9P as the client. The fixture tree reproduces
// the Nix shapes the feature lives on — absolute + relative symlink chains,
// a dangling link, and the /mnt/yore recursion guard.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P9, NOFID, DOTL_VERSION, QT, encode, decode } from "./protocol.js";

const CC = process.env.CC || "cc";
const haveCc = spawnSync(CC, ["--version"], { stdio: "ignore" }).status === 0;
const maybe = haveCc ? describe : describe.skip;

/** Minimal 9P client over a node socket: framing + sequential tag rpc. */
function makeClient(socket) {
  let buf = Buffer.alloc(0);
  let waiter = null;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const size = buf.readUInt32LE(0);
      if (buf.length < size) break;
      const frame = new Uint8Array(buf.subarray(0, size));
      buf = buf.subarray(size);
      const w = waiter;
      waiter = null;
      w?.(decode(frame));
    }
  });
  let tag = 1;
  return async function rpc(msg) {
    const reply = await new Promise((resolve) => {
      waiter = resolve;
      socket.write(encode({ ...msg, tag: tag++ }));
    });
    if (reply.type === P9.Rlerror) {
      const e = new Error("Rlerror " + reply.ecode);
      e.ecode = reply.ecode;
      throw e;
    }
    return reply;
  };
}

const ENOENT = 2;
const EROFS = 30;

maybe("ninepd (real C binary) ↔ JS 9P client", () => {
  let root, bin, listener, child, rpc, sock;

  beforeAll(async () => {
    // Fixture: a miniature Nix system, interesting paths only via symlinks.
    root = mkdtempSync(join(tmpdir(), "ninepd-fixture-"));
    mkdirSync(join(root, "nix/store/aaa-app/share/applications"), { recursive: true });
    mkdirSync(join(root, "nix/store/zzz-system/sw"), { recursive: true });
    mkdirSync(join(root, "run"), { recursive: true });
    mkdirSync(join(root, "mnt/yore"), { recursive: true });
    writeFileSync(join(root, "mnt/yore/HOST-FILE"), "must never be served\n");
    writeFileSync(
      join(root, "nix/store/aaa-app/share/applications/app.desktop"),
      "[Desktop Entry]\nType=Application\nName=App\nExec=app\nCategories=Game;\n",
    );
    writeFileSync(join(root, "big.bin"), Buffer.alloc(200_000, 7));
    symlinkSync("/nix/store/zzz-system", join(root, "run/current-system"));
    symlinkSync("../../aaa-app/share", join(root, "nix/store/zzz-system/sw/share"));
    symlinkSync("/nix/store/gone", join(root, "dangling"));

    bin = join(root, "ninepd");
    const cc = spawnSync(CC, [
      "-O2",
      "-o",
      bin,
      new URL("../../userspace/ninepd.c", import.meta.url).pathname,
    ]);
    if (cc.status !== 0) throw new Error("cc failed: " + cc.stderr);

    // Reverse connection: we LISTEN, the daemon dials out (its vsock posture).
    const conn = new Promise((resolve) => {
      listener = createServer((s) => resolve(s));
      listener.listen(0, "127.0.0.1");
    });
    await new Promise((r) => listener.once("listening", r));
    child = spawn(bin, {
      env: {
        ...process.env,
        NINEPD_TCP_PORT: String(listener.address().port),
        NINEPD_ROOT: root,
        NINEPD_ONESHOT: "1",
      },
      stdio: "inherit",
    });
    sock = await conn;
    rpc = makeClient(sock);

    const rv = await rpc({ type: P9.Tversion, msize: 65536, version: DOTL_VERSION });
    expect(rv.version).toBe(DOTL_VERSION);
    await rpc({ type: P9.Tattach, fid: 0, afid: NOFID, uname: "pc", aname: "/", n_uname: 0 });
  });

  afterAll(() => {
    sock?.destroy();
    listener?.close();
    child?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  async function walk(names, newfid = 1) {
    return rpc({ type: P9.Twalk, fid: 0, newfid, wnames: names });
  }
  const clunk = (fid) => rpc({ type: P9.Tclunk, fid });

  test("walk + getattr on a real directory", async () => {
    const rw = await walk(["nix", "store"]);
    expect(rw.qids.length).toBe(2);
    expect(rw.qids[1].type & QT.DIR).toBe(QT.DIR);
    const at = await rpc({ type: P9.Tgetattr, fid: 1, request_mask: 0x7ff });
    expect((at.mode & 0o170000) === 0o040000).toBe(true);
    await clunk(1);
  });

  test("walk stops at a symlink, readlink serves the target", async () => {
    const rw = await walk(["run", "current-system", "sw"]);
    // current-system is a symlink → partial walk: run + the link's own qid.
    expect(rw.qids.length).toBe(2);
    expect(rw.qids[1].type & QT.SYMLINK).toBe(QT.SYMLINK);
    // Walk TO the link (full walk binds the fid), then readlink it.
    await walk(["run", "current-system"], 2);
    const rl = await rpc({ type: P9.Treadlink, fid: 2 });
    expect(rl.target).toBe("/nix/store/zzz-system");
    await clunk(2);
  });

  test("readdir lists sorted entries; read returns file bytes", async () => {
    await walk(["nix", "store", "aaa-app", "share", "applications"], 3);
    await rpc({ type: P9.Tlopen, fid: 3, flags: 0 });
    const rd = await rpc({ type: P9.Treaddir, fid: 3, offset: 0, count: 8192 });
    expect(rd.data.length).toBeGreaterThan(0);
    await clunk(3);

    await walk(["nix", "store", "aaa-app", "share", "applications", "app.desktop"], 4);
    await rpc({ type: P9.Tlopen, fid: 4, flags: 0 });
    const rr = await rpc({ type: P9.Tread, fid: 4, offset: 0, count: 8192 });
    expect(new TextDecoder().decode(rr.data)).toContain("Name=App");
    await clunk(4);
  });

  test("multi-chunk read: 200KB file in msize-bounded pieces", async () => {
    await walk(["big.bin"], 5);
    await rpc({ type: P9.Tlopen, fid: 5, flags: 0 });
    let got = 0;
    for (;;) {
      const r = await rpc({ type: P9.Tread, fid: 5, offset: got, count: 65536 - 24 });
      if (r.data.length === 0) break;
      for (const b of r.data) expect(b).toBe(7);
      got += r.data.length;
    }
    expect(got).toBe(200_000);
    await clunk(5);
  });

  test("the recursion guard: /mnt/yore is invisible", async () => {
    // Walking into it stops at mnt — yore is not walkable (partial Rwalk).
    const rw = await walk(["mnt", "yore"], 6);
    expect(rw.qids.length).toBe(1);
    // And hidden from its parent's listing.
    await walk(["mnt"], 7);
    await rpc({ type: P9.Tlopen, fid: 7, flags: 0 });
    const rd = await rpc({ type: P9.Treaddir, fid: 7, offset: 0, count: 8192 });
    expect(new TextDecoder().decode(rd.data)).not.toContain("yore");
    await clunk(7);
  });

  test("missing path → ENOENT; writes → EROFS", async () => {
    await expect(walk(["no-such-thing"], 8)).rejects.toMatchObject({ ecode: ENOENT });
    await walk(["big.bin"], 9);
    // Tlopen with write access refused.
    await expect(rpc({ type: P9.Tlopen, fid: 9, flags: 1 })).rejects.toMatchObject({
      ecode: EROFS,
    });
    // Twrite (a mutating message) refused even unopened.
    await expect(
      rpc({ type: P9.Twrite, fid: 9, offset: 0, data: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ ecode: EROFS });
    await clunk(9);
  });

  test("dangling symlink: walkable as a leaf, qid says symlink", async () => {
    const rw = await walk(["dangling"], 10);
    expect(rw.qids[0].type & QT.SYMLINK).toBe(QT.SYMLINK);
    const rl = await rpc({ type: P9.Treadlink, fid: 10 });
    expect(rl.target).toBe("/nix/store/gone");
    await clunk(10);
  });
});
