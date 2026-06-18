// smoke.mjs — Playwright smoke test for the browser demo.
// Starts serve.mjs on port 8090, navigates to the demo page, waits for a
// shell prompt, types `echo WEB_OK` + Enter, asserts WEB_OK appears, and
// screenshots to web/demo.png. Exits 0 on success, non-zero on failure.
//
// Usage: node web/smoke.mjs   (run from runtime/)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const PORT = 8090;
const TIMEOUT_MS = 120_000;
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
  // Start the dev server.
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

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();

    // Navigate to the demo.
    await page.goto(`http://localhost:${PORT}/web/`, { waitUntil: "domcontentloaded" });

    console.log("Page loaded, waiting for shell prompt…");

    // Poll window._termLog for a shell prompt (#, $, or %).
    await waitFor(
      () =>
        page.evaluate(() => {
          const log = window._termLog || "";
          return /[#$%]/.test(log) ? log : null;
        }),
      TIMEOUT_MS,
    );
    console.log("Shell prompt detected.");

    // Click the terminal to give it keyboard focus, then type the command.
    await page.click("#term");
    await page.keyboard.type("echo WEB_OK");
    await page.keyboard.press("Enter");

    // Wait for WEB_OK to appear in the terminal output.
    await waitFor(
      () =>
        page.evaluate(() => {
          const log = window._termLog || "";
          return log.includes("WEB_OK") ? log : null;
        }),
      30_000,
    );
    console.log("WEB_OK received.");

    // Screenshot the terminal.
    const screenshotPath = join(HERE, "demo.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved to ${screenshotPath}`);

    console.log("PASS");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
