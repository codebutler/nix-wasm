# Plan — an autoconf-capable, NOMMU-safe guest shell

**Status:** not started; this is the critical path for autotools `./configure`
support (and thus for a large class of "typical packages"). Discovered by A2 (see
`docs/STATUS.md` § Real autoconf `./configure`).

## The problem

The guest `/bin/sh` is busybox **hush**, chosen because its small, well-defined set
of process-spawn sites could be converted to the **clone-with-fn** model the NOMMU
wasm guest requires (one shared `WebAssembly.Memory`; no `fork`/`vfork` — a child
can't resume the parent mid-call; see the fork/vfork notes in `STATUS.md`). hush
works for interactive use, init, and simple scripts.

But hush is **not POSIX-complete enough for autoconf**. A real
autoconf-generated `configure` fails under hush with `ambiguous redirect` and
`syntax error at 'fi'`, producing no Makefile. autoconf scripts assume a full POSIX
`sh` (parameter expansions like `${1+"$@"}`, `LINENO`, here-doc edge cases, complex
`case`/redirection). autoconf even tries to *re-exec under a better shell* if the
initial `/bin/sh` is deficient — but there is no better shell on the guest.

The deeper issue: a full POSIX shell implements subshells, pipelines, and command
substitution by **`fork()`-ing the shell itself** (the child is a divergent copy of
the parent shell's state, continuing from the fork point). That is precisely the
operation NOMMU-wasm cannot do — the same wall that ruled out `fork`/`vfork`
project-wide. So "ship a real shell" isn't free: any shell needs its
fork-for-subshell reworked for the clone-with-fn model.

## Options

### 1. Port busybox `ash` to the clone-with-fn model (most promising)
`ash` (dash-class) *is* POSIX enough for autoconf, and it's already in the busybox
tree — just disabled (`# CONFIG_ASH is not set`; `CONFIG_SH_IS_HUSH=y`). Work:
- Enable `CONFIG_ASH` + `CONFIG_SH_IS_ASH` (and the `ASH_*` features autoconf needs:
  `ASH_BASH_COMPAT`, arithmetic, `test`, `printf`, `getopts`, etc.) in
  `configs/wasm_defconfig` (patch `0001`).
- Port ash's fork sites — `forkchild`/`forkparent`/`forkshell`, `evalsubshell`,
  `evalpipe`, `openhere` (here-doc), `expbackq`/command-substitution, and job control
  — to clone-with-fn, exactly as patches `0001`/`0003`/`0006` did for hush. The hard
  cases are the ones that need the *child to keep running shell code* (subshell,
  left side of `|`, `$(...)`): on NOMMU these must run the child as a fresh shell
  instance executing the captured AST/state, not a memory copy. Evaluate whether the
  child can be driven via the existing clone-with-fn callback running an ash entry
  point that re-enters evaluation with serialized state.
- Disable/avoid any remaining ash vfork the guest doesn't need (mirror the curated
  disable list in `userspace/busybox.nix`).
- Validate with the A2 harness (a real `configure` → `make` → run).

**Open question to resolve first:** how busybox ash behaves on NOMMU today. busybox
has historical NOMMU handling for ash (re-exec/`vfork`); a quick experiment —
enable `CONFIG_ASH`, build, and test `ash -c 'echo hi'`, a pipeline, and `$(...)`
in-guest — tells us how much is already viable vs. needs the clone-with-fn port.

### 2. Cross-build `dash` as `/bin/sh`
dash is a small, strict POSIX shell. Same fundamental problem: its subshell/pipeline
forks need the clone-with-fn rework, and dash isn't structured around busybox's
NOMMU spawn helpers, so this is likely *more* work than (1) with less shared
infrastructure. Not recommended unless ash proves intractable.

### 3. Improve hush's POSIX coverage
Chasing autoconf compatibility inside hush (fixing each `ambiguous redirect` /
parser gap) is a losing battle — hush is intentionally a smaller language, and
autoconf targets a full `sh`. Not recommended.

## Recommendation

Pursue **Option 1 (ash)**. Start with the experiment (enable `CONFIG_ASH`, measure
what works on NOMMU), then port the fork sites to clone-with-fn following the hush
patches as the template. This is the single highest-leverage item for "any autotools
package compiles in-guest." Until then, the guest compiles plain-Makefile and
`nix-build`-driven C/C++ projects fine; autotools `./configure` is the gap.

## Relationship to other work

- The clone-with-fn spawn model and the existing hush/libbb patches
  (`patches/busybox/0001,0003,0004,0005,0006`) are the template and the shared
  infrastructure.
- Overlaps the remaining busybox vfork applet long-tail (`tar` done; `wget` et al.):
  same clone-with-fn technique, same NOMMU constraint.
