// tab-nav-events.mjs — reproduce the freeze (P1->P2 works, then tabs dead) WHILE
// capturing GDK_DEBUG=events, to see whether GTK still RECEIVES the post-switch tab
// clicks (and at what coordinates) but fails to act, vs input stopping. Dumps the
// GDK event log after the sequence. Exit 0.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8130,
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
    console.log("[tne] INCONCLUSIVE — no prompt");
    process.exit(0);
  }
  console.log("[tne] prompt up");
  const focusTerm = () => page.evaluate(() => document.getElementById("term")?.focus());
  const typeCmd = async (s) => {
    await focusTerm();
    await page.keyboard.type(s);
    await page.keyboard.press("Enter");
  };
  await typeCmd("GDK_DEBUG=events gtk3-widget-factory >/tmp/wf.log 2>&1 &");

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
    console.log("[tne] no GTK window");
    process.exit(0);
  }
  console.log(`[tne] window ${JSON.stringify(box)}`);
  const region = { x: Math.round(box.x), y: Math.round(box.y), width: Math.min(box.w, 1280 - box.x), height: Math.min(box.h, 820 - box.y) };
  const TAB = { 1: 537, 2: 658, 3: 779 };
  const clickTab = async (n) => {
    await page.mouse.move(Math.round(box.x + TAB[n]), Math.round(box.y + 45));
    await sleep(150);
    await page.mouse.down();
    await sleep(90);
    await page.mouse.up();
    await sleep(1300);
  };
  const shot = () => page.screenshot({ clip: region });

  let prev = await shot();
  const seq = [2, 1, 3];
  for (const n of seq) {
    await clickTab(n);
    const s = await shot();
    console.log(`[tne] -> Page ${n} (tabX=${TAB[n]}): changed=${Buffer.compare(prev, s) !== 0}`);
    writeFileSync(`/tmp/tne-page${n}.png`, s);
    prev = s;
  }

  // Dump the GDK event log — see which button presses GTK received and the coords.
  await typeCmd("echo EVDUMP; grep -E 'press|release|motion|frame|enter|leave|crossing' /tmp/wf.log | tail -60; echo EVEND");
  await sleep(3000);
  const log = await page.evaluate(() => window._termLog || "");
  const a = log.lastIndexOf("EVDUMP"),
    b = log.lastIndexOf("EVEND");
  console.log("\n===== GDK EVENT LOG (last 40 input events) =====\n" + (a >= 0 && b > a ? log.slice(a, b) : log.slice(-1800)));
  console.log("[tne] done");
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);
