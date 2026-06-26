// page2-guest-probe.mjs — Phase-1: probe the GUEST GTK process state when Page 2
// "freezes", to distinguish an in-guest hang (real bug) from a headless rAF
// render-stall artifact. The terminal is a separate process from the frozen GTK
// window, so we can type shell commands and read /proc for the gtk process:
//   State (R spinning / S blocked / D uninterruptible), wchan (kernel fn it's
//   parked in), stack. Also re-checks liveness by probing BEFORE and AFTER the
//   Page-2 switch. Exit 0 always.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8126,
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
    console.log("[probe] INCONCLUSIVE — no prompt");
    process.exit(0);
  }
  console.log("[probe] prompt up");

  // A shell helper that dumps the gtk3-widget-factory process kernel state.
  // MARK lets us slice fresh output out of the (cumulative) terminal log.
  const PROBE =
    'echo MK_$1; for d in /proc/[0-9]*; do n=$(cat $d/comm 2>/dev/null); ' +
    'case "$n" in *idget*|*gtk*) echo "P $d $n"; ' +
    'grep -E "^State" $d/status 2>/dev/null; ' +
    'echo -n "wchan="; cat $d/wchan 2>/dev/null; echo; ' +
    "echo stack:; cat $d/stack 2>/dev/null; echo ---;; esac; done; echo MKEND_$1";

  const termRead = () => page.evaluate(() => window._termLog || "");
  // The GTK window canvas overlays #term and intercepts pointer events, so a
  // real click can't reach the terminal. Focus the contenteditable directly via
  // JS — browser key events then go to the terminal, not the wayland canvas.
  const focusTerm = () =>
    page.evaluate(() => {
      const t = document.getElementById("term");
      t?.focus();
      return document.activeElement?.id || "";
    });
  const runProbe = async (mark) => {
    await focusTerm();
    await page.keyboard.type(PROBE.replace(/\$1/g, String(mark)));
    await page.keyboard.press("Enter");
    await sleep(2500);
    const log = await termRead();
    const a = log.lastIndexOf("MK_" + mark);
    const b = log.lastIndexOf("MKEND_" + mark);
    return a >= 0 && b > a ? log.slice(a, b) : "(probe output not found)\n--- tail ---\n" + log.slice(-1200);
  };

  // Launch the app.
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
    console.log("[probe] no GTK window");
    process.exit(0);
  }
  console.log(`[probe] window ${JSON.stringify(box)}`);

  // BEFORE: probe while on page 1 (should be healthy — S, blocked in poll/wait).
  console.log("\n===== PROBE BEFORE (page 1) =====\n" + (await runProbe("BEFORE")));

  // Switch to Page 2 (canvas tab at ~700,43).
  await page.mouse.move(Math.round(box.x + 700), Math.round(box.y + 43));
  await sleep(120);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
  await sleep(2500);
  console.log("[probe] clicked Page 2 tab");

  // AFTER #1: immediately after the switch.
  console.log("\n===== PROBE AFTER#1 (just switched) =====\n" + (await runProbe("AFTER1")));
  // AFTER #2: a few seconds later — if hung, state should be identical (same wchan).
  await sleep(3000);
  console.log("\n===== PROBE AFTER#2 (3s later) =====\n" + (await runProbe("AFTER2")));

  console.log("[probe] done");
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);
