import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

// A fake R2 bucket: keys → string bodies. get() returns an R2-object-like value.
function fakeEnv(objects) {
  return {
    PREVIEWS: {
      async get(key) {
        if (!(key in objects)) return null;
        return { body: objects[key], httpEtag: `"etag-${key}"` };
      },
    },
  };
}

const call = (env, path) =>
  worker.fetch(new Request(`https://preview.example${path}`), env);

test("stamps cross-origin-isolation headers on every response", async () => {
  const res = await call(fakeEnv({}), "/");
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
});

test("serves a pr-<N> asset with content-type + short cache", async () => {
  const env = fakeEnv({ "pr-7/demo/web/main.js": "export {}" });
  const res = await call(env, "/pr-7/demo/web/main.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(await res.text(), "export {}");
});

test("serves a cas artifact as immutable octet-stream", async () => {
  const env = fakeEnv({ "cas/abc123/base.squashfs": "SQSH" });
  const res = await call(env, "/cas/abc123/base.squashfs");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("serves wasm as application/wasm", async () => {
  const env = fakeEnv({ "cas/abc123/vmlinux.wasm": "\0asm" });
  const res = await call(env, "/cas/abc123/vmlinux.wasm");
  assert.equal(res.headers.get("content-type"), "application/wasm");
});

test("directory path falls back to index.html with no-store", async () => {
  const env = fakeEnv({ "pr-7/demo/web/index.html": "<html>" });
  const res = await call(env, "/pr-7/demo/web/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("preview.json is no-store", async () => {
  const env = fakeEnv({ "pr-7/demo/web/preview.json": "{}" });
  const res = await call(env, "/pr-7/demo/web/preview.json");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("unknown layer → 404 (still isolated)", async () => {
  const res = await call(fakeEnv({}), "/secrets/x");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
});

test("missing key under a valid layer → 404", async () => {
  const res = await call(fakeEnv({}), "/pr-7/demo/web/nope.js");
  assert.equal(res.status, 404);
});

test("bare /pr-<N> redirects to /pr-<N>/", async () => {
  const res = await call(fakeEnv({}), "/pr-7");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "https://preview.example/pr-7/");
});
