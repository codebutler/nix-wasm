# M0 — wl_seat input probe: verification record

**Status: PENDING — manual browser verification not yet run.**

The `wl-input-probe` binary has been built and baked into the initramfs, but the
browser-side input verification (Step 5 of the brief) requires a person to move a
mouse and press keys in a live browser session against the Greenfield compositor.
That step cannot be automated and has not yet been performed.

## What was built

`/bin/wl-input-probe` (wasm32-nommu) — a minimal Wayland client that:

1. Connects to the Wayland display and binds `wl_compositor`, `wl_shm`,
   `xdg_wm_base`, and `wl_seat` from the registry.
2. Creates one `wl_shm`-backed xdg-toplevel surface (240×160, blank dark-grey
   buffer) so the compositor has a target to deliver input to.
3. Attaches `wl_pointer` + `wl_keyboard` listeners via `wl_seat_get_pointer` /
   `wl_seat_get_keyboard` and logs every event to stdout with `PROBE ` prefix.
4. Loops forever on `wl_display_dispatch()`.

Expected console output (once verified):

```
PROBE seat.caps=0x3          ← pointer (0x1) + keyboard (0x2) bits both set
PROBE pointer.enter x=N y=N
PROBE pointer.motion x=N y=N
PROBE pointer.button button=272 state=1   ← left-click (BTN_LEFT=272), the M0 goal
PROBE pointer.button button=272 state=0   ← release
PROBE kb.enter
PROBE kb.key key=N state=1   ← key press (nice-to-have)
```

## Verification procedure

```sh
# 1. Build the artifacts (vmlinux.wasm, initramfs.cpio.gz, store.json)
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#vmlinux .#wasm-initramfs .#wasm-store-manifest --print-out-paths

# 2. Serve the browser demo (from runtime/)
ln -sfn /path/to/artifacts web/artifacts
node web/serve.mjs

# 3. Open http://localhost:PORT in a browser (needs COOP/COEP for SAB)
#    Boot the guest; in the guest shell run:
#      /bin/wl-input-probe &
#    Then move the mouse over the probe window, click, and press a key.
#    Watch the browser console or the guest terminal for PROBE lines.

# 4. Headless playwright smoke (checks WEB_OK, not input events):
node web/smoke.mjs
```

## Observed results

_Not yet run._ Update this section after the browser session with:

- `PROBE seat.caps=0x...` value observed (or "no seat event")
- Whether `pointer.motion` lines appeared on mouse movement
- Whether `pointer.button button=272 state=1` appeared on left-click (**M0 goal**)
- Whether `kb.key` appeared on a key press
- Any gap description (e.g., "Greenfield sends motion but not button") if events
  are missing, to track in the `pc` repo

## Build output

```
/nix/store/r2dwqkjbl8bmlc3s9bri4xhdm8camv08-wl-input-probe-static-wasm32-unknown-linux-musl-0.1.0
```

`$out/bin/wl-input-probe` — 178 KiB wasm32 static binary.
