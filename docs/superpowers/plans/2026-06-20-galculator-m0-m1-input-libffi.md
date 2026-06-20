# Galculator-on-wasm — Plan 1: M0 (input spike) + M1 (libffi f32/f64/i64) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the GTK3/galculator effort by (M0) confirming pointer-button + key
input reaches a guest `wl_seat` client, and (M1) extending the raw wasm libffi
backend to support `f32`/`f64`/`i64` by-value arguments — proven by a standalone
in-guest unit test that runs and passes before any GTK work.

**Architecture:** M0 is a throwaway guest Wayland client run manually against
Greenfield in the browser demo (the Node harness has only a minimal registry
server, so input is verified in-browser). M1 replaces the all-`i32` trampoline
ladder in `patches/libffi/wasm32-raw-ffi.c` with a build-time **generator** that
emits one statically-typed `call_indirect` trampoline per argument *type-vector*
over `{i32,i64,f32,f64}`, bounded by K (max args) and M (max non-`i32` args). A C
unit-test harness, cross-built against `cross.libffi` and run in-guest via the
existing `bootNode` smoke pattern, is the gate.

**Tech Stack:** Nix flake (`deps-overlay.nix` `isWasm` overrides), the wasm32-nommu
cross cc-wrapper, C, Python 3 (the trampoline generator, run in the derivation's
`postPatch`), the `runtime/` Node boot harness (`bootNode` / `waitForOutput`),
libwayland-client + xdg-shell (M0 only).

## Global Constraints

- **PRIME DIRECTIVE:** ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks,
  no stubs. Take the path correct *in general*, not merely sufficient for galculator.
- **Shared fixes only:** every libffi change lives in `deps-overlay.nix` /
  `patches/libffi/` and is `isWasm`-guarded — never package-private. Native builds
  must stay byte-identical (the `whenWasm` guard already does this).
- **Fail loud, never silent:** any signature outside the generated bounds must
  `abort()` with a diagnostic, never mis-call.
- **Target triple / flags:** wasm32 cross builds use the repo's existing
  `cross.stdenv.cc` (`clang-21`, `-mbulk-memory -matomics -fwasm-exceptions`,
  `-shared` dylink). Do not introduce new toolchain flags.
- **libffi version:** the pinned nixpkgs libffi (3.5.x). The raw backend file is
  `src/wasm/ffi.c`, substituted via the overlay's `postPatch`.
- **Bounds (principled defaults, parameterized):** `MAX_ARGS_ALL_I32 = 24`
  (preserve the existing all-`i32` reach for libwayland), `MAX_ARGS_MIXED = 10`,
  `MAX_NON_I32 = 2`. These are generous principled caps (a marshalled GObject
  signal has `nparams+2` args and GTK's widest signals are ~6 params, so arity-10
  with up to two non-`i32` scalars covers anything real); they are generator
  parameters so a later GTK-instrumentation pass (Plan 3 / M3) can bump them with a
  one-line change. With these bounds the generator emits ~8k trampolines.
- **FFI_TYPE enum values** (from libffi `ffi.h`, used by the generator and dispatch):
  `VOID=0 INT=1 FLOAT=2 DOUBLE=3 LONGDOUBLE=4 UINT8=5 SINT8=6 UINT16=7 SINT16=8`
  `UINT32=9 SINT32=10 UINT64=11 SINT64=12 STRUCT=13 POINTER=14 COMPLEX=15`.

---

## File structure

| File | Responsibility | M |
|------|----------------|---|
| `userspace/wl-input-probe.c` | Throwaway `wl_seat`/`wl_pointer`/`wl_keyboard` event logger | M0 |
| `userspace/wl-input-probe.nix` | Cross-build the probe (mirrors `wl-anim.nix`) | M0 |
| `flake.nix` | Wire the probe into `extraBins` + a packages attr; wire the libffi test bin | M0/M1 |
| `docs/superpowers/notes/m0-input-probe.md` | The manual browser verification procedure + result | M0 |
| `patches/libffi/gen-trampolines.py` | Build-time generator → emits `wasm-ffi-trampolines.inc` | M1 |
| `patches/libffi/wasm32-raw-ffi.c` | Generalized `load_arg` + key-based dispatch including the generated `.inc` | M1 |
| `deps-overlay.nix:113` | Run the generator in libffi's `postPatch`, emit the `.inc` beside `ffi.c` | M1 |
| `userspace/libffi-selftest.c` | In-guest unit test: mixed-type `ffi_call`s with asserts | M1 |
| `userspace/libffi-selftest.nix` | Cross-build the selftest against `cross.libffi` | M1 |
| `runtime/node/libffi-smoke.mjs` | Boot, exec `/bin/libffi-selftest`, assert `LIBFFI-SELFTEST: ALL PASS` | M1 |

