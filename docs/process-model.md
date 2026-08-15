# Guest process model

The published/default wasm guest is a **software-MMU system**: processes share
one `WebAssembly.Memory`, while the checked two-level page-table walk gives each
process an isolated, copy-on-write address space. Fork-capable binaries use the
asyncify seam to return twice; ordinary binaries continue to use
`posix_spawn`. The single-arena NOMMU guest remains a supported, selectable
yore-pc mode through explicitly `-nommu`-suffixed artifacts and the production
channel's `variants.nommu` image.

This document is the authoritative description of the **spawn contract**. Its
purpose: the busybox/ash/glib spawn patches are **one documented platform port**,
not a pile of ad-hoc per-package hacks.

## Spawn contract — fork-capable libc, `posix_spawn` for ordinary binaries

wasm cannot execute `fork()`/`vfork()` **in a plain, non-asyncified module**. "Return
twice" requires re-entering a call frame mid-execution — a **multi-shot
continuation**. No shipped wasm engine provides one natively: WasmFX and JSPI
are **one-shot** (verified empirically in `spikes/stackswitch/` — a 2nd
`resume` traps with "resuming an invalid continuation"). The one multi-shot
mechanism is per-binary **asyncify** (serialize the stack to copyable linear
memory) — rejected as the *whole-userspace default* (size/speed tax on every
binary), but it **works and already ships as an opt-in seam**: see "Real
`fork()` — the asyncify seam" below. On the default toolchain a new task is
therefore always a **fresh instance running a function** — which is precisely
`clone(CLONE_VM, fn)` / `posix_spawn`, the one spawn primitive that needs no
return-twice.

The default libc now contains the real-fork seam, but that does not make every
binary fork-capable. The contract is defined at three layers:

- **Published software-MMU kernel:** `posix_spawn` still uses
  `clone(CLONE_VM|CLONE_VFORK|SIGCHLD, fn)` for ordinary binaries, while an
  asyncified fork binary uses the `capture_stack` seam plus COW page tables.
- **musl:** `posix_spawn` rides that primitive; `system()` and `popen()` route
  through `posix_spawn` (upstream musl 1.2.5 already does — `src/process/system.c`
  and `src/stdio/popen.c` call `posix_spawn`, and `src/process/posix_spawn.c` uses
  `__clone(…, CLONE_VM|CLONE_VFORK|SIGCHLD, …)`). The default libc also defines
  `fork`/`vfork` through `_Fork`'s `capture_stack` seam. `capture_stack` is
  deliberately absent from the shared host-import allow-list, so a plain caller
  fails to **link** specifically on that symbol — loud, early, traceable. Only a
  per-binary fork build both admits that import and runs Binaryen asyncify.
- **Ports:** a program that hard-codes `fork`/`vfork`+exec is handled **once**, per
  the rules below — never with a runtime stub.

The link behavior is pinned by `spikes/spawn-contract/` (`.#spawn-linkcheck`),
which compiles a `fork()` user and a `posix_spawn()` user through the plain
cross cc-wrapper and records `fork=NEEDS_CAPTURE_STACK / spawn=LINKED` for
the `nommu-spawn` profile. The SAME two probes, plus a closure-wide sweep
(`scripts/wasm-check-imports.py --fork-contract=PROFILE` +
`userspace/spawn-contract-sweep.nix`, `.#guest-spawn-contract-nommu` /
`.#guest-spawn-contract-fork`) over every real shipped wasm module, are what
remain standing gates for the promoted default — see CLAUDE.md's "#202 PR-1"
learnings entry for the full mechanism (the capture_stack/asyncify TypeError
this catches at build time instead of at boot).

## Real `fork()` — the asyncify + software-MMU profile

