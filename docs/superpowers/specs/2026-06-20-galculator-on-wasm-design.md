# Design — GTK3 + galculator in the wasm guest

**Date:** 2026-06-20
**Status:** approved design, pre-implementation
**Tracking issue:** codebutler/nix-wasm#19
**Related memory:** `gtk-on-wasm-goal`, `libffi-wasm-raw-backend`

## Goal

Run **galculator** (a real GTK3 calculator: non-GNOME, non-libadwaita, minimal
dependency surface) inside the wasm32-unknown-linux-musl NOMMU guest, rendering
through the existing Wayland → waylandproxyd → virtio_wl → Greenfield path, with
working pointer input. Acceptance: in-guest, click `7 × 6 =` and read back `42`.

The bar is **general GTK3, shipped incrementally**, with galculator as the first
end-to-end proof point — not a galculator-specific hack. Every fix is a SHARED
crossSystem / `deps-overlay.nix` (`isWasm`-guarded) or kernel-source change, per
the PRIME DIRECTIVE ("ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS"). When two
paths exist, take the one correct *in general*, not the one merely sufficient for
this app.

## Why GTK3 (not GTK4), why galculator

- **GTK3** draws its Wayland backend via **cairo image surfaces into `wl_shm`
  pools** — the exact path already proven by the raw-libffi Wayland clients
  (wl-eyes / weston-flowers / wl-anim). **GTK4** defaults to GL/Vulkan renderers;
  there is no Mesa/EGL/GL here. **libadwaita** is GTK4 + GNOME, so "non-Adwaita"
  aligns with GTK3 anyway.
- **galculator** is a thin GtkBuilder app whose only real dependency is
  `gtk3 + glib`. Minimal surface, single process (no fork — fits NOMMU), and a
  crisp acceptance test (`7 × 6 = 42`).

## Milestone ladder

Each milestone ends in a **runnable proof**, not "it compiles". Ordered so the one
kill-risk (libffi) is validated first, in isolation.

| # | Milestone | Proof |
|---|-----------|-------|
| **M0** | Input spike | A throwaway guest `wl_seat` client logs a pointer **button-press** + a **key** event from the browser (motion already works). |
| **M1** | libffi f32/f64/i64 args | Standalone in-guest unit test calls C functions with mixed `double`/`int64`/`float`/pointer args through `ffi_call` and asserts correct results. Bounds (K, M) informed by instrumenting a real GTK run. |
| **M2** | Text stack (glib-free) | freetype + fribidi + fontconfig + harfbuzz cross-built; cairo rebuilt with freetype/fontconfig backends; a guest `wl-text --selftest` shapes (harfbuzz) + rasterizes (cairo-ft) a fontconfig-resolved string headlessly and asserts non-zero pixels (CI gate), + a `wl_shm` window for the visual check. **No glib/pango** (moved to M3). |
| **M3** | GTK3 + runtime | **glib/gobject/gio + pango** (moved from M2), atk, gdk-pixbuf (built-in loaders), libepoxy (no-GL) cross-built; schemas/font/icons baked; `gtk3-widget-factory` (or a GTK hello-window) opens and paints in-guest. |
| **M4** | galculator | Packaged + baked into initramfs; in-guest click `7 × 6 =` → `42`, captured by a smoke test. |

Ground rules carried throughout:
- Every library is **nixpkgs-via-crossSystem** with `isWasm`-guarded overrides in
  `deps-overlay.nix` — no package-private recipes, no stubs.
- The static NOMMU guest **cannot dlopen**, so every plugin system is compiled in
  **statically** (gdk-pixbuf loaders, gio modules, GTK immodules) — real upstream
  build options, not workarounds.

---

## M0 — Input spike (cheap, first)

A throwaway guest client (`wl-input-probe.c`, same shape as `wltest`/`wl-anim`)
binds `wl_seat` → `wl_pointer` + `wl_keyboard` and logs every event. Run through
the existing proxy/transport/Greenfield path and confirm:

- pointer enter/motion (expected to already work — observed),
- pointer **button** press/release ← *galculator requires this*,
- **key** press (nice-to-have; galculator is usable click-only).

