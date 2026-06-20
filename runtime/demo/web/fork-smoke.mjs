// fork-smoke.mjs — Playwright browser test for real fork() in the browser (#28).
// Boots the demo (nix system) in headless chromium, waits for a shell prompt,
// runs /bin/fork-returns-twice (baked into the initramfs), and asserts the
// asyncify double return + private memory landed IN THE BROWSER (Web Workers +
// SharedArrayBuffer), not just under Node. Exits 0 on PASS, non-zero on failure.
//
// Usage: node web/fork-smoke.mjs   (run from runtime/, web/artifacts symlinked)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

// Resolve an installed chromium even when the playwright npm version expects a
// newer browser build than what's cached (download skipped in this env). Prefer
// PLAYWRIGHT_EXECUTABLE; else glob ~/.cache/ms-playwright for any headless_shell
// or chrome binary. Returns undefined to fall back to playwright's own resolver.
function resolveChromium() {
  if (process.env.PLAYWRIGHT_EXECUTABLE) return process.env.PLAYWRIGHT_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const candidates = [];
  for (const d of readdirSync(base)) {
    if (!d.startsWith("chromium")) continue;
    for (const exe of ["chrome-linux/headless_shell", "chrome-linux/chrome"]) {
      const p = join(base, d, exe);
      if (existsSync(p)) candidates.push(p);
    }
  }
  return candidates.sort().pop();
}

const PORT = 8093;
const BOOT_TIMEOUT_MS = 180_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

async function waitFor(fn, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function main() {
  const server = spawn(process.execPath, [join(HERE, "serve.mjs"), String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("localhost")) resolve(undefined);
    });
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`Server exited with ${code}`)));
  });

  const executablePath = resolveChromium();
  if (executablePath) console.log(`Using chromium at ${executablePath}`);
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (/error|panic|fork|asyncify/i.test(t)) console.log("  [page]", t);
    });
    // Busybox-only boot (?nonix) — fast, and the fork acceptance programs live in
    // the initramfs so the /nix overlay isn't needed.
    await page.goto(`http://localhost:${PORT}/web/?nonix`, { waitUntil: "domcontentloaded" });
    console.log("Page loaded, waiting for shell prompt…");

    // Wait until a shell prompt appears anywhere in the log (root '#').
    await waitFor(
      () =>
        page.evaluate(() => {
          const log = window._termLog || "";
          if (/panic/i.test(log)) throw new Error("BOOT PANIC");
          return /#/.test(log) ? log : null;
        }),
      BOOT_TIMEOUT_MS,
    );
    console.log("Shell prompt detected.");
    await page.click("#term");

    // Run the fork program. The shell may not have finished wiring stdin the
    // instant the prompt printed, so re-issue the command until its output shows.
    const log = await waitFor(
      async () => {
        const seen = await page.evaluate(() => {
          const l = window._termLog || "";
          return /FORK PARENT child_pid=\d+/.test(l) && /FORK CHILD ret=0/.test(l) ? l : null;
        });
        if (seen) return seen;
        await page.keyboard.type("/bin/fork-returns-twice");
        await page.keyboard.press("Enter");
        return null;
      },
      60_000,
      4000,
    );

    // Validate the double return + private memory divergence from the captured log.
    const child = /FORK CHILD ret=0 witness=0x([0-9a-f]+)/.exec(log);
    const parent = /FORK PARENT child_pid=(\d+) witness=0x([0-9a-f]+) childexit=(\d+)/.exec(log);
    const checks = [
      ["browser: fork() returned 0 in the CHILD", !!child],
      ["browser: fork() returned child pid in the PARENT", !!parent && Number(parent[1]) > 0],
      ["browser: private memory — child witness 0x10c", child && child[1] === "10c"],
      ["browser: private memory — parent witness 0x1b0 (diverged)", parent && parent[2] === "1b0"],
      ["browser: waitpid child exit status 7", parent && Number(parent[3]) === 7],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
      ok = ok && !!pass;
    }

    await page.screenshot({ path: join(HERE, "fork-demo.png"), fullPage: true });
    console.log(`Screenshot saved to ${join(HERE, "fork-demo.png")}`);

    if (!ok) throw new Error("fork double-return assertions failed in the browser");
    console.log("PASS — real fork() returns twice with private memory IN THE BROWSER");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
