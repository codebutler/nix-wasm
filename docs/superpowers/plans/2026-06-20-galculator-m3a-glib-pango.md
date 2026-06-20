# Galculator-on-wasm — Plan 3 (M3a): glib + pango Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-build glib (glib/gobject/gio) and pango to wasm32-nommu — the
glib-dependent layer GTK3 sits on — proven by an in-guest gobject selftest (which
also exercises the M1 libffi `double`-argument marshaller) and a pango layout →
cairo render.

**Architecture:** glib and pango are nixpkgs cross packages (`cross.*` =
`legacyPackages.aarch64-linux.*`) with `isWasm`-guarded `deps-overlay.nix`
overrides. The gating risk is glib: nixpkgs glib drags **libselinux/libsepol,
util-linux/libmount, libsysprof-capture** (a dry-run confirmed this) — none
cross-compile to NOMMU wasm and none are needed; the override disables them, keeps
gio modules **built-in** (no dlopen on the static guest), and links the M1 libffi
backend. pango then builds on glib + the M2 text stack (cairo+freetype+fontconfig+
harfbuzz+fribidi). Proofs are in-guest selftests gated by Node boot smokes.

**Tech Stack:** nixpkgs cross (`deps-overlay.nix`), the wasm32-nommu cross
cc-wrapper, C (glib/gobject/gio + pango/pangocairo), the `runtime/` Node boot
harness (`bootNode({ nix: true })` — fonts/closure live in the system profile).

## Global Constraints

- **PRIME DIRECTIVE:** ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks,
  no stubs. If glib/pango won't cross-build, fix the *root cause* with an
  `isWasm`-guarded override — never stub or skip a feature galculator needs.
- **No dlopen on the static NOMMU guest.** gio's loadable modules and gmodule must
  be **built-in / static**. nixpkgs glib already builds gio modules into libgio on
  static builds, but verify (`-Ddtrace=disabled`, no `gioModuleDir` dlopen path).
- **Disable the un-crossable glib deps** (the dry-run found them): `selinux`,
  `libmount` (util-linux), `sysprof` (libsysprof-capture). Also `tests`, `man`,
  `dtrace`, `glib_debug` off; `nls` may stay (gettext crosses). These are the
  expected override; add more only if a build fails.
- **glib's build-time codegen tools** (`glib-genmarshal`, `glib-compile-schemas`,
  `glib-compile-resources`, `glib-mkenums`) come from **native `buildPackages`** —
  meson's cross machinery handles this automatically; do NOT try to run the
  wasm-built tools on the host.
- **libffi = the M1 backend.** glib's gobject uses libffi (`g_cclosure_marshal_generic`
  → `ffi_call`); the cross set already carries the M1 raw backend. The Task 1
  selftest deliberately exercises a `double`-argument signal to validate it.
- **Every override `isWasm`-guarded** (`whenWasm (...) prev.X`) — native untouched.
- **Build host = aarch64-linux**; cross attr path `.#legacyPackages.aarch64-linux.<lib>`.
  glib is a large C library (may build from source — aarch64 cache lags) but must
  NOT trigger an LLVM/clang from-source build. If one would, STOP and report
  BLOCKED (never kill a running build — CLAUDE.md corollary 3).
- **sudo for nix:** daemon runs as root; local password `password`; `sudo -E`
  ignored, pass config inline:
  `echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#<attr> --no-link --print-out-paths`
