# M4: galculator on wasm32-nommu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-build galculator 2.1.4 to wasm32-nommu, bake it into the guest initramfs, and prove it initializes in-guest via a `--selftest` headless gate; the click-to-42 visual check is a MANUAL browser check (no compositor in the node harness).

**Architecture:** `userspace/galculator.nix` is an autotools cross-derivation (mirrors `gtk-hello.nix` structure but uses `autoreconfHook` + `intltool`). A minimal source patch adds `--selftest` to `main.c`: it bypasses `gtk_init` (no display), loads the real `.ui` files from `PACKAGE_UI_DIR` via `gtk_builder_add_from_file`, asserts widget objects exist, prints `GALCULATOR-SELFTEST: ... OK`, exits. The `.ui` files are filesystem data installed to `$out/share/galculator/ui/`; the derivation is added to `environment.systemPackages` in `system.nix` so they reach the guest via the served `/nix` closure. The binary goes through the `fpcast-emu` seam (galculator is C + gobject). `runtime/node/galculator-smoke.mjs` boots (`nix: true`) and asserts the selftest OK line.

**Tech Stack:** Nix autotools cross-build (`cross.stdenv.mkDerivation`), galculator 2.1.4 (GTK3 + glib only, no GSettings schema, no GResource — `.ui` files on fs), the shared `fpcast-emu` seam (`userspace/fpcast-emu.nix`), Node boot harness (`bootNode({ nix: true })`).

## Global Constraints

- **PRIME DIRECTIVE:** NO SHORTCUTS. No stubs. Every override `isWasm`-guarded in `deps-overlay.nix`.
- **No GSettings schema for galculator** — it uses `~/.config/galculator/galculator.conf`. `gtk-assets.nix` does NOT need changes.
- **`.ui` files are filesystem data**, NOT a GResource. They install to `$(datadir)/galculator/ui/` = `$out/share/galculator/ui/` and must be present at the same store path at runtime.
- **`--selftest` must be compositor-independent**: do NOT call `gtk_init` (returns FALSE with no display and then `gtk_window_new` aborts fatally). Use `gtk_init_check` only to record, then load `.ui` files via `gtk_builder_add_from_file`, which is display-free. Assert GtkWindow `"main_window"` from `main_frame.ui` and GtkToggleButton `"button_7"` from `basic_buttons_gtk3.ui`.
- **fpcast-emu seam required**: galculator is gobject-heavy → run `fpcast_emu galculator.pre galculator` post-link. No `--enable-exception-handling` (pure C, no `-fwasm-exceptions`).
- **nix: true smoke**: `.ui` files live in the store closure (via `systemPackages`), not in the initramfs directly.
- **Nixpkgs patches**: apply the same three patches nixpkgs uses (fno-common, gettext-0.25, C23 compat). Fetch them with `pkgs.fetchpatch2` / `pkgs.fetchDebianPatch` exactly as in nixpkgs' `package.nix`.
- **Build host = aarch64-linux**; galculator is plain C autotools, no LLVM from source.
- **sudo for nix:** `echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build ...`
- **Boot tests: refresh `.artifacts/`** after every flake/userspace change (`wasm-initramfs` + `wasm-store-manifest`).
- Branch: `gtk3-galculator`. Commit directly to it.

---

## File Structure

| File | Responsibility | Task |
|------|---------------|------|
| `userspace/galculator.nix` | Autotools cross-build of galculator 2.1.4; applies three nixpkgs patches + selftest patch; fpcast seam | 1 |
| `userspace/galculator-selftest.patch` | Minimal patch to `src/main.c`: adds `--selftest` argv check + `galculator_run_selftest()` | 1 |
| `userspace/system.nix` | Add `galculator` to `environment.systemPackages` + `/share/galculator` to `pathsToLink` | 2 |
| `flake.nix` | Wire `galculator` derivation, add to `extraBins`, expose `packages…galculator` | 2 |
| `runtime/node/galculator-smoke.mjs` | Boot nix:true → `/bin/galculator --selftest` → assert `GALCULATOR-SELFTEST: .* OK` | 3 |
| `CLAUDE.md` | M4 learnings bullet + `galculator-smoke` gate line | 4 |
| `docs/superpowers/notes/m4-galculator-visual.md` | PENDING manual browser check (like M0, M3b) | 4 |

