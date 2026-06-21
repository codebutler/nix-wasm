# Fork/vfork triage — clean-NOMMU spawn contract (2026-06-21)

Task 1 removed `fork()`/`vfork()` from the wasm musl libc so callers fail
at **link time** (loud, traceable) instead of SIGILL/abort at runtime.

Linkcheck spike confirms: `fork=ABSENT`, `spawn=LINKED` (posix_spawn works).

## Packages that now fail to link (intended loud failures)

### 1. openssl (CLI binary `apps/openssl`) — blocks `nix-wasm`

**Error:**
```
wasm-ld: error: apps/openssl-bin-speed.o: undefined symbol: fork
wasm-ld: error: apps/libapps.a(libapps-lib-http_server.o): undefined symbol: fork
```

**Root cause:** The `openssl` CLI binary uses `fork` in `speed.c` (parallel
benchmark workers) and `apps/http_server.c`. The **libraries** (libssl/libcrypto)
do NOT use fork — only the CLI tool.

**Impact:** openssl build failure cascades: openssl → curl → libgit2 → `nix-wasm`.

**Fix (Task 3):** Add `no-apps` to the openssl configure flags in the wasm override
in `deps-overlay.nix`. This is the correct fix — the cross-compiled `openssl` CLI
wasm binary is never executed on the host, and the guest only needs libssl/libcrypto.

```nix
# In deps-overlay.nix openssl override, add to configureFlags:
"no-apps"
```

---

### 2. busybox — blocks `wasm-initramfs`, `wasm-store-manifest`, smoke

**Errors:**
```
wasm-ld: error: libbb/lib.a(xfuncs_printf.o): undefined symbol: vfork
wasm-ld: error: networking/lib.a(ifupdown.o): undefined symbol: vfork
wasm-ld: error: networking/lib.a(ifupdown.o): undefined symbol: vfork
wasm-ld: error: networking/lib.a(telnetd.o): undefined symbol: vfork
```

**Root cause:** Three sources:

1. **`libbb/xfuncs_printf.o`** — contains `xvfork()`, the low-level raw vfork
   wrapper used directly by some applets. The `0004-libbb-spawn-clone.patch`
   converted `spawn()`/`fork_or_rexec()` in `vfork_daemon_rexec.c` but did NOT
   eliminate `xvfork()` itself in `libbb/xfuncs_printf.c`.

2. **`networking/ifupdown.o`** (`CONFIG_IFUPDOWN`) — `ifupdown` uses vfork to
   execute `/sbin/ip`. It is enabled in `wasm_defconfig` (patch 0001) but is
   NOT in the disable list in `userspace/busybox.nix`.

3. **`networking/telnetd.o`** (`CONFIG_TELNETD`) — telnetd uses vfork to spawn
   child sessions. It is enabled in `wasm_defconfig` (patch 0001) but is NOT
   in the disable list in `userspace/busybox.nix`.

**Fix (Task 3):** Two sub-fixes:

a. Add `IFUPDOWN` and `TELNETD` to the disable list in `userspace/busybox.nix`
   (the same `sed` loop that already disables HTTPD, WGET, NC, etc.) — these
   applets are not needed on the NOMMU wasm guest.

b. Either remove `xvfork()` from `libbb/xfuncs_printf.c` (replacing all call
   sites with `clone(…CLONE_VM|CLONE_VFORK…)`) or, since IFUPDOWN/TELNETD are
   the only remaining callers of `xvfork`, disabling them may suffice to eliminate
   the linker reference entirely (verify with `--gc-sections` in effect).

---

## Packages that PASS (no regression)

- **`kernel`** (`.#kernel`) — builds successfully:
  `/nix/store/9lzixfmjj51yqwmnqn523ll1pyz0nh2k-vmlinux-wasm-7.0-039e5f3e`
- **`nofork-linkcheck` spike** — `fork=ABSENT`, `spawn=LINKED` (contract verified)
- **engine unit tests** (`bun run test`) — 79/79 pass

## Smoke result

BLOCKED — `wasm-initramfs` and `nix-wasm` both fail to build; the smoke
(`nix-env -iA sl`) cannot run until Task 3 fixes the above.

## What NOT to do

- Do not add `fork`/`vfork` stubs back (defeats the whole point of Task 1).
- Do not skip openssl by replacing it with a different TLS library (stick with
  the nixpkgs crossSystem path per PRIME DIRECTIVE corollary 1).
- Do not patch ifupdown/telnetd to use clone-with-fn (they are network daemons
  not needed on the NOMMU wasm guest — disable them instead).
