# Galculator-on-wasm — Plan 4 (M3b): GTK3 + runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-build GTK3 (+ its remaining deps gdk-pixbuf, libepoxy, atk) to
wasm32-nommu, bake the GTK runtime assets (compiled GSettings schemas, a minimal
icon theme) into the guest, and prove GTK3 initializes and builds a widget tree
in-guest — the last layer before galculator.

**Architecture:** All libraries are nixpkgs cross packages (`cross.*` =
`legacyPackages.aarch64-linux.*`) with `isWasm`-guarded `deps-overlay.nix`
overrides, following the M3a pattern. GTK3 builds wayland-only (x11/cups/print/
vulkan/broadway/introspection disabled — a dry-run confirmed gtk3 otherwise drags
cups+avahi+libx11). gdk-pixbuf uses **built-in** loaders (the static NOMMU guest
can't dlopen). The GTK proof binary is built through the shared `--fpcast-emu` seam
(`userspace/fpcast-emu.nix`) like every gobject binary. The node harness has no
compositor, so the **automated** gate is GTK init + widget-tree construction; the
**visual** window render is a manual browser check via pc/Greenfield.

**Tech Stack:** nixpkgs cross (`deps-overlay.nix`), the wasm32-nommu cross
cc-wrapper, the M3a glib/pango + M2 text stack, the `userspace/fpcast-emu.nix` seam,
C (GTK3), the `runtime/` Node boot harness (`bootNode({ nix: true })`).

## Global Constraints

- **PRIME DIRECTIVE:** ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks,
  no stubs. If a library won't cross-build, fix the *root cause* with an
  `isWasm`-guarded override — never stub it or skip a feature galculator needs.
- **No dlopen on the static NOMMU guest.** gdk-pixbuf loaders, gio modules, and the
  GTK immodule must all be **built-in / static**.
- **GTK is wayland-only here.** Enable the wayland backend; disable
  x11/broadway/vulkan, print/cups, cloudproviders, colord, introspection,
  demos/tests/examples, gtk_doc. The dry-run confirmed gtk3 otherwise pulls
  **cups + avahi + libx11** (none cross / needed) — disable them at the root like
  glib's selinux.
- **Default Adwaita CSS theme is a compiled-in GResource** in libgtk-3 — no external
  theme files needed. The **"simple" immodule built-in**.
- **libffi = the M1 backend** (already in the cross set). GTK's gobject signal
  marshalling rides the M1 f64/i64 trampolines (proven in M3a).
- **fpcast-emu seam:** every gobject/GTK-linking executable runs the
  `userspace/fpcast-emu.nix` `fpcast_emu` post-link pass (the gobject fn-pointer-cast
  fix from M3a). If the proof binary ends up **C++ / `-fwasm-exceptions`**, add
  `--enable-exception-handling` to the seam's flag list first (per its own note).
- **Every override `isWasm`-guarded** (`whenWasm (...) prev.X`) — native untouched.
- **Build host = aarch64-linux**; cross attr `.#legacyPackages.aarch64-linux.<lib>`.
  gtk3 is the heaviest build yet but is small C relative to LLVM — it must NOT
  trigger an LLVM/clang from-source build. If one would, STOP and report BLOCKED
  (never kill a running build — CLAUDE.md corollary 3). Watch host memory pressure.
- **sudo for nix:** daemon root; local password `password`; `sudo -E` ignored, pass
  config inline. **Boot smokes use `nix: true`** (the served /nix closure carries the
  system profile: fonts, schemas, icons). After flake/userspace changes refresh BOTH
  `.artifacts/initramfs.cpio.gz` and `.artifacts/store.json`+`store-content` (the
  M3a glib-smoke step has the exact commands). Raw `node` exit 133 = benign
  post-exit-0 OOM; the PASS print is the verdict; re-run once on exit 2 / panic.
- Continues branch `gtk3-galculator` (PR #21 lineage); commit directly to it.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `deps-overlay.nix` | `isWasm`-guarded overrides: gdk-pixbuf (built-in loaders), libepoxy (no-GL), atk/at-spi2-core (no a11y bridge), gtk3 (wayland-only) | 1, 2 |
| `userspace/gtk-assets.nix` | Compiled GSettings schemas + minimal icon theme bundle (a `pkgs` runCommand) | 3 |
| `userspace/system.nix` | Wire the GTK asset bundle into the guest closure + `XDG_DATA_DIRS`/`GSETTINGS_SCHEMA_DIR` env | 3 |
| `userspace/gtk-hello.c` | The proof: `gtk_init` + GtkWindow + GtkLabel; `--selftest` headless gate + default maps the window for the browser | 4 |
| `userspace/gtk-hello.nix` | Cross-build gtk-hello through the fpcast-emu seam | 4 |
| `runtime/node/gtk-smoke.mjs` | Boot (nix:true) → `/bin/gtk-hello --selftest` → assert `GTK-SELFTEST: ... OK` | 4 |
| `flake.nix` | Wire `gtkHello` into `extraBins` + a package attr | 4 |
| `CLAUDE.md` | Document the gtk3 override learnings + the smoke gate + the manual-visual note | 4 |

---

## Task 1: Cross-build the GTK leaf deps (gdk-pixbuf, libepoxy, atk)

**Files:**
- Modify: `deps-overlay.nix` (add `isWasm`-guarded overrides for gdk-pixbuf,
  libepoxy, at-spi2-core/atk — only what fails needs an override)

**Interfaces:**
- Consumes: `cross.glib` (M3a), `cross.libpng`/`cross.zlib` (gdk-pixbuf needs a png
  loader for icons — build `cross.libpng` if not present), the cross set.
- Produces: `cross.gdk-pixbuf` (built-in loaders), `cross.libepoxy` (no GL provider),
  `cross.atk` (= `at-spi2-core`, a11y bridge off). Consumed by Task 2 (gtk3).

- [ ] **Step 1: Build libepoxy with no GL provider**

GTK3 hard-links libepoxy even on the cairo path; its GL entry points are resolved
lazily and never called when GTK renders via cairo. Build with egl/glx/x11 OFF:
```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.libepoxy --no-link --print-out-paths
```
If it fails wanting a GL/EGL provider, add an `isWasm`-guarded override disabling
them (meson `-Degl=no -Dglx=no -Dx11=false`); epoxy still provides the symbols GTK
links. Confirm `libepoxy.a` exists. (If epoxy fundamentally requires a GL header that
can't cross, that's a real finding — report it, don't stub.)

- [ ] **Step 2: Build gdk-pixbuf with built-in loaders**

The static guest can't dlopen loader modules, so loaders must be compiled in:
```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.gdk-pixbuf --no-link --print-out-paths
```
Add an `isWasm`-guarded override forcing built-in loaders + disabling
introspection/tests/man: meson `-Dbuiltin_loaders=all` (or at least `png`),
`-Dintrospection=disabled -Dtests=false -Dman=false -Dgio_sniffing=false`. gdk-pixbuf
needs a PNG loader for icons → ensure `cross.libpng` is a real input (build
`.#legacyPackages.aarch64-linux.libpng` first if it isn't already cross-built).
Confirm: `nix-store -q --references <gdk-pixbuf-out>` has no dlopen `loaders.cache`
expectation (built-in), and `libgdk_pixbuf-2.0.a` exists.

- [ ] **Step 3: Build atk (at-spi2-core) with the a11y bridge off**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.atk --no-link --print-out-paths
```
GTK3 links the ATK API; the at-spi2 D-Bus bridge isn't needed (and dbus won't cross
cleanly). Add an `isWasm`-guarded override disabling the bridge/dbus
(meson `-Dintrospection=no`; if at-spi2-core insists on dbus, disable the at-spi
bridge components — keep only the libatk-1.0 API). Confirm `libatk-1.0.a` (or the
atk lib gtk links) exists and dbus is not in the closure
(`nix-store -q --references <atk-out> | grep -i dbus` → empty, or justified).

- [ ] **Step 4: Commit**

```sh
git add deps-overlay.nix
git commit -m "M3b: cross-build GTK leaf deps (gdk-pixbuf built-in loaders, libepoxy no-GL, atk no-bridge)"
```

---

## Task 2: Cross-build gtk3 (wayland-only)

**Files:**
- Modify: `deps-overlay.nix` (add the `isWasm`-guarded gtk3 override)

**Interfaces:**
- Consumes: glib, pango, cairo, gdk-pixbuf, libepoxy, atk, harfbuzz, fontconfig,
  freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib —
  all cross-built.
- Produces: `cross.gtk3` (`libgtk-3.a`, `libgdk-3.a`) with the wayland backend +
  built-in "simple" immodule + the compiled-in Adwaita CSS. Consumed by Task 4.

- [ ] **Step 1: Add the gtk3 override and build**

In `deps-overlay.nix`, add an `isWasm`-guarded gtk3 override. Enable wayland; disable
the heavies the dry-run found (cups/avahi via print backends; libx11 via x11):
```nix
  gtk3 = whenWasm
    (p: (p.override {
      x11Support = false;
      cupsSupport = false;
      # null any introspection/x11/cups/colord inputs the override exposes
    }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [
        "-Dwayland_backend=true"
        "-Dx11_backend=false"
        "-Dbroadway_backend=false"
        "-Dprint_backends=none"
        "-Dvulkan=disabled"
        "-Dcloudproviders=false"
        "-Dcolord=no"
        "-Dintrospection=false"
        "-Ddemos=false" "-Dexamples=false" "-Dtests=false"
        "-Dgtk_doc=false"
      ];
    }))
    prev.gtk3;
```
(Use the REAL meson option names — gtk3's `meson_options.txt` names vary by version;
if a flag is rejected, `nix eval .#legacyPackages.aarch64-linux.gtk3.override.__functionArgs`
and the build error tell you the right names. The load-bearing intent: wayland on,
everything else off.)
```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.gtk3 --no-link --print-out-paths
```
This is the heaviest build — iterate on failures, fixing at root (a missing wayland
protocol, an immodule wanting dlopen → build-in `simple`, a NOMMU/musl gap). Expect
to disable more optional features. Do NOT stub.

- [ ] **Step 2: Verify the build**

Confirm `libgtk-3.a` + `libgdk-3.a` exist; `gtk+-3.0.pc` / `gtk+-wayland-3.0.pc` in
the dev output; and the closure is free of x11/cups/avahi
(`nix-store -q --references <gtk3-out> | grep -iE "libx11|cups|avahi"` → empty).

- [ ] **Step 3: Commit**

```sh
git add deps-overlay.nix
git commit -m "M3b: cross-build gtk3 (wayland-only; x11/cups/print/vulkan/introspection off)"
```

---

## Task 3: Bake the GTK runtime assets (GSettings schemas + icon theme)

**Files:**
- Create: `userspace/gtk-assets.nix`
- Modify: `userspace/system.nix`

**Interfaces:**
- Consumes: `pkgs` (NATIVE `glib` for `glib-compile-schemas`), `cross.glib` +
  `cross.gtk3`'s installed `*.gschema.xml`, `pkgs.adwaita-icon-theme` +
  `pkgs.hicolor-icon-theme` (for a minimal icon set), the guest closure machinery.
- Produces: in the guest fs — `/usr/share/glib-2.0/schemas/gschemas.compiled` (glib's
  + gtk's schemas), a minimal icon theme under `/usr/share/icons`, and
  `XDG_DATA_DIRS`/`GSETTINGS_SCHEMA_DIR` env so GTK finds them. Consumed by Task 4
  (GTK aborts at startup without `org.gtk.Settings.*`).

- [ ] **Step 1: Write the GTK asset bundle derivation**

Create `userspace/gtk-assets.nix`. Collect the `.gschema.xml` from cross glib + gtk3,
compile them with the **native** `glib-compile-schemas` (the guest can't), and assemble
a minimal icon theme:

```nix
# userspace/gtk-assets.nix — GTK runtime assets baked into the guest (M3b).
# Compiled GSettings schemas (glib + gtk — GTK aborts without org.gtk.Settings.*)
# + a minimal hicolor/adwaita icon theme. Schemas compiled with NATIVE glib.
{ pkgs, cross }:
pkgs.runCommand "gtk-assets" { nativeBuildInputs = [ pkgs.glib ]; } ''
  mkdir -p $out/share/glib-2.0/schemas $out/share/icons
  # gather schemas from the cross glib + gtk3 (they ship the .gschema.xml)
  for d in ${cross.glib.dev or cross.glib}/share/glib-2.0/schemas \
           ${cross.gtk3.dev or cross.gtk3}/share/glib-2.0/schemas; do
    [ -d "$d" ] && cp "$d"/*.gschema.xml $out/share/glib-2.0/schemas/ 2>/dev/null || true
  done
  glib-compile-schemas $out/share/glib-2.0/schemas
  # minimal icon theme (hicolor index + a small adwaita subset)
  cp -r ${pkgs.hicolor-icon-theme}/share/icons/hicolor $out/share/icons/ 2>/dev/null || true
  # (adwaita can be large; start with hicolor + the index, grow only if GTK warns)
''
```
NOTE: if the cross glib/gtk3 don't ship the `.gschema.xml` in those paths, find where
they install them (`find <cross.gtk3> -name '*.gschema.xml'`) and adjust — the schema
XML is arch-independent so the cross copy is fine to compile natively.

- [ ] **Step 2: Wire into the guest closure**

In `userspace/system.nix`, mirror the M2 `guestFonts` wiring: add
`import ./gtk-assets.nix { inherit pkgs cross; }` (call it `gtkAssets`) to
`environment.systemPackages`, add `/share/glib-2.0/schemas` and `/share/icons` to
`environment.pathsToLink`, and set:
- `environment.variables.GSETTINGS_SCHEMA_DIR = "/run/current-system/sw/share/glib-2.0/schemas";`
- `environment.variables.XDG_DATA_DIRS = "/run/current-system/sw/share";`
Read the existing `guestFonts` block first (M2) and follow its exact structure.

- [ ] **Step 3: Build the closure**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-system --no-link --print-out-paths
```
Confirm it builds and `gtk-assets` is referenced; spot-check
`<out>/share/glib-2.0/schemas/gschemas.compiled` exists. (End-to-end is Task 4.)

- [ ] **Step 4: Commit**

```sh
git add userspace/gtk-assets.nix userspace/system.nix
git commit -m "M3b: bake GTK GSettings schemas + minimal icon theme into the guest"
```

---

## Task 4: The GTK proof (gtk-hello) + smoke

**Files:**
- Create: `userspace/gtk-hello.c`, `userspace/gtk-hello.nix`,
  `runtime/node/gtk-smoke.mjs`
- Modify: `flake.nix`, `CLAUDE.md`

**Interfaces:**
- Consumes: `cross.gtk3` + all its transitive cross deps, the M3a fpcast-emu seam,
  the Task 3 assets.
- Produces: `/bin/gtk-hello`; `packages.aarch64-linux.gtk-hello`;
  `runtime/node/gtk-smoke.mjs`. `--selftest` prints `GTK-SELFTEST: <detail> OK`.

- [ ] **Step 1: Write gtk-hello.c (headless `--selftest` + visual default)**

The node harness has no compositor, so `--selftest` must NOT block on a window map.
It proves GTK initializes (or, if `gtk_init_check` can't open the stub display, that
GTK links + its types register) and builds a widget tree, then prints OK and exits.
The default mode maps the window (for the manual browser check via pc/Greenfield).

```c
/* gtk-hello.c — M3b GTK3 proof. --selftest: prove GTK initializes + a widget tree
   builds in-guest, print "GTK-SELFTEST: <detail> OK", exit WITHOUT mapping (the node
   harness has no compositor). Default: map the window for the in-browser visual check.
   Built through the fpcast-emu seam (gobject fn-pointer casts). */
#include <gtk/gtk.h>
#include <stdio.h>
#include <string.h>

static int run_selftest(void) {
  /* gtk_init_check connects to wayland-0; against the node harness's minimal
     registry it may or may not fully open a display. Either way, prove GTK's type
     system + widget construction works (gobject-heavy — exercises the fpcast/marshaller
     paths). Build the tree WITHOUT show/map (no compositor to satisfy a configure). */
  int argc = 0; char **argv = NULL;
  gboolean inited = gtk_init_check(&argc, &argv);

  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(win), "hello");
  gtk_window_set_default_size(GTK_WINDOW(win), 200, 80);
  GtkWidget *label = gtk_label_new("Hello, GTK on wasm!");
  gtk_container_add(GTK_CONTAINER(win), label);

  /* assert the tree is real GTK objects with the expected types/props */
  int ok = GTK_IS_WINDOW(win) && GTK_IS_LABEL(label)
        && strcmp(gtk_label_get_text(GTK_LABEL(label)), "Hello, GTK on wasm!") == 0
        && gtk_get_major_version() == 3;

  printf("GTK-SELFTEST: gtk_init_check=%d window=%d label=%d major=%u %s\n",
         inited, GTK_IS_WINDOW(win), GTK_IS_LABEL(label), gtk_get_major_version(),
         ok ? "OK" : "FAIL");
  fflush(stdout);
  gtk_widget_destroy(win);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();
  /* visual mode (manual browser check): gtk_init, build the tree, gtk_widget_show_all,
     gtk_main — maps a real wayland window via the gtk wayland backend → Greenfield. */
  gtk_init(&argc, &argv);
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  GtkWidget *label = gtk_label_new("Hello, GTK on wasm!");
  gtk_container_add(GTK_CONTAINER(win), label);
  gtk_widget_show_all(win);
  gtk_main();
  return 0;
}
```

If `gtk_init_check` against the harness's minimal server proves to HANG (it shouldn't
— init does a roundtrip, not a configure-wait — but if it does), change `--selftest`
to skip `gtk_init_check` and assert on `gtk_get_major_version()` + a GTK type
registration (`g_type_from_name("GtkWindow")` after `gtk_type_init`/first widget
construction) so the gate is fully compositor-independent. Decide empirically in Step 5.

- [ ] **Step 2: Write the derivation (through the fpcast-emu seam)**

Create `userspace/gtk-hello.nix`, linking gtk3 via pkg-config `gtk+-3.0` and applying
the shared seam (gtk is gobject → fn-pointer casts):

```nix
# gtk-hello — M3b GTK3 proof. gtk_init + GtkWindow + GtkLabel. --selftest is the
# headless CI gate; default maps a wayland window (manual browser check). Built
# through the fpcast-emu seam (gobject casts). Links cross gtk3 + its deps.
{ cross, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gtk-hello";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    CFLAGS="$($PKG_CONFIG --cflags gtk+-3.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gtk+-3.0) -lffi -lm"
    $CC $CFLAGS ${./gtk-hello.c} $LDLIBS -o gtk-hello.pre
    fpcast_emu gtk-hello.pre gtk-hello
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 gtk-hello $out/bin/gtk-hello
    runHook postInstall
  '';
  meta.description = "GTK3 hello-window proof (M3b), wasm32";
}
```

- [ ] **Step 3: Write the smoke + flake wiring**

Create `runtime/node/gtk-smoke.mjs` (mirror `glib-smoke.mjs`, `nix: true`, 180s):
run `/bin/gtk-hello --selftest`, assert `/GTK-SELFTEST: .* OK/`, print
`[gtk-smoke] PASS/FAIL`, exit 0/1/2.

In `flake.nix`, add `gtkHello` (pass all the cross deps the `.nix` needs), add to
`extraBins`, expose `gtk-hello = gtkHello;`.

- [ ] **Step 4: Build, refresh artifacts, run the smoke**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#gtk-hello --no-link --print-out-paths
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null)
ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
SM=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-store-manifest --no-link --print-out-paths 2>/dev/null)
ln -sfn "$SM/store.json" .artifacts/store.json ; ln -sfn "$SM/store-content" .artifacts/store-content
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/gtk-smoke.mjs ; echo "exit=$?" ; cd ..
```
Expected: `GTK-SELFTEST: ... OK` + `[gtk-smoke] PASS`. If GTK aborts at startup with a
GSettings/schema error, Task 3's schemas aren't on the guest path — fix the
`GSETTINGS_SCHEMA_DIR`/closure. If it traps in a gobject call_indirect, the fpcast
seam didn't apply (or needs `--enable-exception-handling` if gtk-hello is EH) — fix the
seam application. If `gtk_init_check` hangs, apply the Step 1 compositor-independent
fallback. Re-run once on exit 2.

- [ ] **Step 5: Document + the manual visual note**

In `CLAUDE.md`: add a Hard-won-learnings bullet (gtk3 wayland-only override; the
disabled heavies cups/avahi/x11; gdk-pixbuf built-in loaders; libepoxy no-GL; atk no
a11y bridge; GTK needs the baked GSettings schemas + `GSETTINGS_SCHEMA_DIR`; gtk-hello
built through the fpcast seam). Add the `node node/gtk-smoke.mjs` line to the boot-test
section. Add a note in `docs/superpowers/notes/m3b-gtk-visual.md`: the full GTK window
render is a MANUAL browser check via pc/Greenfield (the node harness has no
compositor) — run `/bin/gtk-hello` in the browser demo and confirm a window with the
label appears; mark PENDING (like M0).

- [ ] **Step 6: Commit**

```sh
git add userspace/gtk-hello.c userspace/gtk-hello.nix runtime/node/gtk-smoke.mjs flake.nix CLAUDE.md docs/superpowers/notes/m3b-gtk-visual.md
git commit -m "M3b: GTK3 hello-window proof (gtk-hello --selftest) + smoke + docs"
```

---

## Self-review

**Spec coverage (M3 library graph — the GTK3 layer):**
- gdk-pixbuf built-in loaders, libepoxy no-GL, atk no-bridge → Task 1. ✓
- gtk3 wayland-only (x11/cups/print/vulkan/broadway/introspection off; Adwaita
  GResource; simple immodule built-in) → Task 2. ✓
- Baked GSettings schemas + icon theme → Task 3. ✓
- GTK opens/paints proof → Task 4 (auto-gate = init + widget tree; visual = manual
  browser, since the node harness has no compositor). ✓
- fpcast-emu seam on the GTK binary → Task 4 Step 2. ✓
- **Deviation from spec, justified:** the spec's M3 proof said "`gtk3-widget-factory`
  opens and paints in-guest." The node harness has NO compositor (minimal registry
  only), so a full paint can't be auto-gated there. The automated gate is GTK
  init + widget-tree construction (compositor-independent); the visual paint is a
  manual browser check via pc/Greenfield (consistent with M0 and wl-text's wayland
  mode). gtk3-widget-factory can be the manual visual target instead of/alongside
  gtk-hello.

**Placeholder scan:** the gtk-hello.c default (visual) mode is complete; the
`--selftest` path is the gate. The Step 1 fallback (compositor-independent assert) is a
real, decided-empirically instruction, not a placeholder. No TODO/TBD.

**Type/contract consistency:** the selftest string `GTK-SELFTEST: ... OK` is defined
in gtk-hello.c and matched by the gtk-smoke regex. Build attr path
`.#legacyPackages.aarch64-linux.<lib>` consistent. The fpcast seam interface
(`fpcast.binaryen`, `fpcast.shellFn`, `fpcast_emu in out`) matches
`userspace/fpcast-emu.nix` as used in M3a.

## Out of scope (M4)

- galculator itself (its package, GtkBuilder `.ui` + its GSettings schema, the
  click-to-`42` end-to-end) — the M4 plan.
- The full GTK window visual render is a manual browser check, not automated here.