---

## Task 1: galculator derivation + selftest patch

**Files:**
- Create: `userspace/galculator-selftest.patch`
- Create: `userspace/galculator.nix`

**Interfaces:**
- Consumes: `cross.stdenv`, `cross.buildPackages.pkg-config`, `cross.buildPackages.autoreconfHook`, `cross.buildPackages.intltool`, `cross.buildPackages.flex`, `cross.gtk3`, `cross.glib`, `fpcast-emu.nix { inherit cross; }`
- Produces: `$out/bin/galculator` (wasm32, fpcast-seam applied); `$out/share/galculator/ui/*.ui` (12 UI files, filesystem data)

**Key source facts (verified from galculator 2.1.4):**
- `MAIN_GLADE_FILE` = `PACKAGE_UI_DIR "/main_frame.ui"` where `PACKAGE_UI_DIR` = `$(datadir)/galculator/ui` (defined in `src/Makefile.am`)
- `BASIC_GLADE_FILE` = `PACKAGE_UI_DIR "/basic_buttons_gtk3.ui"` (selected when `USE_GTK3` is defined, which autoconf sets when linking gtk+-3.0)
- Widget IDs: `"main_window"` (GtkWindow in `main_frame.ui`), `"button_7"` (GtkToggleButton in `basic_buttons_gtk3.ui`)
- galculator calls `ui_main_window_create()` which opens `MAIN_GLADE_FILE` → the selftest must check this file exists AND GtkBuilder parses it
- No GSettings schema; no GResource; dependency is `pkg_modules = "gtk+-3.0"` only
- Three nixpkgs patches required (from `pkgs/by-name/ga/galculator/package.nix` in pinned nixpkgs, hash `sha256-XLDQdUGin7b9SgYV1kwMChBF+l0mYc9sAscY4YRZEGA=`):
  1. fno-common: `https://github.com/galculator/galculator/commit/501a9e3feeb2e56889c0ff98ab6d0ab20348ccd6.patch` (hash `sha256-qVJHcfJTtl0hK8pzSp6MjhYAh1NbIIWr3rBDodIYBvk=`)
  2. gettext-0.25: from nixpkgs store at build time (fetched as `pkgs.path + "/pkgs/by-name/ga/galculator/gettext-0.25.patch"`)
  3. C23 compat (Debian): `fetchDebianPatch { pname="galculator"; version="2.1.4"; patch="0002-Declare-function-parameters-as-required-by-C23.patch"; debianRevision="2.1"; hash="sha256-kwRYYNOo3Z2SjFQzR6Mo+qBgW3LQfhxdE6mMpLGoE44="; }`

- [ ] **Step 1: Write the selftest patch**

Create `userspace/galculator-selftest.patch`. This patches `src/main.c` to add a `--selftest` early-exit path before `gtk_init`. The selftest is entirely display-free: it uses `gtk_builder_add_from_file` (does not need a display) to load the two main UI files and asserts the key widget objects exist.

