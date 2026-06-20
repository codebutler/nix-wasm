# M4 — galculator visual acceptance: click 7 × 6 = 42

**Status: PENDING — manual browser verification not yet run.**

The headless node smoke gate is GREEN (`runtime/node/galculator-smoke.mjs` PASS):
galculator starts in-guest, GModule and GTK reach display init (GModule-CRITICAL +
`Gtk-WARNING: cannot open display:`), and exits without a wasm trap.  The fpcast-emu
seam (wasm-opt `--fpcast-emu`, applied as a post-link pass in `deps-overlay.nix`) is
confirmed working.  But the node harness has **no compositor**, so the actual calculator
window render and arithmetic interaction are a MANUAL browser check via pc/Greenfield.

## What was built

`/bin/galculator` (wasm32-nommu, 2.1.4) — the galculator GTK3 calculator, cross-compiled
for wasm32 and post-processed with binaryen `--fpcast-emu`.  Its `.ui` files land in the
served closure under the galculator store path (`$out/share/galculator/ui/*.ui`) and are
accessible in-guest at `$XDG_DATA_DIRS`.  The binary is wired into the initramfs via the
`extraBins` list (`flake.nix`) and the store manifest (`wasm-store-manifest`).

## Headless behavior (node harness — automated gate)

Running `/bin/galculator` in-guest (no compositor) produces:

```
(galculator:89): GModule-CRITICAL **: g_module_symbol: assertion 'module != NULL' failed
(galculator:89): GModule-CRITICAL **: g_module_close: assertion 'module != NULL' failed
(galculator:89): Gtk-WARNING **: cannot open display:
```

Then exits with code 1.  No wasm trap (`null function or function signature mismatch` /
`unreachable`).  GModule-CRITICAL is expected: the static wasm build has no dlopen/dlsym
(GLib's module system is a no-op), galculator probes for a GTK input method module and
the probe fails gracefully.  `Gtk-WARNING: cannot open display` confirms GTK reached
`gdk_display_open` before giving up — all gobject class_init / marshaller paths (the
fpcast-emu seam) ran without incident.

`runtime/node/galculator-smoke.mjs` gates on `REACHED_GTK = /cannot open display|GModule-CRITICAL|Gtk-WARNING/`
plus absence of `TRAP = /null function or function signature mismatch|unreachable|RuntimeError|wasm trap/i`.

## Verification procedure (manual)

```sh
# 1. Build the artifacts.
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#vmlinux .#wasm-initramfs .#wasm-store-manifest --print-out-paths

# 2. Point the browser demo at them and serve with COOP/COEP (SharedArrayBuffer).
ln -sfn /path/to/artifacts runtime/web/artifacts && node runtime/web/serve.mjs

# 3. In a browser (with the pc/Greenfield compositor wired up), boot to a root
#    shell and run waylandproxyd, then launch galculator:
/bin/waylandproxyd &
WAYLAND_DISPLAY=wayland-0 /bin/galculator

# 4. CONFIRM:
#    a. A GTK3 calculator window appears — button grid, display, menu bar.
#    b. Click: 7  ×  6  =
#    c. The display reads 42.
```

Until a person runs the browser check and confirms the rendered window and arithmetic,
this note stays PENDING.
