import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL(".", import.meta.url));
const port = +(process.argv[2] || 8092);
createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    const body = readFileSync(dir + "harness.html");
    res.setHeader("Content-Type", "text/html");
    res.end(body);
  } catch (e) { res.statusCode = 404; res.end("404"); }
}).listen(port, () => console.log("harness http://localhost:" + port + "/"));