```diff
--- a/src/main.c
+++ b/src/main.c
@@ -148,6 +148,52 @@ GtkWidget *hildon_new_window (void)
 
 /* i18n support */
 
+/* galculator_run_selftest — compositor-independent CI gate (--selftest).
+   Loads the real .ui files from PACKAGE_UI_DIR via gtk_builder_add_from_file
+   (display-free), asserts the main window and a digit button exist in the
+   parsed widget tree, prints GALCULATOR-SELFTEST: ... OK/FAIL, returns 0/1.
+   Called before gtk_init so it works in the node harness (no compositor). */
+static int galculator_run_selftest(void)
+{
+    GtkBuilder *builder;
+    GObject    *main_win, *btn_7;
+    GError     *err = NULL;
+    int         builder_ok, win_ok, btn_ok, ok;
+
+    /* Load the main frame UI (contains GtkWindow "main_window"). */
+    builder = gtk_builder_new();
+    builder_ok = gtk_builder_add_from_file(builder, MAIN_GLADE_FILE, &err) != 0;
+    if (!builder_ok) {
+        fprintf(stderr, "galculator selftest: failed to load %s: %s\n",
+                MAIN_GLADE_FILE, err ? err->message : "unknown");
+        g_object_unref(builder);
+        printf("GALCULATOR-SELFTEST: builder=0 win=0 btn_7=0 FAIL\n");
+        fflush(stdout);
+        return 1;
+    }
+    main_win = gtk_builder_get_object(builder, "main_window");
+    win_ok   = (main_win != NULL) && GTK_IS_WINDOW(GTK_WIDGET(main_win));
+    g_object_unref(builder);
+
+    /* Load the basic buttons UI (contains GtkToggleButton "button_7"). */
+    builder = gtk_builder_new();
+    if (!gtk_builder_add_from_file(builder, BASIC_GLADE_FILE, &err)) {
+        fprintf(stderr, "galculator selftest: failed to load %s: %s\n",
+                BASIC_GLADE_FILE, err ? err->message : "unknown");
+        g_object_unref(builder);
+        printf("GALCULATOR-SELFTEST: builder=%d win=%d btn_7=0 FAIL\n",
+               builder_ok, win_ok);
+        fflush(stdout);
+        return 1;
+    }
+    btn_7  = gtk_builder_get_object(builder, "button_7");
+    btn_ok = (btn_7 != NULL) && GTK_IS_TOGGLE_BUTTON(GTK_WIDGET(btn_7));
+    g_object_unref(builder);
+
+    ok = builder_ok && win_ok && btn_ok;
+    printf("GALCULATOR-SELFTEST: builder=%d win=%d btn_7=%d %s\n",
+           builder_ok, win_ok, btn_ok, ok ? "OK" : "FAIL");
+    fflush(stdout);
+    return ok ? 0 : 1;
+}
+
 int main (int argc, char *argv[])
 {
     char		*config_file_name;
@@ -155,6 +201,10 @@ int main (int argc, char *argv[])
 
+    /* --selftest: compositor-independent gate (loads .ui files, asserts widget tree). */
+    if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
+        return galculator_run_selftest();
+
 	/*
 	 * gtk_init runs (among other things) setlocale (LC_ALL, ""). Therefore we
```

The exact line numbers for the context lines don't matter for a `git apply` — the patch tool uses context matching. Save the patch with the content above, using real unified-diff format.

- [ ] **Step 2: Write the derivation**

Create `userspace/galculator.nix`:

```nix
# galculator — M4 galculator 2.1.4 cross-built to wasm32-nommu. GTK3 algebraic
# calculator. --selftest (CI gate, headless): loads the .ui files from
# PACKAGE_UI_DIR, asserts GtkWindow + GtkToggleButton, prints
# GALCULATOR-SELFTEST: ... OK, exits. Default: gtk_init → gtk_main (wayland
# window, MANUAL browser check). Autotools cross-build; fpcast-emu seam.
# No GSettings schema (galculator uses its own config file). No GResource
# (ui files are filesystem data at $(datadir)/galculator/ui/).
{ pkgs, cross
, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation rec {
  pname = "galculator";
  version = "2.1.4";

  src = pkgs.fetchFromGitHub {
    owner = "galculator";
    repo  = "galculator";
    rev   = "v${version}";
    hash  = "sha256-XLDQdUGin7b9SgYV1kwMChBF+l0mYc9sAscY4YRZEGA=";
  };

  patches = [
    # -fno-common toolchain support (upstream PR #45)
    (pkgs.fetchpatch2 {
      name = "fno-common.patch";
      url  = "https://github.com/galculator/galculator/commit/501a9e3feeb2e56889c0ff98ab6d0ab20348ccd6.patch";
      hash = "sha256-qVJHcfJTtl0hK8pzSp6MjhYAh1NbIIWr3rBDodIYBvk=";
    })
    # gettext 0.25 AM_GNU_GETTEXT_VERSION macro requirement
    (pkgs.path + "/pkgs/by-name/ga/galculator/gettext-0.25.patch")
    # C23 function-parameter declaration compat (Debian patch)
    (pkgs.fetchDebianPatch {
      inherit pname version;
      patch           = "0002-Declare-function-parameters-as-required-by-C23.patch";
      debianRevision  = "2.1";
      hash            = "sha256-kwRYYNOo3Z2SjFQzR6Mo+qBgW3LQfhxdE6mMpLGoE44=";
    })
    # M4: --selftest headless CI gate (compositor-independent: loads .ui files,
    # asserts widget tree, prints GALCULATOR-SELFTEST: ... OK, exits).
    ./galculator-selftest.patch
  ];

  # autoreconf regenerates configure from configure.in + Makefile.am (needed
  # after the gettext-0.25 patch adds AM_GNU_GETTEXT to configure.in).
  # intltool provides intltool-extract/merge/update (used by po/Makefile).
  # flex generates the flex_parser.c lexer from flex_parser.l.
  nativeBuildInputs = [
    cross.buildPackages.autoreconfHook
    cross.buildPackages.intltool
    cross.buildPackages.flex
    cross.buildPackages.pkg-config
    cross.buildPackages.gettext
    fpcast.binaryen
  ];

  buildInputs = [
    gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib
  ];

  # Cross-compilation: --host tells configure the target triple. configureFlags
  # mirrors gtk-hello's pattern (dontConfigure=false here so autoconf runs).
  configureFlags = [
    "--host=wasm32-unknown-linux-musl"
    "--disable-quadmath"   # libquadmath doesn't cross to wasm; double precision is enough
    "--disable-nls"        # disable NLS (no guest locale infrastructure for .mo files)
  ];

  # strictDeps = false matches nixpkgs galculator (AM_GLIB_GNU_GETTEXT workaround)
  strictDeps = false;

  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    make -j$NIX_BUILD_CORES galculator
    # Apply fpcast-emu post-link pass (gobject fn-pointer casts → call_indirect mismatch fix)
    fpcast_emu src/galculator src/galculator.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 src/galculator.wasm $out/bin/galculator
    # Install the .ui files (filesystem data; loaded at runtime from PACKAGE_UI_DIR).
    # galculator's make install copies them to $(datadir)/galculator/ui/ — mirror that.
    install -d $out/share/galculator/ui
    install -m644 ui/*.ui $out/share/galculator/ui/
    runHook postInstall
  '';

  meta.description = "GTK3 algebraic calculator, wasm32 (M4)";
}
```