Because `waylandproxyd` is a transparent wire relay and the host→guest path was
unified (commit `3ccf259`), input events should ride the existing transport for
free **at the protocol level** — provided Greenfield emits them. If button events
do not arrive, the gap is found *before* any GTK spend and is tracked in
`pc`/Greenfield (out of this repo's scope). The probe is a diagnostic; it may be
kept as a test fixture but is not baked into the shipped initramfs.

---

## M1 — libffi f32/f64/i64 arguments (the gating risk)

### Why this is hard on wasm (and trivial on normal CPUs)

On a normal CPU a call is an **untyped jump**: the `call` instruction takes a raw
address and does not care about the function's signature. So libffi's `ffi_call`
is a single runtime routine that shuffles argument bytes into the ABI's
registers/stack and jumps — it handles *any* signature, with any mix of
int/float/double/pointer args, in one loop. The number of argument types never
causes a combinatorial anything.

wasm has **no untyped jump**. To call a function pointer you use `call_indirect`,
and **every `call_indirect` names a type signature fixed at compile time** (a type
index baked into the instruction; the runtime verifies it at load and traps on
mismatch). A wasm signature is just the ordered list of argument value-types, and
wasm has exactly four scalar value-types: `i32` (int/pointer), `i64`, `f32`, `f64`.
You therefore cannot write a runtime loop that "calls with a dynamically-chosen
signature" — each distinct signature needs its **own** trampoline emitted ahead of
time. emscripten dodges this by having a JS host synthesise a wasm function of the
right signature at runtime (`addFunction`); our guest has no JS host, so signatures
must be enumerated at **compile time**. This is the whole reason the backend exists
and looks the way it does — recorded here so the generator is never "cleaned up"
and re-broken.

The current backend (`patches/libffi/wasm32-raw-ffi.c`) forces **every** argument
to `i32`, giving one trampoline per arity (`i32^N`). That covers libwayland's
all-pointer/int dispatch. GObject's generic signal marshaller
(`g_cclosure_marshal_generic`) calls `ffi_call` with `gdouble`/`gint64` args, which
the current backend aborts on — hence M1.

### Mechanism (Approach A — bounded generator)

If every one of N positions could independently be any of the 4 value-types, the
number of possible signatures is `4^N` ("4 to the power N": 16 at 2 args, 4096 at
6). Pre-generating all of them (Approach C) explodes binary size and compile time;
hand-curating only galculator's observed signatures (Approach B) is the forbidden
"sufficient for this app" shortcut. **Approach A** is the maximally-correct,
tractable middle: real GObject signatures are almost entirely `i32` (pointers) with
*at most one or two* non-`i32` args, so we enumerate only "mostly-`i32`" signatures.

- Replace the hand-written `P0..P24` / `A0..A24` macro ladder with a **build-time
  generator** (a small script run in the derivation's `postPatch`, emitting the
  trampoline table as C).
- It enumerates trampolines for argument type-vectors over `{i32, i64, f32, f64}`
  with two bounds: **K** = max total args, **M** = max number of *non-`i32`* args
  in one call. The current all-`i32` path is exactly **M = 0**.
- Each generated trampoline is one statically-typed `call_indirect`. `ffi_call`
  selects among them by reading the per-arg wasm value-class from the `ffi_cif`.
- **K and M are a documented, principled cap that stays general up to (K, M) for
  any app** — not values tuned to galculator. Measurement (below) informs the
  default and margin; the generator does not special-case galculator.
- Returns already cover void/i32/i64/f32/f64 — unchanged. Anything past (K, M)
  **aborts loudly** with a diagnostic (unchanged philosophy); never a silent
  mis-call.
- Generalize `load_i32_arg` → `load_arg`: a position yields `i32`/`i64`/`f32`/`f64`
  feeding the correctly-typed trampoline.

### Choosing K and M honestly

Add a temporary instrumentation build of libffi that logs every
`(arg-type-vector, return-type)` passed to `ffi_prep_cif` during a real
`gtk3-widget-factory` + galculator session. Read off the actual maxima, set K and M
to cover them with margin, and **record the observed distribution in this spec's
follow-up notes**. This makes the cap measured-and-general rather than guessed.

### Proof — standalone unit-test harness (the M1 gate)

`tests/libffi-wasm/`: tiny C target functions (e.g.
`double mix(void* a, double b, int c, int64_t d)`), hand-built cifs, called through
`ffi_call`, asserting results. Covers each scalar return; one and two non-`i32`
args at varied positions; the K/M boundary and that K+1 aborts. **This runs and
passes in-guest before any GTK work** and becomes a permanent regression test.

### Deferred sub-risk — struct-by-value args

The backend aborts on by-value struct args. M1 instrumentation determines whether
GTK's marshaller ever emits one. If yes → scoped extension (lower the struct into
its constituent scalar wasm types). If no → stays a loud abort. Recorded either way.

---

## M2 — Text stack (glib-free rasterization + shaping layer)

