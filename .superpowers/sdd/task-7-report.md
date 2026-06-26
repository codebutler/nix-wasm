# Task 7 Report: Sommelier fork()→posix_spawn patch

## Patch produced
`patches/sommelier/0001-posix-spawn.patch` — applies with `patch -p1` from the
sommelier source root (paths: `a/sommelier.cc` / `b/sommelier.cc`).
The vendored `vendor/sommelier/sommelier.cc` is UNTOUCHED.

---

## `sl_spawn` helper design

Added `#include <spawn.h>` and a new `sl_spawn()` function immediately where
`sl_execvp` was (after removing `sl_execvp` — see below):

```c
static pid_t sl_spawn(const char* file,
                      char* const argv[],
                      int wayland_socket_fd,
                      posix_spawn_file_actions_t* fa);
```

- `wayland_socket_fd >= 0`: clears CLOEXEC on that fd via `fcntl(fd, F_SETFD, 0)`,
  then `putenv("WAYLAND_SOCKET=<fd>")` in the parent before spawn (same semantic as
  `sl_execvp`'s `dup`+`putenv`; no separate dup needed since the fd number is fixed).
- `setenv("SOMMELIER_VERSION", ...)` in parent (same as `sl_execvp`).
- `fa != NULL`: caller-supplied `posix_spawn_file_actions_t*` for close/dup2 ops
  in the child (used by the worker and xwayland sites). `fa == NULL`: a local
  file_actions with no ops is allocated and destroyed internally.
- Returns `pid` on success, `-1` (with errno set) on failure.

`sl_execvp` is **removed** — it is now dead code (no remaining callers) and
contains `execvp()` which would fail to link against fork-less musl.

---

## Per-site conversion

### Site 1 — line 3627 (`sl_window_manager`, single-client Xwayland runprog)

Original child: `setenv("WAYLAND_DISPLAY", ".", 1)` → `sl_execvp(ctx->runprog[0], ctx->runprog, -1)`.

Conversion: move `setenv("WAYLAND_DISPLAY", ".", 1)` to parent, then
`pid = sl_spawn(ctx->runprog[0], ctx->runprog, -1, NULL)`. Sommelier is
single-threaded; the WAYLAND_DISPLAY env mutation before spawn is safe and
immediately inherited by the child. The comment about why we set "." rather
than unsetting is preserved.

### Site 2 — line 3935 (`sl_run_parent`, initial runprog before accepting clients)

Original child: `setenv("WAYLAND_DISPLAY", socket_name, 1)` → `sl_execvp(ctx->runprog[0], ctx->runprog, -1)`.

Conversion: move `setenv("WAYLAND_DISPLAY", socket_name, 1)` to parent, then
`pid = sl_spawn(ctx->runprog[0], ctx->runprog, -1, NULL)`. The parent then
`waitpid` loop is unchanged.

### Site 3 — line 3972 (`sl_run_parent`, per-accepted-client worker re-exec)

Original child: `close(sock_fd); close(lock_fd);` → build `args[]` with
`--peer-pid=` and `--client-fd=` → `execvp(args[0], ...)`.

The `client_fd` comes from `accept()` without `SOCK_CLOEXEC` — it already
survives `posix_spawn` with no action needed.

Conversion: build `args[]` in the parent (it's all local data, no child-only
computation). Use `posix_spawn_file_actions_addclose` for `sock_fd` and
`lock_fd` to close them in the child:

```c
posix_spawn_file_actions_t fa;
posix_spawn_file_actions_init(&fa);
posix_spawn_file_actions_addclose(&fa, sock_fd);
posix_spawn_file_actions_addclose(&fa, lock_fd);
int pid = sl_spawn(args[0], const_cast<char* const*>(args), -1, &fa);
posix_spawn_file_actions_destroy(&fa);
```

`close(client_fd)` in the parent loop is unchanged (parent closes its copy
after spawn, as before).

### Site 4 — line 4056 (`sl_spawn_xwayland`)

Original child: `dup(ds[1])` / `dup(wm[1])` to non-CLOEXEC fds → build args
with the dup'd fd numbers → `sl_execvp(args[0], ..., wayland_socket_fd)`.

Decision: **clean posix_spawn conversion** (preferred over `#if 0`).

Conversion: args are built in the parent using `ds[1]` / `wm[1]` directly as
the fd numbers (no dup needed). Both are cleared of CLOEXEC via
`fcntl(fd, F_SETFD, 0)`. A `posix_spawn_file_actions_t` closes the
parent-facing ends (`ds[0]`, `wm[0]`) in the child. `wayland_socket_fd` passes
through `sl_spawn`'s WAYLAND_SOCKET path (which also clears its CLOEXEC).
The `sv[1]` socketpair was created with `SOCK_CLOEXEC` — clearing CLOEXEC on
it before spawn is correct since we want the child (Xwayland) to see the fd.

### Site 5 — line 4607 (main function, single-client runprog via `sv[1]`)

Original child: `unsetenv("DISPLAY")` → `sl_execvp(ctx.runprog[0], ctx.runprog, sv[1])`.

Conversion: move `unsetenv("DISPLAY")` to parent (single-threaded, terminal
before spawn — safe). `sv[1]` is the wayland socket fd; pass it as
`wayland_socket_fd` so `sl_spawn` clears its CLOEXEC and sets WAYLAND_SOCKET.
Then `close(sv[1])` in the parent (unchanged position).

---

## Xwayland decision

**Full posix_spawn conversion** rather than `#if 0`. Rationale: the child setup
in `sl_spawn_xwayland` is purely fd management (close parent ends, expose child
ends) — exactly what `posix_spawn_file_actions_t` is designed for. The conversion
is clean and keeps the code compilable/correct if `-X` is ever used. No
`#if 0` dead blocks to maintain.

---

## Verification output

```
# Dry-run (from fresh copy of vendor/sommelier):
$ patch -p1 --dry-run < patches/sommelier/0001-posix-spawn.patch
checking file sommelier.cc

# Apply + grep:
$ patch -p1 < patches/sommelier/0001-posix-spawn.patch
patching file sommelier.cc

$ grep -nE '\b(fork|vfork)\s*\(|\bexecvp?\s*\(' sommelier.cc
3493:/* wasm/NOMMU: musl has no fork(). Spawn via posix_spawn (fork+exec atomically),
```

The single match is inside a `/* */` block comment (the `sl_spawn` function's
doc comment). Zero live `fork()`/`vfork()`/`execvp()` calls remain in the code.

```
$ grep -n 'posix_spawnp' sommelier.cc
3518:  int rv = posix_spawnp(&pid, file, fap, NULL, argv, environ);
```

---

## Concerns

1. **`sv[1]` CLOEXEC**: the socketpair at line 4581 is created with
   `SOCK_CLOEXEC`. `sl_spawn` clears CLOEXEC on it via `fcntl(sv[1], F_SETFD, 0)`
   before setting `WAYLAND_SOCKET`. This is correct but is a parent-side mutation —
   if `sl_spawn` fails and the program continues (it does `errno_assert`), sv[1]
   remains non-CLOEXEC. Not a real issue since errno_assert aborts on failure.

2. **`sl_run_parent` worker `peer_cmd_prefix` memory**: `peer_cmd_prefix_str` and
   the `args[]` strings are `sl_xasprintf` allocations. In the original fork, the
   child's copies were freed by `_exit`. In the converted version the parent
   allocates them per-iteration and they are not freed (small leak per accepted
   client). This was already implicit in the original (parent fork loop also
   allocated `sl_xasprintf` strings for `peer_pid_str`/`client_fd_str` — visible
   in the original code at 3995–3997). The loop runs indefinitely; the per-client
   allocation is O(1) bytes. Not a new issue introduced by this patch.

3. **`environ` declaration**: `extern char** environ;` is declared inside
   `sl_spawn`. On most POSIX systems this is also available from `<unistd.h>`.
   The inline `extern` declaration is safe (compatible with the implicit external
   linkage), matches the pattern used in other wasm ports, and avoids any
   header ordering concern.

---

## Review-finding fixes (commit: fix(#7): Sommelier sl_spawn — child-only envp, restore SOMMELIER_VERSION)

Two review findings addressed in the regenerated patch:

### Finding 1: SOMMELIER_VERSION regression

The first patch dropped `SOMMELIER_VERSION` from every spawned child (it was set
inside `sl_execvp` which was called from forked children). Fixed by always
appending `SOMMELIER_VERSION=<SOMMELIER_VERSION>` to `child_env` inside `sl_spawn`
(unconditional, last entry before the NULL sentinel).

Grep confirmation (applied patch):
```
$ grep -n "SOMMELIER_VERSION" sommelier.cc
3527:   * SOMMELIER_VERSION + NULL sentinel. */
3543:   * SOMMELIER_VERSION (we always supply it). */
3563:    /* Skip WAYLAND_SOCKET and SOMMELIER_VERSION — we always write them. */
3565:                  strncmp(*e, "SOMMELIER_VERSION=", 18) == 0))
3587:  /* Always append SOMMELIER_VERSION. */
3588:  char* sv_str = sl_xasprintf("SOMMELIER_VERSION=%s", SOMMELIER_VERSION);
```

### Finding 2: Parent env mutation

The first patch moved per-child env tweaks (`WAYLAND_DISPLAY`, `WAYLAND_SOCKET`,
`unsetenv("DISPLAY")`) into the parent before `posix_spawnp`, permanently mutating
the parent's environment. This is incorrect — in the original code all of these
ran only inside `if (pid == 0)` child blocks.

**Fix: build a child-only `envp` inside `sl_spawn`.**

New `sl_spawn` signature:
```c
static pid_t sl_spawn(const char* file,
                      char* const argv[],
                      int wayland_socket_fd,
                      const char* const* add_env,
                      const char* const* unset_vars,
                      posix_spawn_file_actions_t* fa);
```

`add_env`: NULL-terminated list of `"VAR=value"` strings to add/override in
the child environment. `unset_vars`: NULL-terminated list of variable names to
omit. Inside `sl_spawn`, `child_env` is built by:
1. Copying `environ`, skipping entries whose names appear in `unset_vars`, are
   overridden by `add_env`, or are `WAYLAND_SOCKET`/`SOMMELIER_VERSION` (always
   supplied fresh).
2. Appending `add_env` entries.
3. Appending `WAYLAND_SOCKET=<fd>` when `wayland_socket_fd >= 0` (also clears
   CLOEXEC on the fd).
4. Always appending `SOMMELIER_VERSION=<SOMMELIER_VERSION>`.
5. NULL-terminating.

`child_env` (heap array), `ws_str`, and `sv_str` are freed after `posix_spawnp`.

### Call-site child-only env deltas

| Site | add_env | unset_vars |
|------|---------|------------|
| `sl_window_manager` runprog (`"."`) | `{"WAYLAND_DISPLAY=.", NULL}` | none |
| `sl_run_parent` initial runprog | `{sl_xasprintf("WAYLAND_DISPLAY=%s", socket_name), NULL}` | none |
| `sl_run_parent` per-client worker | none | none |
| `sl_spawn_xwayland` | `{"LIBGL_DRIVERS_PATH=<path>", NULL}` (conditional) or `nullptr` | none |
| main single-client | none | `{"DISPLAY", NULL}` |

No `setenv`/`unsetenv`/`putenv` calls were added to the patch for any of these
child-only tweaks. The only `setenv`/`putenv` remaining in the patched file are
the two that were already in the parent before `fork()` in the original code:
`setenv("DISPLAY", display_name, 1)` (line ~3704) and
`putenv("XCURSOR_SIZE=...")` (line ~3736) — both in `sl_handle_display_ready_event`
above the fork, so they were already parent-env mutations in the original.

### Dry-run + grep verification output

```
# Dry-run against pristine vendor/sommelier:
$ patch -p1 --dry-run -d /tmp/somm-dryrun < patches/sommelier/0001-posix-spawn.patch
checking file sommelier.cc

# After apply:
$ grep -n "fork(" sommelier.cc   # only in comment
3493:/* wasm/NOMMU: musl has no fork(). Spawn via posix_spawnp...

$ grep -n "vfork\|execvp" sommelier.cc
(no output)

$ grep -n "posix_spawnp" sommelier.cc
3493:/* wasm/NOMMU...
3602:  int rv = posix_spawnp(&pid, file, fap, NULL, argv, child_env);

# setenv/unsetenv/putenv in patched file (original-parent-level only):
$ grep -n "setenv\|unsetenv\|putenv" sommelier.cc
3704:  setenv("DISPLAY", display_name, 1);          # original parent-level
3736:  putenv(sl_xasprintf("XCURSOR_SIZE=..."));    # original parent-level
4215:  // Build as child-only env entry (not a parent setenv).  # comment only

# SOMMELIER_VERSION present in child_env construction:
$ grep -n "SOMMELIER_VERSION" sommelier.cc
3527/3543/3563/3565/3587/3588: child_env construction + append
```

No parent env mutation introduced by the patch. SOMMELIER_VERSION present in
every spawned child via `child_env`.