- [ ] **Step 3: Build and verify the derivation compiles**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#galculator --no-link --print-out-paths
```

Expected: a store path like `/nix/store/...-galculator-static-wasm32-unknown-linux-musl-2.1.4`. Verify:

```sh
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#galculator --no-link --print-out-paths 2>/dev/null)
ls $OUT/bin/galculator $OUT/share/galculator/ui/main_frame.ui $OUT/share/galculator/ui/basic_buttons_gtk3.ui
file $OUT/bin/galculator
```

Expected: `galculator` is a WebAssembly file; both `.ui` files are present.

If the build fails:
- **"No rule to make target galculator"** in buildPhase: the autotools executable is actually named `galculator` in `src/`; check `make -n` output and adjust the target name.
- **"MAIN_GLADE_FILE not found" at selftest runtime** (not build time): the `.ui` files must be installed AND the store path must match `PACKAGE_UI_DIR`. If `--prefix` differs, add `--prefix=$out` to `configureFlags`.
- **"intltool-extract: command not found"**: add `cross.buildPackages.gettext` to `nativeBuildInputs` (intltool wraps it).
- **autoreconf errors**: the gettext-0.25 patch requires `gettext`'s m4 macros; ensure `gettext` is in `nativeBuildInputs`.
- **fpcast wasm-opt error "feature not enabled"**: the existing seam flags (`--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types --enable-multivalue`) cover pure-C autotools binaries. If galculator uses `__attribute__((musttail))` or similar, add `--enable-tail-call`.

- [ ] **Step 4: Commit the derivation**

```sh
git add userspace/galculator.nix userspace/galculator-selftest.patch
git commit -m "M4: galculator 2.1.4 cross-build derivation + --selftest patch"
```

---

## Task 2: Wire galculator into the guest + flake

**Files:**
- Modify: `userspace/system.nix`
- Modify: `flake.nix`
- Build: refresh `.artifacts/`

**Interfaces:**
- Consumes: `galculator` store path (Task 1 output)
- Produces: `/bin/galculator` in the guest initramfs; `galculator` package attr in flake; `/share/galculator/ui/` in the served `/nix` closure

**Why system.nix change is needed:** galculator's `.ui` files live in `$out/share/galculator/ui/`. The guest finds them at `PACKAGE_UI_DIR` = `<store_path>/share/galculator/ui/` (hardcoded in the binary). The binary and data share the same store path (one derivation), so they're always co-located — no env var needed. But `pathsToLink` must include `/share/galculator` so `system-path` creates the symlink in the profile (needed only if we ever want `/run/current-system/sw/share/galculator/ui/` — actually galculator uses the store path directly, so this is optional). Add it for cleanliness.

**Why galculator goes in `systemPackages` not `extraBins`:** The `.ui` data files must be in the served `/nix` store closure. `extraBins` only puts the binary in the initramfs (the binary's store path wouldn't be in the manifest). Adding galculator to `environment.systemPackages` (like `gtkAssets`, `guestFonts`) pulls it into `wasmToplevel` → `wasmStoreManifest` → the served closure. The binary is then symlinked onto `$PATH` via the profile. No separate `extraBins` entry needed.

- [ ] **Step 1: Add galculator to system.nix**

In `userspace/system.nix`, in the `environment.systemPackages` list (around line 99), add `galculator` alongside `gtkAssets`:

```nix
environment.systemPackages = lib.mkForce ([
  busybox
  terminfoMin
  autologin
  guestFonts
  gtkAssets
  galculator   # M4: GTK3 calculator + .ui files (in store, UI loaded at runtime)
] ++ toolchain);
```

Also add to `environment.pathsToLink` (around line 121):

```nix
environment.pathsToLink = [
  "/share/terminfo"
  "/share/fonts"
  "/share/glib-2.0/schemas"
  "/share/icons"
  "/share/galculator"   # M4: galculator .ui files (optional, for profile symlink)
];
```

- [ ] **Step 2: Wire galculator in flake.nix**

Read `flake.nix` around lines 160-210 (the `gtkHello` block) and around line 227 (the `wasmInitramfs` line) and around line 281 (the `packages.` block). Make three changes:

**2a. Add the galculator derivation** (after `gtkHello`, around line 194):

```nix
      # M4 (galculator): galculator 2.1.4 cross-built to wasm32-nommu. GTK3
      # algebraic calculator. --selftest is the headless CI gate; default maps
      # a wayland window for the manual browser check. Fpcast-emu seam applied.
      # .ui files are filesystem data (in store at share/galculator/ui/).
      galculator = import ./userspace/galculator.nix {
        inherit pkgs cross;
        gtk3 = cross.gtk3; glib = cross.glib; pango = cross.pango; cairo = cross.cairo;
        gdk-pixbuf = cross.gdk-pixbuf; atk = cross.atk; libepoxy = cross.libepoxy;
        harfbuzz = cross.harfbuzz; fontconfig = cross.fontconfig; freetype = cross.freetype;
        fribidi = cross.fribidi; pixman = cross.pixman; wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols; libxkbcommon = cross.libxkbcommon;
        libffi = cross.libffi; zlib = cross.zlib;
      };
