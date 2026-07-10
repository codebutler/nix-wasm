// Phase 2 Task 1a — host asyncify build-path smoke.
//
// Asserts the host build path (.#asyncify-cc-smoke = cross.stdenv.cc + host
// wasm-opt --asyncify) produces a fork-capable guest module: it must import the
// dedicated unwind point env.capture_stack and EXPORT the asyncify control
// surface proven in the Task-0 spike. Pure static inspection of the .wasm — no
// boot required.
//
// Usage: ASYNCIFY_SMOKE=/nix/store/…-fork-smoke/bin/fork-smoke node --test runtime/node/asyncify-link.test.mjs
//   (or it resolves the path via `nix build .#asyncify-cc-smoke` if NIX is usable)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function resolveSmoke() {
  if (process.env.ASYNCIFY_SMOKE) return process.env.ASYNCIFY_SMOKE;
  const out = execSync(
    "nix --extra-experimental-features 'nix-command flakes' build .#asyncify-cc-smoke --no-link --print-out-paths",
    { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" },
  ).trim();
  return `${out}/bin/fork-smoke`;
}

const REQUIRED_EXPORTS = [
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state",
];

test("host asyncify path emits a fork-capable module", async () => {
  const bytes = readFileSync(resolveSmoke());
  const mod = await WebAssembly.compile(bytes);

  const exportNames = WebAssembly.Module.exports(mod).map((e) => e.name);
  for (const want of REQUIRED_EXPORTS) {
    assert.ok(exportNames.includes(want), `missing asyncify export: ${want}`);
  }

  const imports = WebAssembly.Module.imports(mod);
  assert.ok(
    imports.some((i) => i.module === "env" && i.name === "capture_stack"),
    "module must import env.capture_stack (the dedicated unwind point)",
  );
});
