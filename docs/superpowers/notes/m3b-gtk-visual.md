# M3b — GTK3 hello-window visual render: verification record

**Status: PENDING — manual browser verification not yet run.**

The headless `gtk-hello --selftest` gate is GREEN in the node harness (GTK
initializes, registers its GTypes, and the gobject class_init paths run through the
fpcast-emu seam). But the node harness has **no compositor** — only a minimal `wl`
registry — so it cannot satisfy a GTK window's display connection / `xdg` configure
roundtrip. The full GTK *window render* (a real `GtkWindow` mapped on screen with the
`GtkLabel` painted) is therefore a MANUAL browser check via pc/Greenfield, exactly
like the M0 input probe and wl-text's wayland mode.

## What was built

`/bin/gtk-hello` (wasm32-nommu) — links the cross GTK3 stack through the shared
`--fpcast-emu` seam. Two modes:

- `--selftest` (headless CI gate, automated): `gtk_init_check` +
  `g_type_class_ref(GTK_TYPE_WINDOW/LABEL)` (registers the real GTK GTypes,
  display-free, exercising the gobject class_init/marshaller paths) + assert
  `gtk_get_major_version()==3` and `g_type_from_name` resolves the registered types.
  Prints `GTK-SELFTEST: ... OK`. This is what `runtime/node/gtk-smoke.mjs` gates on.
- default (visual, MANUAL): `gtk_init` → `gtk_window_new(GTK_WINDOW_TOPLEVEL)` →
  `GtkLabel("Hello, GTK on wasm!")` → `gtk_widget_show_all` → `gtk_main`. Maps a real
  wayland toplevel via GTK's wayland backend.

The selftest deliberately does NOT construct a `GtkWindow` *instance* — against the
harness's minimal registry `gtk_init_check` returns FALSE (no `GdkDisplay` opens),
and with no display `gtk_window_new` aborts fatally ("Can't create a
GtkStyleContext without a display connection"). The compositor-independent type
registration is the brief's Step 1 fallback and is the correct headless gate.

## Verification procedure (manual)

```sh
# 1. Build the artifacts.
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#vmlinux .#wasm-initramfs .#wasm-store-manifest --print-out-paths

# 2. Point the browser demo at them and serve with COOP/COEP (SharedArrayBuffer).
ln -sfn /path/to/artifacts runtime/web/artifacts && node runtime/web/serve.mjs

# 3. In a browser (with the pc/Greenfield compositor wired up), boot to a root
#    shell and run the default (visual) mode:
/bin/gtk-hello

# 4. CONFIRM: a GTK window titled "hello" appears showing the label
#    "Hello, GTK on wasm!". Closing it (destroy) exits via gtk_main_quit.
```

`gtk3-widget-factory` can serve as a richer manual visual target alongside/instead
of `gtk-hello` once M4 wires galculator. Until a person runs the browser check and
confirms the rendered window, this note stays PENDING.