```

**2b. Thread `galculator` into `wasmSystem`** — `wasmSystem` is constructed by passing `toolchain` to `system.nix`. But galculator goes in `systemPackages` directly (not toolchain). The `system.nix` import at line ~274 passes the `galculator` arg:

Find the `wasmSystem = import ./userspace/system.nix { ... }` call and add `inherit galculator;` (or `galculator = galculator;`) to it:

```nix
wasmSystem = import ./userspace/system.nix {
  inherit nixpkgs cross busybox galculator;
  toolchain = [ ... ];
};
```

Update `userspace/system.nix`'s argument list to accept `galculator`:

```nix
{ nixpkgs, cross, busybox, galculator, toolchain ? [ ], nixPackage ? cross.nix }:
```

**2c. Expose the package attr** (in the `packages.aarch64-linux` block, after `gtk-hello`):

```nix
        # M4: galculator — GTK3 calculator cross-built to wasm32. --selftest
        # is the headless gate; default maps a wayland window (manual browser check).
        galculator = galculator;
```

- [ ] **Step 3: Build wasm-initramfs and wasm-store-manifest, refresh .artifacts/**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#wasm-initramfs --no-link --print-out-paths
```

```sh
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null)
ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
```

```sh
SM=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#wasm-store-manifest --no-link --print-out-paths 2>/dev/null)
ln -sfn "$SM/store.json" .artifacts/store.json
ln -sfn "$SM/store-content" .artifacts/store-content
```

