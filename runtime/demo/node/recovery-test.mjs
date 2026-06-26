// recovery-test.mjs — after the freeze (P1->P2 works, then tabs dead), test whether
// forcing a pointer LEAVE + ENTER (move far out of the window, then back) un-sticks
// tab clicking. If it recovers, the freeze is a wedged pointer focus/grab state that
// an `enter` resets — pinning the root cause. Exit 0.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8131,
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
    console.log("[rec] INCONCLUSIVE — no prompt");
    process.exit(0);
  }
  console.log("[rec] prompt up");
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
    console.log("[rec] no GTK window");
    process.exit(0);
  }
  console.log(`[rec] window ${JSON.stringify(box)}`);
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
  const changedSince = async (p) => Buffer.compare(p, await shot()) !== 0;

  let prev = await shot();
  await clickTab(2);
  console.log(`[rec] P1->P2: changed=${await changedSince(prev)}`);
  prev = await shot();

  await clickTab(1);
  const frozen = !(await changedSince(prev));
  console.log(`[rec] P2->P1 (expect frozen): changed=${!frozen}`);
  prev = await shot();

  // ---- Recovery attempt: force LEAVE (move far out) + ENTER (move back in) ----
  console.log("[rec] forcing pointer LEAVE (move to 3,3, outside the GTK window) then re-enter…");
  await page.mouse.move(3, 3); // top-left of page, outside the GTK window canvas
  await sleep(600);
  await page.mouse.move(Math.round(box.x + 300), Math.round(box.y + 400)); // re-enter into window body
  await sleep(400);
  await page.mouse.move(Math.round(box.x + 200), Math.round(box.y + 300)); // a second motion (first after enter is swallowed by setFocus)
  await sleep(400);

  // Now try the tabs again.
  await clickTab(1);
  const recov1 = await changedSince(prev);
  console.log(`[rec] AFTER leave/enter, P?->P1: changed=${recov1}`);
  writeFileSync("/tmp/rec-afterP1.png", await shot());
  prev = await shot();

  await clickTab(3);
  const recov3 = await changedSince(prev);
  console.log(`[rec] AFTER leave/enter, ->P3: changed=${recov3}`);
  writeFileSync("/tmp/rec-afterP3.png", await shot());

  console.log(
    `[rec] RESULT: ${recov1 || recov3 ? "RECOVERED by leave/enter → wedged focus/grab state" : "NOT recovered by leave/enter → deeper hang"}`,
  );
  console.log("[rec] done");
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);
