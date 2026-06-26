// page2-applog.mjs — Phase-1: capture the GTK app's OWN stderr (/tmp/wf.log) with
// GLib/GDK debug around the Page-2 switch. The app's warnings/criticals + frame-clock
// trace should reveal what the in-guest main loop is doing when it hangs. Reads the
// log via the terminal (JS-focused, since the GTK canvas overlays #term). Exit 0.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8128,
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
  let up = false;
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    up = await page.evaluate(() => /[#$%]/.test(window._termLog || ""));
    if (up) break;
  }
  if (!up) {
    console.log("[applog] INCONCLUSIVE — no prompt");
    process.exit(0);
  }
  console.log("[applog] prompt up");

  const focusTerm = () => page.evaluate(() => document.getElementById("term")?.focus());
  const type = async (s) => {
    await focusTerm();
    await page.keyboard.type(s);
    await page.keyboard.press("Enter");
  };
  const termRead = () => page.evaluate(() => window._termLog || "");
  const dumpLog = async (mark) => {
    await type(`echo LG_${mark}; tail -50 /tmp/wf.log; echo LGEND_${mark}`);
    await sleep(2500);
    const log = await termRead();
    const a = log.lastIndexOf("LG_" + mark);
    const b = log.lastIndexOf("LGEND_" + mark);
    return a >= 0 && b > a ? log.slice(a, b) : "(not found) tail:\n" + log.slice(-1500);
  };

  // Launch with GLib/GDK debug. GDK_DEBUG=frames traces the frame clock; if it
  // stops ticking after Page 2, the frame clock is stuck. G_MESSAGES_DEBUG=all
  // surfaces every GLib/Gtk warning+critical.
  await type(
    "G_MESSAGES_DEBUG=all GDK_DEBUG=frames,events gtk3-widget-factory >/tmp/wf.log 2>&1 &",
  );

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
    console.log("[applog] no GTK window");
    process.exit(0);
  }
  console.log(`[applog] window ${JSON.stringify(box)}`);
  const click = async (lx, ly) => {
    await page.mouse.move(Math.round(box.x + lx), Math.round(box.y + ly));
    await sleep(120);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await sleep(800);
  };

  await sleep(1200);
  console.log("\n===== APP LOG: BEFORE Page2 =====\n" + (await dumpLog("BEFORE")));

  await click(700, 43); // Page 2 tab
  await sleep(2500);
  console.log("[applog] switched to Page 2");
  console.log("\n===== APP LOG: AFTER Page2 switch =====\n" + (await dumpLog("AFTER")));

  await click(200, 150); // a page-2 widget
  await sleep(1500);
  console.log("\n===== APP LOG: AFTER page2 click =====\n" + (await dumpLog("CLICK")));

  console.log("[applog] done");
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);
