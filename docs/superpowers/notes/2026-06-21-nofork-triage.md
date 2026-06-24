# Fork/vfork triage — clean-NOMMU spawn contract (2026-06-21)

Task 1 removed `fork()`/`vfork()` from the wasm musl libc so callers fail
at **link time** (loud, traceable) instead of SIGILL/abort at runtime.

Linkcheck spike confirms: `fork=ABSENT`, `spawn=LINKED` (posix_spawn works).

## Packages that now fail to link (intended loud failures)

### 1. openssl (CLI binary `apps/openssl`) — RESOLVED

**Error:**
```
wasm-ld: error: apps/openssl-bin-speed.o: undefined symbol: fork
wasm-ld: error: apps/libapps.a(libapps-lib-http_server.o): undefined symbol: fork
```

**Root cause:** The `openssl` CLI binary uses `fork` in `speed.c` (parallel
benchmark workers) and `apps/http_server.c`. The **libraries** (libssl/libcrypto)
do NOT use fork — only the CLI tool.

**Impact:** openssl build failure cascades: openssl → curl → libgit2 → `nix-wasm`.

**FIX APPLIED** (`deps-overlay.nix`, wasm-guarded openssl override): add `no-apps`
to `configureFlags` (skip building the openssl CLI). nixpkgs' stock `postInstall`
wraps `$bin/bin/openssl` (the now-absent CLI) for the `c_rehash` helper, so the
override also replaces `postInstall` with a CLI-free version (library-only: split
$dev, prune the perl-dependent etc/ssl/misc + empty cert dirs, no bin wrapper).
`nix-wasm` now builds.

### 1b. pcre2 (CLI tool `pcre2grep`) — RESOLVED (surfaced after openssl fixed)

**Error:**
```
wasm-ld: error: src/pcre2grep-pcre2grep.o: undefined symbol: fork
```

**Root cause:** `pcre2grep`'s `--exec`/callout-fork feature
(`SUPPORT_PCRE2GREP_CALLOUT_FORK`) calls fork(). The libpcre2 **library** (the
only thing libgit2 → nix.wasm uses) does NOT.

**FIX APPLIED** (`deps-overlay.nix`, wasm-guarded pcre2 override): add
`--disable-pcre2grep-callout-fork` to `configureFlags`. The tool still builds
(unused on the guest); the library is unaffected. `nix-wasm` builds clean:
`/nix/store/nggnrlmndqzpf5hiv04q00vg0bbll44j-nix-wasm-2.34.7`.

---

### 2. busybox — RESOLVED

**Errors (initial):**
```
wasm-ld: error: libbb/lib.a(xfuncs_printf.o): undefined symbol: vfork
wasm-ld: error: networking/lib.a(ifupdown.o): undefined symbol: vfork
wasm-ld: error: networking/lib.a(telnetd.o): undefined symbol: vfork
```

**Root cause:** Three sources:

