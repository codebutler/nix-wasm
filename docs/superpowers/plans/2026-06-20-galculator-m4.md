# Galculator-on-wasm — Plan 5 (M4, FINAL): galculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package **galculator** (the headline GTK3 calculator) for the wasm32-nommu
guest, bake it in, prove it builds + starts in-guest, and document the
`click 7 × 6 = 42` acceptance as a manual browser check — completing the
galculator-on-wasm effort.

**Architecture:** galculator 2.1.4 is a nixpkgs autotools package whose only library
dependency is the already-built `cross.gtk3`. We override it (`isWasm`-guarded) to
apply the shared `--fpcast-emu` post-link seam (`userspace/fpcast-emu.nix`) to its
binary — it's gobject/GTK, so it has the same function-pointer casts every GTK
binary does. It bakes into the initramfs via `flake.nix extraBins`. The node harness
has no compositor, so the **automated** gate is "galculator builds + starts in-guest
(reaches GTK init without a wasm trap/link failure)"; the headline **compute**
(`7 × 6 = 42`) is a **manual browser check** via pc/Greenfield (needs a real
compositor + pointer input, like M0 and the gtk-hello visual).

**Tech Stack:** nixpkgs cross (`deps-overlay.nix`), the `userspace/fpcast-emu.nix`
seam, the M3b gtk3 stack, the `runtime/` Node boot harness (`bootNode({ nix: true })`).

## Global Constraints

- **PRIME DIRECTIVE:** ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks,
  no stubs. Fix any galculator cross issue at the root; never stub.
- **galculator is gobject/GTK → it needs the `fpcast-emu` seam** applied to its
  linked binary (post-link `wasm-opt --fpcast-emu`). GTK is C (no
  `-fwasm-exceptions`), so the seam's current flags suffice — do NOT add
  `--enable-exception-handling` unless a build error demands it.
- **Every override `isWasm`-guarded** (`whenWasm (...) prev.galculator`) — native
  galculator untouched.
- **galculator 2.1.4**, nixpkgs attr `galculator` (autotools; lib dep = gtk3 only;
  native intltool/autoreconf). No GSettings schema (config is a plain file) and no
  wrapGAppsHook — its `.ui` files install to `$out/share/galculator` and are
  reachable via the served `/nix` closure (verify in Task 1).
- **Build host = aarch64-linux**; cross attr `.#legacyPackages.aarch64-linux.galculator`.
  Light build (only galculator + native intltool per the dry-run) — MUST NOT trigger
  an LLVM/clang from-source build; if one would, STOP and report BLOCKED.
- **sudo for nix:** daemon root; local password `password`; `sudo -E` ignored, pass
  config inline. **Boot smoke uses `nix: true`** (galculator + its `.ui` live in the
  served closure). After flake/userspace changes refresh BOTH
  `.artifacts/initramfs.cpio.gz` and `.artifacts/store.json`+`store-content` (the
  M3b gtk-smoke step has the commands). Raw `node` exit 133 = benign post-exit-0 OOM;
  the PASS print is the verdict; re-run once on exit 2.