**Boundary decision (2026-06-20):** the earlier draft put **pango** in M2, but
**pango is a glib/gobject library and cannot be built without glib** — the single
biggest GTK dependency. Dragging glib into M2 to satisfy pango contradicted M3
owning glib. Resolution: **M2 is the glib-free font/shaping/rasterization layer**
(freetype + fribidi + fontconfig + harfbuzz + the cairo rebuild), proven with
**cairo-ft + harfbuzz directly**; **glib + pango move to the front of M3**, where
GTK needs glib anyway. Same libraries get built before GTK — only the glib/pango
boundary moves. galculator's UI (button labels + a number display) doesn't exercise
full pango layout until GTK pulls it in at M3, so cairo-ft + harfbuzz is a
sufficient M2 proof.

Cross-built bottom-up, all `isWasm`-guarded in `deps-overlay.nix` (many may
cross-build cleanly via `cross.*` with no override; add an `isWasm`-guarded fix
only where a build actually fails):

- **freetype** — built *without* harfbuzz first (breaks the freetype↔harfbuzz
  autohint cycle); zlib on; libpng/brotli/woff2 off.
- **fribidi** — standalone. (Not needed by the M2 proof, but it's a cheap,
  glib-free leaf and a hard pango dep, so building it here de-risks M3.)
- **harfbuzz** — on freetype; **glib OFF** (keeps M2 glib-free; pango's `hb-glib`
  glue is an M3 concern). Shaping via the core harfbuzz API is glib-independent.
- **fontconfig** — needs freetype + expat (expat already cross-built). Runtime
  config + prebuilt cache (see baked assets).
- **cairo — rebuilt** with `freetype=enabled` + `fontconfig=enabled` (today
  image-surface-only, commit `b624404`; the override currently nulls those inputs
  and passes `-Dfreetype=disabled -Dfontconfig=disabled`). Strictly **additive**:
  the existing image-surface clients (weston-flowers) keep working; we add the
  font backends to the **shared** cairo rather than forking a variant. Stays
  glib-free (`-Dglib=disabled` unchanged), x11/png still off.

**Proof:** `wl-text.c` — resolves a face via **fontconfig** (`FcFontMatch`), shapes
a string with **harfbuzz** (`hb_shape`), and rasterizes the glyphs with **cairo-ft**
(`cairo_ft_font_face_create_for_ft_face` + `cairo_show_glyphs`) into a cairo image
surface. A `--selftest` mode renders headlessly and prints
`WL-TEXT-SELFTEST: glyphs=<n> nonzero_px=<m> OK` to stdout (asserted by a Node boot
smoke — a fully automated, compositor-free CI gate, like the M1 selftest). The
default mode blits the same render into a `wl_shm` xdg-toplevel for the in-browser
visual confirmation (manual, like M0). No glib, no pango — proves the rasterization
+ shaping + fontconfig path independent of GTK.

---

## M3 — GTK3 + runtime

### Library graph (nixpkgs cross, `isWasm`-guarded, static, built-in modules)

Built bottom-up. **glib + pango lead** (moved here from M2 — pango is a glib
library; see the M2 boundary note):

- **glib** (glib/gobject/gio) — pcre2, libffi (M1 backend), zlib. Build-time
  codegen (`glib-genmarshal`, `glib-compile-schemas`, `glib-compile-resources`)
  from `buildPackages` (native; meson handles it). gio modules **built-in**. The
  first real exercise of the M1 libffi backend's f64/i64 args via gobject.
- **pango** — pangocairo + pangoft2 + pangofc backends on the M2 text stack
  (cairo + freetype + fontconfig + harfbuzz + fribidi) + glib. Pango ≥1.44 has
  **no dynamic modules** — shaping is in-process via harfbuzz, nothing to dlopen.
  (M2 already built freetype/fontconfig/harfbuzz/fribidi + the cairo font
  backends; this adds the glib-dependent layout layer on top.)
- **atk** — glib only.
- **gdk-pixbuf** — **built-in loaders** (`-Dbuiltin_loaders`, ≥ png for galculator
  icons) → no `loaders.cache`/dlopen. introspection off.
- **libepoxy** — GTK3 hard-links it even on the cairo path. Build with egl/glx/x11
  **all off**; epoxy provides the linked symbols, GL entry points resolve lazily
  and are never called under cairo rendering. (Confirm it builds with no GL
  provider — known wrinkle.)
- **libxkbcommon / wayland / wayland-protocols / pixman** — already cross-built.
  libxkbcommon needed for `wl_keyboard` keymaps.
- **gtk3** — meson: `wayland=enabled`;
  `x11/broadway/vulkan/print/cloudproviders/introspection=disabled`;
  `demos/tests/examples=false`; `gtk_doc=false`. Default **Adwaita CSS theme is a
  compiled-in GResource** — no external theme files. "simple" **immodule built-in**.

