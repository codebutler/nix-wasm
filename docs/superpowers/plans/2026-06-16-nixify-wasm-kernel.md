# Nixify the wasm guest kernel (`vmlinux.wasm`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reproducible Nix derivation `.#kernel` that builds the wasm guest kernel `vmlinux.wasm` from pinned source — replacing pc's shell-script + external-`~/lwbuild` build, `fake-llvm`, and the CI escape hatch.

**Architecture:** The kernel needs a `wasm-ld` that supports GNU `SECTIONS{}` linker scripts (to link `vmlinux` via `arch/wasm/kernel/vmlinux.lds`); stock `wasm-ld` lacks this. We carry the joelseverin/llvm fork's linker-script patch **rebased onto our stock LLVM-21 `lld`** (Path A), packaged as a **locally-scoped** patched `lld` consumed *only* by the kernel derivation (no global overlay → no rebuild cascade; the cached shared toolchain is untouched). The kernel's Makefile takes explicit tool paths, so `kernel.nix` points `make`'s `LD` (via a small wrapper carrying `fake-llvm`'s argv rewrites) at the patched `wasm-ld` and `CC` at stock clang. `wasm-ld` emits the `.wasm` directly — `cp vmlinux → vmlinux.wasm`, no ELF→wasm step.

**Tech Stack:** Nix flakes; nixpkgs `llvmPackages_21` (clang/lld **21.1.8**); joelseverin/linux `039e5f3e` (already fetched by `toolchain/kernel-headers.nix`, verified hash); 6 pc kernel patches; `make ARCH=wasm`.

**Scope (this plan):** ends at `nix build .#kernel` producing a `vmlinux.wasm` whose wasm imports match the 039e5f3e **new exec ABI** (the 15 host funcs incl. `wasm_create_and_run_task`/`wasm_load_executable`, **no** `wasm_exec_*`). It will **NOT boot yet** — that needs the separate `kernel-worker.js` runtime forward-port (next plan). Acceptance here = *reproducible, structurally-correct* kernel, not boot. overlayfs config is a *later* phase too.

**Background:** the kernel can't currently be rebuilt to a booting state because the committed binary + JS runtime speak an OLD exec ABI while the pinned source is the NEW one (see `docs/superpowers/specs/` notes + the agent memory `kernel-build-and-abi`). Nixifying gives a deterministic build to forward-port against.

---

## Conventions
- Run each Nix command standalone (sudo daemon; `sudo -E` ignored; password `password`):
  `echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' <args>`
- One `nix` invocation at a time (shared SQLite eval cache).
- Don't kill running builds. Commit after each task; trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Reference inputs already in the repo:
  - `reference-kernel/wasm-ld-lds-FROM-llvm18-fork.patch` — the spike's **unrebased** (LLVM-18) extract of the linker-script patch (2277 lines; 10/12 lld files apply clean to 21; ~27 `config->`/`WasmSym::` identifier renames + 1 `Driver.cpp` hunk to rework for 21).
  - The 6 kernel patches at `~/Code/pc/vendor/linux-wasm/patches/000*.patch`.
  - The kernel fetch in `toolchain/kernel-headers.nix` (owner=joelseverin repo=linux rev=039e5f3e… hash=sha256-La+8ZfCyPiFt2BSixlRZn/Y9etA2CKoumN5/RB8Kt1U=).
  - The exact config toggles + `make` vars in `~/Code/pc/vendor/linux-wasm/build.sh` `configure_kernel()`/`kernel_make()`, and the argv rewrites in `~/Code/pc/vendor/linux-wasm/.build/linux-wasm/tools/fake-llvm/llvm-wrapper.py`.

---

