# Clean-NOMMU Process Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On top of master's existing shared-NOMMU-arena model, make `fork()`/`vfork()` fail at **link time** (so callers fail loudly in their Nix build instead of SIGILL/abort at runtime), with `posix_spawn` as the documented spawn contract — and document it.

**Architecture:** Master already runs the single shared `WebAssembly.Memory` arena and the clone-with-fn spawn path; musl's `posix_spawn` rides `clone(CLONE_VM, fn)`, and musl's `system()`/`popen()` already route through `posix_spawn` (verified in 1.2.5). The only code change is removing the `fork`/`vfork` symbols from the nix-built musl so the cross cc-wrapper's linker rejects callers, plus a documentation commit. No kernel, runtime, or memory-model change.

**Tech Stack:** Nix (`toolchain/musl.nix`, `wasm-cross.nix` cc-wrapper), musl 1.2.5, LLVM-21 `wasm-ld`, the in-repo `runtime/` node harness.

## Global Constraints

- **Baseline is `master` (`e90170d`).** This is NOT a revert — master already has the shared arena (0 per-process-memory patches; no `userMems`) and the clone-with-fn busybox/ash patches. Build the implementation branch off `master`.
- **Verified fact (do not re-derive):** musl 1.2.5 `src/process/system.c` and `src/stdio/popen.c` both call **`posix_spawn`** (not fork/vfork); `src/process/posix_spawn.c` uses `__clone(child, stack, CLONE_VM|CLONE_VFORK|SIGCHLD, &args)`. So removing `fork`/`vfork` does not break `system`/`popen`/`posix_spawn`.
- **No kernel / runtime / memory-model change.** Only `toolchain/musl.nix` (+ a docs file) change.
- **`fork`/`vfork` must fail at *link* time, never a runtime stub.** The success criterion for the core task is a linker error `undefined symbol: fork` / `vfork` from the cross cc-wrapper.
- **Nix builds:** `echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#<attr> --no-link --print-out-paths` (password in agent memory; run each `sudo nix` as its own command; never run a second `nix` against a live build — the eval cache is one SQLite db).
- **Artifacts for the boot smoke:** `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/` built from `.#kernel`, `.#wasm-initramfs`, `.#wasm-store-manifest`.

---

### Task 1: Remove `fork()`/`vfork()` symbols from the nix-built musl

**Files:**
- Modify: `toolchain/musl.nix` (add a `postPatch` snippet)
- Create: `spikes/nofork/uses-fork.c`, `spikes/nofork/uses-spawn.c`, `spikes/nofork/check.nix`

**Interfaces:**
- Produces: a musl `libc.a` with **no `fork` and no `vfork` symbol**. Downstream: the cross cc-wrapper (`cross.stdenv.cc`) then rejects any object that references `fork`/`vfork` with `wasm-ld: error: undefined symbol: fork` (the cc-wrapper uses `--allow-undefined-file=…`, a *specific* allow-list that does not include fork/vfork). `posix_spawn`/`system`/`popen` keep working.

- [ ] **Step 1: Write the probe sources + the link-behavior check**

`spikes/nofork/uses-fork.c`:
```c
#include <unistd.h>
int main(void) { return fork(); }   /* must FAIL to link */
```

`spikes/nofork/uses-spawn.c`:
```c
#include <spawn.h>
#include <unistd.h>
extern char **environ;
int main(void) {
    pid_t pid; char *argv[] = {"/bin/true", 0};
    return posix_spawn(&pid, "/bin/true", 0, 0, argv, environ);  /* must link */
}
```

`spikes/nofork/check.nix` — compiles each probe through the cross cc-wrapper and records the outcome in `$out` (always builds; `$out` reports the link result so the test is a normal `nix build`):
```nix
{ cross }:
cross.stdenv.mkDerivation {
  name = "nofork-linkcheck";
  dontUnpack = true;
  buildPhase = ''
    res() { echo "$1" >> $out; }
    mkdir -p $out
    : > $out/result
    if $CC ${./uses-fork.c} -o fork.wasm 2>fork.err; then
      echo "fork=LINKED" >> $out/result
    else
      grep -q "undefined symbol: fork" fork.err \
        && echo "fork=ABSENT" >> $out/result \
        || { echo "fork=OTHER_ERROR" >> $out/result; cat fork.err >> $out/result; }
    fi
    if $CC ${./uses-spawn.c} -o spawn.wasm 2>spawn.err; then
      echo "spawn=LINKED" >> $out/result
    else
      echo "spawn=FAILED" >> $out/result; cat spawn.err >> $out/result
    fi
  '';
  installPhase = "true";
}
```