### Baked runtime assets (via the userspace Nix, like the existing font/terminfo work)

- **A font** — DejaVu — plus a minimal `fonts.conf` and a **prebuilt fontconfig
  cache** (`fc-cache` at build time; the guest fs can't rebuild it cheaply).
- **Compiled GSettings schemas** — glib's + gtk's `gschemas.compiled` in
  `/usr/share/glib-2.0/schemas` (GTK aborts at startup without `org.gtk.Settings.*`).
- **Icon theme** — hicolor + a minimal Adwaita icon subset (start minimal, grow
  only if galculator shows missing icons).

**Proof:** `gtk3-widget-factory` (or, if too heavy on first cut, a ~40-line GTK
hello-window) opens a real GTK window in-guest and paints widgets — buttons,
labels, text via the M2 stack — in the browser.

---

## M4 — galculator

- **Package** galculator as a nixpkgs-cross derivation (`isWasm`-guarded). Build
  deps essentially `gtk3 + glib` (+ native `intltool`/`gettext`). Autotools — reuse
  the existing cross autotools path. Pin a **GTK3 + GtkBuilder** release (not a
  GTK2/libglade-era one); verified at packaging time.
- **App assets baked**: galculator's GtkBuilder `.ui` files + its compiled
  GSettings schema into the schema dir alongside glib/gtk's.
- **Bake into initramfs** via the `flake.nix` `extraBins` mechanism the Wayland
  demos already use; started like the existing `wl-*` clients.
- Single process, no fork — fits NOMMU directly.

### Acceptance (M4 proof = project goal)

A scripted smoke test in the spirit of `runtime/node/smoke.mjs`:

1. Boot guest → start `waylandproxyd` → launch `galculator`.
2. Window appears in Greenfield (assert a surface committed with non-trivial
   content).
3. Inject pointer clicks (M0-proven input path) on `7`, `×`, `6`, `=`.
4. Assert the display reads **`42`** — via screenshot/pixel read, or an
   accessibility/text hook if available; fallback is a visual screenshot diff.

If keyboard input landed in M0, add a secondary check: type `7*6=` → `42`.

> **Implementation note (2026-06-20):** The automated gate in the node harness is
> "galculator starts in-guest without a wasm trap" (galculator reaches GTK init,
> confirmed by `Gtk-WARNING: cannot open display`). The node harness has no compositor
> so click input and window mapping cannot be automated there. The **click `7 × 6 = 42`
> headline acceptance** is a MANUAL browser check via pc/Greenfield (see
> `docs/superpowers/notes/m4-galculator-visual.md` — PENDING).

---

## Risk register

| Risk | Mitigation / fallback |
|------|----------------------|
| **libffi mixed-type calls fundamentally unworkable** | M1 standalone & first — fails cheap, before any GTK spend. The kill-risk. |
| **struct-by-value arg** in GTK's marshaller | Detected by M1 instrumentation; scoped scalar-lowering extension, or stays a loud abort if never emitted. |
| **libepoxy won't build with no GL provider** | All GL backends off; use the real upstream no-provider config; never call GL. |
| **gdk-pixbuf needs dlopen loaders** | `-Dbuiltin_loaders` static; if a needed loader can't be built-in, prebuild its cache pointing at static modules. |
| **GTK aborts without schema/icon/font** | All baked at build time (schemas compiled, fontconfig cache prebuilt, minimal icon theme). |
| **NOMMU heap fragmentation** (large GTK closure won't mmap) | Same `CONFIG_BOOT_MEM_PAGES` lever already used for clang; bump shared in kernel source if it bites. |
| **input clicks never arrive** | M0 catches it before GTK; gap tracked in `pc`/Greenfield. |
| **galculator version uses libglade/GTK2** | Pin a GTK3 + GtkBuilder release; verified at packaging time. |

## CI / test gates added

- `tests/libffi-wasm/` — permanent in-guest regression test for the FFI backend.
- `wl-text` and the GTK hello-window kept as guest smoke fixtures.
- The galculator click-to-`42` smoke as the end-to-end gate.

## Out of scope

- GTK4 / libadwaita; any GL/Vulkan rendering path.
- gobject-introspection / language bindings (C app only).
- Greenfield/`pc`-side input plumbing beyond what M0 needs to verify (tracked
  separately if M0 finds a gap).
- The Phase-5 binary cache (issue #2) — orthogonal; galculator's closure will
  substitute through it once that lands, but this design does not depend on it.
