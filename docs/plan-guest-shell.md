# Plan — autoconf-capable guest shell via the existing forkshell ash

**Status:** designed, not yet implemented. This is the critical path for in-guest
autotools `./configure` (discovered by A2). Supersedes the earlier "port ash from
scratch / improve hush" framing.

## The realization

The hard parts are already solved and proven — just not yet wired to *our* guest:

1. **An autoconf-grade parser that needs no `fork()`.** pc's **WASI terminal**
   already ships a no-fork ash: `pc/vendor/busybox/wasi-compat/ash-forkshell.patch`
   (1397 lines), a port of **busybox-w32's** forkshell machinery (Windows has no
   `fork()` either). ash's parser is dash-derived and runs every autoconf script.
2. **The NOMMU "fork-without-exec" mechanism.** forkshell serializes the state a
   child shell needs — `globals_misc`, `globals_var`, `cmdtable`, aliases, and the
   parse-tree `node` — into one flat block **with a relocation bitmap** (reusing
   ash's own `copynode`/`calcsize`). A fresh shell instance fetches the block,
   **rebases every pointer** by `(new_base - old_base)`, reinstalls the globals, and
   evaluates the node. It covers exactly what autoconf needs: `FS_EVALSUBSHELL`
   (`( … )`), `FS_EVALBACKCMD` (`$(shell-code)`), `FS_EVALPIPE` (pipelines),
   `FS_OPENHERE` (heredocs), `FS_SHELLEXEC` (fork+exec).

We rejected asyncify-fork (collides with our pervasive `-fwasm-exceptions`; wasmer
itself punts on fork+Wasm-EH) and MMU emulation (research-grade, "eventually" even
upstream). forkshell needs **neither** — it's pure state serialization + a fresh
process, both of which the guest already supports.

## What stays vs. what changes

The WASI build talks to a **`cb` host-bridge** (wasm imports from module `cb`,
serviced by pc's worker over a futex SAB, booting fresh `sh.wasm` instances). The
guest is a real Linux process environment with working `posix_spawn`/clone-with-fn,
pipes, `waitpid`, `dup2`. So:

- **Reuse verbatim:** the serializer (`forkshell_prepare`/`copynode`/relocation
  bitmap), the child bootstrap (`forkshell_init`/`forkshell_child`, triggered by
  `ash --fs`), and all the `FS_*` eval hooks. This is the asset.
- **Replace:** the ~6 `cb.*` bridge functions with a small guest adapter
  (`forkshell_guest.c`) implemented over ordinary Linux syscalls. Drop the
  `import_module("cb")` attributes so the calls bind to the adapter instead of wasm
  imports.
- **Drop:** `cb_spawn.c` entirely — in the guest, ash runs external commands through
  its **native `shellexec`→`execve`** (the guest has exec via clone-with-fn; busybox
  already execs today). cb_spawn only existed because WASI has no exec.

## The adapter map (`cb.*` → guest syscalls)

The block travels parent→child over an inherited fd (a pipe or `memfd`), length-
prefixed. The child is a re-exec of the same ash binary as `ash --fs`, which calls
`forkshell_init()` → reads the block from that fd via `fork_block`.

| forkshell call | semantics | guest implementation |
|---|---|---|
| `fork_run(blk,len,bg)` | run block in a fresh child shell; wait unless `bg` | write `[len][blk]` to a pipe; `posix_spawn` `ash --fs` with the read end as a known fd (file-action `adddup2`); child inherits stdio (subshell shares the tty); `bg`→return 0, else `waitpid`→`WEXITSTATUS` |
| `fork_capture(blk,len,out,max,*st)` | run block, capture stdout | as `fork_run` + a second pipe for the child's stdout (`posix_spawn_file_actions_adddup2` fd1→pipe); parent reads ≤`max` into `out`, `waitpid`→`*st`; for `$(…)` |
| `fork_pipeline(buf,len,bg)` | `[nstages][len|blk]*`; run all stages wired stage→stage | create `n-1` pipes; `posix_spawn` each `ash --fs` with stdin/stdout dup2'd to the adjacent pipes + its block fd; `waitpid` all; return last stage's status |
| `here_fd(text,len)` | fd that reads a heredoc body | `pipe()` (or `memfd_create`), write `text`, return the read fd (large bodies: a writer or memfd to avoid pipe-buffer deadlock) |
| `poll_signal(consume)` | pending-interrupt check (Ctrl-C) | a `volatile sig_atomic_t` set by ash's `SIGINT` handler (or `sigpending`); return/optionally clear it |
| `fork_block(buf,len)` *(child)* | fetch the serialized block | first call `(NULL,0)`→read the 4-byte length prefix from the block fd and return it; second `(buf,total)`→read `total` bytes |

Everything here is a syscall the guest kernel already services (busybox uses
`posix_spawn`/`pipe`/`waitpid`/`dup2` today; `make` already drives
`system()`→`posix_spawn`→`clone(CLONE_VFORK)` in-guest). No host bridge, no SAB, no
asyncify.

**FS_SHELLEXEC note:** fork+exec of an external command can go through the same
forkshell path (the deserialized child just `execve`s) or be short-circuited to a
direct `posix_spawn` (the child only execs, so no state needs serializing). Start
uniform-through-forkshell for correctness; optimize later if it matters.

## Build wiring

- **`userspace/ash.nix`** (mirror `userspace/busybox.nix`): the same busybox source +
  cross cc-wrapper, with a `wasm_defconfig`-style config enabling `CONFIG_ASH` (+ the
  `ASH_*` features autoconf needs: `ASH_BASH_COMPAT`, math, `test`, `printf`,
  `getopts`, alias) and `SH_IS_ASH` (or keep hush as `/bin/sh` and ship `ash`
  separately first). Apply a guest-adapted forkshell patch set:
  - the upstream `ash-forkshell.patch` serializer/bootstrap/`FS_*` hooks, **minus**
    the `import_module("cb")` attributes;
  - **`forkshell_guest.c`** implementing the 6 entry points above;
  - **not** `cb_spawn.c` (use native execve).
- Add to the system closure (`flake.nix` toolchain list / `system.path`) so `ash` is
  on `PATH`; once validated, consider making it `/bin/sh`.
- The forkshell child re-execs the ash binary by absolute store path as `ash --fs`
  (the guest re-exec/clone-with-fn pattern, like libbb `fork_or_rexec`).

## Validation

Reuse the A2 harness: a real autoconf-generated `configure` + `make` + run, driven
by `ash` in the guest. Stage it: first `ash -c 'echo $(echo hi)'` (one `fork_capture`),
then a subshell and a pipeline, then the full configure.

## Risks / unknowns

- **Block transfer**: WASI passes the block in shared host memory; the guest passes
  it over an fd — `fork_block` must read-and-relocate from the fd. The relocation math
  is unchanged (delta from `old_base`), only the source of the bytes differs.
- **Re-exec cost**: every subshell/`$()` spawns a fresh ash instance loading the
  serialized state. configure spawns *many* — watch throughput; the clone-with-fn
  instance-load is the per-spawn cost (same as every other guest spawn).
- **Heredoc/pipe deadlock**: large heredocs or capture > pipe buffer need a
  writer-side drain or `memfd`, not a single blocking `write`.
- **Signals/job control**: configure rarely needs job control; `poll_signal` + basic
  `waitpid` should suffice. Keep `ASH_JOB_CONTROL` off initially.

## First step

Map confirmed against the patch; next is the build: create `userspace/ash.nix` +
`forkshell_guest.c`, get `ash --fs` round-tripping a single `fork_capture`
(`$(echo hi)`) in-guest, then climb to the full configure via the A2 harness.

## Implementation status (2026-06-17) — built, runs, ONE kernel blocker left

Implemented and committed: `userspace/ash.nix` (busybox ash + the 3 vendored
forkshell patches), `userspace/ash-cb-guest.c` (the `cb` surface over
posix_spawn/pipe/waitpid — replacing pc's WASI futex bridge), and
`userspace/ash-wasm-sjlj.c` (the wasm SjLj runtime). What works in-guest:

- **ash builds** (293 KB wasm, zero `cb.*` imports, all helpers defined).
- **Basic commands + clean exit** — needed the **wasm SjLj fix**: ash's exit/error
  flow uses setjmp/longjmp, but musl-wasm's `longjmp` is `call abort`. Compiling
  ash with `-mllvm -wasm-enable-sjlj` + the vendored SjLj runtime
  (`__wasm_setjmp/_test/__wasm_longjmp` + the `__c_longjmp` tag) fixed it.
- **Subshells `( … )`** (`fork_run`) work end-to-end (serialize → re-exec
  `ash --fs` → run → reap).
- **`$(…)` capture** (`fork_capture`): the child spawns, runs, produces output,
  and is reaped cleanly (verified) — but ash **hangs on the *next* command**.

### The remaining blocker is a GUEST-KERNEL bug
Root-caused with an in-guest C probe: **`waitpid(-1, WNOHANG)` with no children
BLOCKS instead of returning `ECHILD`** on this wasm NOMMU kernel. After a `$()`,
the forkshell child's SIGCHLD sets ash's `got_sigchld`, so ash's next
`dowait()` calls `waitpid(-1, WNOHANG)` → blocks forever. (`sigtimedwait` with a
zero timeout *also* blocks — the kernel doesn't honor non-blocking poll flags.)
This same bug breaks the `timeout` applet (`timeout: can't execute '-pNN'`).

Adapter mitigations tried (committed, correct but insufficient alone): close the
child's stray pipe fds; set `SIGCHLD` to `SIG_DFL` around spawn+reap so ash's
handler doesn't set `got_sigchld`. These don't fully clear it because ash also
hits a blocking `dowait`/`waitpid` via other paths (and likely a `makejob`
orphan job in the forkshell `evalbackcmd` that ash block-waits on at exit).

### Next step: fix the kernel `wait4` (the true root cause)
`waitpid(-1, WNOHANG)`/`wait4` with no eligible children must return `-ECHILD`
(and honor `WNOHANG`), not block, in the joelseverin/linux wasm port's wait path
(`kernel/exit.c do_wait` is generic — the bug is in the wasm port's task/wait or
scheduler glue that fails to wake/return for the no-children case). Rebuild
`vmlinux.wasm` (the patched LLVM is cached, so this is a kernel-only recompile)
and re-validate `$()`/pipelines, then the full configure. This also fixes
`timeout` and any other `WNOHANG` user. Secondary: drop/`freejob` the forkshell
`evalbackcmd` `makejob` orphan so ash doesn't block-wait a child it never owns.
