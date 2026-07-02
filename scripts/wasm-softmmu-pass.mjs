#!/usr/bin/env node
// wasm-softmmu-pass.mjs — CLI wrapper for the software-MMU instrumentation pass
// (#126 Track A / #128), the build-step entry point (a nix derivation runs this,
// mirroring how fpcast-emu / dynsym-inject are build steps). The pass logic +
// its tests live in runtime/softmmu-pass.js.
//
// Usage: node scripts/wasm-softmmu-pass.mjs IN.wasm OUT.wasm [--export-controls]
//   --export-controls  export __mmu_pt_base (global) + __mmu_translate (func)
//                      so the kernel/harness can set the page-table root.
import { readFileSync, writeFileSync } from "node:fs";
import { instrument } from "../runtime/softmmu-pass.js";

const args = process.argv.slice(2);
const exportControls = args.includes("--export-controls");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length !== 2) {
  console.error("usage: wasm-softmmu-pass.mjs IN.wasm OUT.wasm [--export-controls]");
  process.exit(2);
}
const [inp, out] = files;
const bytes = new Uint8Array(readFileSync(inp));
const result = instrument(bytes, { exportControls });
writeFileSync(out, result);
console.error(`wasm-softmmu-pass: instrumented ${inp} -> ${out} (${result.length} bytes)`);
