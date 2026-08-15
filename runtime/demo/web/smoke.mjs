// smoke.mjs — Playwright BROWSER smoke for the demo: boot + dlopen workload.
//
// Boots the full nix system in headless Chromium (real COOP/COEP via
// serve.mjs), waits for a shell prompt, then runs the workload matrix:
//   1. `echo WEB_OK`      — shell round-trip (boot actually works)
//   2. `wl-anim &`        — changing wl_shm pixels reach the real compositor
//   3. `gtk3-demo &`      — the dlopen/dlsym + fpcast + wayland workload
//   4. `echo AFTER_OK`    — the shell (and kernel) survived the GUI apps
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

async function animatedSurfaceState(page) {
  return page.evaluate(() => {
    const win = [...document.querySelectorAll(".wl-win")].find(
      (candidate) => candidate.querySelector(".wl-win-title")?.textContent?.trim() === "anim",
    );
    const canvas = win?.querySelector("canvas");
    if (!canvas || canvas.width !== 240 || canvas.height !== 160) return null;

    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return null;

    // FNV-1a over compositor-visible RGBA bytes. Count each color as an
    // independent content check: wl-anim draws a 48x48 box (2,304 pixels) over
    // a 240x160 background (36,096 pixels), with no antialiasing.
    let hash = 0x811c9dc5;
    const colorCounts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      hash = Math.imul(hash ^ pixels[i], 0x01000193);
      hash = Math.imul(hash ^ pixels[i + 1], 0x01000193);
      hash = Math.imul(hash ^ pixels[i + 2], 0x01000193);
      hash = Math.imul(hash ^ pixels[i + 3], 0x01000193);
      const rgba = pixels[i] | (pixels[i + 1] << 8) | (pixels[i + 2] << 16) | (pixels[i + 3] << 24);
      colorCounts.set(rgba, (colorCounts.get(rgba) || 0) + 1);
    }
    return {
      hash: hash >>> 0,
      colorCounts: [...colorCounts.values()].sort((a, b) => a - b),
      width: canvas.width,
      height: canvas.height,
    };
  });
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

    // #11: wl-anim writes a moving box into ordinary guest wl_shm buffers.
    // Sommelier must copy each damaged region into its intermediate virtwl
    // allocation; Greenfield then imports that allocation and paints this
    // browser canvas. Two non-flat compositor-side frames with distinct hashes
    // prove the mmap+copy resynchronization path is both necessary and working.
    await page.keyboard.type("wl-anim >/tmp/wl-anim.log 2>&1 &");
    await page.keyboard.press("Enter");
    const hasExpectedPixels = (state) =>
      state?.colorCounts.length === 2 &&
      state.colorCounts[0] === 48 * 48 &&
      state.colorCounts[1] === 240 * 160 - 48 * 48;
    const firstFrame = await waitFor(async () => {
      const state = await animatedSurfaceState(page);
      return hasExpectedPixels(state) ? state : null;
    }, 60_000);
    const secondFrame = await waitFor(
      async () => {
        const state = await animatedSurfaceState(page);
        return hasExpectedPixels(state) && state.hash !== firstFrame.hash ? state : null;
      },
      15_000,
      100,
    );
    console.log(
      `wl_shm compositor frames changed: ${firstFrame.hash} -> ${secondFrame.hash} ` +
        `(${secondFrame.width}x${secondFrame.height}, pixel-counts=${secondFrame.colorCounts}).`,
    );

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
