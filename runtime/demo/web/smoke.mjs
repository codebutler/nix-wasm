// smoke.mjs — Playwright BROWSER smoke for the demo: boot + dlopen workload.
//
// Boots the full nix system in headless Chromium (real COOP/COEP via
// serve.mjs), waits for a shell prompt, then runs the workload matrix:
//   1. `echo WEB_OK`      — shell round-trip (boot actually works)
//   2. `gtk3-demo &`      — the dlopen/dlsym + fpcast + wayland workload
//   3. `echo AFTER_OK`    — the shell (and kernel) survived the GUI app
// The run FAILS if any `[user-exec] Wasm crash` (or SAB/TextDecoder rejection)
// appears on the page console at ANY point — that is the whole point: two
// browser-only engine bugs (nix-wasm#137 SAB decode, #139 canonical dynSlot
// thunks) shipped through green Node smokes because nothing booted the guest
// in a BROWSER with a dlopen workload (issue #138). Screenshots to demo.png.
//
// Usage: node demo/web/smoke.mjs   (SMOKE_PORT overrides the port)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const PORT = Number(process.env.SMOKE_PORT || 8090);
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

  const browser = await chromium.launch({
    // Software GL: greenfield needs WebGL and CI runners have no GPU; the
    // SwiftShader fallback is deterministic everywhere (recent Chromium gates
    // it behind --enable-unsafe-swiftshader).
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();

    // Any engine crash on the console fails the smoke, whenever it happens.
    const crashLines = [];
    page.on("console", (m) => {
      const t = m.text();
      if (
        /\[user-exec\] Wasm crash|function signature mismatch|must not be shared|\[kernel worker error\]/.test(
          t,
        )
      ) {
        crashLines.push(t.slice(0, 300));
      }
    });

    // Navigate to the demo.
    await page.goto(`http://localhost:${PORT}/demo/web/`, { waitUntil: "domcontentloaded" });

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

    // dlopen workload: gtk3-demo dlsym's pango/harfbuzz symbols and runs a
    // full GTK UI through sommelier/greenfield. Run it in the background,
    // give it time to reach text shaping (where #137/#139 crashed), then
    // prove the shell still answers.
    await page.keyboard.type("gtk3-demo &");
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 20_000));
    await page.keyboard.type("echo AFTER_OK");
    await page.keyboard.press("Enter");
    await waitFor(
      () =>
        page.evaluate(() => {
          const log = window._termLog || "";
          return log.includes("AFTER_OK") ? log : null;
        }),
      30_000,
    );
    console.log("AFTER_OK received (shell alive alongside gtk3-demo).");

    if (crashLines.length) {
      throw new Error(`engine crash lines on the page console:\n${crashLines.join("\n")}`);
    }
    console.log("No engine crash lines.");

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
