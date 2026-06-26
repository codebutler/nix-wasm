# Pointer-button input for guest Wayland clients (via the greenfield fork)

**Date:** 2026-06-26
**Follows:** #7 (Sommelier on virtwl). Input follow-up #1 of 2 (the other is keyboard).
**Status:** design approved, ready for implementation plan

## Problem

GTK apps (e.g. `gtk3-widget-factory`) render and survive through Sommelier, and the
cursor tracks (wl-eyes follows it), but **mouse clicks do nothing** — widgets don't
respond. Root cause is host-side, in the browser compositor glue, not the guest:

- `runtime/demo/web/wayland-compositor.js` `wireInput()` forwards
  `pointermove → session.userShell.actions.pointerMotion(cs, x, y)` (why motion
  works) but on `pointerdown` only calls `focus()` — it **never sends a button
  event**, and there is no `pointerup` handler.
- The reason it can't: Greenfield's local-input *injection* API only implemented
  motion + leave. `session.userShell.actions` has `pointerMotion`/`pointerLeave`/
  `notifyKey` but **no `pointerButton`**, and `seat.pointer` has
  `forwardLocalMotion`/`forwardLocalLeave` but **no `forwardLocalButton`**. (The
  `notifyButton`/`button`/`sendButton` paths exist but are the scene-hit-tested
  path used by Greenfield's own compositor canvas, not the DOM-windows injection
  path the demo uses, where the browser already hit-tested the window.)

So the proper fix adds the missing button-injection entry point to the fork
(`codebutler/greenfield`, `~/Code/greenfield`), symmetric with the motion path,
then calls it from the demo. No poking Greenfield internals from the demo.

## Non-goals

- **Keyboard** — separate, larger effort (host→guest mmappable keymap fd, a NOMMU
  feature). Out of scope.
- **Scroll / axis (wheel)** — YAGNI; trivial follow-up using the existing
  `sendAxis` if wanted.
- **pc's own compositor** — pc vendors greenfield and has its own input wiring;
  it needs the same re-vendor + (maybe) wiring, flagged as a pc follow-up, NOT
  done here.

## Design

### 1. Greenfield fork (`~/Code/greenfield`, codebutler/greenfield)

`packages/compositor/src/Pointer.ts` — add, mirroring `forwardLocalMotion`
(which "bypasses scene pickView … used by alternative shells (DOM-windows mode)
where the browser already hit-tested which window the event belongs to"):

```ts
// DOM-windows mode: the browser hit-tested the window; the preceding
// forwardLocalMotion set focus. Deliver the button to the focused client without
// scene decoration hit-testing (the alt-shell owns its own titlebar).
forwardLocalButton(view: View, time: number, buttonCode: ButtonCode, released: boolean): void {
  if (this.focus?.surface !== view.surface) {
    return // not focused on this view; a forwardLocalMotion should precede the click
  }
  const event: ButtonEvent = {
    x: this.sx, y: this.sy, timestamp: time, buttonCode, released,
    buttons: 0, sceneId: '',
  }
  // route through the existing wire-send + buttonCount/grab bookkeeping, but
  // WITHOUT renderer.pickDecoration/pickView (no scene; the browser hit-tested).
  // (Exact reuse — sendButton + buttonCount — finalized against Pointer.ts in
  // the plan; the seat's notifyButton maintains buttonCount before grab.button.)
  ...
}
```

`packages/compositor/src/UserShellApi.ts` — add to the `UserShellApiActions`
interface and the impl, mirroring `pointerMotion`:

```ts
pointerButton(compositorSurface: CompositorSurface, buttonCode: ButtonCode, released: boolean): void
// impl:
pointerButton: (compositorSurface, buttonCode, released) => {
  const view = lookupSurface(session, compositorSurface)?.role?.view
  if (view) {
    session.globals.seat.pointer.forwardLocalButton(view, Date.now(), buttonCode, released)
    session.flush()
  }
},
```

Commit to the fork (on top of its current HEAD `283079d`).

### 2. Rebuild + re-vendor

Per `runtime/demo/web/vendor/greenfield/SOURCE.md` ("rebuild, do not hand-edit"):
`tsc` (`--noEmitOnError false`, as the prior patches did) to regenerate
`packages/compositor/dist`, then the documented esbuild bundle command →
regenerate `runtime/demo/web/vendor/greenfield/greenfield.mjs` and
`greenfield.d.mts`. Update `SOURCE.md` with the new fork commit + a patch note
("UserShellApi/Pointer: add pointerButton / forwardLocalButton injection").

### 3. Demo compositor (`runtime/demo/web/wayland-compositor.js`)

In `wireInput()`:
- `pointerdown`: keep `focus()`; add `canvas.setPointerCapture(ev.pointerId)` (so
  the matching `pointerup` lands even if the cursor drifts off the canvas mid-
  click) and `actions.pointerButton(cs, browserBtnToCode(ev.button), false)`.
- `pointerup` (new): `actions.pointerButton(cs, browserBtnToCode(ev.button), true)`
  and `releasePointerCapture`.
- `browserBtnToCode`: `ev.button` 0→`MAIN`, 1→`AUX`, 2→`SECONDARY` (the
  `ButtonCode` enum; Greenfield's `linuxInput[]` maps these to BTN_LEFT/MIDDLE/
  RIGHT). Ignore buttons outside 0–2 for now.

### 4. Data flow

```
canvas pointerdown ─▶ actions.pointerButton(cs, MAIN, released=false)
  └▶ UserShellApi: lookup view ─▶ seat.pointer.forwardLocalButton(view, now, MAIN, false)
       └▶ sendButton ─▶ wl_pointer.button(serial, time, BTN_LEFT, pressed) ─▶ guest client
canvas pointerup   ─▶ … released=true ─▶ wl_pointer.button(… released)
```
(`pointermove → pointerMotion` already set the pointer focus/position before the
press, so the button reaches the right surface.)

## Error handling

- `forwardLocalButton` no-ops if the pointer isn't focused on the view (defensive;
  a stray up/down without a preceding motion is dropped, not crashed).
- `wireInput` keeps its `try/catch` around the action call (matches the motion
  handler), so a transient compositor error never breaks the canvas listener.

## Testing

- **Verification (must actually run, not claim):** headless Playwright + Chrome
  (`--enable-unsafe-swiftshader`) → boot the full nix system → `gtk3-widget-factory`
  → move the pointer onto a **togglebutton** and **checkbutton**, click, and
  screenshot **before/after** to confirm the widget visibly changes state
  (toggled / checked). This is the pass criterion.
- Regression: the existing `sommelier-smoke.mjs` / `sommelier-leak-smoke.mjs`
  gates must still pass (the change is host-side; guest artifacts unchanged), and
  the 4 runtime CI gates (the greenfield bundle is vendored/lint-excluded).

## Components (boundaries)

- `Pointer.ts::forwardLocalButton` — one method, takes a focused `view` + button +
  state, emits `wl_pointer.button`. Depends on the existing `sendButton`/grab.
- `UserShellApi.ts::pointerButton` — thin action: surface→view lookup + forward +
  flush. Mirrors `pointerMotion` exactly.
- `wireInput` button handlers — browser event → `ButtonCode` → action. The only
  nix-wasm-repo logic; everything else is the vendored fork.