Expose it in `flake.nix` near the other ad-hoc checks (the `legacyPackages = cross` / spike pattern), e.g. add to the flake outputs:
```nix
nofork-linkcheck = import ./spikes/nofork/check.nix { inherit cross; };
```

- [ ] **Step 2: Run the check on the CURRENT tree (expect fork still links)**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#nofork-linkcheck --no-link --print-out-paths
# then: cat <out>/result
```
Expected: `fork=LINKED` and `spawn=LINKED` (master ships a `fork` symbol that links and would SIGILL at runtime). This is the failing state.

- [ ] **Step 3: Remove the symbols in `toolchain/musl.nix`**

Add this `postPatch` to the musl derivation in `toolchain/musl.nix` (postPatch runs *after* the existing patch list, so it cleanly supersedes the `0000` `vfork` abort-stub hunk):
```nix
postPatch = (old.postPatch or "") + ''
  # Clean-NOMMU spawn contract: wasm has no fork()/vfork() (return-twice needs a
  # multi-shot continuation, which no shipped engine provides — see
  # docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md). Remove the
  # symbols so a caller fails to LINK in its Nix build (loud, traceable) instead of
  # SIGILL/abort at runtime. posix_spawn (clone-with-fn) is the spawn contract;
  # musl's system()/popen() already route through it.
  # fork(): drop the function (lines `pid_t fork(void)` … first column-0 `}`),
  # keeping fork.c's lock/atfork weak-aliases that other TUs depend on.
  sed -i '/^pid_t fork(void)/,/^}/d' src/process/fork.c
  # vfork(): the whole TU is just the function — empty it so no symbol remains.
  : > src/process/vfork.c