---

## M0 — Input spike

### Task 1: Build the `wl_seat` input probe and verify input in-browser

**Files:**
- Create: `userspace/wl-input-probe.c`
- Create: `userspace/wl-input-probe.nix`
- Create: `docs/superpowers/notes/m0-input-probe.md`
- Modify: `flake.nix` (add `wlInputProbe` deriv, add to `extraBins`, add `packages.wl-input-probe`)

**Interfaces:**
- Consumes: `cross.wayland`, `cross.wayland-protocols`, `cross.libffi`,
  `cross.buildPackages.wayland-scanner` (same inputs as `userspace/wl-anim.nix`).
- Produces: `/bin/wl-input-probe` in the guest initramfs; flake attr
  `packages.${system}.wl-input-probe`.

- [ ] **Step 1: Write the probe client**

Create `userspace/wl-input-probe.c` — bind `wl_seat`, attach `wl_pointer` +
`wl_keyboard`, log every event to stdout. It needs a surface for the compositor to
target input at, so it also creates one `wl_shm` xdg-toplevel (mirror the setup in
`userspace/wl-anim.c`; only the input listeners are new).

```c
/* wl-input-probe.c — M0 input spike. Binds wl_seat → wl_pointer + wl_keyboard
   and logs every input event. Manual proof that browser pointer/keyboard reach a
   guest Wayland client through Greenfield. NOT baked for production — a diagnostic.
   Setup (display/registry/shm/xdg-toplevel + a blank buffer) mirrors wl-anim.c;
   only the seat/pointer/keyboard listeners below are new. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

/* --- the input listeners (the point of this probe) ---------------------- */
static void pt_enter(void *d, struct wl_pointer *p, uint32_t s,
                     struct wl_surface *sf, wl_fixed_t x, wl_fixed_t y) {
  printf("PROBE pointer.enter x=%d y=%d\n", wl_fixed_to_int(x), wl_fixed_to_int(y));
  fflush(stdout);
}
static void pt_leave(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf) {}
static void pt_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {
  printf("PROBE pointer.motion x=%d y=%d\n", wl_fixed_to_int(x), wl_fixed_to_int(y));
  fflush(stdout);
}
static void pt_button(void *d, struct wl_pointer *p, uint32_t s, uint32_t t,
                      uint32_t button, uint32_t state) {
  printf("PROBE pointer.button button=%u state=%u\n", button, state);
  fflush(stdout);
}
static void pt_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) {}
static const struct wl_pointer_listener pt_listener = {
  pt_enter, pt_leave, pt_motion, pt_button, pt_axis,
};

static void kb_keymap(void *d, struct wl_keyboard *k, uint32_t fmt, int32_t fd, uint32_t sz) {}
static void kb_enter(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf,
                     struct wl_array *keys) { printf("PROBE kb.enter\n"); fflush(stdout); }
static void kb_leave(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf) {}
static void kb_key(void *d, struct wl_keyboard *k, uint32_t s, uint32_t t,
                   uint32_t key, uint32_t state) {
  printf("PROBE kb.key key=%u state=%u\n", key, state);
  fflush(stdout);
}
static void kb_mods(void *d, struct wl_keyboard *k, uint32_t s, uint32_t dep,
                    uint32_t lat, uint32_t lock, uint32_t grp) {}
static void kb_repeat(void *d, struct wl_keyboard *k, int32_t rate, int32_t delay) {}
static const struct wl_keyboard_listener kb_listener = {
  kb_keymap, kb_enter, kb_leave, kb_key, kb_mods, kb_repeat,
};

static void seat_caps(void *data, struct wl_seat *seat, uint32_t caps) {
  if (caps & WL_SEAT_CAPABILITY_POINTER)
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pt_listener, NULL);
  if (caps & WL_SEAT_CAPABILITY_KEYBOARD)
    wl_keyboard_add_listener(wl_seat_get_keyboard(seat), &kb_listener, NULL);
  printf("PROBE seat.caps=0x%x\n", caps); fflush(stdout);
}
static void seat_name(void *d, struct wl_seat *s, const char *n) {}
static const struct wl_seat_listener seat_listener = { seat_caps, seat_name };

/* --- registry: bind wl_compositor, wl_shm, xdg_wm_base, wl_seat ---------- */
/* (Identical in spirit to wl-anim.c's registry handler; add the wl_seat bind:
     if (!strcmp(iface,"wl_seat"))
       seat = wl_registry_bind(reg,name,&wl_seat_interface,1),
       wl_seat_add_listener(seat,&seat_listener,NULL);
   then create one blank wl_shm-backed xdg-toplevel surface so the compositor has
   a target to send input to, commit it, and run wl_display_dispatch() forever.) */

int main(void) {
  /* display connect → get_registry → roundtrip → create surface+xdg_toplevel →
     attach a blank buffer → commit → loop on wl_display_dispatch().
     Copy this scaffolding verbatim from wl-anim.c; the only additions are the
     wl_seat bind in the registry handler and the listeners above. */
  fprintf(stderr, "wl-input-probe: copy the wl-anim.c scaffolding into main()\n");
  return 0;
}
```

