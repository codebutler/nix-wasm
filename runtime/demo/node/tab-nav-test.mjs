// tab-nav-test.mjs — decisive: after switching to Page 2, can the notebook tabs be
// navigated at all? Tab switches change the ENTIRE page, so pixel-diff is reliable
// (unlike clicking individual page-2 widgets). Sequence: P1 -> P2 -> P1 -> P3 -> P2.
// If every transition changes pixels, the demo does NOT freeze. Saves a shot per step.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8129,
  RT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [RT + "/demo/web/serve.mjs", String(PORT)], {
  cwd: RT,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((res, rej) => {
  server.stdout.on("data", (c) => String(c).includes("localhost") && res());
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
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/demo/web/`, { waitUntil: "domcontentloaded" });
  let upOk = false;
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    upOk = await page.evaluate(() => /[#$%]/.test(window._termLog || ""));
    if (upOk) break;
  }
  if (!upOk) {
    console.log("[tab] INCONCLUSIVE — no prompt");
    process.exit(0);
  }
  console.log("[tab] prompt up");
  await page.evaluate(() => document.getElementById("term")?.focus());
  await page.keyboard.type("gtk3-widget-factory >/tmp/wf.log 2>&1 &");
  await page.keyboard.press("Enter");

  let box = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    box = await page.evaluate(() => {
      const w = [...document.querySelectorAll(".wl-win")].find((w) => {
        const c = w.querySelector("canvas");
        return c && c.width > 200 && c.height > 200;
      });
      if (!w) return null;
      const r = w.querySelector("canvas").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (box) break;
  }
  if (!box) {
    console.log("[tab] no GTK window");
    process.exit(0);
  }
  console.log(`[tab] window ${JSON.stringify(box)}`);

  const region = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.min(box.w, 1280 - box.x),
    height: Math.min(box.h, 820 - box.y),
  };
  // Tab centers (canvas-local) measured from the rendered p2-B.png tab bar.
  const TAB = { 1: 537, 2: 658, 3: 779 };
  const clickTab = async (n) => {
    await page.mouse.move(Math.round(box.x + TAB[n]), Math.round(box.y + 45));
    await sleep(150);
    await page.mouse.down();
    await sleep(90);
    await page.mouse.up();
    await sleep(1500);
  };
  const shot = () => page.screenshot({ clip: region });

  let prev = await shot();
  writeFileSync("/tmp/tab-start.png", prev);
  const seq = [2, 1, 3, 2];
  for (let i = 0; i < seq.length; i++) {
    await clickTab(seq[i]);
    const s = await shot();
    writeFileSync(`/tmp/tab-${i + 1}-page${seq[i]}.png`, s);
    const changed = Buffer.compare(prev, s) !== 0;
    console.log(`[tab] -> Page ${seq[i]}: pixelsChanged=${changed}`);
    prev = s;
  }
  console.log("[tab] done — if every step is true, tabs navigate freely (NO freeze)");
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);