- Continues branch `gtk3-galculator` (PR #21 lineage); commit directly to it.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `deps-overlay.nix` | `isWasm`-guarded galculator override (apply fpcast seam post-link; any autotools cross fix) | 1 |
| `flake.nix` | Wire galculator into `extraBins` + a package attr | 1 |
| `runtime/node/galculator-smoke.mjs` | Boot (nix:true) → run galculator in-guest → assert it starts (no wasm trap) | 2 |
| `docs/superpowers/notes/m4-galculator-visual.md` | The manual `click 7×6=42` acceptance procedure (PENDING) | 2 |
| `CLAUDE.md` | galculator-packaging learnings + the smoke gate line | 3 |
| `docs/superpowers/specs/2026-06-20-galculator-on-wasm-design.md` | Reconcile the M4 acceptance (automated-start vs manual-compute split) | 3 |

---

## Task 1: Package galculator (fpcast seam + bake in)

**Files:**
- Modify: `deps-overlay.nix` (add the `isWasm`-guarded galculator override)
- Modify: `flake.nix` (wire `galculator` into `extraBins` + a package attr)

**Interfaces:**
- Consumes: `prev.galculator` (nixpkgs), `cross.gtk3`, `userspace/fpcast-emu.nix`.
- Produces: `cross.galculator` whose `$out/bin/galculator` has had the `--fpcast-emu`
  pass applied; `/bin/galculator` in the guest initramfs; flake attr
  `packages.aarch64-linux.galculator`. Consumed by Task 2.

- [ ] **Step 1: Add the galculator override (apply the fpcast seam post-link)**

In `deps-overlay.nix`, add an `isWasm`-guarded galculator override that runs the
shared `fpcast_emu` pass over the built binary. Reference the seam the same way the
userspace derivations do (`import ./userspace/fpcast-emu.nix { inherit cross; }` is
not available here — instead use `final.buildPackages.binaryen` + the wasm-opt flags
directly, matching `userspace/fpcast-emu.nix`):

```nix
  # --- galculator: the headline GTK3 app (M4) ---------------------------------
  # galculator is gobject/GTK → its binary has the same C function-pointer casts
  # every GTK binary does (e.g. GObject class_init), which strict wasm call_indirect
  # rejects. Apply the binaryen --fpcast-emu post-link pass (the shared seam, see
  # userspace/fpcast-emu.nix + the M3a/M3b learnings) to the installed binary. GTK is
  # C (no -fwasm-exceptions) so the base feature set suffices. isWasm-guarded so
  # native galculator is untouched.
  galculator = whenWasm
    (p: p.overrideAttrs (o: {
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ final.buildPackages.binaryen ];
      postFixup = (o.postFixup or "") + ''
        if [ -f "$out/bin/galculator" ]; then
          wasm-opt \
            --enable-threads --enable-bulk-memory --enable-mutable-globals \
            --enable-nontrapping-float-to-int --enable-sign-ext \
            --enable-reference-types --enable-multivalue \
            -pa max-func-params@128 --fpcast-emu \
            "$out/bin/galculator" -o "$out/bin/galculator.fpcast"
          mv "$out/bin/galculator.fpcast" "$out/bin/galculator"
          chmod +x "$out/bin/galculator"
        fi
      '';
    }))
    prev.galculator;
```
NOTE: if the flag list drifts from `userspace/fpcast-emu.nix`, prefer keeping them
identical (single source of truth). If a future refactor exposes the seam's
`shellFn` to overlay code, use that instead; for now the inline copy is acceptable
because deps-overlay.nix can't `import` a userspace helper without threading `cross`.

- [ ] **Step 2: Build galculator and verify the binary + assets**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.galculator --no-link --print-out-paths
```
If the autotools build fails (e.g. a configure check that mis-detects on cross, an
intltool/gettext issue), fix at root with an `isWasm`-guarded override addition (a
`configureFlags`/`postPatch`), not a stub. On success:
- `$out/bin/galculator` exists (a wasm binary, fpcast-processed).
- Verify the `.ui` files: `ls $out/share/galculator/*.ui` (galculator ships
  `galculator.ui` / `galculator-nobasic.ui`). These are in galculator's closure →
  reachable in-guest via the served `/nix` (no separate baking needed).
- Verify NO GSettings schema is required:
  `find $out -name '*.gschema.xml'` → expected empty (galculator 2.1.4 uses a config
  file, not GSettings). If it DOES ship a schema, STOP and note it — Task 2 must then
  extend `userspace/gtk-assets.nix` to compile it (GTK aborts without it).

- [ ] **Step 3: Bake galculator into the initramfs + a package attr**

In `flake.nix`, add `galculator = cross.galculator;` to the `extraBins` list (so
`/bin/galculator` lands in the guest) and expose it as a package attr
`galculator = cross.galculator;`. (galculator's `$out/share/galculator` rides along
in the served closure.) Read the `extraBins` list + the packages attrset first and
follow the existing pattern (`wlAnim`, `gtkHello`, etc.).

- [ ] **Step 4: Commit**

```sh
git add deps-overlay.nix flake.nix
git commit -m "M4: package galculator (fpcast-emu post-link seam) + bake into initramfs"
```

---

## Task 2: Prove galculator starts in-guest + the manual acceptance note

**Files:**
- Create: `runtime/node/galculator-smoke.mjs`,
  `docs/superpowers/notes/m4-galculator-visual.md`

**Interfaces:**
- Consumes: `/bin/galculator` (Task 1), the served closure (`.ui` + gtk assets).
- Produces: `runtime/node/galculator-smoke.mjs` (the automated start gate) and the
  manual `click 7×6=42` acceptance note.

- [ ] **Step 1: Determine the headless start behavior empirically**

galculator calls `gtk_init` then builds its window from the `.ui`. The node harness
has no compositor, so the window can't map; galculator will reach GTK and abort on
"no display" (like gtk-hello's `gtk_window_new`) — NOT a clean exit, but the abort
*proves the binary linked, instantiated, ran its gobject statics through the fpcast
seam, and reached GTK init*. First check whether galculator supports a pre-`gtk_init`
flag:
```sh
# rebuild artifacts (Task 1 added /bin/galculator) then attach and try --version/--help:
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null); ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
SM=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-store-manifest --no-link --print-out-paths 2>/dev/null); ln -sfn "$SM/store.json" .artifacts/store.json; ln -sfn "$SM/store-content" .artifacts/store-content
# interactive probe:
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/attach.mjs
#   in the guest: /bin/galculator --version ; echo "rc=$?"   then   /bin/galculator ; echo "rc=$?"
```
Record what galculator prints for each. Two acceptable automated-gate outcomes:
- **(A)** `--version`/`--help` prints a version/usage line and exits 0 (pre-`gtk_init`)
  → gate on that exact string.
- **(B)** no pre-init flag → running `/bin/galculator` reaches GTK and emits a
  GTK display error (e.g. `cannot open display` / `Can't create GtkStyleContext
  without a display` / a `Gtk-WARNING`) → gate on that message being present AND no
  wasm trap (`null function or function signature mismatch`, `unreachable`,
  `RuntimeError`) being present. That distinguishes "galculator ran to GTK init"
  (PASS — the build is sound) from "galculator failed to link/instantiate or trapped
  in a gobject cast" (FAIL).

- [ ] **Step 2: Write the smoke runner**

Create `runtime/node/galculator-smoke.mjs` (mirror `gtk-smoke.mjs`, `nix: true`,
180s). Use the gate decided in Step 1. Skeleton for outcome (B) (adjust the regex to
the actual message observed; if (A), match the version string instead):

```js
// galculator-smoke.mjs — boots (nix:true) and confirms /bin/galculator STARTS in-guest
// (links, instantiates, runs its gobject statics through the fpcast seam, reaches GTK
// init). The full window render + the click-7x6=42 compute need a real compositor and
// are a MANUAL browser check (docs/superpowers/notes/m4-galculator-visual.md).
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const TRAP = /null function or function signature mismatch|unreachable|RuntimeError|wasm trap/;
const REACHED_GTK = /cannot open display|Can't create GtkStyleContext|Gtk-WARNING|GdkDisplay|wayland/i; // refine to the observed message

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
  s.send("/bin/galculator; echo GALC_RC=$?\n");
  // it reached GTK init (started + ran) and did NOT wasm-trap
  const reachedGtk = await s.waitForOutput(REACHED_GTK, 30000);
  const tail = s.snapshot();
  pass = reachedGtk && !TRAP.test(tail);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[galculator-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
```

Run it:
```sh
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/galculator-smoke.mjs ; echo "exit=$?" ; cd ..
```
Expected: `[galculator-smoke] PASS` — galculator started in-guest with no wasm trap.
If it shows a wasm trap (a gobject `call_indirect` mismatch), the fpcast seam didn't
apply to galculator's binary — fix Task 1's postFixup. If GTK aborts on a missing
schema, recheck the Task 1 `.gschema.xml` finding.

- [ ] **Step 3: Write the manual acceptance note**

Create `docs/superpowers/notes/m4-galculator-visual.md` documenting the headline
acceptance as a MANUAL browser check (PENDING, like M0/m3b-gtk-visual): point the pc
browser demo (Greenfield) at fresh artifacts, run `/bin/galculator`, confirm a
calculator window appears, **click `7` `×` `6` `=` and read `42`** (and/or type it on
the keyboard). State that this needs a real compositor + pointer input (unavailable
in the node harness) and stays PENDING until a person runs it.

- [ ] **Step 4: Commit**

```sh
git add runtime/node/galculator-smoke.mjs docs/superpowers/notes/m4-galculator-visual.md
git commit -m "M4: galculator start smoke (in-guest) + manual click-7x6=42 acceptance note"
```

---

## Task 3: Docs — learnings, smoke gate, acceptance reconciliation

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-06-20-galculator-on-wasm-design.md`

- [ ] **Step 1: CLAUDE.md learnings + smoke gate**

Add a Hard-won-learnings bullet: galculator (the headline app) is packaged via an
`isWasm`-guarded override of the nixpkgs derivation that applies the shared
`--fpcast-emu` post-link pass in `postFixup` (gobject casts); lib dep = gtk3 only; no
GSettings schema (config file); `.ui` rides the served closure. Add the
`node node/galculator-smoke.mjs` line to the boot-test section (note: automated gate
= start/no-trap; the click-`42` compute is the manual browser check).

- [ ] **Step 2: Reconcile the design-spec acceptance**

In the design spec's M4/Acceptance section, note the split: the **automated** gate is
"galculator builds + starts in-guest (no wasm trap)"; the **`click 7×6=42`** headline
acceptance is a manual browser check via pc/Greenfield (the node harness has no
compositor — consistent with M0 and the gtk-hello/m3b visual). Keep the goal
unchanged; just record how it's verified.

- [ ] **Step 3: Commit**

```sh
git add CLAUDE.md docs/superpowers/specs/2026-06-20-galculator-on-wasm-design.md
git commit -m "docs: M4 galculator learnings + smoke gate + acceptance reconciliation"
```

---

## Self-review

**Spec coverage (M4 of the design):**
- Package galculator (gtk3 + intltool; autotools cross) → Task 1. ✓
- App assets: `.ui` reachable via the served closure; GSettings schema check (none
  expected for 2.1.4) → Task 1 Step 2 (+ Task 2 fallback if a schema exists). ✓
- Bake into initramfs (extraBins) → Task 1 Step 3. ✓
- The fpcast seam on the GTK app binary → Task 1 Step 1. ✓
- Acceptance (`click 7×6=42`) → automated start gate (Task 2 smoke) + manual browser
  acceptance note (Task 2 Step 3); reconciled in the spec (Task 3). ✓
- **Deviation from spec, justified:** the spec's M4 acceptance "in-guest click
  `7 × 6 = 42`" can't be auto-gated (no compositor/input in the node harness). The
  automated gate proves galculator builds + starts in-guest; the click-to-`42` is a
  manual browser check via pc/Greenfield (the same constraint as M0 and the
  gtk-hello/galculator window render). Recorded in Task 3.

**Placeholder scan:** the smoke's `REACHED_GTK` regex is explicitly "refine to the
observed message" — a real empirical step (Task 2 Step 1 records the actual galculator
output), not a placeholder; the implementer pins it from the probe. No TODO/TBD.

**Type/contract consistency:** the smoke gate string is decided in Task 2 Step 1 and
used in Step 2's regex; the `[galculator-smoke] PASS` line + exit codes match the
repo smoke pattern. Build attr `.#legacyPackages.aarch64-linux.galculator` consistent.

## Out of scope

- The `nix profile install` / drvPath wrinkle (issue #1) and the Phase-5 binary cache
  (issue #2) — orthogonal to making galculator run.
- The full visual compute (`7×6=42`) is a manual browser check, not automated here.