- [ ] **Step 4: Smoke-check galculator is on PATH in-guest (attach)**

```sh
LINUX_WASM_ARTIFACTS="file://$PWD/.artifacts/" node runtime/node/attach.mjs --no-nix
```

At the prompt, run:
```
which galculator
/bin/galculator --help
```

Expected: `which galculator` prints `/run/current-system/sw/bin/galculator` (or the profile symlink). `--help` prints galculator's usage (the existing argv>1 check in `main.c` runs `print_usage()` and exits). Exit the attach session with Ctrl-].

If `galculator` is not found: check that the store manifest includes galculator's store path (`grep galculator .artifacts/store.json | head`). If missing, verify `galculator` is in `environment.systemPackages` in `system.nix` and the `wasmSystem` import passes `galculator`.

- [ ] **Step 5: Commit the wiring**

```sh
git add userspace/system.nix flake.nix
git commit -m "M4: wire galculator into guest systemPackages + flake"
```

---

## Task 3: galculator-smoke + selftest in-guest

**Files:**
- Create: `runtime/node/galculator-smoke.mjs`

**Interfaces:**
- Consumes: `bootNode({ nix: true })`, galculator in the served closure
- Produces: exit 0 (PASS) / 1 (FAIL) / 2 (INCONCLUSIVE — kernel panic, re-run)

- [ ] **Step 1: Write galculator-smoke.mjs**

Mirror `gtk-smoke.mjs` exactly:

```js
// galculator-smoke.mjs — boots (nix:true) and runs /bin/galculator --selftest
// in-guest. The M4 galculator proof: loads the real .ui files from
// PACKAGE_UI_DIR, asserts GtkWindow "main_window" + GtkToggleButton "button_7"
// exist in the parsed widget tree (no compositor needed). Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[galculator-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/galculator --selftest\n");
  pass = await s.waitForOutput(/GALCULATOR-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[galculator-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Run the smoke test**

```sh
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/galculator-smoke.mjs; echo "exit=$?"
```

Expected transcript (in-guest):
```
GALCULATOR-SELFTEST: builder=1 win=1 btn_7=1 OK
```
Expected exit:
```
[galculator-smoke] PASS
exit=0
```

**If `builder=0` / file-not-found:**
- The `.ui` files are missing from the guest. Check `PACKAGE_UI_DIR` is the store path. Run `attach.mjs --no-nix` and `ls $(galculator --selftest 2>&1 | grep "failed to load" | sed 's/.*load //' | sed 's/:.*//')` — see if the dir exists. The issue is either that galculator's store path isn't in the served manifest or that `--prefix` during configure pointed to a different path.

**If `win=0` or `btn_7=0`:**
- The `.ui` file parsed but the widget ID wasn't found. Run `attach.mjs` (nix:true), run `galculator --selftest` manually and read the stderr output. Possibly the GTK3 branch of the `#ifdef` that selects `BASIC_GLADE_FILE` (i.e. `basic_buttons_gtk3.ui` vs `basic_buttons_gtk2.ui`) wasn't taken — check that `USE_GTK3` is defined. Autoconf sets it when gtk+-3.0 is found. Verify with `grep USE_GTK3 src/config.h` from within the build sandbox (or check build log).

**If galculator crashes with a fpcast trap (SIGILL-like wasm trap):**
- The fpcast seam wasn't applied or the wasm-opt step failed silently. Check build log for `fpcast_emu` output. Verify `$out/bin/galculator` is the post-seam binary (not `src/galculator`).

**If exit 2 (kernel panic):**
- Re-run once. Known benign: the NOMMU BOOT_MEM_PAGES is already at 0x4000 (1 GiB) from the clang fix; galculator is much smaller than clang. If it still panics, check if a new OOM is happening — galculator + GTK might push heap pressure; the BOOT_MEM_PAGES kernel patch can be bumped to 0x8000 if needed (but try twice first).

- [ ] **Step 3: Run the engine regression tests**

```sh
cd runtime && bun run test
```

Expected: 79 pass / 0 fail.

- [ ] **Step 4: Lint the new smoke file**

```sh
cd runtime && bunx oxlint --max-warnings 0 node/galculator-smoke.mjs && bunx oxfmt --check node/galculator-smoke.mjs
```

Expected: clean (no warnings, no format diff).