Note: the `main()`/registry scaffolding is the *same* boilerplate as
`userspace/wl-anim.c`. Open `wl-anim.c`, copy its `main()` + registry-global
handler, and add only the `wl_seat` bind + the three listeners above. (This is the
one place copying is correct — it is shared Wayland setup, not duplicated logic.)

- [ ] **Step 2: Write the derivation**

Create `userspace/wl-input-probe.nix` as a near-copy of `userspace/wl-anim.nix`,
changing only the `pname` and the source filename:

```nix
# wl-input-probe — M0 input spike. Binds wl_seat/pointer/keyboard and logs input
# events. Manual proof (run in the browser demo against Greenfield). Mirrors
# wl-anim.nix. Diagnostic only — kept as a fixture, not a production client.
{ cross, wayland, wayland-protocols, libffi }:
cross.stdenv.mkDerivation {
  pname = "wl-input-probe";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner
    cross.buildPackages.pkg-config
  ];
  buildInputs = [ wayland wayland-protocols libffi ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner
    WP=${wayland-protocols}/share/wayland-protocols
    mkdir -p gen
    "$SCANNER" client-header "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-client-protocol.h
    "$SCANNER" private-code  "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-protocol.c
    CFLAGS="$($PKG_CONFIG --cflags wayland-client) -I gen -O2"
    LDLIBS="$($PKG_CONFIG --libs wayland-client) -lffi -lm"
    $CC $CFLAGS ${./wl-input-probe.c} gen/xdg-shell-protocol.c $LDLIBS -o wl-input-probe
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 wl-input-probe $out/bin/wl-input-probe
    runHook postInstall
  '';
  meta.description = "wl_seat input probe (M0 spike), wasm32";
}
```

- [ ] **Step 3: Wire into flake.nix**

In `flake.nix`, beside the `wlAnim = import ./userspace/wl-anim.nix { ... }` block
(around line 133), add:

```nix
      # M0 (galculator): wl-input-probe — wl_seat/pointer/keyboard event logger.
      # Manual proof that browser input reaches a guest client through Greenfield.
      wlInputProbe = import ./userspace/wl-input-probe.nix {
        inherit cross;
        wayland = cross.wayland;
        wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
      };
```

Add `wlInputProbe` to the `extraBins` list (line ~223):

```nix
        extraBins = [ wasmWlTest wasmWaylandProxyd wasmWlClient wasmWlHandshake wlEyes wlAnim westonFlowers wlInputProbe ];
```

And expose it as a package (beside the `wl-anim = wlAnim;` attr, ~line 331):

```nix
        wl-input-probe = wlInputProbe;
```

- [ ] **Step 4: Build the probe**

Run: `echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wl-input-probe --no-link --print-out-paths`
Expected: a `/nix/store/...-wl-input-probe-0.1.0` path; `$out/bin/wl-input-probe` exists.

- [ ] **Step 5: Verify input in the browser demo (manual)**

This is a manual proof — the Node harness only has a minimal registry server, so a
real compositor (Greenfield, in the `pc` repo) is needed to source input. Build the
artifacts, point the browser demo at them, boot, run the probe, then move the mouse
over the surface, click, and press a key.

```sh
# from runtime/ — serve the web demo with the artifacts symlinked (see CLAUDE.md)
ln -sfn /path/to/artifacts web/artifacts && node web/serve.mjs
# in the browser: boot, then in the guest shell:
#   /bin/wl-input-probe &
# move the mouse over the window, click, press a key; watch the console.
```

Expected console lines:
- `PROBE seat.caps=0x...` (non-zero; pointer bit `0x1`, keyboard bit `0x2`)
- `PROBE pointer.motion ...` (already known to work)
- `PROBE pointer.button button=272 state=1` on left-click ← **the M0 goal**
- `PROBE kb.key key=... state=1` on a key press (nice-to-have)

- [ ] **Step 6: Record the result**

Create `docs/superpowers/notes/m0-input-probe.md` with: which events were observed,
whether button + key arrived, and — if either did not — a precise description of the
gap (e.g. "Greenfield sends motion but not button") to track in the `pc` repo. This
note is the M0 deliverable.

