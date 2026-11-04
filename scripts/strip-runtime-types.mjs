// strip-runtime-types.mjs — copy a runtime/ tree with every .ts module's types
// stripped, for hosts that serve files as they are (the PR preview's R2
// bucket). File names stay .ts: the modules import each other by those names.
//
// Usage: node scripts/strip-runtime-types.mjs <runtime dir> <out dir>
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: strip-runtime-types.mjs <runtime dir> <out dir>");
  process.exit(2);
}
const skip = (name) => name === "node_modules" || name === ".git";
cpSync(src, out, { recursive: true, filter: (p) => !p.split("/").some(skip) });

let n = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".ts")) {
      writeFileSync(p, stripTypeScriptTypes(readFileSync(p, "utf8")));
      n++;
    }
  }
};
walk(out);
console.error(`strip-runtime-types: ${n} modules`);
