# Guest process model (clean NOMMU)

The wasm guest is a **single-shared-arena NOMMU system**: one
`WebAssembly.Memory`, `mm/nommu.c` loads each process at its `data_start`
offset (the runtime wires `data_start → __memory_base` in
`runtime/kernel-worker.js`), soft isolation only, `MAP_SHARED` works, and it
scales to thousands of processes. This is exactly what real uClinux does — the
guest even prints *"This architecture does not have kernel memory protection."*

This document is the authoritative description of the **spawn contract**. Its
purpose: the busybox/ash/glib spawn patches are **one documented platform port**,
not a pile of ad-hoc per-package hacks.

## Spawn contract — `posix_spawn` only

wasm cannot implement `fork()`/`vfork()`. "Return twice" requires re-entering a
call frame mid-execution — a **multi-shot continuation**. No shipped wasm engine
provides one: WasmFX and JSPI are **one-shot** (verified empirically in
`spikes/stackswitch/` — a 2nd `resume` traps with "resuming an invalid
continuation"), and per-binary **asyncify** (serialize the stack to copyable
memory) is the only multi-shot option, which we reject as a whole-userspace tax.
A new task on wasm is therefore always a **fresh instance running a function** —
which is precisely `clone(CLONE_VM, fn)` / `posix_spawn`, the one spawn primitive
that needs no return-twice.

So the platform is **`posix_spawn`-only**, defined once at three layers:

- **Kernel:** `clone(CLONE_VM|CLONE_VFORK|SIGCHLD, fn)` is the spawn primitive
  (the same `clone()`-with-a-function `pthread_create` uses). Already on master.
- **musl:** `posix_spawn` rides that primitive; `system()` and `popen()` route
  through `posix_spawn` (upstream musl 1.2.5 already does — `src/process/system.c`
  and `src/stdio/popen.c` call `posix_spawn`, and `src/process/posix_spawn.c` uses
  `__clone(…, CLONE_VM|CLONE_VFORK|SIGCHLD, …)`). The **`fork`/`vfork` symbols are
  removed** (`toolchain/musl.nix` postPatch: delete `fork()`'s body keeping
  fork.c's weak aliases; empty `vfork.c`). A caller then fails to **link** in its
  Nix build — loud, early, traceable — instead of master's old runtime SIGILL/abort
  stub. autoconf also correctly detects no-fork.
- **Ports:** a program that hard-codes `fork`/`vfork`+exec is handled **once**, per
  the rules below — never with a runtime stub.

The link-behavior is pinned by a probe: `spikes/nofork/` (flake attr
`.#nofork-linkcheck`) compiles a `fork()` user and a `posix_spawn()` user through
the cross cc-wrapper and records `fork=ABSENT` / `spawn=LINKED` in its output.

## Handling a fork/vfork holdout — the decision rule

When a package fails to link with `undefined symbol: fork`/`vfork`, pick exactly
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
   - **busybox** — disable the IFUP/IFDOWN/TELNETD applets (network daemons,
     unused on the networkless guest) in `userspace/busybox.nix`.

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

### The busybox/ash spawn port (the labeled platform port)

busybox's spawn is centralized in `libbb` (`vfork_daemon_rexec.c` + a few applet
sites); ash's is its own forkshell. These patches ARE the busybox-on-wasm spawn
port — kept and labeled, not removed:

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

Result: a curated, `posix_spawn`-clean userspace. Programs using
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
  independent walls.
- **Software MMU** (per-access translation) — 10–100× slowdown, not viable.

Full rationale and the investigation record:
`docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md`. Per-holdout
triage: `docs/superpowers/notes/2026-06-21-nofork-triage.md`.

**Escape hatch:** if multi-shot continuations ever ship in a wasm engine, a clean
`vfork` becomes expressible centrally in the runtime (and `vfork` shares memory,
so it dodges the ~124 cap) — revisit then. One-shot stack-switching does **not**
qualify.
