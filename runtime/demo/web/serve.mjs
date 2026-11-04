// serve.mjs — minimal no-store, cross-origin-isolated static server for the
// browser demo. COOP/COEP enable SharedArrayBuffer (the kernel needs it).
// Usage: node web/serve.mjs [port]  (serves runtime/web + ../ for ../index.js)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)); // runtime/ root
const PORT = Number(process.argv[2] || 8090);
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".gz": "application/gzip",
  ".css": "text/css",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let p = normalize(decodeURIComponent(url.pathname));
  // Redirect bare root or directory paths to their index.html.
  if (p === "/" || p === "" || p.endsWith("/")) {
    p = (p === "/" || p === "" ? "/demo/web/" : p) + "index.html";
  }
  const file = ROOT + p.replace(/^\/+/, "");
  try {
    let buf = await readFile(file);
    // The runtime is TypeScript with only erasable syntax: strip the types
    // so the browser gets JavaScript (Node does the same when it imports it).
    if (extname(file) === ".ts") buf = Buffer.from(stripTypeScriptTypes(buf.toString("utf8")));
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end("not found");
  }
}).listen(PORT, () => console.log(`linux-wasm demo: http://localhost:${PORT}/demo/web/`));