- [ ] **Step 7: Commit**

```bash
git add userspace/wl-input-probe.c userspace/wl-input-probe.nix flake.nix docs/superpowers/notes/m0-input-probe.md
git commit -m "M0: wl_seat input probe (browser verification pending)"
```

---

## M1 — libffi f32/f64/i64 arguments

The order is test-first: write the unit-test harness (the contract), make it
build + run in-guest and *fail* on float args (proving the gap), then implement the
generator + dispatch to make it pass.

### Task 2: Write the in-guest libffi selftest harness (the contract)

**Files:**
- Create: `userspace/libffi-selftest.c`
- Create: `userspace/libffi-selftest.nix`
- Create: `runtime/node/libffi-smoke.mjs`
- Modify: `flake.nix` (add `libffiSelftest` deriv + `extraBins` + package attr)

**Interfaces:**
- Consumes: `cross.libffi` (headers + `libffi.a`), `cross.stdenv.cc`.
- Produces: `/bin/libffi-selftest` printing exactly `LIBFFI-SELFTEST: ALL PASS` on
  success or `LIBFFI-SELFTEST: FAIL <name>` on the first failing case; flake attr
  `packages.${system}.libffi-selftest`; smoke `runtime/node/libffi-smoke.mjs`.

- [ ] **Step 1: Write the failing test (the selftest C harness)**

Create `userspace/libffi-selftest.c`. Each case builds a cif by hand, calls the
target through `ffi_call`, and asserts. Covers: all-i32 baseline (regression);
single `double`/`float`/`int64` arg at varied positions; two non-i32 args; each
scalar return class; and the boundary (a call with `MAX_NON_I32+1` non-i32 args must
NOT be exercised here — that path aborts the process, so it is checked separately in
Task 5, Step 3).

```c
/* libffi-selftest.c — in-guest unit test for the raw wasm FFI_WASM32 backend.
   Proves f32/f64/i64 by-value ARGUMENTS call correctly (M1). Prints exactly
   "LIBFFI-SELFTEST: ALL PASS" on success. */
#include <ffi.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int failed = 0;
#define CHECK(name, cond) do { \
  if (!(cond)) { printf("LIBFFI-SELFTEST: FAIL %s\n", name); failed = 1; return; } \
} while (0)

/* ---- target functions covering the arg/return classes ------------------ */
static int      t_iii(int a, int b, int c)            { return a + b + c; }
static double   t_pdi(void *p, double d, int i)       { return (double)((intptr_t)p) + d + i; }
static double   t_dddd(double a,double b,double c,double e){ return a+b+c+e; }
static int64_t  t_Ii(int64_t a, int i)                { return a + i; }
static float    t_fpf(float a, void *p, float b)      { return a + b + (float)((intptr_t)p); }
static int64_t  t_pId(void *p, int64_t a, double d)   { return (int64_t)((intptr_t)p) + a + (int64_t)d; }
static double   t_only_d(double a)                    { return a * 2.0; }

/* ---- cases ------------------------------------------------------------- */
static void c_iii(void) {
  ffi_cif cif; ffi_type *at[3] = { &ffi_type_sint32, &ffi_type_sint32, &ffi_type_sint32 };
  CHECK("prep_iii", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint32, at) == FFI_OK);
  int a=2,b=3,c=4,r=0; void *av[3]={&a,&b,&c};
  ffi_call(&cif,(void(*)(void))t_iii,&r,av);
  CHECK("iii", r == 9);
}
static void c_pdi(void) {
  ffi_cif cif; ffi_type *at[3] = { &ffi_type_pointer, &ffi_type_double, &ffi_type_sint32 };
  CHECK("prep_pdi", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_double, at) == FFI_OK);
  void *p=(void*)100; double d=1.5; int i=2, r_ok; double r=0; void *av[3]={&p,&d,&i};
  ffi_call(&cif,(void(*)(void))t_pdi,&r,av);
  r_ok = (r == 103.5); CHECK("pdi", r_ok);
}
static void c_dddd(void) {
  ffi_cif cif; ffi_type *at[4]={&ffi_type_double,&ffi_type_double,&ffi_type_double,&ffi_type_double};
  CHECK("prep_dddd", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 4, &ffi_type_double, at) == FFI_OK);
  double a=1,b=2,c=3,e=4,r=0; void *av[4]={&a,&b,&c,&e};
  ffi_call(&cif,(void(*)(void))t_dddd,&r,av);
  CHECK("dddd", r == 10.0);
}
static void c_Ii(void) {
  ffi_cif cif; ffi_type *at[2]={&ffi_type_sint64,&ffi_type_sint32};
  CHECK("prep_Ii", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, at) == FFI_OK);
  int64_t a=5000000000LL; int i=7; int64_t r=0; void *av[2]={&a,&i};
  ffi_call(&cif,(void(*)(void))t_Ii,&r,av);
  CHECK("Ii", r == 5000000007LL);
}
static void c_fpf(void) {
  ffi_cif cif; ffi_type *at[3]={&ffi_type_float,&ffi_type_pointer,&ffi_type_float};
  CHECK("prep_fpf", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_float, at) == FFI_OK);
  float a=1.5f,b=2.0f; void *p=(void*)0; float r=0; void *av[3]={&a,&p,&b};
  ffi_call(&cif,(void(*)(void))t_fpf,&r,av);
  CHECK("fpf", r == 3.5f);
}
static void c_pId(void) {
  ffi_cif cif; ffi_type *at[3]={&ffi_type_pointer,&ffi_type_sint64,&ffi_type_double};
  CHECK("prep_pId", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint64, at) == FFI_OK);
  void *p=(void*)1; int64_t a=2; double d=3.9; int64_t r=0; void *av[3]={&p,&a,&d};
  ffi_call(&cif,(void(*)(void))t_pId,&r,av);
  CHECK("pId", r == 6); /* 1 + 2 + (int64_t)3.9 */
}
static void c_only_d(void) {
  ffi_cif cif; ffi_type *at[1]={&ffi_type_double};
  CHECK("prep_only_d", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_double, at) == FFI_OK);
  double a=21.0, r=0; void *av[1]={&a};
  ffi_call(&cif,(void(*)(void))t_only_d,&r,av);
  CHECK("only_d", r == 42.0);
}

int main(void) {
  c_iii(); c_pdi(); c_dddd(); c_Ii(); c_fpf(); c_pId(); c_only_d();
  if (!failed) printf("LIBFFI-SELFTEST: ALL PASS\n");
  return failed;
}
```

