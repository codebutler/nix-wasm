// @ts-nocheck
// Tests for the read-only content-addressed /nix store VFS (Phase E/N1).
// Headless (bun): no kernel, no browser — just the VFS surface server.js drives.
import { test, expect, describe } from "bun:test";
import { createNixStore } from "./nix-store.js";

const bytes = (s) => new TextEncoder().encode(s);
const PKG = { name: "cbhello", version: "1.0", files: { "bin/cbhello": bytes("\0asm-fake-wasm") } };
// path within the store backend (the export root maps to /nix in the guest)
const backendPath = (storePath) => storePath.replace(/^\/nix/, "");

describe("nix-store (content-addressed, read-only)", () => {
  test("a package gets a hashed store path: <32 base32>-<name>-<version>", async () => {
    const store = await createNixStore([PKG]);
    expect(store.storePaths.length).toBe(1);
    expect(store.storePaths[0]).toMatch(/^\/nix\/store\/[0-9a-z]{32}-cbhello-1\.0$/);
    // Nix base32 alphabet excludes e, o, t, u.
    const hash = store.storePaths[0].slice("/nix/store/".length, "/nix/store/".length + 32);
    expect(hash).not.toMatch(/[eotu]/);
  });

  test("the package's files are readable through the store", async () => {
    const store = await createNixStore([PKG]);
    const bin = backendPath(store.storePaths[0]) + "/bin/cbhello";
    const st = await store.stat(bin);
    expect(st).toBeTruthy();
    expect(st.type).not.toBe("folder");
    expect(st.size).toBe(PKG.files["bin/cbhello"].length);
    const blob = await store.readBlob(bin);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PKG.files["bin/cbhello"]);
    // /store lists the package dir
    const listed = (await store.list("/store")).map((e) => e.name);
    expect(listed).toEqual([store.storePaths[0].slice("/nix/store/".length)]);
  });

  test("the store is read-only — mutations throw EROFS", async () => {
    const store = await createNixStore([PKG]);
    await expect(store.write("/store/evil", { type: "file", bytes: bytes("x") })).rejects.toThrow(
      /EROFS/,
    );
    await expect(store.mkdir("/store/evil")).rejects.toThrow(/EROFS/);
    const bin = backendPath(store.storePaths[0]) + "/bin/cbhello";
    await expect(store.remove(bin)).rejects.toThrow(/EROFS/);
  });

  test("the hash is content-addressed: deterministic, and content-sensitive", async () => {
    const a = await createNixStore([PKG]);
    const b = await createNixStore([PKG]);
    expect(a.storePaths[0]).toBe(b.storePaths[0]); // same content → same path

    const changed = {
      name: "cbhello",
      version: "1.0",
      files: { "bin/cbhello": bytes("different") },
    };
    const c = await createNixStore([changed]);
    expect(c.storePaths[0]).not.toBe(a.storePaths[0]); // different content → different hash
  });

  test("multi-file packages nest correctly and hash order-independently", async () => {
    const p1 = {
      name: "x",
      version: "0",
      files: { "bin/x": bytes("B"), "share/d.txt": bytes("A") },
    };
    const p2 = {
      name: "x",
      version: "0",
      files: { "share/d.txt": bytes("A"), "bin/x": bytes("B") },
    };
    const s1 = await createNixStore([p1]);
    const s2 = await createNixStore([p2]);
    expect(s1.storePaths[0]).toBe(s2.storePaths[0]); // insertion order doesn't change the hash
    const root = backendPath(s1.storePaths[0]);
    expect((await store_stat(s1, root + "/share/d.txt")).size).toBe(1);
    expect((await store_stat(s1, root + "/bin/x")).size).toBe(1);
  });
});

const store_stat = (s, p) => s.stat(p);