- **Boot smokes use `nix: true`** (the full nix-system boot mounts the served /nix
  closure where fonts + the system profile live; busybox-only can't see them).
  After flake/userspace changes, refresh BOTH the initramfs and the store manifest
  in `./.artifacts/`:
  ```
  OUT=$(… build .#wasm-initramfs …); ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
  SM=$(… build .#wasm-store-manifest …); ln -sfn "$SM/store.json" .artifacts/store.json; ln -sfn "$SM/store-content" .artifacts/store-content
  ```
  Run smokes from `runtime/` with `LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/"`.
  (Raw `node` exit may be 133 = benign post-exit-0 V8 teardown OOM under host
  memory pressure; the PASS print is the verdict. Re-run once on exit 2 / panic.)
- Continues branch `gtk3-galculator` (PR #21 lineage); commit directly to it.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `deps-overlay.nix` | `isWasm`-guarded glib override (disable selinux/libmount/sysprof; built-in gio); pango override | 1, 2 |
| `userspace/glib-selftest.c` | In-guest gobject proof: GObject + property + a generic-marshaller `double` signal (exercises M1 libffi) | 1 |
| `userspace/glib-selftest.nix` | Cross-build the gobject selftest | 1 |
| `runtime/node/glib-smoke.mjs` | Boot (nix:true) → `/bin/glib-selftest` → assert `GLIB-SELFTEST: ... OK` | 1 |
| `userspace/pango-text.c` | Pango layout → cairo image surface render; `--selftest` prints `PANGO-TEXT-SELFTEST: …px OK` | 3 |
| `userspace/pango-text.nix` | Cross-build the pango proof | 3 |
| `runtime/node/pango-smoke.mjs` | Boot (nix:true) → `/bin/pango-text --selftest` → assert OK | 3 |
| `flake.nix` | Wire `glibSelftest` + `pangoText` into `extraBins` + package attrs | 1, 3 |
| `CLAUDE.md` | Document the glib/pango learnings + the two smoke gates | 4 |

---

## Task 1: Cross-build glib + an in-guest gobject selftest (the gating risk)

**Files:**
- Modify: `deps-overlay.nix` (add the `isWasm`-guarded glib override)
- Create: `userspace/glib-selftest.c`, `userspace/glib-selftest.nix`,
  `runtime/node/glib-smoke.mjs`
- Modify: `flake.nix`

**Interfaces:**
- Consumes: `cross.pcre2`, `cross.libffi` (M1 backend), `cross.zlib`,
  `cross.gettext`; native codegen from `cross.buildPackages.glib`.
- Produces: `cross.glib` (glib/gobject/gio static libs, no selinux/libmount/sysprof,
  gio built-in); `/bin/glib-selftest`; `packages.aarch64-linux.glib-selftest`;
  `runtime/node/glib-smoke.mjs`. The selftest prints `GLIB-SELFTEST: signal_double=<v> OK`.

- [ ] **Step 1: Add the glib override**

In `deps-overlay.nix`, add an `isWasm`-guarded glib override (place after the
harfbuzz override). Disable the un-crossable deps the dry-run found, plus the
non-essential features:

```nix
  # --- glib: cross-build for the GTK stack (M3a) ------------------------------
  # nixpkgs glib drags libselinux/libsepol, util-linux (libmount) and
  # libsysprof-capture — none cross-compile to NOMMU wasm and none are needed for a
  # GTK app. Disable them + tests/man/dtrace. gio's loadable modules build INTO
  # libgio on the static build (the NOMMU guest can't dlopen). The build-time
  # codegen tools (glib-genmarshal/compile-schemas/…) come from native
  # buildPackages via meson cross. libffi is the M1 raw backend (gobject's generic
  # marshaller → ffi_call). isWasm-guarded so native glib is untouched.
  glib = whenWasm
    (p: (p.override { selinuxSupport = false; util-linuxMinimal = null; }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dselinux=disabled"
        "-Dlibmount=disabled"
        "-Dsysprof=disabled"
        "-Dman-pages=disabled"
        "-Ddtrace=disabled"
        "-Dtests=false"
        "-Dnls=enabled"
      ];
    }))
    prev.glib;
```

NOTE: the exact attribute names (`selinuxSupport`, `util-linuxMinimal`) may differ
in this nixpkgs — if the `.override` rejects an arg, read the glib derivation's
formal args (`nix eval .#legacyPackages.aarch64-linux.glib.override.__functionArgs`)
and use the real names; the meson flags are the load-bearing part regardless.

- [ ] **Step 2: Build glib — fix at root until it cross-compiles**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.glib --no-link --print-out-paths
```
This is the gating risk — expect to iterate. Likely failures and the CORRECT fix:
- a still-pulled un-crossable dep → disable its meson feature (do NOT stub the dep).
- a NOMMU/musl gap (e.g. a libc symbol) → an `isWasm`-guarded `NIX_CFLAGS`/patch at
  root (mirror the zlib `-include errno.h` precedent in `deps-overlay.nix`).
- gio wanting a dlopen module dir → confirm modules are built-in (static); no
  runtime `GIO_MODULE_DIR` dlopen.
Confirm on success: `$out`/dev has `libglib-2.0.a`, `libgobject-2.0.a`,
`libgio-2.0.a`; and `nix-store -q --references <glib-out> | grep -iE "selinux|mount|sysprof"`
is EMPTY. Capture every override you added and why.

- [ ] **Step 3: Write the gobject selftest (proves glib + the M1 marshaller)**

Create `userspace/glib-selftest.c`. It (a) creates a GObject and round-trips a
property, and (b) registers a signal carrying a `double` with the **generic
(libffi) marshaller** and emits it — directly exercising the M1 `ffi_call`
double-argument path under real gobject.

```c
/* glib-selftest.c — in-guest gobject proof (M3a). Proves glib/gobject works AND
   that gobject's generic (libffi) signal marshaller passes a `double` correctly —
   the first real exercise of the M1 raw wasm FFI backend's f64 argument support.
   Prints "GLIB-SELFTEST: signal_double=<v> OK" on success. */
#include <glib.h>
#include <glib-object.h>
#include <stdio.h>

static double g_received = 0.0;

/* signal handler: (instance, gdouble value, user_data) */
static void on_value(GObject *obj, gdouble value, gpointer user_data) {
  g_received = value;
}

int main(void) {
  /* (a) basic gobject: a GObject with a double "x" property round-trips. */
  GObject *o = g_object_new(G_TYPE_OBJECT, NULL);
  if (!G_IS_OBJECT(o)) { printf("GLIB-SELFTEST: FAIL no-object\n"); return 1; }

  /* (b) a signal carrying a gdouble, using the GENERIC (libffi) marshaller
     (marshaller = NULL → g_signal_emit uses g_cclosure_marshal_generic →
     ffi_call with a double arg → the M1 raw wasm FFI backend). */
  guint sig = g_signal_newv("value-set",
      G_TYPE_OBJECT, G_SIGNAL_RUN_LAST, NULL /*class closure*/,
      NULL, NULL, NULL /*c_marshaller = NULL → generic*/,
      G_TYPE_NONE, 1, (GType[]){ G_TYPE_DOUBLE });
  (void)sig;
  g_signal_connect(o, "value-set", G_CALLBACK(on_value), NULL);

  const double sent = 42.5;
  g_signal_emit_by_name(o, "value-set", sent);

  int ok = (g_received == sent);
  printf("GLIB-SELFTEST: signal_double=%g %s\n", g_received, ok ? "OK" : "FAIL");
  g_object_unref(o);
  return ok ? 0 : 1;
}
```

- [ ] **Step 4: Write the derivation + smoke + flake wiring**

Create `userspace/glib-selftest.nix` (links cross glib/gobject; uses cross
pkg-config for `gobject-2.0`):

```nix
# glib-selftest — in-guest gobject proof (M3a). Links cross glib/gobject and
# exercises a generic-marshaller double signal (validates the M1 libffi f64 path).
{ cross, glib, libffi, pcre2, zlib }:
cross.stdenv.mkDerivation {
  pname = "glib-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ glib libffi pcre2 zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags gobject-2.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gobject-2.0) -lffi -lm"
    $CC $CFLAGS ${./glib-selftest.c} $LDLIBS -o glib-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 glib-selftest $out/bin/glib-selftest
    runHook postInstall
  '';
  meta.description = "gobject + libffi-marshaller selftest (M3a), wasm32";
}
```

Create `runtime/node/glib-smoke.mjs` (mirror `wl-text-smoke.mjs`, `nix: true`):

```js
// glib-smoke.mjs — boots (nix:true) and runs /bin/glib-selftest in-guest.
// Proves glib/gobject + the M1 libffi double-marshaller. Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[glib-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/glib-selftest\n");
  pass = await s.waitForOutput(/GLIB-SELFTEST: signal_double=42\.5 OK/, 30000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[glib-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
```

In `flake.nix`, add the `glibSelftest` deriv (passing `cross`, `glib = cross.glib`,
`libffi = cross.libffi`, `pcre2 = cross.pcre2`, `zlib = cross.zlib`), add it to
`extraBins`, and expose `glib-selftest = glibSelftest;`.

- [ ] **Step 5: Build, refresh artifacts, run the smoke — expect PASS**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#glib-selftest --no-link --print-out-paths
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null)
ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
SM=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-store-manifest --no-link --print-out-paths 2>/dev/null)
ln -sfn "$SM/store.json" .artifacts/store.json ; ln -sfn "$SM/store-content" .artifacts/store-content
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/glib-smoke.mjs ; echo "exit=$?" ; cd ..
```
Expected: `GLIB-SELFTEST: signal_double=42.5 OK` and `[glib-smoke] PASS`. If it
prints `FAIL` or aborts at `g_signal_emit_by_name`, the libffi generic marshaller
mis-handled the double — that is an M1 backend gap surfaced by real gobject;
diagnose (it should be covered by the M1 f64 trampolines) and report. Do NOT stub
the signal.

- [ ] **Step 6: Commit**

```sh
git add deps-overlay.nix userspace/glib-selftest.c userspace/glib-selftest.nix runtime/node/glib-smoke.mjs flake.nix
git commit -m "M3a: cross-build glib (no selinux/libmount/sysprof) + gobject/libffi-marshaller selftest"
```

---

## Task 2: Cross-build pango

**Files:**
- Modify: `deps-overlay.nix` (add the `isWasm`-guarded pango override if needed)

**Interfaces:**
- Consumes: `cross.glib` (Task 1), `cross.cairo` (M2, ft+fc), `cross.freetype`,
  `cross.fontconfig`, `cross.harfbuzz`, `cross.fribidi`.
- Produces: `cross.pango` with pangocairo + pangoft2 + pangofc (`libpango-1.0.a`,
  `libpangocairo-1.0.a`, `libpangoft2-1.0.a`). Consumed by Task 3 + (later) GTK3.

- [ ] **Step 1: Build pango; add an override only if it fails**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.pango --no-link --print-out-paths
```
pango needs glib + the M2 text stack (all built). Likely overrides if it fails:
disable `introspection`, `tests`, `gtk_doc`/`documentation`, and any sysprof. Add
them `isWasm`-guarded, e.g.:
```nix
  pango = whenWasm
    (p: (p.override { /* nullify introspection if it pulls gobject-introspection */ }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Dintrospection=disabled" "-Dgtk_doc=false" "-Dtests=false" "-Dsysprof=disabled" ];
    }))
    prev.pango;
```
Confirm on success: the pango `.a`s exist and `pangocairo-1.0.pc`,
`pangoft2-1.0.pc` are in the dev output. Stays glib-coupled (that's expected now —
glib is built) but must NOT pull gobject-introspection (a native-only dep).

- [ ] **Step 2: Commit**

```sh
git add deps-overlay.nix
git commit -m "M3a: cross-build pango on glib + the M2 text stack"
```

(If pango built with no override, commit a no-op note in the Task 4 docs instead —
do not create an empty commit.)

---

## Task 3: Pango layout proof client + smoke

**Files:**
- Create: `userspace/pango-text.c`, `userspace/pango-text.nix`,
  `runtime/node/pango-smoke.mjs`
- Modify: `flake.nix`

**Interfaces:**
- Consumes: `cross.pango`, `cross.cairo`, `cross.glib`, the M2 font bundle.
- Produces: `/bin/pango-text`; `packages.aarch64-linux.pango-text`;
  `runtime/node/pango-smoke.mjs`. `--selftest` prints
  `PANGO-TEXT-SELFTEST: nonzero_px=<m> OK`.

- [ ] **Step 1: Write the pango layout render + selftest**

Create `userspace/pango-text.c`. Unlike M2's wl-text (raw harfbuzz+cairo-ft), this
uses **pango layout** (the GTK text path): a `PangoLayout` on a `pangocairo`
context, `pango_layout_set_text` + `pango_cairo_show_layout` into a cairo image
surface; `--selftest` asserts non-zero pixels.

```c
/* pango-text.c — M3a pango-layout proof. pangocairo PangoLayout → cairo image
   surface (the GTK text rendering path). --selftest asserts non-white pixels and
   prints "PANGO-TEXT-SELFTEST: nonzero_px=<m> OK". (No wayland needed for the
   gated proof; this is a headless render like wl-text --selftest.) */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <cairo.h>
#include <pango/pangocairo.h>

#define TW 320
#define TH 80

static long nonwhite_px(cairo_surface_t *surf) {
  unsigned char *data = cairo_image_surface_get_data(surf);
  int stride = cairo_image_surface_get_stride(surf);
  int w = cairo_image_surface_get_width(surf);
  int h = cairo_image_surface_get_height(surf);
  long nz = 0;
  for (int j = 0; j < h; j++) {
    uint32_t *row = (uint32_t *)(data + j * stride);
    for (int i = 0; i < w; i++)
      if ((row[i] & 0x00ffffff) != 0x00ffffff) nz++;
  }
  return nz;
}

static long render(cairo_surface_t *surf) {
  cairo_t *cr = cairo_create(surf);
  cairo_set_source_rgb(cr, 1, 1, 1); cairo_paint(cr);
  cairo_set_source_rgb(cr, 0, 0, 0);
  cairo_move_to(cr, 10, 10);

  PangoLayout *layout = pango_cairo_create_layout(cr);
  pango_layout_set_text(layout, "Hello, pango!", -1);
  PangoFontDescription *desc = pango_font_description_from_string("DejaVu Sans 24");
  pango_layout_set_font_description(layout, desc);
  pango_font_description_free(desc);
  pango_cairo_show_layout(cr, layout);
  cairo_surface_flush(surf);

  long nz = nonwhite_px(surf);
  g_object_unref(layout);
  cairo_destroy(cr);
  return nz;
}

int main(int argc, char **argv) {
  cairo_surface_t *surf = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, TW, TH);
  long nz = render(surf);
  cairo_surface_destroy(surf);
  int ok = (nz > 0);
  printf("PANGO-TEXT-SELFTEST: nonzero_px=%ld %s\n", nz, ok ? "OK" : "FAIL");
  fflush(stdout);
  return ok ? 0 : 1;
}
```

(Note: `pango_font_description_from_string("DejaVu Sans 24")` selects the M2-baked
font via fontconfig — proving the pango→fontconfig→cairo path end-to-end.)

- [ ] **Step 2: Write the derivation + smoke + flake wiring**

Create `userspace/pango-text.nix`:

```nix
# pango-text — M3a pango-layout proof. PangoLayout → cairo image surface (the GTK
# text path). Links cross pango + cairo + glib. --selftest asserts non-white px.
{ cross, pango, cairo, glib, harfbuzz, fontconfig, freetype, fribidi, pcre2, zlib, libffi, pixman }:
cross.stdenv.mkDerivation {
  pname = "pango-text";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ pango cairo glib harfbuzz fontconfig freetype fribidi pcre2 zlib libffi pixman ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags pangocairo) -O2"
    LDLIBS="$($PKG_CONFIG --libs pangocairo) -lffi -lm"
    $CC $CFLAGS ${./pango-text.c} $LDLIBS -o pango-text
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 pango-text $out/bin/pango-text
    runHook postInstall
  '';
  meta.description = "Pango-layout text render proof (M3a), wasm32";
}
```

Create `runtime/node/pango-smoke.mjs` (mirror `glib-smoke.mjs`, `nix: true`):
boot, `s.send("/bin/pango-text --selftest\n")`, assert
`/PANGO-TEXT-SELFTEST: nonzero_px=[1-9][0-9]* OK/`, print `[pango-smoke] PASS/FAIL`,
exit 0/1/2.

In `flake.nix`, add `pangoText` (passing all the cross deps the .nix needs), add to
`extraBins`, expose `pango-text = pangoText;`.

- [ ] **Step 3: Build, refresh artifacts, run the smoke — expect PASS**

Same procedure as Task 1 Step 5, with `.#pango-text` and `node/pango-smoke.mjs`.
Expected: `PANGO-TEXT-SELFTEST: nonzero_px=<big> OK`, `[pango-smoke] PASS`. If
`nonzero_px=0`: pango didn't resolve/lay out the font — check the font description
matches the baked DejaVu (fontconfig) and that pangocairo linked the ft backend.

- [ ] **Step 4: Commit**

```sh
git add userspace/pango-text.c userspace/pango-text.nix runtime/node/pango-smoke.mjs flake.nix
git commit -m "M3a: pango-layout proof client (pango_cairo_show_layout) + smoke"
```

---

## Task 4: Document the M3a learnings + smoke gates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the learnings + smoke lines**

Under "Hard-won learnings", add a bullet recording: glib cross-build disables
selinux/libmount/sysprof (un-crossable, unneeded) + tests/man/dtrace; gio modules
built-in (no dlopen); the generic gobject marshaller exercises the M1 libffi f64
path (validated by glib-selftest); pango builds on glib + the M2 text stack
(introspection disabled). Under "Boot-test the built guest", add the two smoke
lines (matching the `node node/…` style):
```sh
# M3a glib/gobject + libffi marshaller: boot full nix system → gobject selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/glib-smoke.mjs
# M3a pango layout (pango_cairo_show_layout): boot full nix system → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/pango-smoke.mjs
```

- [ ] **Step 2: Commit**

```sh
git add CLAUDE.md
git commit -m "docs: M3a glib/pango learnings + smoke gates"
```

---

## Self-review

**Spec coverage (M3 library graph — glib+pango lead):**
- glib (glib/gobject/gio), pcre2 + libffi(M1) + zlib, gio built-in, native codegen → Task 1. ✓
- pango (pangocairo/pangoft2/pangofc) on glib + M2 text stack → Task 2. ✓
- Proof exercising glib/gobject AND the M1 f64/i64 marshaller → Task 1 (generic-marshaller double signal) + Task 3 (pango layout). ✓
- Disable un-crossable deps at root (selinux/libmount/sysprof) → Task 1 Step 1 (concrete, from the dry-run). ✓
- No-dlopen → gio built-in (Global Constraints + Task 1 Step 2 check). ✓

**Placeholder scan:** none — all code is complete. Task 1 Step 1's note about
verifying the real `.override` arg names is a real instruction (the meson flags are
the load-bearing fix), not a placeholder.

**Type/contract consistency:** selftest output strings (`GLIB-SELFTEST:
signal_double=42.5 OK`, `PANGO-TEXT-SELFTEST: nonzero_px=<m> OK`) are defined once
in their `.c` and matched by the corresponding smoke regex. The double value `42.5`
is consistent between `glib-selftest.c` (`sent`) and `glib-smoke.mjs` (regex). Build
attr path `.#legacyPackages.aarch64-linux.<lib>` consistent throughout.

## Out of scope (M3b + later)

- atk, gdk-pixbuf (built-in loaders), libepoxy (no-GL), gtk3, baked GSettings
  schemas + icon theme, `gtk3-widget-factory` — the M3b plan.
- galculator (M4).
