# Pointer-button input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mouse clicks reach guest Wayland clients (gtk3-widget-factory widgets respond) by adding a `forwardLocalButton`/`pointerButton` injection path to the greenfield fork (symmetric with the existing motion path) and calling it from the demo compositor.

**Architecture:** The browser demo (`runtime/demo/web/`) renders each guest surface to its own canvas (DOM-windows mode) and forwards input via Greenfield's `session.userShell.actions`. That API has `pointerMotion` but no button equivalent. Add `Pointer.forwardLocalButton` (sends `wl_pointer.button` to the focused client, bypassing scene hit-testing like `forwardLocalMotion`) + a `pointerButton` userShell action in the `codebutler/greenfield` fork, rebuild + re-vendor the bundle, then wire `pointerdown`/`pointerup` in the demo to call it.

**Tech Stack:** TypeScript (greenfield fork, `~/Code/greenfield`), esbuild bundling, vanilla JS (the demo), Playwright + Chrome (verification), the nix-wasm runtime harness.

## Global Constraints

- The greenfield fork is `codebutler/greenfield` at `~/Code/greenfield` (origin set). Make the source change there, COMMIT it, and reference the commit in the vendored `SOURCE.md`.
- Vendored greenfield rule (`runtime/demo/web/vendor/greenfield/SOURCE.md`): **rebuild, do not hand-edit** `greenfield.mjs`. Rebuild with `tsc` then the documented esbuild command.
- `tsc` in the fork: build with `--noEmitOnError false` (the fork's dist has pre-existing SAB-vs-ArrayBuffer strict-type errors unrelated to this change — see SOURCE.md).
- The guest (Sommelier, gtk3-widget-factory, kernel) is UNCHANGED — do NOT rebuild guest artifacts. Reuse the staged set at `/home/vbvntv/lwbuild/sommelier-artifacts/` (vmlinux.wasm + initramfs.cpio.gz + base.squashfs + nix-cache, all symlinks). The browser demo needs `runtime/demo/web/artifacts → that dir` (`ln -sfn`).
- Browser verification needs system Chrome at `/opt/google/chrome/chrome` with `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader` (Greenfield WebGL). Playwright is installed under `runtime/node_modules`; run driver scripts FROM `runtime/` so `import "playwright"` resolves. Default demo URL path is `/demo/web/` (NOT `/web/`).
- `ButtonCode` enum (greenfield `ButtonEvent.ts`): `MAIN=0, AUX=1, SECONDARY=2, FOURTH=3, FIFTH=4`. Browser `MouseEvent.button` uses the same 0/1/2 numbering. `linuxInput[]` maps 0→0x110(BTN_LEFT), 1→0x112(BTN_MIDDLE), 2→0x111(BTN_RIGHT).
- 4 runtime CI gates must pass: `cd runtime && bun run test && bun run lint && bun run format:check && bun run typecheck`. The vendored `greenfield.mjs` is lint/format-excluded (vendor/); the demo `wayland-compositor.js` is NOT excluded.
- pc also vendors greenfield + has its own input wiring — OUT OF SCOPE here; note it as a pc follow-up.

## File Structure

- `~/Code/greenfield/packages/compositor/src/Pointer.ts` — add `forwardLocalButton`.
- `~/Code/greenfield/packages/compositor/src/UserShellApi.ts` — add `pointerButton` to interface + impl.
- `runtime/demo/web/vendor/greenfield/{greenfield.mjs,greenfield.d.mts}` — regenerated bundle (do not hand-edit).
- `runtime/demo/web/vendor/greenfield/SOURCE.md` — provenance/patch note + new commit.
- `runtime/demo/web/wayland-compositor.js` — `wireInput()` button handlers.
- `runtime/demo/node/sommelier-click-smoke.mjs` — (Task 4) the browser click verification.

---

## Task 1: greenfield fork — `forwardLocalButton` + `pointerButton` action

**Files:**
- Modify: `~/Code/greenfield/packages/compositor/src/Pointer.ts` (add a method to the `Pointer` class, near `forwardLocalMotion` ~line 687)
- Modify: `~/Code/greenfield/packages/compositor/src/UserShellApi.ts` (interface ~line 68, impl ~line 131)

**Interfaces:**
- Produces (consumed by the demo via the rebuilt bundle):
  - `session.userShell.actions.pointerButton(compositorSurface: CompositorSurface, buttonCode: ButtonCode, released: boolean): void`
  - `Pointer.forwardLocalButton(view: View, time: number, buttonCode: ButtonCode, released: boolean): void`

- [ ] **Step 1: Add `forwardLocalButton` to `Pointer.ts`**

Insert immediately AFTER the existing `forwardLocalMotion(...)` method (it ends with `this.sendFrame()` then `}`). `ButtonEvent` and `ButtonCode` are already imported in this file (used by `sendButton`). Mirror `forwardLocalMotion`'s "bypass scene" approach and replicate the seat `notifyButton` buttonCount bookkeeping, then call `sendButton` directly (NOT `grab.button`, which does scene `pickDecoration`/`pickView` that DOM-windows mode has no scene for):

```ts
  /**
   * Deliver a pointer button press/release directly to the focused surface,
   * bypassing scene pickView/decoration hit-testing. Used by alternative shells
   * (DOM-windows mode) where the browser already hit-tested the window and a
   * preceding forwardLocalMotion set the pointer focus. Maintains buttonCount /
   * grabButton like the seat's notifyButton so the implicit pointer grab stays
   * consistent.
   */
  forwardLocalButton(view: View, time: number, buttonCode: ButtonCode, released: boolean): void {
    if (this.focus?.surface !== view.surface) {
      return // a forwardLocalMotion must set focus on this view before the click
    }
    if (released) {
      if (this.buttonCount === 0) {
        return
      }
      this.buttonCount--
    } else {
      if (this.buttonCount === 0) {
        this.grabButton = buttonCode
        this.grabTime = time
      }
      this.buttonCount++
    }
    const event: ButtonEvent = {
      x: this.sx,
      y: this.sy,
      timestamp: time,
      buttonCode,
      released,
      buttons: 0,
      sceneId: '',
    }
    this.sendButton(event)
  }
```

- [ ] **Step 2: Add `pointerButton` to the `UserShellApiActions` interface**

In `UserShellApi.ts`, the interface lists `pointerMotion`/`pointerLeave`/`notifyKey` (~lines 68-70). Add after `pointerLeave` (and ensure `ButtonCode` is imported — add `import { ButtonCode } from './ButtonEvent'` if not already present):

```ts
  pointerButton(compositorSurface: CompositorSurface, buttonCode: ButtonCode, released: boolean): void
```

- [ ] **Step 3: Add the `pointerButton` action implementation**

In the actions object, immediately after the `pointerMotion: (...) => { ... }` block (the one calling `forwardLocalMotion`), add:

```ts
      pointerButton: (compositorSurface, buttonCode, released) => {
        const view = lookupSurface(session, compositorSurface)?.role?.view
        if (view) {
          session.globals.seat.pointer.forwardLocalButton(view, Date.now(), buttonCode, released)
          session.flush()
        }
      },
```

(Match `pointerMotion`'s exact shape: it does `const view = lookupSurface(session, compositorSurface)?.role?.view; if (view) { ...; session.flush() }`. If `pointerMotion` uses a slightly different view lookup, mirror THAT verbatim.)

- [ ] **Step 4: Type-check the fork**

```bash
cd ~/Code/greenfield/packages/compositor
npx tsc --noEmitOnError false 2>&1 | grep -iE "Pointer\.ts|UserShellApi\.ts" || echo "no NEW errors in the two changed files"
```
Expected: no errors referencing our two files (pre-existing SAB errors elsewhere are fine). Confirm `dist/UserShellApi.js` now contains `pointerButton` and `dist/Pointer.js` contains `forwardLocalButton`:
```bash
grep -l pointerButton ~/Code/greenfield/packages/compositor/dist/UserShellApi.js
grep -l forwardLocalButton ~/Code/greenfield/packages/compositor/dist/Pointer.js
```
Expected: both paths printed.

- [ ] **Step 5: Commit to the fork**

```bash
cd ~/Code/greenfield
git add packages/compositor/src/Pointer.ts packages/compositor/src/UserShellApi.ts
git commit -m "UserShellApi/Pointer: add pointerButton + forwardLocalButton (DOM-windows click injection)

Symmetric with pointerMotion/forwardLocalMotion: deliver wl_pointer.button to the
focused surface in DOM-windows mode (browser hit-tested; no scene grab/decoration),
maintaining buttonCount/grabButton. Lets alt-shells forward clicks, not just motion."
git rev-parse --short HEAD   # record this for SOURCE.md in Task 2
```

---

## Task 2: rebuild greenfield + re-vendor into nix-wasm

**Files:**
- Modify: `runtime/demo/web/vendor/greenfield/greenfield.mjs` (regenerated)
- Modify: `runtime/demo/web/vendor/greenfield/greenfield.d.mts` (regenerated, if produced)
- Modify: `runtime/demo/web/vendor/greenfield/SOURCE.md` (commit ref + patch note)

**Interfaces:**
- Consumes: the fork commit from Task 1 (its `dist/`).
- Produces: a vendored `greenfield.mjs` whose `createCompositorSession(...).userShell.actions` includes `pointerButton`.

- [ ] **Step 1: Re-bundle the compositor dist** (run from the nix-wasm worktree root)

```bash
cd /home/vbvntv/Code/nix-wasm/.claude/worktrees/sommelier-pointer-button
GF=~/Code/greenfield
bunx esbuild "$GF/packages/compositor/dist/index.js" \
  --bundle --format=esm --loader:.png=dataurl \
  --outfile=runtime/demo/web/vendor/greenfield/greenfield.mjs
```
Expected: esbuild writes the bundle, no errors.

- [ ] **Step 2: Regenerate the `.d.mts` types if the vendoring shipped them**

The vendor has `greenfield.d.mts`. Regenerate it the same way it was originally produced if a command exists; otherwise add the one new line by hand to the `UserShellApiActions` type (the `.d.mts` is types-only, hand-editing the declaration is acceptable and not the "don't hand-edit the bundle" rule):
```ts
  pointerButton(compositorSurface: CompositorSurface, buttonCode: number, released: boolean): void;
```
Verify it sits next to the existing `pointerMotion`/`pointerLeave` declarations.

- [ ] **Step 3: Verify the new action is in the bundle**

```bash
grep -c "pointerButton" runtime/demo/web/vendor/greenfield/greenfield.mjs
grep -c "forwardLocalButton" runtime/demo/web/vendor/greenfield/greenfield.mjs
```
Expected: both ≥ 1.

- [ ] **Step 4: Update `SOURCE.md`** — bump the `Commit:` line to the Task-1 fork SHA and add a patch-note bullet (alongside the existing requestSurfaceClose / Shm-clamp notes):

```markdown
- **Local patch (input):** `src/Pointer.ts` + `src/UserShellApi.ts` add
  `forwardLocalButton` / `pointerButton` — the DOM-windows-mode button-injection
  entry point (the upstream local-input API had motion+leave but no button).
```

- [ ] **Step 5: Commit**

```bash
git add runtime/demo/web/vendor/greenfield/greenfield.mjs runtime/demo/web/vendor/greenfield/greenfield.d.mts runtime/demo/web/vendor/greenfield/SOURCE.md
git commit -m "vendor(greenfield): re-bundle with pointerButton injection action"
```

---

## Task 3: demo `wireInput` — forward clicks

**Files:**
- Modify: `runtime/demo/web/wayland-compositor.js` (`wireInput()`, ~lines 250-286)

**Interfaces:**
- Consumes: `actions.pointerButton(cs, buttonCode, released)` (Task 2).

- [ ] **Step 1: Add a browser-button→ButtonCode helper + button handlers**

In `wireInput()` (which already has `const actions = session.userShell.actions;` and a `pointermove`→`actions.pointerMotion` handler), replace the existing `pointerdown` handler and add a `pointerup` handler. The current `pointerdown` is:
```js
    canvas.addEventListener("pointerdown", () => {
      focus();
      canvas.focus();
    });
```
Replace it with:
```js
    // Map browser MouseEvent.button (0 left / 1 middle / 2 right) to Greenfield's
    // ButtonCode enum (MAIN/AUX/SECONDARY = 0/1/2). Ignore other buttons.
    const toButtonCode = (b) => (b === 0 || b === 1 || b === 2 ? b : null);
    canvas.addEventListener("pointerdown", (ev) => {
      focus();
      canvas.focus();
      const code = toButtonCode(ev.button);
      if (code === null) return;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {}
      try {
        actions.pointerButton(cs, code, false);
      } catch {}
    });
    canvas.addEventListener("pointerup", (ev) => {
      const code = toButtonCode(ev.button);
      if (code === null) return;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {}
      try {
        actions.pointerButton(cs, code, true);
      } catch {}
    });
```
(Leave the `pointermove`/`pointerenter`/`pointerleave`/`keydown`/`keyup` handlers unchanged.)

- [ ] **Step 2: Run the runtime static gates**

```bash
cd runtime && bun run lint && bun run format:check && bun run typecheck
```
Expected: all pass (format the file with `bun run format` first if needed; `wayland-compositor.js` is NOT vendor-excluded).

- [ ] **Step 3: Commit**

```bash
git add runtime/demo/web/wayland-compositor.js
git commit -m "demo(wayland): forward pointer button down/up to the guest via pointerButton"
```

---

## Task 4: browser verification — clicks actually toggle a widget

**Files:**
- Create: `runtime/demo/node/sommelier-click-smoke.mjs`

**Interfaces:** none (end-to-end visual check).

- [ ] **Step 1: Stage the browser artifacts** (guest is unchanged; reuse the staged set)

```bash
cd /home/vbvntv/Code/nix-wasm/.claude/worktrees/sommelier-pointer-button
ln -sfn /home/vbvntv/lwbuild/sommelier-artifacts runtime/demo/web/artifacts
ls -l runtime/demo/web/artifacts/{vmlinux.wasm,initramfs.cpio.gz,base.squashfs}
```
Expected: the three symlinks resolve.

- [ ] **Step 2: Write the click smoke**

Create `runtime/demo/node/sommelier-click-smoke.mjs`. It: starts `demo/web/serve.mjs`, launches Chrome (the swiftshader args), navigates to `/demo/web/`, waits for the shell prompt (poll `window._termLog` for `[#$%]` end), runs `gtk3-widget-factory >/tmp/wf.log 2>&1 &`, waits ~25 s for the window, finds the GTK window canvas (the visible non-terminal canvas — see the DOM probe below), screenshots it, clicks a **checkbutton** location inside it, screenshots again, and asserts the pixels in the clicked region changed (the checkbox toggled). Use the proven driver shape (parent serves + Playwright child) and the helpers below:

```js
// sommelier-click-smoke.mjs — verifies pointer-button forwarding: a click on a
// gtk3-widget-factory checkbutton toggles it (pixels in the click region change).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8120, RT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [RT + "/demo/web/serve.mjs", String(PORT)], { cwd: RT, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res, rej) => { server.stdout.on("data", (c) => { if (String(c).includes("localhost")) res(); }); server.on("exit", (c) => rej(new Error("srv " + c))); });
const browser = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
let code = 2;
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/demo/web/`, { waitUntil: "domcontentloaded" });
  let up = false;
  for (let i = 0; i < 16; i++) { await sleep(15000); up = await page.evaluate(() => /[#$%]\s*$/.test((window._termLog || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd())); if (up) break; }
  if (!up) { console.log("[click-smoke] INCONCLUSIVE — no prompt"); process.exit(2); }
  await page.click("#term");
  await page.keyboard.type("gtk3-widget-factory >/tmp/wf.log 2>&1 &"); await page.keyboard.press("Enter");
  // wait for the GTK window canvas to appear (a visible canvas that is NOT #term, > 200px)
  let box = null;
  for (let i = 0; i < 18; i++) {
    await sleep(2000);
    box = await page.evaluate(() => {
      const cs = [...document.querySelectorAll("canvas")].filter((c) => c.id !== "term" && c.offsetParent !== null && c.getBoundingClientRect().width > 200 && c.getBoundingClientRect().height > 200);
      if (!cs.length) return null;
      const r = cs[0].getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (box) break;
  }
  if (!box) { console.log("[click-smoke] FAIL — no GTK window canvas appeared"); code = 1; }
  else {
    // gtk3-widget-factory Page 1 has a column of checkbuttons on the lower-left.
    // Click a point ~18% across, ~72% down the window (a checkbutton row).
    const cx = Math.round(box.x + box.w * 0.18), cy = Math.round(box.y + box.h * 0.72);
    const region = { x: Math.round(box.x + box.w * 0.10), y: cy - 12, width: 40, height: 24 };
    const before = await page.screenshot({ clip: region });
    await page.mouse.move(cx, cy); await sleep(150);
    await page.mouse.down(); await sleep(80); await page.mouse.up(); await sleep(500);
    const after = await page.screenshot({ clip: region });
    await page.screenshot({ path: "/tmp/click-after.png" });
    const changed = Buffer.compare(before, after) !== 0;
    console.log(`[click-smoke] window=${JSON.stringify(box)} clickRegionChanged=${changed}`);
    code = changed ? 0 : 1;
    console.log(changed ? "[click-smoke] PASS — click toggled the widget (pixels changed)" : "[click-smoke] FAIL — click had no visible effect");
  }
} finally { await browser.close(); server.kill(); }
process.exit(code);
```

- [ ] **Step 3: Run it (clicks must work)**

```bash
cd runtime && node demo/node/sommelier-click-smoke.mjs; echo "EXIT=$?"
```
Expected: `[click-smoke] PASS … pixels changed`, EXIT=0. If FAIL with a window but no pixel change, the click region may be off a widget — adjust the 0.18/0.72 fractions using `/tmp/click-after.png` to locate an actual checkbutton/togglebutton, re-run. If the build/bundle is wrong, `actions.pointerButton` will be undefined → the `try/catch` swallows it and nothing toggles (FAIL) — check `grep pointerButton runtime/demo/web/vendor/greenfield/greenfield.mjs`.

- [ ] **Step 4: Gate + commit**

```bash
cd runtime && bun run lint && bun run format:check
git add runtime/demo/node/sommelier-click-smoke.mjs
git commit -m "test: browser click smoke — pointer-button forwarding toggles a GTK widget"
```

---

## Self-Review

**Spec coverage:**
- Fork `forwardLocalButton` (Pointer.ts) → Task 1 Step 1 ✓
- Fork `pointerButton` action + interface (UserShellApi.ts) → Task 1 Steps 2-3 ✓
- Rebuild + re-vendor + SOURCE.md → Task 2 ✓
- Demo `wireInput` button handlers + capture + button mapping → Task 3 ✓
- Verification (real click toggles a widget, screenshot proof) → Task 4 ✓
- Non-goals (keyboard, axis, pc) — excluded, noted ✓

**Placeholder scan:** `forwardLocalButton` body is concrete (buttonCount bookkeeping + `sendButton`, matching the seat `notifyButton` + `sendButton` read in the source). The `.d.mts` regeneration (Task 2 Step 2) allows a hand-edit of the types-only declaration (not the bundle) — concrete one-line addition given. The click-region fractions in Task 4 are a starting guess with an explicit "adjust using the screenshot" fallback — inherent to a visual-coordinate click test, not a deferred placeholder.

**Type consistency:** `pointerButton(compositorSurface, buttonCode, released)` and `forwardLocalButton(view, time, buttonCode, released)` used consistently across Tasks 1-3. `buttonCode` is the `ButtonCode`/browser 0/1/2 throughout (mapped to kernel codes inside the fork's `sendButton` via `linuxInput`). `actions.pointerButton(cs, code, false/true)` in the demo matches the action signature.

**Sequencing:** Task 2 consumes Task 1's fork commit; Task 3 consumes Task 2's bundle; Task 4 verifies 1-3 end-to-end.