Real fork-without-exec **exists and passes acceptance** (PR #20): the
fork-capable musl (`toolchain/musl.nix`), the `cc-fork` driver
(`toolchain/guest-cc-fork.nix`), and `userspace/asyncify-cc.nix` build a
binary whose live stack asyncify can serialize into copyable linear memory —
so the child genuinely returns twice, gets private memory, and is reaped
correctly (8 `fork-*` acceptance programs). It was shelved (#32/#25/#29) when
every fork paid an eager whole-RSS copy; **Track A's software-MMU COW removed
that cliff**, and **#129 (Track B)** generalized the seam into a cross-stdenv
flag so opting a package into real `fork()` is a build option, not a bespoke
derivation. The design confines the asyncify tax to fork-using binaries
(shells, `make`, daemons) — everything else stays `posix_spawn` and pays
nothing. The forkshell `ash` and clone-with-fn accommodations remain isolated
to the independently supported NOMMU mode; the MMU mode does not carry them.

The libc default is now fork-capable, but an executable still opts into the
fork build pipeline, and it must run with the software-MMU+COW kernel. Do not
describe `fork()` as impossible on this platform — it is an opt-in with a
per-binary cost and a kernel-profile requirement.

## Current profiles

The repo builds two CI-gated process-model shapes. The libc promotion is shared
by both; Phase 3 made the software-MMU/fork shape the unsuffixed default.

**(i) Shipped software-MMU / real-fork guest — `.#kernel`,
`.#wasm-initramfs`, and `.#wasm-base-squashfs` (also available through the
former `-mmu-a2`/`-fork` compatibility names).** Real `fork()`+COW works:
the program is linked through the fork stdenv and asyncified, the kernel's
software-MMU page tables
(`patches/kernel/0023`/`0024`/`0026`) give a forked child a genuinely
isolated, copy-on-write address space (Track A2's demand-paging + COW,
boot-verified), and the engine's asyncify-based `capture_stack`/
`run_user_entry` machinery (ENGINE_ABI 10) makes the fork call genuinely
return twice. On this guest `/bin/sh` is **stock busybox hush**, not
forkshell ash — stock ash was tried and found blocked by an orthogonal wasm
limit (musl's `longjmp` is an `abort()` stub, nix-wasm#188), not by fork
itself.

Boot-verified today: `fork()`+`wait()` returns twice with real COW
divergence (`fork-smoke.mjs`, gated); the default `nix-boot-smoke` GTK +
core smoke set (the same one-per-boot apps the NOMMU guest runs), plus
`autotools-fork-smoke.mjs`'s in-guest autotools acceptance smoke (promoted
2026-08-13, see "Now closed" below for its history), each recorded CI
greens and hard-gate — a regression on any of them turns the job red. The
`core` shard is fully green as of 2026-08-13 (issue #192, the exec-image
fragmentation bug that used to hit its in-guest compiler gates, is fixed —
see below). And hush itself is autoconf-capable — three independent,
previously-unfixed-upstream hush bugs (the variable-fd redirect `>&$4`, the
internally-opened-fd-0 misdetection on `N<&0`, and EXIT-trap bare-`exit`/`$?`
status resumption) are fixed (`patches/busybox/0009`–`0011`) and HARD-GATED
on the host, hermetically, by `.#autotools-fixture-hush-check` against a real
generated `configure` (including a sabotaged-compiler negative case pinned to
exit 77). Full record: CLAUDE.md's hush learnings entry.

**(ii) Supported NOMMU guest — `.#kernel-nommu`,
`.#wasm-initramfs-nommu`, and `.#wasm-base-squashfs-nommu`.** It retains the
busybox/ash/glib spawn-port accommodations and ordinary programs use
`posix_spawn`. No module may import `capture_stack`;
`.#guest-spawn-contract-nommu` pins that closure contract. One clearly labeled
CI job keeps it from silently rotting until Phase 4 removes it.

**Now closed (2026-08-13):** the IN-GUEST autotools proof
(`runtime/demo/node/autotools-fork-smoke.mjs`) recorded its first-ever green
`CFGRC` end-to-end once issue #192 — a kernel exec-image-buffer fragmentation
bug (repeated large execs, e.g. clang's driver+cc1 pair, failed around the
6th with `page allocation failure: order:14`) — was fixed by a per-inode
exec-image cache (`patches/kernel/0030`, PR #199); no remaining hush defect
stood in the way (the shell half closed earlier the same day via
`patches/busybox/0009`–`0011`). The smoke is now a `run_smoke` hard gate in
`nix-wasm.yml`'s default `nix-boot-smoke` `core` shard — no soak step remains
for it. Full record: the root `CLAUDE.md`'s autotools caveat and the
2026-08-05 parity-plan note's "Real-fork autotools proof" item (see "Full
status record" just below). Issue #131's Slice‑1 disposition is profile-local:
the MMU image already uses stock BusyBox fork sites with hush as `/bin/sh`,
while the supported NOMMU image retains forkshell ash and the clone-with-fn
spawn port. The fork initramfs build (`userspace/busybox-fork.nix`) runs the
shared `scripts/wasm-check-imports.py` import-contract check, and the NOMMU
profile has its own closure-wide no-`capture_stack` gate.

Full status record: `docs/superpowers/specs/2026-07-01-cleanup-131-audit.md`,
`docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md`, and the
hush/#192 entries in the root `CLAUDE.md`.

## Handling a fork/vfork holdout — the decision rule

When a package fails to link because it calls fork without the asyncify seam
(historically `undefined symbol: fork`; now `undefined symbol: capture_stack`),
pick exactly
one of these — in order of preference — and **never** add a stub that links:

1. **It's an unused CLI/tool/feature/demo → don't build it.** The library the
   guest consumes is fork-free; only an auxiliary artifact forks. Drop that
   artifact via the package's own configure/build knobs. Applied (all
   `isWasm`-guarded overrides in `deps-overlay.nix`, so native builds are
   untouched):
   - **openssl** — `no-apps` (the `openssl` CLI's `speed.c`/`http_server.c` fork;
     libssl/libcrypto do not).
   - **pcre2** — `--disable-pcre2grep-callout-fork` (the `pcre2grep` `--exec`
     feature; libpcre2 does not).
   - **ncurses** — `buildFlags = [ "libs" "progs" ]` so `make` skips the `test/`
     demos (`ditto.c` et al. fork); libncursesw + tic/tput do not.
   - **busybox NOMMU** — disable IFUP/IFDOWN/TELNETD because their vfork sites
     cannot use the NOMMU process model. The MMU BusyBox build enables all
     three and asserts that configuration during its build.

2. **It's a real spawn API in a library we need → port it to `posix_spawn`.**
   Force the library's existing `posix_spawn` codepath and compile out the raw
   fork/exec branch; if a case genuinely cannot be expressed via `posix_spawn`,
   fail **loudly** (set the `GError`/abort with a clear message) — do not fake
   success. Applied:
   - **glib** (`patches/glib/0001-posix-spawn-only-wasm-nommu.patch`,
     `deps-overlay.nix` glib override): forces `g_spawn`'s `posix_spawn` path
     (handles `working_directory` via `posix_spawn_file_actions_addchdir_np`, fd
     cleanup, ENOEXEC/shebang retry via `posix_spawn("/bin/sh","-c",…)`), compiles
     out the raw fork/exec block, and **rejects `child_setup`-using calls with a
     `GError`** ("wasm NOMMU (no fork/exec split; posix_spawn is used)"). The
     ENOEXEC fallback re-spawns the target as `/bin/sh <script> <args…>` (execvp's
     shell-script convention — no `-c`). **Known limitation:** the
     `G_SPAWN_SEARCH_PATH_FROM_ENVP` case routes through `posix_spawnp`, which
     searches `$PATH` from the *current* process environment rather than from the
     supplied `envp`; a caller passing a divergent `PATH` in `envp` fails loudly
     (ENOENT), never silently mis-spawns. No guest consumer relies on that case.
     `gtestutils.c`'s deprecated `g_test_trap_fork` is compiled out (the guest
     never runs glib's test harness). Grounded in GNOME/glib MR !95 (the
     posix_spawn codepath) + MR !1968 (its fd remapping) — this is *forcing* an
     existing path, not a rewrite.

3. **It's a genuine return-twice API (`vfork` parent-waits-and-exits) with no
   `posix_spawn` equivalent, and no enabled caller → compile the symbol out.**
   The symbol becomes **absent**, so any future caller fails at link (loud), and
   the present (disabled) callers are simply gone. Applied:
   - **busybox `libbb`** — `xvfork_parent_waits_and_exits()` (`#if !defined(__wasm__)`)
     and `xfork()` (`#if BB_MMU && !defined(__wasm__)`) are compiled out on wasm
     (`patches/busybox/0004`, `0007`). Their only callers — `nsenter`/`unshare` —
     are disabled on the guest. (This replaced an earlier runtime-abort stub; the
     symmetric `__wasm__` guard covers both the NOMMU busybox build, `BB_MMU=0`,
     and the allnoconfig ash build, `BB_MMU=1`.)

4. **The fork is load-bearing (real fork-without-exec in a program we need)
   → opt the binary into the asyncify fork seam** (see "Real `fork()`" above;
   #129 is making this a flag). The binary pays the asyncify size/speed tax;
   nothing else does. Prefer rules 1–3 when the fork is incidental.

### The busybox/ash spawn port (the labeled platform port)

busybox's spawn is centralized in `libbb` (`vfork_daemon_rexec.c` + a few applet
sites); ash's is its own forkshell. These patches are the supported NOMMU
busybox-on-wasm spawn port—kept and labeled, and absent from the MMU BusyBox
recipe:

- `patches/busybox/0001-wasm-arch-and-clone-spawn.patch` — the wasm arch +
  convert `run_pipe`/spawn to clone-with-a-fn.
- `patches/busybox/0003-hush-cmdsub-clone.patch`, `0005-tar-compressor-clone.patch`,
  `0006-hush-heredoc-clone.patch` — the remaining hush `$()`/pipeline/heredoc and
  tar-compressor spawn sites.
- `patches/busybox/0004-libbb-spawn-clone.patch` — `libbb` `spawn()`/
  `fork_or_rexec()` + `timeout`'s watcher to clone-with-a-fn; `xvfork_parent_…`
  compiled out (rule 3).
- `patches/busybox/0007-xfork-no-fork-wasm.patch` — `xfork()` compiled out for the
  `BB_MMU=1` ash build (rule 3).
- `patches/busybox/ash/*` + `userspace/ash.nix` — the forkshell ash (NOMMU
  fork-without-exec over `posix_spawn`), promoted to `/bin/sh`.

NOMMU result: a curated, `posix_spawn`-clean userspace. Programs using
`posix_spawn`/`system`/`popen` run unmodified; raw-`fork`/`vfork` holdouts are
either not built or ported via one of the three rules above. No silent
per-package hacks; no symbol that links but aborts at runtime.

## Why not per-process memory or real `fork()` (measured dead-ends)

- **Per-process `WebAssembly.Memory`** caps at **~124 concurrent Memory objects
  per browser tab** — a fixed ~8 GiB V8 guard reservation each inside a ~1 TiB
  per-renderer cage, immune to size, `shared`, memory64 (worse, ~61), Worker
  spread, and `--no-wasm-trap-handler`. Measured in `spikes/elastic-mem/`.
- **Real `fork()`** needs *both* multi-shot control (unavailable — see above) and
  a same-address child copy (which forces per-process Memory → the ~124 cap). Two
  independent walls. **Both are superseded by measurement/boot-verification**
  (see the 2026-08-13 update above): asyncify supplies the multi-shot control
  this document itself describes and ships as an opt-in seam ("Real `fork()`
  — the asyncify seam" above), and the software MMU gives a forked child a
  *private page table* on the SAME one shared `WebAssembly.Memory` — a
  same-address COW copy without needing a second per-process `Memory` object
  at all, so the ~124-Memory cap never comes into play. Track B's
  `fork-smoke.mjs` is boot-verified and hard-gated in CI. Per this document's
  own rule: never describe fork as impossible — it is a working, opt-in guest
  shape today (shape (ii) above), not (yet) the default.
- **Software MMU** (per-access translation) — assumed too costly to be viable
  when this section was first written; **superseded by measurement** (see the
  2026-08-13 update above). The pass's real per-access cost, measured on real
  compiler output with the SHIPPED kernel-layout 2-level walk, is ~3–4× on
  pure-memory loops (3.01×/4.10×/3.60× across three micro-benchmarks) and
  ~1.01× (near-free) on compute-mixed code (`spikes/softmmu/REAL-BINARY.md`'s
  2026-07-02 two-level re-measurement — an earlier single-level spike had
  measured ~2.2× on the memory poles, before the pass moved to the kernel's
  real 2-level table format). Track A/B
  (`docs/superpowers/specs/2026-07-01-software-mmu-asyncify-design.md`)
  shipped a booted, CI-gated software-MMU + real-fork guest on top of this
  cost, consistent with CLAUDE.md's "permanent ~2-3× per-access-walk cost"
  framing. It is not a per-process-Memory-style dead end — it is a second,
  working guest shape and is now the published default; NOMMU remains the
  separately selectable, supported profile described above.

Full rationale and the investigation record:
`docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md`. Per-holdout
triage: `docs/superpowers/notes/2026-06-21-nofork-triage.md`.

**Escape hatch:** if multi-shot continuations ever ship in a wasm engine, a clean
`vfork` becomes expressible centrally in the runtime (and `vfork` shares memory,
so it dodges the ~124 cap) — revisit then. One-shot stack-switching does **not**
qualify.
