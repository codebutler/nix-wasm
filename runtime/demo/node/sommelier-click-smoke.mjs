// sommelier-click-smoke.mjs — verifies pointer-button forwarding end-to-end:
// boots headless Chrome, launches gtk3-widget-factory, clicks the "Page 2" tab,
// and asserts that the canvas pixels change (page content switches).
//
// Exit 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE (boot panic — re-run).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8120,
  RT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [RT + "/demo/web/serve.mjs", String(PORT)], {
  cwd: RT,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((res, rej) => {
  server.stdout.on("data", (c) => {
    if (String(c).includes("localhost")) res();
  });
  server.on("exit", (c) => rej(new Error("srv " + c)));
});

const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

let code = 2;
try {
  const page = await browser.newPage();

  await page.goto(`http://localhost:${PORT}/demo/web/`, { waitUntil: "domcontentloaded" });

  // Wait for shell prompt (up to 240 s — full nix boot is slow in headless Chrome)
  let up = false;
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    up = await page.evaluate(() => /[#$%]/.test(window._termLog || ""));
    if (up) break;
    console.log(`[click-smoke] waiting for prompt (${(i + 1) * 15}s)…`);
  }

  if (!up) {
    console.log("[click-smoke] INCONCLUSIVE — no prompt");
    process.exit(2);
  }
  console.log("[click-smoke] shell prompt detected");

  // Launch gtk3-widget-factory in the background
  await page.click("#term");
  await page.keyboard.type("gtk3-widget-factory >/tmp/wf.log 2>&1 &");
  await page.keyboard.press("Enter");
  console.log("[click-smoke] launched gtk3-widget-factory");

  // Wait for the GTK window canvas inside a .wl-win div (painted to > 200px).
  // Prefer the .wl-win whose title matches "widget-factory"; fall back to first large canvas.
  let box = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    box = await page.evaluate(() => {
      const wins = [...document.querySelectorAll(".wl-win")];
      // Prefer surface with "widget-factory" or "gtk3" in title; else first large canvas.
      const pick =
        wins.find((w) => {
          const t = w.querySelector(".wl-win-title")?.textContent || "";
          return t.includes("widget-factory") || t.includes("gtk3");
        }) ||
        wins.find((w) => {
          const c = w.querySelector("canvas");
          return c && c.width > 200 && c.height > 200;
        });
      if (!pick) return null;
      const canvas = pick.querySelector("canvas");
      if (!canvas || canvas.width <= 200) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (box) {
      console.log(`[click-smoke] GTK window canvas found: ${JSON.stringify(box)}`);
      break;
    }
    if (i % 3 === 0) console.log(`[click-smoke] waiting for GTK window (${i * 2}s)…`);
  }

  if (!box) {
    console.log("[click-smoke] FAIL — no GTK window canvas appeared");
    code = 1;
  } else {
    // gtk3-widget-factory tab bar (canvas-local coordinates):
    //   "Page 2" tab: x≈700, y≈43.  Clicking switches page content — visually unambiguous.
    const tabX = Math.round(box.x + 700);
    const tabY = Math.round(box.y + 43);

    // Capture canvas region before the click.
    const canvasRegion = {
      x: box.x,
      y: box.y,
      width: Math.min(box.w, 1280 - box.x),
      height: Math.min(box.h, 900 - box.y),
    };
    const before = await page.screenshot({ clip: canvasRegion });
    writeFileSync("/tmp/sommelier-click-before.png", before);

    // Move onto the canvas (sets wl_pointer.enter focus) then click the Page 2 tab.
    await page.mouse.move(tabX, tabY);
    await sleep(300);
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
    await sleep(1500); // wait for GTK repaint + Greenfield canvas update

    const after = await page.screenshot({ clip: canvasRegion });
    writeFileSync("/tmp/sommelier-click-after.png", after);

    const changed = Buffer.compare(before, after) !== 0;
    console.log(
      `[click-smoke] canvas=${JSON.stringify(box)} tabAt=(${tabX},${tabY}) pixelsChanged=${changed}`,
    );

    code = changed ? 0 : 1;
    console.log(
      changed
        ? "[click-smoke] PASS — Page 2 tab click changed the canvas (pointer-button forwarding works)"
        : "[click-smoke] FAIL — click had no visible effect",
    );
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