1. **`networking/ifupdown.o`** — the `ifup`/`ifdown` applets (`CONFIG_IFUP`/
   `CONFIG_IFDOWN`) vfork-exec `/sbin/ip`. Enabled in `wasm_defconfig`, missing
   from the disable list in `userspace/busybox.nix`. (Note: the gating symbols are
   `IFUP`/`IFDOWN`, not a standalone `IFUPDOWN` toggle — that was the first
   wrong attempt; the parent symbol isn't written as a `=y` line.)

2. **`networking/telnetd.o`** (`CONFIG_TELNETD`) — telnetd vforks per session.
   Enabled in `wasm_defconfig`, missing from the disable list.

3. **`libbb/xfuncs_printf.o`** — `xvfork_parent_waits_and_exits()` expands the
   `xvfork()` macro → `vfork()`. It lives in the always-linked `xfuncs_printf.o`
   TU, so even with `--gc-sections` it left an unresolved `vfork`. It is a genuine
   vfork-return-twice API (parent waits+exits, child continues IN the caller) that
   clone-with-fn cannot express; its only callers (nsenter/unshare) are disabled.

**FIX APPLIED:**

a. `userspace/busybox.nix` disable loop: added `IFUP IFDOWN TELNETD` (and the
   sanity-check list). These network tools aren't needed on the NOMMU wasm guest.

b. `patches/busybox/0004-libbb-spawn-clone.patch`: added a hunk compiling
   `xvfork_parent_waits_and_exits()`'s body to a loud `bb_simple_error_msg_and_die`
   under `!BB_MMU` (unreachable — no enabled applet calls it), so no `vfork`
   reference remains. busybox now links clean.

---

### 3. glib (`gspawn-posix.c`, `gtestutils.c`) — OPEN BLOCKER (NEW, surfaced after busybox fixed)

**Error:**
```
wasm-ld: error: glib/libglib-2.0.a(gtestutils.c.o): undefined symbol: fork
wasm-ld: error: glib/libglib-2.0.a(gspawn-posix.c.o): undefined symbol: fork
```

**Root cause:** glib's process-spawn API `g_spawn_*` (`gspawn-posix.c`) and its
test harness (`gtestutils.c`, `g_test_trap_fork`) call **fork()** directly. Unlike
openssl/pcre2/busybox-applets, this is NOT a disposable CLI tool — it's the glib
**library** itself (`libglib-2.0.a`), consumed by the entire GTK3 stack.

**Impact:** glib failure cascades to the whole GTK demo stack pulled into
`wasm-initramfs` via `extraBins` (flake.nix line 291): cairo, gdk-pixbuf,
at-spi2-core, pango, gtk+3, gtk-hello, galculator, weston-flowers, wl-text,
pango-text, glib-selftest. **This blocks `wasm-initramfs`** (and thus the boot
smoke artifact assembly).

**This is the genuine clean-NOMMU porting work** (Task 3-class, NOT a "disable the
tool" fix). Options, in priority order:

1. **Port `gspawn-posix.c` to clone-with-fn** — glib's `g_spawn` is the real
   spawn contract GTK apps use (e.g. launching helpers). Convert its
   `fork()`+exec to `clone(CLONE_VM|CLONE_VFORK|SIGCHLD, fn)` / `posix_spawn`,
   the same pattern busybox uses. Substantial (glib's fork path has
   pre/post-fork child-setup callbacks, fd remapping, the
   `g_spawn_async_with_pipes` machinery).
2. **Compile out `gtestutils.c`'s `g_test_trap_fork`** under wasm — it's the test
   harness, never used at runtime on the guest (a clean disable, like the openssl
   CLI).
3. **Wasm-guard glib override to disable the fork-using bits** if glib exposes a
   meson option (e.g. tests off already; check whether g_spawn can be stubbed for
   the NOMMU build). gspawn is core glib API though — likely needs the real port.

**Does it block the boot smoke?** The smoke's functional path (`nix-env -iA sl`)
does not need GTK. But `wasm-initramfs` bundles the GTK demos in `extraBins`, so
the **artifact** won't build until glib is ported (or the GTK extraBins are
temporarily dropped from the initramfs for a smoke-only build — a scoping choice,
not a fork fix).

---

## Packages that PASS (no regression)

- **`kernel`** (`.#kernel`) — builds successfully:
  `/nix/store/9lzixfmjj51yqwmnqn523ll1pyz0nh2k-vmlinux-wasm-7.0-039e5f3e`
- **`nix-wasm`** (`.#nix-wasm`) — builds after openssl + pcre2 fixes:
  `/nix/store/nggnrlmndqzpf5hiv04q00vg0bbll44j-nix-wasm-2.34.7`
- **busybox / ash** — build after the IFUP/IFDOWN/TELNETD + xvfork fixes.
- **`nofork-linkcheck` spike** — `fork=ABSENT`, `spawn=LINKED` (contract verified)
- **engine unit tests** (`bun run test`) — 79/79 pass

### 4. ncurses (`test/` demo programs, e.g. `test/ditto.c`) — RESOLVED (surfaced after glib fixed)

**Error:**
```
wasm-ld: error: ../objects/ditto.o: undefined symbol: fork
```
(building dir `/build/ncurses-6.6/test`; cascades ncurses → terminfo-xterm-256color
→ system-path → wasm-system → wasm-store-manifest)

**Root cause:** ncurses' default `make all` descends into its `test/` directory and
builds the demo programs. `ditto.c` is a multi-terminal demo that calls `fork()`
(several other demos do too). Those demos are NEVER installed (the install targets
are `install.{libs,progs,includes,data,man}` — none touch `test/`) and never run on
the guest. They only linked under the old runtime-abort-stub model because `fork`
was a linkable symbol that SIGILL'd at runtime; with the symbol removed they fail at
LINK. The ncurses **library** (libncursesw) and **progs** (tic/tput/…) the guest
actually uses do NOT call fork.

**FIX APPLIED** (`deps-overlay.nix`, wasm-guarded ncurses override): set
`buildFlags = [ "libs" "progs" ]` so `make` builds only the targets that get
installed, skipping the unused fork-using `test/` demos. Library + programs
unaffected; native ncurses still builds its full `all`.

## Smoke result — PASS (2026-06-21)

Full boot smoke is **GREEN** end-to-end (`node demo/node/smoke.mjs`, exit 0):
boot → 9P read/write/overwrite/append/ls → `nix-env -iA sl` substitutes `sl` from
the committed binary cache and renders. The clean-NOMMU spawn changes (fork/vfork
removed at link level, glib ported to `posix_spawn`, ncurses test-demos skipped)
do **not** regress the boot path. Artifacts: kernel/initramfs/store-manifest from
`nix build`; the `sl` package cache is the committed pc-vendored
`nix-cache/` fixture (wired into `.artifacts/nix-cache`).

## What NOT to do

- Do not add `fork`/`vfork` stubs back (defeats the whole point of Task 1).
- Do not skip openssl by replacing it with a different TLS library (stick with
  the nixpkgs crossSystem path per PRIME DIRECTIVE corollary 1).
- Do not patch ifup/ifdown/telnetd to use clone-with-fn (network daemons not
  needed on the NOMMU wasm guest — disable them instead).
- Do NOT stub glib's `g_spawn` to a no-op — it's real GTK-app API; port it
  properly to clone-with-fn (corollary 1: the correct general fix, not a hack).