'';
```
If `toolchain/musl.nix` uses `mkDerivation { … }` directly (not an overlay `old`), append the two shell lines to the existing `postPatch` string instead of `(old.postPatch or "")`.

- [ ] **Step 4: Rebuild musl + re-run the check (expect fork ABSENT, spawn LINKED)**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#musl --no-link --print-out-paths
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#nofork-linkcheck --no-link --print-out-paths
# cat <out>/result
```
Expected: `fork=ABSENT` (linker reports `undefined symbol: fork`) and `spawn=LINKED`. If `fork=OTHER_ERROR`, read the captured stderr — most likely the cc-wrapper allow-undefined list *does* include fork (then remove it from `wasm-cross.nix`'s allow-undefined file) or `--gc-sections` elided the reference (add `-Wl,--no-gc-sections` to the probe to force the reference).

- [ ] **Step 5: Commit**

```bash
git add toolchain/musl.nix spikes/nofork/ flake.nix
git commit -m "musl(wasm): remove fork()/vfork() symbols — callers fail to link (clean-NOMMU spawn contract)"
```

---

### Task 2: No-regression — guest userspace still builds and boots

**Files:**
- None modified (verification task). Any package that now fails to link is triaged here.

**Interfaces:**
- Consumes: the fork/vfork-absent musl from Task 1.
- Produces: confirmation that the existing guest (busybox/ash/nix/coreutils) still builds against the new musl and boots, and a triage record for any package that referenced `fork` (the intended loud failure).

- [ ] **Step 1: Rebuild the userspace artifacts against the new musl**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#nix-wasm --no-link --print-out-paths
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-store-manifest --no-link --print-out-paths
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#kernel --no-link --print-out-paths
```
Expected: all build. If any package fails with `undefined symbol: fork`/`vfork`, that's the intended loud failure — record the package in `docs/superpowers/notes/` and port its spawn site to `posix_spawn` via the documented pattern (Task 3), or exclude it. Busybox/ash/nix already use clone-with-fn/posix_spawn and should be unaffected.

- [ ] **Step 2: Assemble artifacts + run the full-system boot smoke (the existing gate)**

Assemble the four artifacts into a dir (vmlinux.wasm, initramfs.cpio.gz, store.json, store-content) as `runtime/scripts/build-artifacts.sh` does, then:
```bash
cd runtime
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/smoke.mjs ; echo "exit=$?"
```
Expected: exit 0 — boot → 9P read/write/ls → `nix-env -iA sl` substitutes and `sl` renders (the pre-existing Phase-A/B gate). (Exit 2 = boot panic → re-run; exit 1 = real failure.)

- [ ] **Step 3: Run the engine unit tests (must stay green — nothing engine-side changed)**

```bash
cd runtime && bun run test
```
Expected: all pass (79 engine tests; unchanged — this task touched only musl).

- [ ] **Step 4: Commit (the triage note, if any)**

```bash
git add docs/superpowers/notes/ 2>/dev/null || true
git commit -m "test(wasm): clean-NOMMU musl — full system boots + nix-env -iA sl renders; no regression" --allow-empty
```

---

### Task 3: Document the spawn contract; relabel the busybox/ash spawn patches

**Files:**
- Create: `docs/process-model.md`
- Modify: `CLAUDE.md` (add a one-paragraph pointer under the Architecture section)

**Interfaces:**
- Consumes: the behavior established in Tasks 1–2.
- Produces: a single authoritative description of the spawn contract so the busybox/ash clone-with-fn patches are understood as one documented platform port rather than ad-hoc commits.

- [ ] **Step 1: Write `docs/process-model.md`**

```markdown
# Guest process model (clean NOMMU)

The guest is a single-shared-arena NOMMU system: one `WebAssembly.Memory`,
`mm/nommu.c` loads each process at its `data_start` offset, soft isolation,
`MAP_SHARED` works, thousands of processes.

## Spawn contract — `posix_spawn` only

wasm cannot implement `fork()`/`vfork()`: "return twice" needs a multi-shot
continuation. WasmFX and JSPI are one-shot (verified — `spikes/stackswitch/`:
a 2nd `resume` traps), and per-binary asyncify is rejected. So:

- **Kernel:** `clone(CLONE_VM|CLONE_VFORK|SIGCHLD, fn)` is the spawn primitive.
- **musl:** `posix_spawn` rides it; `system()`/`popen()` route through `posix_spawn`
  (upstream 1.2.5 already does). `fork`/`vfork` symbols are **removed**
  (`toolchain/musl.nix` postPatch) — a caller fails to **link** in its Nix build.
- **Ports:** a program that hard-codes `vfork`+exec is ported once via the documented
  `vfork`→`posix_spawn`/clone-with-fn pattern. The busybox patches
  (`patches/busybox/0001/0003/0004/0005/0006`, ash) ARE this port for busybox — its
  spawn is centralized in `libbb` (`vfork_daemon_rexec.c` + applet sites). Keep them
  as the labeled busybox-on-wasm spawn port.

## Why not per-process memory / real fork
Per-process `WebAssembly.Memory` caps at ~124/tab (`spikes/elastic-mem/`). Real
`fork()` needs both multi-shot control (unavailable) and a same-address child copy
(forces per-process Memory → the cap). Both dead-ends are measured, not assumed.
See docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md.
```

- [ ] **Step 2: Add the CLAUDE.md pointer**

Add under the Architecture section of `CLAUDE.md`:
```markdown
- **Process model** = single shared NOMMU arena + a `posix_spawn`-only spawn
  contract; `fork`/`vfork` are removed at the libc level (callers fail to link).
  See `docs/process-model.md`. (Per-process Memory and real `fork()` are measured
  dead-ends — `spikes/elastic-mem/`, `spikes/stackswitch/`.)
```

- [ ] **Step 3: Commit**

```bash
git add docs/process-model.md CLAUDE.md
git commit -m "docs(wasm): document the clean-NOMMU posix_spawn contract; label busybox spawn port"
```

---

## Self-Review

**Spec coverage:**
- Verify-first (musl system/popen → posix_spawn) → resolved in Global Constraints (verified: both use `posix_spawn`); no routing patch needed (spec's "one musl patch if not" → not triggered).
- Remove `fork`/`vfork` at link level → Task 1.
- No kernel/runtime/memory change → Global Constraints + only `musl.nix`/docs touched.
- Keep busybox; document the port → Task 3.
- No-regression (boot + `nix-env -iA sl`) → Task 2.
- Record the two dead-ends → Task 3 doc references `spikes/elastic-mem/` + `spikes/stackswitch/`.

**Placeholder scan:** none — every step has concrete code/commands. The `<pw>` and `/path/to/artifacts/` are environment values the implementer substitutes (password from agent memory; artifacts dir from the build), not plan placeholders.

**Type consistency:** the flake attr `nofork-linkcheck`, the probe filenames (`uses-fork.c`/`uses-spawn.c`), and `$out/result` markers (`fork=ABSENT`/`spawn=LINKED`) are named identically across Task 1 steps. `docs/process-model.md` is the single doc referenced by both Task 3 steps and the CLAUDE.md pointer.

**Risk note:** Task 1 Step 4 may surface that the cc-wrapper's allow-undefined list includes fork, or `--gc-sections` elides the reference — both have inline mitigations. Task 2 may surface a currently-building package that references `fork` — that is the *intended* loud failure, triaged in place.