- [ ] **Step 2: Write the derivation**

Create `userspace/libffi-selftest.nix`:

```nix
# libffi-selftest — in-guest unit test for the raw wasm FFI_WASM32 backend (M1).
# Links the cross libffi (raw backend) and asserts f32/f64/i64 by-value arg calls.
{ cross, libffi }:
cross.stdenv.mkDerivation {
  pname = "libffi-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ libffi ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags libffi) -O2"
    LDLIBS="$($PKG_CONFIG --libs libffi)"
    $CC $CFLAGS ${./libffi-selftest.c} $LDLIBS -o libffi-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 libffi-selftest $out/bin/libffi-selftest
    runHook postInstall
  '';
  meta.description = "Raw wasm FFI_WASM32 backend unit test (M1), wasm32";
}
```

- [ ] **Step 3: Wire into flake.nix**

Beside the `wlInputProbe` block, add:

```nix
      # M1 (galculator): libffi-selftest — in-guest unit test for the raw wasm
      # FFI backend's f32/f64/i64 by-value argument support.
      libffiSelftest = import ./userspace/libffi-selftest.nix {
        inherit cross;
        libffi = cross.libffi;
      };
```

Add `libffiSelftest` to `extraBins`, and expose `libffi-selftest = libffiSelftest;`
beside the other package attrs.

- [ ] **Step 4: Write the smoke runner**

