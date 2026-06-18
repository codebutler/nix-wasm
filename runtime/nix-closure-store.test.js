// @ts-nocheck
import { describe, test, expect } from "bun:test";
import { createNixClosureStore } from "./nix-closure-store.js";

// A tiny fake manifest server: createNixClosureStore takes a manifestUrl, so we
// pass a data: URL (fetch supports it) carrying the JSON.
function manifestUrl(obj) {
  return "data:application/json," + encodeURIComponent(JSON.stringify(obj));
}
const b64 = (s) => Buffer.from(s).toString("base64");

describe("createNixClosureStore", () => {
  test("serves files, dirs, and symlinks at real store paths", async () => {
    const store = await createNixClosureStore(
      manifestUrl({
        "store/abc-foo": { t: "d" },
        "store/abc-foo/bin": { t: "d" },
        "store/abc-foo/bin/hello": { t: "f", x: true, d: b64("#!/bin/sh\necho hi\n") },
        "var/nix/profiles/system": { t: "l", to: "store/abc-foo" },
      }),
    );

    // file contents (mounted at /nix -> export root, so "/store/.." is "/nix/store/..")
    const blob = await store.readBlob("/store/abc-foo/bin/hello");
    // readBlob returns a Blob (server.js sizeOf needs .size); decode via arrayBuffer.
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toContain("echo hi");

    // dir listing
    const ls = await store.list("/store/abc-foo/bin");
    expect(ls.map((r) => r.name)).toContain("hello");

    // symlink: stat is a symlink, readlink returns the target
    const st = await store.stat("/var/nix/profiles/system");
    expect(st.type).toBe("alias");
    expect(st.target).toBe("store/abc-foo");
  });

  test("creates missing parent directories (manifest omits some parents)", async () => {
    // 'var', 'var/nix', 'var/nix/profiles' are NOT in the manifest — only the leaf.
    const store = await createNixClosureStore(
      manifestUrl({
        "var/nix/profiles/system": { t: "l", to: "/nix/store/x" },
      }),
    );
    // listing intermediate dirs must work (they were auto-created)
    const ls = await store.list("/var/nix/profiles");
    expect(ls.map((r) => r.name)).toContain("system");
    const st = await store.stat("/var/nix");
    expect(st.type).toBe("folder");
  });

  test("is read-only (EROFS on write)", async () => {
    const store = await createNixClosureStore(manifestUrl({ "store/x": { t: "d" } }));
    await expect(store.write("/store/x/y", new Uint8Array())).rejects.toThrow(/EROFS/);
  });

  test("readBlob returns a Blob (server reads .size)", async () => {
    const bytes = "hello world";
    const store = await createNixClosureStore(
      manifestUrl({
        "store/x": { t: "d" },
        "store/x/f": { t: "f", x: false, d: b64(bytes) },
      }),
    );
    const blob = await store.readBlob("/store/x/f");
    expect(typeof blob.size).toBe("number");
    expect(blob.size).toBe(bytes.length);
  });

  test("large files are lazy: stat reports size without fetching; readBlob fetches store-content/<h> once", async () => {
    const big = "X".repeat(1000);
    const h = "deadbeefcafe";
    const base = "https://closure.test/store.json";
    const realFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url) === base) {
        return new Response(
          JSON.stringify({
            "store/x": { t: "d" },
            "store/x/big": { t: "f", x: true, s: big.length, h },
          }),
          { status: 200 },
        );
      }
      if (String(url) === "https://closure.test/store-content/" + h) {
        return new Response(new TextEncoder().encode(big), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    try {
      const progress = [];
      const store = await createNixClosureStore(base, { onProgress: (e) => progress.push(e) });
      // Creation fetched ONLY the manifest — not the content blob.
      expect(fetched).toEqual([base]);
      // stat reports the manifest-declared size, still WITHOUT fetching content
      // (so server.js Tgetattr/sizeOf never forces a download).
      const st = await store.stat("/store/x/big");
      expect(st.size).toBe(big.length);
      expect(fetched).toEqual([base]);
      // readBlob fetches the content lazily and returns the real bytes.
      const blob = await store.readBlob("/store/x/big");
      expect(blob.size).toBe(big.length);
      expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(big);
      expect(fetched).toContain("https://closure.test/store-content/" + h);
      // progress reported the right total and a terminal done.
      expect(progress.some((p) => p.total === big.length)).toBe(true);
      expect(progress.some((p) => p.done)).toBe(true);
      // A second read is served from cache — no second content fetch.
      const n = fetched.length;
      await store.readBlob("/store/x/big");
      expect(fetched.length).toBe(n);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("move is read-only (EROFS)", async () => {
    const store = await createNixClosureStore(manifestUrl({ "store/x": { t: "d" } }));
    await expect(store.move("/store/x", "/store/y")).rejects.toThrow(/EROFS/);
  });

  test("missing/unfetchable manifest is non-fatal (returns null)", async () => {
    // A nonexistent file:// URL: fetch rejects (or returns !ok) — either way the
    // store degrades to null so the kernel still boots (guest /init falls back).
    const store = await createNixClosureStore("file:///nonexistent-closure-xyz.json");
    expect(store).toBeNull();
  });
});
