// web-shims.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installFetchShim } from "./web-shims.mjs";

test("file:// fetch reads bytes, json, and 404s a missing file", async () => {
  installFetchShim();
  const dir = await mkdtemp(join(tmpdir(), "wsf-"));
  const p = join(dir, "x.json");
  await writeFile(p, '{"hello":"world"}');
  const url = pathToFileURL(p).href;

  const r = await fetch(url);
  assert.equal(r.ok, true);
  assert.deepEqual(await r.json(), { hello: "world" });
  assert.equal(new Uint8Array(await (await fetch(url)).arrayBuffer()).length, 17);

  const miss = await fetch(pathToFileURL(join(dir, "nope")).href);
  assert.equal(miss.ok, false);
  assert.equal(miss.status, 404);
});