## File structure
| File | Responsibility |
|---|---|
| `patches/llvm/wasm-ld-linker-script-21.patch` (create) | the fork's linker-script patch, **rebased to LLVM-21** |
| `patches/kernel/000*.patch` (create, ×6) | copies of pc's kernel patches |
| `toolchain/kernel-src.nix` (create) | shared pinned kernel `src` (factored out of kernel-headers.nix) |
| `toolchain/patched-lld.nix` (create) | `llvmPackages_21.lld` + the rebased patch (kernel-only) |
| `toolchain/kernel-cc.nix` (create) | clang + patched-`wasm-ld` wrappers (the `fake-llvm` equivalent) |
| `kernel.nix` (create) | configure + `make vmlinux` + install → `$out/vmlinux.wasm` |
| `toolchain/kernel-headers.nix` (modify) | consume the shared `kernel-src.nix` |
| `flake.nix` (modify) | expose `patched-lld`, `kernel` |

---

## Task 1: Rebase the `wasm-ld` linker-script patch onto LLVM-21 + package a kernel-only patched `lld`

**Files:** Create `patches/llvm/wasm-ld-linker-script-21.patch`, `toolchain/patched-lld.nix`; Modify `flake.nix`.

This is the crux. The spike confirmed: the new files (`ScriptLexer`/`ScriptParser`, ~1780 lines) apply clean; the work is the LLVM 18→21 API rename (`config->X` → `ctx.arg.X`, `WasmSym::X` → `ctx.sym.X`; ~27 refs) across `Driver.cpp`/`Writer.cpp`/`SymbolTable.cpp`/`InputFiles.cpp`/`Config.h`, plus one `Driver.cpp` hunk (`config->globalBase` → `ctx.arg.globalBase`). The `linkerScript` field added to `Config.h` must move to LLVM-21's `ctx.arg`.

- [ ] **Step 1: Get the LLVM-21.1.8 `lld/wasm` source to rebase against.** Fetch the llvm-project `lld/wasm` tree at tag `llvmorg-21.1.8` (shallow, `lld/` only) into a scratch dir, and the stock `llvmorg-18.1.2` `lld/wasm` (to 3-way against). Apply `reference-kernel/wasm-ld-lds-FROM-llvm18-fork.patch` onto the 21 tree with `git apply --3way` to land the clean files and surface the conflicts.

- [ ] **Step 2: Resolve the rename conflicts.** In the conflicting/【offset】 hunks, rewrite the patch's added lines: `config->` → `ctx.arg.` (and `config->isPic` → `ctx.isPic` if present), `WasmSym::` → `ctx.sym.`; move the new `linkerScript` config field into LLVM-21's `Config`/`ctx.arg` struct; rework the `Driver.cpp` hunk #3 (`globalBase`). Leave `symtab->` as-is (survives). Produce a clean unified diff against `llvmorg-21.1.8` and save it as `patches/llvm/wasm-ld-linker-script-21.patch`.

- [ ] **Step 3: Package the patched lld (kernel-only).** Create `toolchain/patched-lld.nix`:
```nix
{ pkgs }:
pkgs.llvmPackages_21.lld.overrideAttrs (o: {
  patches = (o.patches or [ ]) ++ [ ../patches/llvm/wasm-ld-linker-script-21.patch ];
})
```
Wire into `flake.nix` `let`: `patchedLld = import ./toolchain/patched-lld.nix { inherit pkgs; };` and expose `packages.${system}.patched-lld = patchedLld;`.

