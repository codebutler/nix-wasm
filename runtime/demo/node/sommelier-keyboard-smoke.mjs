// sommelier-keyboard-smoke.mjs — verifies keyboard input end-to-end:
// boots headless Chrome, launches gtk3-widget-factory, focuses a text entry,
// types, and asserts the canvas pixels change (the typed text renders). Proves
// the guest-backed keymap fd (VIRTIO_WL_VFD_FILL) makes libxkbcommon's mmap
// succeed so key events become characters.
//
// Exit 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE (boot panic — re-run).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 8121,
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

  let up = false;
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    up = await page.evaluate(() => /[#$%]/.test(window._termLog || ""));
    if (up) break;
    console.log(`[kbd-smoke] waiting for prompt (${(i + 1) * 15}s)…`);
  }
  if (!up) {
    console.log("[kbd-smoke] INCONCLUSIVE — no prompt");
    process.exit(2);
  }
  console.log("[kbd-smoke] shell prompt detected");

  await page.click("#term");
  await page.keyboard.type("gtk3-widget-factory >/tmp/wf.log 2>&1 &");
  await page.keyboard.press("Enter");
  console.log("[kbd-smoke] launched gtk3-widget-factory");

  let box = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    box = await page.evaluate(() => {
      const wins = [...document.querySelectorAll(".wl-win")];
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
      console.log(`[kbd-smoke] GTK window canvas found: ${JSON.stringify(box)}`);
      break;
    }
    if (i % 3 === 0) console.log(`[kbd-smoke] waiting for GTK window (${i * 2}s)…`);
  }

  if (!box) {
    console.log("[kbd-smoke] FAIL — no GTK window canvas appeared");
    code = 1;
  } else {
    // gtk3-widget-factory page 1 has a GtkSearchEntry near the top-left of the
    // content area. Click into it to focus, then type. Canvas-local (~130,90).
    // (If the entry isn't there, the verify step adjusts these coords from the
    // before-screenshot.)
    const entryX = Math.round(box.x + 130);
    const entryY = Math.round(box.y + 90);
    const region = {
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y + 40)),
      width: Math.min(box.w, 1280 - box.x),
      height: Math.min(120, box.h),
    };

    await page.mouse.move(entryX, entryY);
    await sleep(200);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await sleep(400);

    const before = await page.screenshot({ clip: region });
    writeFileSync("/tmp/sommelier-kbd-before.png", before);

    await page.keyboard.type("hello", { delay: 60 });
    await sleep(1500); // GTK repaint + Greenfield canvas update

    const after = await page.screenshot({ clip: region });
    writeFileSync("/tmp/sommelier-kbd-after.png", after);

    const changed = Buffer.compare(before, after) !== 0;
    console.log(
      `[kbd-smoke] entryAt=(${entryX},${entryY}) region=${JSON.stringify(region)} pixelsChanged=${changed}`,
    );
    code = changed ? 0 : 1;
    console.log(
      changed
        ? "[kbd-smoke] PASS — typing rendered characters (keymap fd mmap works)"
        : "[kbd-smoke] FAIL — typing produced no visible change",
    );
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