Create `runtime/node/libffi-smoke.mjs` (mirrors `smoke.mjs`'s boot pattern):

```js
// libffi-smoke.mjs — boots and runs /bin/libffi-selftest in-guest.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({});
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[libffi-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/libffi-selftest\n");
  pass = await s.waitForOutput(/LIBFFI-SELFTEST: ALL PASS/, 30000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[libffi-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
```

- [ ] **Step 5: Build and run — verify it FAILS on float args**

Run:
```sh
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#libffi-selftest --no-link
# then boot-test against the built artifacts:
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/node/libffi-smoke.mjs
```
Expected: **FAIL** — the current backend `abort()`s in `load_i32_arg` on the first
`double`/`float`/`int64` argument (case `c_pdi`). The transcript tail shows the
`wasm_ffi_unsupported("by-value argument type")` diagnostic. (The all-i32 `c_iii`
case passes; the float cases are the gap.)

- [ ] **Step 6: Commit**

```bash
git add userspace/libffi-selftest.c userspace/libffi-selftest.nix runtime/node/libffi-smoke.mjs flake.nix
git commit -m "M1: in-guest libffi selftest harness (fails on f32/f64/i64 args)"
```

### Task 3: Write the trampoline generator

**Files:**
- Create: `patches/libffi/gen-trampolines.py`

**Interfaces:**
- Produces: a script `python3 gen-trampolines.py > wasm-ffi-trampolines.inc` emitting
  a C `switch (key)` body. Consumed by Task 4's `ffi_call`. The key encoding is the
  contract between generator and dispatch:
  `key = (return_class << 40) | (arity << 32) | argvec`, where `argvec = Σ
  class_i << (2*i)` and the per-arg class is `0=i32, 1=i64, 2=f32, 3=f64`; the
  return_class is `0=void, 1=u32(int/ptr/subword), 2=i64, 3=f32, 4=f64`.

- [ ] **Step 1: Write the generator**

Create `patches/libffi/gen-trampolines.py`. It enumerates, for every return class and
every in-bounds arg type-vector, one `case` that casts `fn` to the exact C prototype,
loads each argument with the correctly-typed accessor, calls, and stores the result.

```python
#!/usr/bin/env python3
# gen-trampolines.py — emit the FFI_WASM32 trampoline switch body.
# One `call_indirect` per argument type-vector over {i32,i64,f32,f64}, bounded by
# MAX_ARGS_ALL_I32 (all-i32 reach, M=0) / MAX_ARGS_MIXED / MAX_NON_I32. wasm requires
# each indirect call's signature to be statically known, so signatures are enumerated
# here at build time (no JS host to synthesize them — see wasm32-raw-ffi.c rationale).
import itertools, sys

MAX_ARGS_ALL_I32 = 24
MAX_ARGS_MIXED   = 10
MAX_NON_I32      = 2

# arg class -> (C param type, loader expr template over avalue[i])
ARG = {
    0: ("u32",      "load_i32_arg(at[{i}], av[{i}])"),  # i32: int/ptr/subword
    1: ("uint64_t", "(*(uint64_t*)av[{i}])"),           # i64
    2: ("float",    "(*(float*)av[{i}])"),              # f32
    3: ("double",   "(*(double*)av[{i}])"),             # f64
}
# return class -> (C return type, store stmt using `r` and `rvalue`)
RET = {
    0: ("void",     None),
    1: ("u32",      "if (rvalue) *(ffi_arg*)rvalue = (ffi_arg)r;"),
    2: ("uint64_t", "if (rvalue) *(uint64_t*)rvalue = r;"),
    3: ("float",    "if (rvalue) *(float*)rvalue = r;"),
    4: ("double",   "if (rvalue) *(double*)rvalue = r;"),
}

def argvecs():
    # all-i32 (M=0) up to MAX_ARGS_ALL_I32
    for n in range(0, MAX_ARGS_ALL_I32 + 1):
        yield (0,) * n
    # >=1 non-i32, up to MAX_NON_I32, up to MAX_ARGS_MIXED
    for n in range(1, MAX_ARGS_MIXED + 1):
        for positions in itertools.chain.from_iterable(
                itertools.combinations(range(n), k) for k in range(1, MAX_NON_I32 + 1)):
            for kinds in itertools.product((1, 2, 3), repeat=len(positions)):
                vec = [0] * n
                for pos, kind in zip(positions, kinds):
                    vec[pos] = kind
                yield tuple(vec)

def key(rc, vec):
    av = 0
    for i, c in enumerate(vec):
        av |= c << (2 * i)
    return (rc << 40) | (len(vec) << 32) | av

def emit():
    print("/* GENERATED by gen-trampolines.py — do not edit. */")
    seen = set()
    for rc, (rtype, store) in RET.items():
        for vec in argvecs():
            k = key(rc, vec)
            if k in seen:      # all-i32 arity-0 collides across nothing; guard anyway
                continue
            seen.add(k)
            params = ",".join(ARG[c][0] for c in vec) or "void"
            loads  = ",".join(ARG[c][1].format(i=i) for i, c in enumerate(vec))
            cast   = f"{rtype} (*)({params})"
            call   = f"(({cast})fn)({loads})"
            print(f"case 0x{k:x}ULL: {{")
            if rtype == "void":
                print(f"  {call};")
            else:
                print(f"  {rtype} r = {call};")
                print(f"  {store}")
            print("  break; }")
    print(f"/* {len(seen)} trampolines */", file=sys.stderr)

if __name__ == "__main__":
    emit()
```

- [ ] **Step 2: Sanity-run the generator on the build host**

Run: `python3 patches/libffi/gen-trampolines.py > /tmp/tramp.inc; wc -l /tmp/tramp.inc; head -20 /tmp/tramp.inc`
Expected: several thousand `case 0x...ULL:` lines; the stderr footer prints the
trampoline count (≈8k with these bounds — several thousand, NOT tens of thousands;
that confirms the M=2 / K=10 bounds contain the `4^N` blow-up). Each case casts `fn`
to a concrete prototype.

- [ ] **Step 3: Commit**

```bash
git add patches/libffi/gen-trampolines.py
git commit -m "M1: trampoline generator (bounded f32/f64/i64 arg signatures)"
```

### Task 4: Rewrite ffi_call dispatch to use the generated trampolines

**Files:**
- Modify: `patches/libffi/wasm32-raw-ffi.c` (replace the `P*/A*/DISPATCH/CASE` ladder
  and the body of `ffi_call`; keep `load_i32_arg`, `ffi_prep_cif_machdep`, the
  `_var` refusal, and `wasm_ffi_unsupported`).

**Interfaces:**
- Consumes: `wasm-ffi-trampolines.inc` (Task 3 output, generated into the build dir
  by Task 5) and the key encoding from Task 3.
- Produces: a `ffi_call` that computes `key` identically and `#include`s the `.inc`
  inside its `switch`.

- [ ] **Step 1: Add the arg/return class helpers and key computation**

Replace the trampoline-ladder section (the `#define P0..A24`, `CASE`, `DISPATCH`
macros) and the `ffi_call` body with the following. Keep `load_i32_arg` as-is (it
performs the sub-word sign/zero extension the generator's class-0 loader relies on);
keep `wasm_ffi_unsupported`.

```c
/* arg wasm value-class: 0=i32, 1=i64, 2=f32, 3=f64. Aborts on what the raw ABI
   can't pass by value (struct/complex/long double). */
static unsigned arg_class(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_INT: case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32: case FFI_TYPE_POINTER:
      return 0;
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64: return 1;
    case FFI_TYPE_FLOAT:  return 2;
    case FFI_TYPE_DOUBLE: return 3;
    default: wasm_ffi_unsupported("by-value argument type"); return 0;
  }
}

/* return wasm value-class: 0=void,1=u32,2=i64,3=f32,4=f64. */
static unsigned ret_class(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_VOID: return 0;
    case FFI_TYPE_INT: case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32: case FFI_TYPE_POINTER:
      return 1;
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64: return 2;
    case FFI_TYPE_FLOAT:  return 3;
    case FFI_TYPE_DOUBLE: return 4;
    default: wasm_ffi_unsupported("return type"); return 0;
  }
}

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue) {
  ffi_type **at = cif->arg_types;
  void **av = avalue;
  unsigned n = cif->nargs;
  uint64_t key = ((uint64_t)ret_class(cif->rtype) << 40) | ((uint64_t)n << 32);
  for (unsigned i = 0; i < n; i++)
    key |= (uint64_t)arg_class(at[i]) << (2 * i);

  switch (key) {
    #include "wasm-ffi-trampolines.inc"
    default:
      wasm_ffi_unsupported("argument signature outside generated bounds");
  }
}
```

Note: the generated loaders reference `at`, `av`, `fn`, `rvalue` — the exact names
bound above. Do not rename them.

- [ ] **Step 2: Commit (compiles only after Task 5 wires the generator)**

```bash
git add patches/libffi/wasm32-raw-ffi.c
git commit -m "M1: key-based ffi_call dispatch over generated trampolines"
```

### Task 5: Wire the generator into the libffi build and make the selftest pass

**Files:**
- Modify: `deps-overlay.nix` (the `libffi = whenWasm ...` block, ~line 113)

**Interfaces:**
- Consumes: `patches/libffi/gen-trampolines.py`, the rewritten `wasm32-raw-ffi.c`.
- Produces: `cross.libffi` whose `src/wasm/` contains both `ffi.c` and the generated
  `wasm-ffi-trampolines.inc`; the selftest from Task 2 now passes.

- [ ] **Step 1: Run the generator in libffi's postPatch**

Edit the `libffi` override in `deps-overlay.nix` so `postPatch` also generates the
`.inc` beside `ffi.c` (the generator needs `python3` from the *native* buildPackages):

```nix
  libffi = whenWasm
    (p: p.overrideAttrs (o: {
      nativeBuildInputs = (o.nativeBuildInputs or []) ++ [ final.buildPackages.python3 ];
      postPatch = (o.postPatch or "") + ''
        cp ${./patches/libffi/wasm32-raw-ffi.c} src/wasm/ffi.c
        python3 ${./patches/libffi/gen-trampolines.py} > src/wasm/wasm-ffi-trampolines.inc
      '';
    }))
    prev.libffi;
```

(The `#include "wasm-ffi-trampolines.inc"` in `ffi.c` resolves because both files
sit in `src/wasm/` and libffi compiles `ffi.c` from that directory.)

- [ ] **Step 2: Update the overlay comment**

Update the comment block above the `libffi` override (lines ~99–112) to note that
the backend now supports f32/f64/i64 by-value arguments via the bounded generator,
not just all-i32 — so the rationale index stays accurate. Replace the sentence
"...over all-i32 argument lists with scalar returns..." with a note that it now
covers up to `MAX_NON_I32` non-i32 args per call via `gen-trampolines.py`, and
aborts loud past the (K, M) bounds.

- [ ] **Step 3: Rebuild libffi and run the selftest — verify PASS**

Run:
```sh
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#libffi-selftest --no-link --print-out-paths
# rebuild the guest artifacts (initramfs) so /bin/libffi-selftest is the new binary, then:
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/node/libffi-smoke.mjs
```
Expected: **PASS** — `LIBFFI-SELFTEST: ALL PASS`, `[libffi-smoke] PASS`, exit 0. All
seven cases (incl. `c_pdi`, `c_dddd`, `c_fpf`, `c_pId`, `c_only_d`) succeed.

- [ ] **Step 4: Verify the abort boundary (loud-fail discipline)**

Add one more case to `userspace/libffi-selftest.c` *temporarily* that builds a cif
with `MAX_NON_I32 + 1` (= 3) double args and confirm the process aborts with
"argument signature outside generated bounds" rather than mis-calling. Because abort
kills the process, verify this by running it as its own invocation and asserting the
diagnostic appears in the transcript, then **revert** the temporary case (it can't
live in the always-run harness). Record the observed diagnostic in a comment.

Run: build + boot, `s.send("/bin/libffi-selftest-boundary\n")`, expect transcript to
contain `argument signature outside generated bounds`.

- [ ] **Step 5: Confirm native libffi is unchanged**

Run: `echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.x86_64-linux.libffi --no-link 2>/dev/null || true`
Expected: the *native* libffi build is untouched by the `whenWasm` guard — no
rebuild from source is triggered for native consumers. (Spot-check: the overlay
edit is inside `whenWasm`, so `isWasm == false` returns `prev.libffi` verbatim.)

- [ ] **Step 6: Commit**

```bash
git add deps-overlay.nix
git commit -m "M1: wire trampoline generator into libffi build; selftest passes"
```

### Task 6: Add the libffi smoke as a documented gate

**Files:**
- Modify: `CLAUDE.md` (add `libffi-smoke.mjs` to the boot-test harness section)

- [ ] **Step 1: Document the gate**

In `CLAUDE.md`, under "Boot-test the built guest", add a line documenting the new
smoke:

```sh
# libffi raw-backend unit test (f32/f64/i64 by-value args): boot → run selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/node/libffi-smoke.mjs
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document libffi-smoke gate"
```

---

## Self-review

**Spec coverage (M0+M1 portion of the design):**
- M0 input spike (button + key proof) → Task 1. ✓ (manual browser proof, recorded)
- M1 bounded generator over `{i32,i64,f32,f64}`, (K,M) caps, all-i32 = M=0 → Tasks 3,4. ✓
- `load_i32_arg` → generalized loaders → Task 4 (`arg_class` + generated per-class loads). ✓
- Standalone in-guest unit test, runs/passes before any GTK → Tasks 2,5. ✓
- Loud abort past bounds → Task 4 `default:` + Task 5 Step 4. ✓
- Recorded wasm-vs-CPU rationale → already in the spec; overlay comment updated (Task 5 Step 2). ✓
- Struct-by-value deferred (loud abort) → `arg_class` default aborts; instrumentation deferred to M3. ✓
- **Deviation from spec, intentional:** the spec said K/M are "informed by
  instrumenting a real GTK run." Because GTK isn't built until M3, this plan ships
  *principled defaults* (K=14, M=2, all-i32=24) — parameters in `gen-trampolines.py`
  — and the M3 plan will instrument and adjust if needed. Recorded in Global
  Constraints. This is more correct than blocking M1 on M3.

**Placeholder scan:** the only intentionally-incomplete code is `wl-input-probe.c`'s
`main()`/registry scaffolding, explicitly delegated to "copy from `wl-anim.c`" —
correct shared-setup reuse, not a logic placeholder. No TODO/TBD elsewhere.

**Type consistency:** the key encoding (`(rc<<40)|(n<<32)|argvec`, classes
`i32=0,i64=1,f32=2,f64=3`; return `void=0,u32=1,i64=2,f32=3,f64=4`) is defined once
in Task 3 and computed identically in Task 4 (`arg_class`/`ret_class`). The
generated loaders reference `at`/`av`/`fn`/`rvalue`, the exact names bound in Task 4's
`ffi_call`. `load_i32_arg` (kept from the existing file) is reused by class-0 loads.

## Out of scope (later plans)

- M2 text stack, M3 GTK3 + runtime assets, M4 galculator — each its own plan.
- GTK-driven instrumentation to confirm/raise (K, M) — folded into the M3 plan.