- [ ] **Step 4: Build it (the test).** Run `echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#patched-lld --no-link --print-out-paths`. Expected: a `/nix/store/…-lld-21.1.8` path (only `lld` rebuilds; `libLLVM` substitutes from cache). If compile errors → fix the rebased patch (likely a missed rename) and rebuild. If the build wants to recompile `libLLVM` from source, note it (means the patch reached an llvm lib — it shouldn't; the linker-script patch is lld-only).

- [ ] **Step 5: Verify the feature is present (the real test).** With `LLD=<out>`: run `$LLD/bin/wasm-ld --help 2>&1 | grep -- --script` (expect a `--script` option line) and `$LLD/bin/wasm-ld --script=/dev/null --version 2>&1` (expect NO "unknown argument: --script"; a version string or a script-parse error is fine — the point is the flag is recognized). Stock `wasm-ld` errors "unknown argument"; the patched one must not.

- [ ] **Step 6: Commit.**
```bash
cd ~/Code/nix-wasm && git add patches/llvm/wasm-ld-linker-script-21.patch toolchain/patched-lld.nix flake.nix
git commit -m "toolchain: patched LLVM-21 lld with wasm-ld GNU linker-script support (kernel-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Note for later tasks:** if Task 4's kernel build fails in the *assembler* (not the link), the fork's `llvm/lib/MC/{WasmAsmParser,WasmObjectWriter}.cpp` changes (+58 lines, not in this patch) are also needed → that patch goes on `libllvm` (heavier rebuild). Confirm there, not here.

---

## Task 2: Vendor the kernel patches + factor a shared pinned `kernel-src`

**Files:** Create `patches/kernel/000*.patch` (×6), `toolchain/kernel-src.nix`; Modify `toolchain/kernel-headers.nix`.

- [ ] **Step 1: Copy the 6 kernel patches** from `~/Code/pc/vendor/linux-wasm/patches/000*.patch` into `nix-wasm/patches/kernel/` (same names). These are the host-integration patches (9p `trans_cb`, hvc multi-console, winsize, single-CPU pin, 16K stack, force-max-order).

- [ ] **Step 2: Factor the kernel fetch** into `toolchain/kernel-src.nix`:
```nix
{ pkgs }:
pkgs.fetchFromGitHub {
  owner = "joelseverin"; repo = "linux";
  rev = "039e5f3e583f56f329657d1fe9945510dba10f41";
  hash = "sha256-La+8ZfCyPiFt2BSixlRZn/Y9etA2CKoumN5/RB8Kt1U=";
}
```
Modify `toolchain/kernel-headers.nix` to `src = import ./kernel-src.nix { inherit pkgs; };` (drop the inline fetchFromGitHub). 

- [ ] **Step 3: Verify no regression.** Build `.#kernelHeaders` (or whatever the flake attr is): `echo password | sudo -S nix … build .#kernelHeaders --no-link --print-out-paths` → same output path as before the refactor (the fetch is identical). Expected: builds, unchanged hash.

- [ ] **Step 4: Commit** (`patches/kernel/*`, `toolchain/kernel-src.nix`, `toolchain/kernel-headers.nix`).

---

## Task 3: Kernel cc/ld wrappers (the `fake-llvm` equivalent) over the patched `lld`

**Files:** Create `toolchain/kernel-cc.nix`; Modify `flake.nix`.

Reproduce `fake-llvm/llvm-wrapper.py`'s argv rewrites as Nix wrapper scripts, but pointing the linker at `patchedLld`. The kernel `make` is driven with `LLVM=<dir>/` style (a dir of `clang`, `ld.lld`/`wasm-ld`, `llvm-ar`, …) OR explicit `CC=/LD=`. Read `llvm-wrapper.py` for the exact transforms; the load-bearing ones:
- **clang**: rewrite `--target=*-linux-musl` → `--target=wasm32-unknown-unknown`; add `-D__linux__ -D__unix__`; force `-matomics -mbulk-memory`; (the kernel is `-nostdlib`, freestanding).
- **ld (wasm-ld)**: de-dup `--start-group`/`--end-group`; drop `--build-id=*`, `-z *`, `-X`; add `--error-limit=0`. Do NOT add the dylink/`-shared` userspace flags for the kernel link (the kernel uses its linker script + its own flags); replicate `rewrite_lld` faithfully (it skips dylink flags at `-r` — but the kernel vmlinux link isn't `-r`; check what flags the kernel's `link-vmlinux.sh` actually passes and ensure the wrapper doesn't inject userspace dylink flags that break the `--script` link).
- **objcopy** (llvm-objcopy): drop `--set-section-flags .modinfo=noload` and `--strip-unneeded-symbol=__mod_device_table__*`.

- [ ] **Step 1: Read `llvm-wrapper.py`** (`~/Code/pc/vendor/linux-wasm/.build/linux-wasm/tools/fake-llvm/llvm-wrapper.py`) and transcribe the exact `rewrite_clang`/`rewrite_lld`/`rewrite_objcopy` logic.

- [ ] **Step 2: Create `toolchain/kernel-cc.nix`** producing a toolchain dir (`$out/bin/{clang,clang++,wasm-ld,ld.lld,llvm-ar,llvm-nm,llvm-objcopy,llvm-strip,…}`) — symlinks to stock `llvmPackages_21` tools EXCEPT the wrapped `clang` and `wasm-ld`/`ld.lld` (wrapper scripts doing the rewrites; `wasm-ld` → `${patchedLld}/bin/wasm-ld`). Take `{ pkgs, patchedLld }`.
```nix
{ pkgs, patchedLld }:
let llvm = pkgs.llvmPackages_21; in
pkgs.runCommand "kernel-llvm-wrappers" { } ''
  mkdir -p $out/bin
  # symlink the unwrapped tools
  for t in llvm-ar llvm-nm llvm-strip llvm-objdump llvm-readobj; do
    ln -s ${llvm.bintools-unwrapped}/bin/$t $out/bin/$t
  done
  # wrapped clang (argv rewrite) and wasm-ld (patched lld) — see steps
  cat > $out/bin/clang <<EOF
  #!${pkgs.runtimeShell}
  … (rewrite_clang transforms) … exec ${llvm.clang-unwrapped}/bin/clang "\$@"
  EOF
  cat > $out/bin/ld.lld <<EOF
  #!${pkgs.runtimeShell}
  … (rewrite_lld transforms) … exec ${patchedLld}/bin/wasm-ld "\$@"
  EOF
  ln -s $out/bin/ld.lld $out/bin/wasm-ld
  cat > $out/bin/llvm-objcopy <<EOF
  #!${pkgs.runtimeShell}
  … (rewrite_objcopy) … exec ${llvm.bintools-unwrapped}/bin/llvm-objcopy "\$@"
  EOF
  chmod +x $out/bin/{clang,ld.lld,llvm-objcopy}
''
```
(Fill the `…` from Step 1 verbatim. Provide `clang++` as a clang symlink/wrapper if the build needs it.)

- [ ] **Step 3: Wire `kernelCC = import ./toolchain/kernel-cc.nix { inherit pkgs patchedLld; };`** in `flake.nix` `let`; expose `packages.${system}.kernel-cc = kernelCC;` (for inspection).

- [ ] **Step 4: Build + sanity (the test).** `nix build .#kernel-cc --print-out-paths`; verify `$out/bin/wasm-ld` resolves to the patched lld (`$out/bin/wasm-ld --script=/dev/null --version` recognizes `--script`), and `$out/bin/clang --version` works.

- [ ] **Step 5: Commit** (`toolchain/kernel-cc.nix`, `flake.nix`).

---

## Task 4: `kernel.nix` — configure + build + install `vmlinux.wasm`

**Files:** Create `kernel.nix`; Modify `flake.nix`.

- [ ] **Step 1: Read the authoritative build steps** in `~/Code/pc/vendor/linux-wasm/build.sh`: `configure_kernel()` (the `make … <defconfig>` + the exact `scripts/config --enable/--set-val …` toggle list + `make … olddefconfig`) and `kernel_make()`/`build_kernel()` (the `make … vmlinux` invocation + vars: `ARCH=wasm`, `CROSS_COMPILE=wasm32-unknown-unknown-`, `HOSTCC=gcc`, and how `LLVM=`/`REAL_LLVM=` are passed). Reproduce the toggle list EXACTLY (the base set: NET, NET_9P, NET_9P_CB, 9P_FS, DEVTMPFS, DEVTMPFS_MOUNT, FILE_LOCKING, SCHED_STACK_END_CHECK, ARCH_FORCE_MAX_ORDER=15, + UNIX98_PTYS). **Do NOT add overlay/shmem/tmpfs** (that's a later phase).

- [ ] **Step 2: Create `kernel.nix`** `{ pkgs, kernelSrc, kernelCC }`:
  - `src = kernelSrc;` `patches = [ ./patches/kernel/0001-….patch … ./patches/kernel/0006-….patch ];`
  - `nativeBuildInputs = [ pkgs.gnumake pkgs.bison pkgs.flex pkgs.bc pkgs.python3 pkgs.perl pkgs.rsync pkgs.gcc kernelCC ];`
  - `configurePhase`: `make ARCH=wasm O=$PWD/build LLVM=${kernelCC}/bin/ HOSTCC=gcc CROSS_COMPILE=wasm32-unknown-unknown- wasm32_nommu_defconfig` then the `scripts/config --file build/.config …` toggles then `make … olddefconfig`. (Match build.sh exactly.)
  - `buildPhase`: `make ARCH=wasm O=$PWD/build LLVM=${kernelCC}/bin/ HOSTCC=gcc CROSS_COMPILE=wasm32-unknown-unknown- -j$NIX_BUILD_CORES vmlinux`
  - `installPhase`: `mkdir -p $out; cp build/vmlinux $out/vmlinux.wasm`
  - `dontFixup = true;`
  Wire `kernel = import ./kernel.nix { inherit pkgs kernelCC; kernelSrc = import ./toolchain/kernel-src.nix { inherit pkgs; }; };` + expose `packages.${system}.kernel = kernel;`.

- [ ] **Step 3: Build (the test).** `echo password | sudo -S nix … build .#kernel --no-link --print-out-paths`. Expected: `$out/vmlinux.wasm`. **If it fails in the assembler/MC layer** (errors mentioning WasmAsmParser / asm directives), apply the fork's `llvm/lib/MC/` changes too (extract them like Task 1, patch `libllvm` — a `patched-libllvm.nix` overriding `llvmPackages_21.libllvm`, used by `patched-lld` + `kernelCC`'s clang). Note this branch if hit; it's the heavier path.

- [ ] **Step 4: Verify it's a structurally-correct NEW-ABI kernel (the real acceptance).** With `K=$out/vmlinux.wasm`:
  - `file $K` → `WebAssembly (wasm) binary module`.
  - `wasm-objdump -x -j Import $K | grep -E 'func\[' ` → imports include `wasm_create_and_run_task`, `wasm_load_executable`, `wasm_release_task`, `wasm_serialize_tasks`, the hvc/9p drivers, panic/cpu/random — and **NO `wasm_exec_*`** (confirms the 039e5f3e new ABI). Compare the import set to the agent's local build `/tmp/vmlinux.baseclean.bak` (same ABI) if still present.
  - (Boot is NOT expected yet — runtime forward-port is the next plan.)

- [ ] **Step 5: Commit + push** (`kernel.nix`, `flake.nix`).

---

## Task 5: Reproducibility check + docs

**Files:** Modify `docs/STATUS.md`, `README.md`.

- [ ] **Step 1: Reproducibility.** Build `.#kernel` twice (`--rebuild` or after `nix store delete` of the out path) and confirm identical output hash, OR confirm the path is deterministic across two evals. Note any nondeterminism (kernel builds can embed timestamps/versions — if so, set `KBUILD_BUILD_TIMESTAMP`/`KBUILD_BUILD_USER`/`HOST` to fixed values in `kernel.nix` and re-verify).

- [ ] **Step 2: Docs.** STATUS.md + README: record that the kernel now builds via Nix (`.#kernel`), the Path-A patched-lld approach, and that it's the *new* ABI (boot pending the runtime forward-port). Note the MC-layer branch if it was hit.

- [ ] **Step 3: Commit + push.**

---

## Self-review notes
- **Spec coverage:** patched lld (crux) → T1; kernel src+patches → T2; fake-llvm→Nix wrappers → T3; configure/build/install + ABI verify → T4; reproducibility/docs → T5. The toolchain-isolation requirement (kernel-only patched lld, no global overlay) is satisfied by the local `patchedLld` binding (T1/T3) consumed only by `kernel.nix`.
- **Known live risks (flagged at their tasks):** (1) lld rebase rename completeness (T1 build shakes out); (2) the `llvm/lib/MC/` assembler changes may be needed → heavier `libllvm` patch (T4 Step 3 branch); (3) kernel-build determinism (T5). 
- **Out of scope (later plans):** runtime forward-port to the new ABI (makes it boot), overlayfs config, Plan 2 (served `/nix` store + bootstrap).