- [ ] **Step 5: Commit the smoke**

```sh
git add runtime/node/galculator-smoke.mjs
git commit -m "M4: galculator-smoke — GALCULATOR-SELFTEST gate (nix:true, 180s)"
```

---

## Task 4: Docs — CLAUDE.md + visual note

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/superpowers/notes/m4-galculator-visual.md`

**Interfaces:**
- Consumes: Task 3 confirmed PASS transcript
- Produces: updated CLAUDE.md with M4 learnings + smoke gate line; visual note doc (PENDING)

- [ ] **Step 1: Add galculator-smoke to the boot-test section of CLAUDE.md**

Find the boot-test section in `CLAUDE.md` (around the gtk-smoke line):

```sh
# M3b GTK3 (gtk_init + GtkWindow/GtkLabel widget tree, gobject through fpcast seam):
# boot full nix system → gtk-hello --selftest (headless gate; visual window is a
# MANUAL browser check — docs/superpowers/notes/m3b-gtk-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/gtk-smoke.mjs
```

Add after it:

```sh

# M4 galculator (GTK3 calculator: loads real .ui files, asserts widget tree, no
# compositor needed; visual click-to-42 is a MANUAL browser check —
# docs/superpowers/notes/m4-galculator-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/galculator-smoke.mjs
```

- [ ] **Step 2: Add M4 learnings bullet to CLAUDE.md Hard-won learnings**

Find the M3b GTK3 cross-build bullet in the Hard-won learnings section. After it, add:

```markdown
- **M4 galculator cross-build** (`userspace/galculator.nix`): galculator 2.1.4
  is a **GTK3-only** autotools app (`pkg_modules = "gtk+-3.0"`); build deps =
  `autoreconfHook` + `intltool` + `flex` + `gettext` (intltool wraps gettext m4
  macros — missing it causes "AM_GLIB_GNU_GETTEXT not found"). Three nixpkgs
  patches required: **fno-common** (clang `-fno-common` support), **gettext-0.25**
  (adds `AM_GNU_GETTEXT_VERSION` to configure.in — required before autoreconf),
  **C23 compat** (Debian; forward-declares function params). `strictDeps = false`
  (upstream nixpkgs workaround: `AM_GLIB_GNU_GETTEXT` fails strict-deps check). No
  GSettings schema (galculator uses `~/.config/galculator/galculator.conf`, NOT
  GSettings). No GResource: `.ui` files are **filesystem data** installed to
  `$out/share/galculator/ui/` and loaded at runtime from `PACKAGE_UI_DIR`
  (`$(datadir)/galculator/ui/` = the store path). The **`--selftest` patch** is a
  compositor-independent gate: `gtk_builder_add_from_file(MAIN_GLADE_FILE)` +
  `gtk_builder_add_from_file(BASIC_GLADE_FILE)` (display-free), asserting
  `"main_window"` (GtkWindow) and `"button_7"` (GtkToggleButton). galculator must
  be in `environment.systemPackages` (not just `extraBins`) so its store path
  enters the served `/nix` closure and the `.ui` files are present at runtime.
  The full wayland window (click-to-42) is a MANUAL browser check (PENDING,
  `docs/superpowers/notes/m4-galculator-visual.md`).
```

- [ ] **Step 3: Write docs/superpowers/notes/m4-galculator-visual.md**

```markdown
# M4 — galculator visual render: verification record

**Status: PENDING — manual browser verification not yet run.**

The headless `galculator --selftest` gate is GREEN in the node harness (GTK
initializes, the real `.ui` files load, and `GtkWindow "main_window"` +
`GtkToggleButton "button_7"` are confirmed present). But the node harness has
**no compositor** — only a minimal `wl` registry — so it cannot satisfy
`gtk_init`'s display connection. The full galculator **window render and
click-to-42** is a MANUAL browser check via pc/Greenfield, exactly like M0 and M3b.

## What was built

`/bin/galculator` (wasm32-nommu) — links the cross GTK3 stack through the shared
`--fpcast-emu` seam. Two modes:

- `--selftest` (headless CI gate, automated): before `gtk_init`, load
  `MAIN_GLADE_FILE` (`main_frame.ui`) and `BASIC_GLADE_FILE`
  (`basic_buttons_gtk3.ui`) via `gtk_builder_add_from_file`, assert
  `GTK_IS_WINDOW(main_window)` and `GTK_IS_TOGGLE_BUTTON(button_7)`, print
  `GALCULATOR-SELFTEST: builder=1 win=1 btn_7=1 OK`. This is what
  `runtime/node/galculator-smoke.mjs` gates on.
- default (visual, MANUAL): `gtk_init` → full galculator UI → `gtk_main`. Maps
  a real wayland toplevel via GTK's wayland backend with the calculator interface
  painted via cairo (wl_shm path).

## Acceptance (M4 project goal)

**Click-to-42 proof**: in-guest, click `7 × 6 =` on the galculator keyboard and
read `42` in the display. This confirms:
- GTK input event handling (wl_pointer button events from the browser)
- galculator's algebraic engine (`calc_basic.c`)
- The display update path

## Verification procedure (manual)

```sh
# 1. Build the artifacts (vmlinux + initramfs + store manifest).
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#vmlinux .#wasm-initramfs .#wasm-store-manifest --print-out-paths

# 2. Symlink artifacts and serve the browser demo with COOP/COEP.
ln -sfn /path/to/artifacts runtime/web/artifacts
node runtime/web/serve.mjs

# 3. In a browser (pc/Greenfield compositor wired up), boot to a root shell
#    and start waylandproxyd + galculator:
/bin/waylandproxyd &
sleep 1
WAYLAND_DISPLAY=wayland-0 /bin/galculator

# 4. CONFIRM: a galculator window appears. Click 7, ×, 6, = and read 42.
#    Close the window (× button or Ctrl-Q) — gtk_main exits cleanly.
```

Until a person runs the browser check and confirms the click-to-42 result,
this note stays PENDING.
```

- [ ] **Step 4: Commit docs**

```sh
git add CLAUDE.md docs/superpowers/notes/m4-galculator-visual.md
git commit -m "M4: CLAUDE.md learnings + galculator-visual manual check note"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| galculator 2.1.4 cross-build derivation | Task 1 |
| Three nixpkgs patches applied | Task 1, Step 2 |
| `--selftest` patch (compositor-independent) | Task 1, Steps 1-2 |
| `.ui` files installed to `$out/share/galculator/ui/` | Task 1, Step 2 (installPhase) |
| fpcast-emu seam applied | Task 1, Step 2 (buildPhase) |
| galculator in `systemPackages` (not just extraBins) | Task 2, Step 1 |
| `flake.nix` wiring + package attr | Task 2, Step 2 |
| `.artifacts/` refreshed | Task 2, Step 3 |
| galculator on PATH in-guest (attach check) | Task 2, Step 4 |
| `galculator-smoke.mjs` (nix:true, 180s, regex) | Task 3, Steps 1-2 |
| Engine 79/79 regression | Task 3, Step 3 |
| Lint clean | Task 3, Step 4 |
| CLAUDE.md gate line + learnings bullet | Task 4, Steps 1-2 |
| Visual note PENDING (honest, like M0/M3b) | Task 4, Step 3 |

**Placeholder scan:** None found. Every step has concrete file names, exact commands, exact content.

**Type consistency:** `GALCULATOR-SELFTEST:` string defined in patch (Task 1 Step 1) and matched by regex `/GALCULATOR-SELFTEST: .* OK/` in smoke (Task 3 Step 1) — consistent. Widget IDs `"main_window"` and `"button_7"` verified from galculator 2.1.4 source (`ui/main_frame.ui` and `ui/basic_buttons_gtk3.ui`). `fpcast_emu` shell function name matches `fpcast-emu.nix` — consistent with `gtk-hello.nix` usage.

**Potential gotcha not in a task step:** galculator's `configure.in` uses `AM_GLIB_GNU_GETTEXT` from glib's autoconf macros (separate from gettext's `AM_GNU_GETTEXT`). The gettext-0.25 patch adds `AM_GNU_GETTEXT([external])` which supersedes it. If autoreconf still fails with "possibly undefined macro: AM_GLIB_GNU_GETTEXT", set `strictDeps = false` (already in the derivation) and ensure `intltool` provides the m4 macro path. This matches nixpkgs' comment (`# BUG: when set as true, complains with: configure.in:76: error: possibly undefined macro: AM_GLIB_GNU_GETTEXT`).
