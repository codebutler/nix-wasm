# CLAUDE.md — nix-wasm

Build `nix.wasm` (Nix for the `wasm32-linux-musl` NOMMU guest) and its toolchain,
**entirely through Nix**. This file is the operating guide AND the record of
current state and hard-won learnings — read it before doing anything.

## PRIME DIRECTIVE (non-negotiable)

**ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks. No stubs.** There is
no "good enough for now," no tactical workaround, no deferred-correctness. If two
paths exist, take the one that is *correct in general*, not the one that is merely
sufficient for the task in front of you — even when it is harder, slower, or larger.
Every artifact is a reproducible Nix derivation. The OLD approach (hand-written
shell scripts + fake-lib stubs) has been deleted — it lives in git history; the Nix
derivations are the only build path.

Hard-won corollaries (each was a real mistake; don't repeat them):

1. **Don't propose a fix that solves the immediate task but not the actual goal.**
   Minimal per-dep derivations would build `nix.wasm` but a *user* package sharing
   those deps (e.g. `git` → `curl`/`libgit2`) would still pull the broken nixpkgs
   cross dep and fail. The CORRECT path fixes the **crossSystem** (overlay
   overrides on `cross.*` + the platform bugs) so nixpkgs packages cross-compile
   — those fixes are **shared** across `nix.wasm` AND every user-installable
   package. Stay on nixpkgs-via-crossSystem; never fork off package-private recipes.
2. **Don't recommend "do the easy slice now, defer the hard part."** The goal is
   the whole environment built reproducibly; carving off the tractable piece and
   calling it done is a shortcut in disguise.
3. **Don't kill a running build to "restart cleanly."** On `aarch64` the first
   build compiles LLVM/clang from source (~1–2 h); killing it mid-way restarts it
   from scratch. Leave builds alone; they notify on completion.
4. **If disk runs out (ENOSPC), STOP and ask for more disk — do NOT `nix store
   gc`.** GC forces re-realizing derivations (slow recompiles).
5. Report progress, not questions. Once the correct path is clear, execute.

## Architecture

A real nixpkgs **crossSystem** whose stdenv targets `wasm32-unknown-linux-musl`,
with a prebuilt **clang-21** cc-wrapper injected via the supported
`config.replaceCrossStdenv` seam (`wasm-cross.nix`). nixpkgs' own package
definitions then cross-compile.

- **Toolchain** = focused Nix derivations (NOT nixpkgs packages), built from
  stock LLVM-21 + pinned musl/kernel sources: `toolchain/{musl,compiler-rt,
  libcxx,kernel-headers,sysroot}.nix`. This layer is **done and validated**.
- **cc-wrapper** = `clang-unwrapped` (LLVM 21) + a **flag-filtering `wasm-ld`**
  (drops ELF-only flags like `--undefined-version`, wired via `clang -B$out/bin`)
  over the nix-built sysroot. Stock LLVM-21 for all of userspace — no joelseverin/
  llvm fork (the wasm-EH patch is upstream in LLVM ≥19).
- **Deps** = nixpkgs packages via `cross.*`, with cross-wasm fixes in
  `deps-overlay.nix` (all wasm-guarded so native packages stay stock/cached).
- **`nix.wasm`** = `nix-wasm.nix`: meson compiles Nix's C++ with clang-21 against
  the nix-built libc++ + the `cross.*` deps, then a custom `.o` link (meson's
  `-r` prelink can't emit wasm TLS relocs — a real wasm limit, not a shortcut).
- **Guest kernel** = `kernel.nix`: `vmlinux.wasm` from the pinned joelseverin/linux
  wasm port. The ONLY patched-LLVM consumer (`kernel-llvm.nix`: a libllvm patch for
  `EXPORT_SYMBOL` inline-asm + an lld patch for the `vmlinux.lds` linker script —
  real toolchain features, not flag massaging), exposed as a plain `symlinkJoin`
  (`kernel-cc.nix`). The wasm cc/ld/objcopy flags live in the kernel SOURCE
  (`patches/kernel/0008-0012`) — there is **no fake-llvm wrapper** (deleted).
- **Guest userspace** = `userspace/*.nix`: a curated `lib.evalModules` NixOS
  closure (no systemd/perl/python) + a patched busybox (`userspace/busybox.nix`:
  clone-with-fn spawn — NOMMU wasm can't fork/vfork) built via the `cross`
  cc-wrapper; boots through a thin Nix-generated `/init` (`bootstrap.nix`) that
  overlays the served `/nix` closure and hands off to busybox-init.

LLVM target triple is `wasm32-unknown-unknown` (clang rejects
`wasm32-unknown-linux-musl`); `-D__linux__ -matomics -mbulk-memory
-fwasm-exceptions` supply the rest. Everything links static `.a` into the final
`-shared` dylink wasm module.

## Build / test

Nix daemon runs as root here → `sudo`; enable flakes via `NIX_CONFIG`:

```sh
export NIX_CONFIG="experimental-features = nix-command flakes"
sudo -E nix build .#musl --no-link --print-out-paths        # a toolchain stage
sudo -E nix build .#crossZlib --no-link --print-out-paths    # cc-wrapper smoke test
sudo -E nix build .#dep-openssl --no-link --print-out-paths  # a dependency
sudo -E nix build .#nix-wasm --print-out-paths               # the goal
```

- `sudo` loses a piped password into `$(sudo …)` subshells — run each `sudo nix`
  as its own command, or `echo <pw> | sudo -S …` per call. (Local password noted
  in agent memory, not here.)
- **Validate toolchain stages against the known-good** linux-wasm artifacts at
  `~/lwbuild/ws/install/{musl,cxx,llvm}-wasm32_nommu` (symbol-set diffs). Don't
  build those from this repo — they're the read-only oracle.
- The eval cache is a single SQLite db — concurrent `nix` invocations race
  ("database is busy"); don't run a status check against a live build.

### Boot-test the built guest — in-repo runtime/ harness

nix-wasm now both *builds* the guest and *runs* it. The `runtime/` package
(kernel host + 9P server + Nix store wiring) runs in Node and the browser; pc
vendors it via `runtime/sync-to-pc.sh`. **Any change to a runtime engine file
(e.g. `kernel-worker.js` — the loader gained glib `GOT.func`/`__lsan_*` stubs in
M3a) requires re-running `runtime/sync-to-pc.sh <pc-checkout>`, or pc boots a stale
engine that fails to instantiate glib/GTK binaries.**

Artifacts (`vmlinux.wasm`, `initramfs.cpio.gz`, `store.json`, `nix-cache/`) come
from `nix build` (`.#vmlinux`, `.#wasm-initramfs`, `.#wasm-store-manifest`). Point
at them via `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/` for the Node CLI, or
symlink `demo/web/artifacts → /path/to/artifacts` for the browser demo. Local-dev
fallback: pc's vendored set (`vendor/linux-wasm/` in a pc checkout).

Run these from the **runtime/** directory:

```sh
# Engine unit tests (79 tests, no artifacts needed):
bun run test

# Node integration tests:
node --test demo/node/

# Full nix-system smoke: boot → 9P read/write/ls → nix-env -iA sl.
# Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/smoke.mjs

# Interactive guest root shell (Ctrl-] to quit).
# --no-nix = fast busybox-only boot when you don't need the /nix overlay.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/attach.mjs [--no-nix]

# libffi raw-backend unit test (f32/f64/i64 by-value args): boot → run selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/libffi-smoke.mjs

# M2 text stack (fontconfig→freetype→harfbuzz→cairo-ft): boot full nix system → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/wl-text-smoke.mjs

# M3a glib/gobject (+ libffi double marshaller): boot full nix system → gobject selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/glib-smoke.mjs

# M3a pango layout (pango_cairo_show_layout → fontconfig → cairo-ft): boot → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/pango-smoke.mjs

# M3b GTK3 (gtk_init + GtkWindow/GtkLabel widget tree, gobject through fpcast seam):
# boot full nix system → gtk-hello --selftest (headless gate; visual window is a
# MANUAL browser check — docs/superpowers/notes/m3b-gtk-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/gtk-smoke.mjs

# M4 galculator (GTK3 calculator: --selftest parses the real .ui files from
# PACKAGE_UI_DIR + runs the GTK widget gobject classes through the fpcast seam,
# display-free; visual click-7x6=42 is a MANUAL browser check —
# docs/superpowers/notes/m4-galculator-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/galculator-smoke.mjs

# Browser demo (serves runtime/demo/web/ with COOP/COEP for SharedArrayBuffer):
ln -sfn /path/to/artifacts demo/web/artifacts && node demo/web/serve.mjs [port]
# Headless Playwright smoke (asserts WEB_OK):
node demo/web/smoke.mjs
```

`makeConsoleSession` wraps a boot handle's console with session conveniences:
`write`, `onData`, `resize`, `kill`, `hangup`.

**Four CI gates for runtime/** (all must pass before pushing):

```sh
bun run test          # engine unit tests
bun run lint          # oxlint, zero warnings tolerated
bun run format:check  # oxfmt
bun run typecheck     # tsc
```

`demo/node/` and `demo/web/` are tooling/demo (tsc-excluded); `demo/web/vendor/ghostty` is
vendored (excluded from all three static gates).

## Current state

**It works end-to-end** (2026-06-17). `nix build .#nix-wasm` builds the wasm Nix;
the dep closure (`cross.*`), the kernel, and the curated guest userspace all build
reproducibly. In the runtime harness (`runtime/demo/node/smoke.mjs`) the
Nix-built userspace boots — served-closure `/nix` overlay → busybox-init → getty →
autologin → root shell — and **`nix-env -iA sl` substitutes `sl` from the binary
cache and renders it** (Phase A + B both PASS). Every wasm fix is a SHARED
crossSystem/overlay or kernel-source fix, never a package-private workaround (PRIME
DIRECTIVE corollary 1).

**Phase 3 is also done** (2026-06-17): the in-guest compiler is nixified —
`.#guest-clang` (LLVM-21 clang+lld cross-built to wasm32), `.#cc-sysroot`,
`.#guest-cc` (the `cc` driver), and `.#guest-cxx` (the `c++` driver). The guest now
COMPILES C **and C++** in-browser entirely from Nix-built artifacts (`cc -O2 hello.c
&& ./hello` and `c++` building std::string/vector/exceptions/iostream both validated
in-guest). Enabling clang needed a shared kernel fix: `CONFIG_BOOT_MEM_PAGES`
0x2000→0x4000 (512MiB→1GiB) so the 57MB clang.wasm can be mmap'd contiguously after
the sysroot unpack fragments the NOMMU heap. C startup needed two link/loader fixes
(guest-cc `--gc-sections` + a loader data-relocs guard — see the guest-compile
SIGILL note in agent memory + `toolchain/guest-cc.nix`); `c++` adds `-D__linux__`
(libc++ pthread thread-API selection on the `-unknown` triple) + `--allow-undefined`
(the host-provided `__cpp_exception` wasm-EH tag), with libc++ shipped in
`cc-sysroot` (`sys/cxx`).

**In-guest autotools also works** (2026-06-17): a real autoconf `./configure &&
make && ./prog` runs end-to-end in the guest. The guest `/bin/sh` is busybox's
**forkshell ash** (busybox-w32 lineage, NOMMU fork-without-exec over `posix_spawn`;
`userspace/ash.nix` + `userspace/ash-cb-guest.c`), promoted to `/bin/sh` in
`bootstrap.nix`. Six forkshell/spawn/shell fixes made autoconf's preamble,
`$()`/subshell/pipeline, and `config.status` work (full record in the
`userspace/ash.nix` postPatch comments + the `patches/busybox/ash/*` patches + git
history). The old "hush isn't POSIX-enough" gap is closed.

Remaining: **Phase 5** (CI + binary cache — the design goal below: build on
x86_64, publish the wasm outputs, guest substitutes; issue #2).
One known wrinkle folded into Phase 5: in-guest installs use `nix-env -iA` (the
cache index is `outPath`-only "fake derivations"); `nix profile install` rejects
those for lacking a `drvPath` — shipping real `.drv`s in the published closure
fixes it (codebutler/nix-wasm#1). Archive ops work: `tar` (czf/xzf, patched) is
validated; `wget` is N/A on the
guest (no network — package sources arrive via the 9P-mounted Nix binary cache, not
internet fetch), so the disabled network/service vfork applets aren't needed.

## Caching (design goal)

The **host** must build from cache, not from source: pin a fully-cached nixpkgs
(`nixos-26.05`), build/CI on `x86_64-linux` (aarch64's cache lags → from-source
LLVM), and publish the wasm outputs (`cross.*`, `nix.wasm`, user packages) to a
binary cache. The **guest** then *substitutes* pre-built wasm artifacts rather
than building in-guest — that's the "install any package" model and what makes
the crossSystem approach scale. From-source host rebuilds are a failure mode to
design out (see the Environment notes under Hard-won learnings).

## ccache (opt-in compile cache — dev iteration only)

ccache is **not** the caching design goal above (that's the Nix binary cache,
which works at derivation granularity). ccache is orthogonal: it speeds up the
*dev loop* on the two from-source LLVM builds — `guest-clang` and the kernel's
patched LLVM (`kernel-llvm`) — where tweaking a flag or patch changes the
derivation hash and forces a full ~1–2 h rebuild even though almost every C++ TU
is identical. ccache reuses those object files, turning the rebuild into minutes.

It is **off by default** (PRIME DIRECTIVE: the standard build is fully hermetic;
the default `.#guest-clang` / `.#kernel` derivation hashes are unchanged). The
cache dir is an impure `extra-sandbox-path`, so it's gated behind separate flake
attrs and explicit host setup. ccache (daemonless) is used, not sccache (its
background server doesn't fit the per-derivation Nix sandbox; its distributed
backend would only duplicate the Nix binary cache).

**One-time host setup** (the cache dir + exposing it into the build sandbox):

```sh
echo password | sudo -S install -d -m 0770 -o root -g nixbld /nix/var/cache/ccache
# Expose the dir into the sandbox (the daemon reads /etc/nix/nix.conf):
echo password | sudo -S sh -c \
  "echo 'extra-sandbox-paths = /nix/var/cache/ccache' >> /etc/nix/nix.conf"
echo password | sudo -S systemctl restart nix-daemon   # reload the daemon
```

**Build with ccache** (cold first build still compiles from source — it *populates*
the cache; the speedup is on the *next* rebuild after a source change):

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#guest-clang-ccache --print-out-paths      # in-guest clang+lld
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#kernel-ccache --print-out-paths           # vmlinux.wasm (patched LLVM cached)
```

Inspect hit rate with `ccache -s -d /nix/var/cache/ccache`. The ccache outputs
are deterministic (bit-identical to the hermetic builds) but carry a different
input-addressed store path — they're for iteration, not for publishing as the
canonical `.#guest-clang` / `.#kernel` artifacts. The wiring is a `useCcache`
arg on `toolchain/{guest-clang,kernel-llvm}.nix` (cmake `COMPILER_LAUNCHER`).

## Hard-won learnings (gotchas & dead-ends)

Each was a real bug or a rejected approach; the detailed root-cause narrative
lives in the relevant `.nix`/patch comment + git history. This is the index of
*why* the non-obvious flags exist so they aren't "cleaned up" and re-broken.

**Cross-build (shared crossSystem/overlay — what makes nixpkgs packages
cross-compile; all in `wasm-cross.nix` / `deps-overlay.nix`):**
- **Static is a PLATFORM flag, not per-dep.** `crossSystem.isStatic = true` AND
  force `hasSharedLibraries = true` back on (else sqlite reads the now-missing
  `extensions.sharedLibrary` → eval abort). nixpkgs then applies `makeStatic`
  everywhere; the `__musl_tp` general-dynamic-TLS reloc only trips when linking a
  separate `.so`, so keeping everything static (incl. stdio) is correct, and
  `-static` is a harmless no-op on our `-shared` dylink modules.
- **`musl` must be OUR nix-built musl** (override the `musl` attr). nixpkgs'
  cross-musl bootstrap embeds a compiler-rt built with the clang-rejected
  `wasm32-unknown-linux-musl` triple, in a stage *neither `overlays` nor
  `crossOverlays` reach* → cascades to everything (via `libiconv`). Wrapping our
  own musl eliminates that bad bootstrap compiler-rt.
- **compiler-rt triple** = force `wasm32-unknown-unknown` (clang rejects
  `-linux-musl`); override `llvmPackages_21.compiler-rt` via `overrideScope` (the
  top-level `compiler-rt` attr doesn't exist here — that override was dead code).
- **ALWAYS guard overlay overrides with `prev.stdenv.hostPlatform.isWasm`** — the
  overlay hits `buildPackages` too; an unguarded `zlib`/`openssl` override rebuilds
  the *entire native toolchain* (coreutils, python) from source.
- **libc++abi self-contained**: fold `Unwind-wasm.o` INTO `libc++abi.a`
  (`toolchain/libcxx.nix`) so `_Unwind_*` resolves internally — cc-wrapper
  consumers can't reliably inject `-lunwind` after clang's auto `-lc++abi`.
- **bintools**: stock LLVM ships `ar`/`ranlib` *unprefixed* → add the
  target-prefixed symlinks or `$AR`/`$RANLIB` come up empty.
- **wasm-ld flag filter** must also drop `--compress-debug-sections` (silently
  failed every sqlite autosetup link probe → bogus "Cannot find libm") alongside
  the ELF-only flags (`--undefined-version`, …).
- **crt `int main`**: a weak 2-arg crt `main` wrapper (`musl.nix`) so all of
  `int main(void)` / `(int,char**)` link — else autoconf's "C compiler cannot
  create executables" aborts every autoconf dep.
- **libffi raw wasm backend** (`deps-overlay.nix` / `patches/libffi/`): the
  upstream `src/wasm/ffi.c` is emscripten-only; we drop in `wasm32-raw-ffi.c`
  which dispatches `ffi_call` through a build-time generated trampoline table
  (`gen-trampolines.py`, ~8375 entries) keyed on the per-arg wasm value-type
  vector (i32/i64/f32/f64). Supports i32/i64/f32/f64 by-value scalar arguments
  up to K=24 all-i32 / K=10 mixed, M=2 non-i32 per call (covers libwayland's
  i32/ptr dispatch AND GObject signal marshallers with double/int64 args); aborts
  loud past the (K,M) bounds or on struct args/varargs/closures — never a silent
  mis-call. Bump K/M in gen-trampolines.py to extend coverage if needed.
- **M2 text stack** (`deps-overlay.nix` / `userspace/fonts.nix`): **harfbuzz** is
  forced glib-free (`glib=null` + `-Dglib=disabled -Dgobject=disabled`) — nixpkgs
  enables hb-glib by default, which drags the whole glib cross-build into M2 (glib
  + pango are M3); also drop the `devdoc` output (`outputs=["out" "dev"]`) since
  `-Ddocs=disabled` means the gtk-doc devdoc dir is never created and the builder
  errors on the missing output. **cairo** is rebuilt with freetype+fontconfig
  backends strictly additive: un-null freetype/fontconfig + flip the meson flags to
  `enabled`; glib/x11/png/lzo stay off; weston-flowers (image-surface-only) is the
  regression gate. **Guest font lives in the Nix system profile** (`userspace/
  fonts.nix` + `system.nix` bake DejaVu + `/etc/fonts/fonts.conf` +
  `FONTCONFIG_FILE`): the wl-text/M2 smoke MUST boot `nix:true` (served `/nix`
  closure) — a busybox-only boot has no font config and fontconfig `FcInit` fails.
  Rebuild `.#wasm-store-manifest` after any `fonts.nix`/`system.nix` change so
  the new store path is included in the served `store.json`.
- **M3a glib/gobject** (`deps-overlay.nix` glib override): disable
  `selinux`/`libmount`/`sysprof`/`man-pages`/`dtrace`/`documentation` + `tests`
  (nixpkgs glib drags libselinux/libsepol + util-linux/libmount + libsysprof-capture
  — none cross to NOMMU wasm, none needed). `util-linuxMinimal` can't be `null`ed
  (an `isLinux` assert) → filter it out of build/propagated inputs post-override;
  drop **target** `gnum4` (m4 won't cross — gnulib `stackvma.c` has no wasm path; the
  guest never uses glib's m4 macros); drop the `devdoc` output (like harfbuzz). gio
  modules build **into libgio** (the NOMMU guest can't dlopen). Codegen tools
  (glib-genmarshal/compile-schemas/…) come from native `buildPackages` via meson cross.
- **futex_time64 arity** (`patches/kernel/0015`): `__NR_futex_time64` (422) maps to the
  6-arg `sys_futex`, but **glib's raw `syscall()`** (`g_futex_simple`) calls it with
  **4** args (`uaddr,op,val,utime`) for FUTEX_WAIT/WAKE → strict wasm `call_indirect`
  on the 6-arg handler traps. (musl pads its OWN futex calls to 6, so musl pthread —
  used by nix.wasm/busybox — is unaffected; only glib's raw 4-arg call traps.) Fix = a
  4-arg `sys_wasm32_futex` wrapper forwarding `sys_futex(uaddr,op,val,utime,NULL,0)`
  (FUTEX_WAIT/WAKE ignore uaddr2/val3), overriding `__NR_futex_time64` — mirrors the
  `sys_wasm32_*` pattern. Rebuilds only vmlinux.
- **glib/GTK `__lsan_*` loader stubs — DO NOT "clean up"** (`runtime/kernel-worker.js`):
  wasm-ld emits glib's weak-undef `__lsan_enable`/`__lsan_ignore_object` as BOTH an
  `env` import AND a `GOT.func` import. Instantiation FAILS if the `env` no-op stub is
  absent even though the function is never called (its `GOT.func` address resolves to 0
  → the call guard is false). The `GOT.func`/`GOT.mem` Proxy is scoped to those two
  import namespaces ONLY — it can't touch `env.*` or the internal `GOT.func.internal.*`
  defined globals (those carry real function-pointer relocs and are untouched). **M3b
  GTK adds `__lsan_disable`** — the 14.6MB libgtk references the full disable/enable
  bracket pair (not just glib's enable/ignore_object); same weak-undef mechanism, same
  no-op `env` stub. (kernel-worker.js host edits need a `pc` sync — `runtime/sync-to-pc.sh`.)
- **gobject class_init trap = wasm strict-`call_indirect` SIGNATURE cast, NOT a reloc
  bug** (third instance of this theme, with libffi/M1 + futex): glib casts
  `g_object_do_class_init` (1-arg) to the 2-arg `GClassInitFunc` and calls it through
  that type; strict wasm traps, and LLVM-21's opaque pointers leave no IR bitcast for
  `WebAssemblyFixFunctionBitcasts` (no clang/wasm-ld flag). Fix = a **binaryen post-link
  pass** `wasm-opt -pa max-func-params@128 --fpcast-emu` (emscripten's
  `EMULATE_FUNCTION_POINTER_CASTS` equivalent; `max-func-params@128` because the 18
  default is too narrow). Apply it **per-binary** to each glib/GTK-linking executable
  (a shared seam) — NOT globally in the cc-wrapper, which would rewrite the calling
  convention of EVERY guest binary (nix.wasm, busybox, the libffi backend). No-op for
  the libffi raw `ffi_call` path (that `call_indirect` already has the right arity).
  The seam lives in **`userspace/fpcast-emu.nix`** (`{ binaryen, shellFn }`); glib/GTK
  binaries add `fpcast.binaryen` to `nativeBuildInputs` and run `fpcast_emu in out`
  post-link. **pango** cross-builds clean with NO override (stock nixpkgs, once glib +
  the M2 text stack exist) and the same seam covers its gobject casts — proven by
  `pango-text` (`pango_cairo_show_layout` → fontconfig → cairo-ft).
- **M3b GTK3 cross-build** (`deps-overlay.nix` gtk3 override): **wayland-only** —
  force `x11Support`/`cupsSupport`/`vulkanSupport`/`broadwaySupport`/`trackerSupport`
  off and `wayland` on (the heavies — cups, avahi, X11/xorg, vulkan-loader — don't
  cross to NOMMU wasm and aren't needed); GObject-introspection off (no typelib
  consumer on the guest). **gdk-pixbuf** uses its **built-in loaders** (no
  `loaders.cache`/runtime dlopen — NOMMU can't dlopen modules); **libepoxy** builds
  with **no GL/EGL/GLX** (`-Degl=no -Dglx=no -Dx11=false`, EGL headers absent — GTK's
  wayland backend uses the cairo software path, no GL); **atk** ships with **no a11y
  bridge** (no at-spi/dbus). GTK needs the **baked GSettings schemas** — Task 3 compiles
  `org.gtk.Settings.*` with NATIVE `glib-compile-schemas` into `gtk-assets` and points
  `GSETTINGS_SCHEMA_DIR` at them (`system.nix`); without them GLib aborts at
  `gtk_settings`. **`gtk-hello`** is the proof, built through the shared **fpcast-emu
  seam** (gtk is gobject-heavy → fn-pointer casts; the 14.6MB libgtk has many). The
  `--selftest` gate is **compositor-independent**: the node harness has only a minimal
  `wl` registry (no compositor), so `gtk_init_check` returns FALSE (no GdkDisplay) and
  GTK *instance* construction (`gtk_window_new`) aborts ("Can't create a
  GtkStyleContext without a display connection"). The gate instead `g_type_class_ref`s
  `GTK_TYPE_WINDOW`/`GTK_TYPE_LABEL` (runs each class_init through the fpcast seam,
  display-free) and asserts `g_type_from_name` + `gtk_get_major_version()==3`. The full
  window *render* **now works in the browser** (a real GTK window with the label
  draws via Greenfield) — it was gated on the `/dev/shm` mount, see the Guest
  runtime/kernel learnings below (`docs/superpowers/notes/m3b-gtk-visual.md`).
- **Served-store bloat: drop galculator's `nix-support` ONLY — do NOT strip binary refs**
  (`deps-overlay.nix` galculator override `postFixup`; issue #43). galculator is in
  `environment.systemPackages` (for its `.ui` files), so it's in the SERVED `/nix` closure
  (`store.json`). The catastrophic bloat (~26MB→**345MB** store.json / 3.2k→22.5k files) was
  galculator's `$out/nix-support/propagated-build-inputs` recording `gtk+3-dev`, which
  propagates `pango-dev → libxft-dev → the whole X11 + glibc-locale -dev tree`. galculator
  is a LEAF app (nothing builds against it), so that propagation metadata is pure dead
  weight the ref scanner still follows. **Fix: `rm -rf $out/nix-support`** → ~127MB / 7.5k
  files, X11/glibc/locale gone. **DEAD-END (caused a regression, reverted):** also running
  `remove-references-to` over gtk3/glib/gdk-pixbuf/pango/xkeyboard-config/… to shrink
  further (→28MB) looks safe for a static binary but **breaks GTK at runtime** — those
  binary refs include REAL runtime data deps that ride the served closure for ALL GTK
  wayland apps, notably **xkeyboard-config** (libxkbcommon loads `…/etc/X11/xkb` at startup
  to build the XKB keymap; gdk treats a keymap failure as FATAL → every app died with
  `Gdk-ERROR: Failed to create XKB keymap`). So keep ONLY the `nix-support` removal; the
  remaining gtk3/glib data is the legitimate cost of shipping a GTK app, not bloat. The
  store.json format itself (a giant JSON inlining every small file) is the deeper issue —
  see #43.
- **M4 galculator packaging** (`deps-overlay.nix` `galculator` override): galculator
  2.1.4 is a plain GTK3 autotools app (`pkg_modules = "gtk+-3.0"`); packaged via an
  `isWasm`-guarded nixpkgs override (NOT a from-scratch `userspace/galculator.nix` —
  reuses nixpkgs' own recipe + its three patches, corollary 1) that applies the
  shared `--fpcast-emu` post-link pass in `postFixup` (gobject casts) and **appends a
  `--selftest` source patch** (`patches/galculator/0001-add-selftest.patch`) to
  nixpkgs' patch list. No GSettings schema (galculator uses
  `~/.config/galculator/galculator.conf`). `.ui` files ride the served `/nix` closure
  as filesystem data (`$out/share/galculator/ui/`), loaded at runtime from the
  hardcoded `PACKAGE_UI_DIR` — so galculator must be in `environment.systemPackages`
  (`userspace/system.nix`), NOT just the initramfs `extraBins`, or only the binary
  reaches the guest and the `.ui` files are absent. Two build fixes required: (1)
  **graphite2 .la file** — cmake emits `library_names=libgraphite2.so` on a static
  build (no `.so` produced); downstream libtool-based autotools (galculator) try to
  link the nonexistent `.so`. Fix: `postInstall` sed rewrites the `.la` to clear
  `library_names` and set `old_library=libgraphite2.a`. (2) **autopoint xz PATH** —
  `autoreconfHook` runs `autopoint` (inside `autoconf`) which decompresses
  `archive.dir.tar.xz` with a bare `xz` call; with `strictDeps=false` (needed for
  `AM_GLIB_GNU_GETTEXT` m4 macro lookup) the cross `xz` wasm binary shadows the
  native one. Fix: `preAutoreconf` creates `$TMPDIR/native-xz-bin/xz` symlink →
  native `xz`, prepended to PATH. **`--selftest` is the headless gate**: it must be
  **display-free** — the cross GTK3 is wayland-only and the node harness has no
  compositor, so `GtkBuilder` CANNOT instantiate the `.ui` widgets (GtkWindow
  construction needs a GdkDisplay → fatal `Gtk-ERROR: Can't create a GtkStyleContext
  without a display connection`). Like the M3b `gtk-hello` gate, the selftest instead
  parses the real `.ui` files (`MAIN_GLADE_FILE` = `main_frame.ui`,
  `BASIC_GLADE_FILE` = `basic_buttons_gtk3.ui`) with GLib's GMarkup XML parser —
  asserting `GtkWindow "main_window"` + `GtkToggleButton "button_7"` — and
  `g_type_class_ref`s those widget classes (display-free gobject class_init through
  the fpcast seam), printing `GALCULATOR-SELFTEST: main_window=1 button_7=1
  gtk_types=1 OK`. Gate: `node demo/node/galculator-smoke.mjs` matches
  `/GALCULATOR-SELFTEST: .* OK/`. The full click-to-42 compute is a MANUAL browser
  check (PENDING, `docs/superpowers/notes/m4-galculator-visual.md`). **CAVEAT — the
  real galculator window is GATED by the GModule wall below**: its `--selftest`
  passes but `gtk_builder_connect_signals(NULL)` over its 115 `.ui` handlers needs
  a working GModule, which the static guest lacks. The visual headline moved to
  gtk3-widget-factory (next entry).
- **GtkBuilder signal autoconnect on the static guest = `add_callback_symbol`, NOT
  a runtime `dlsym`** (`userspace/widget-factory.nix`, `patches/widget-factory/`,
  issue #33). `gtk_builder_connect_signals(builder, NULL)` resolves `.ui` `<signal
  handler="...">` names via `g_module_open(NULL)`/`g_module_symbol` → musl
  `dlopen(NULL)`/`dlsym`, which the statically-linked guest stubs to NULL →
  `Gtk-ERROR: requires working GModule`. **A host-side `dlsym` CANNOT fix this** (a
  full impl was built + world-rebuild-tested, then reverted — see #33): `--fpcast-emu`
  rewrites every indirect call to a canonical `(i64×128)→i64` sig, so a fn-pointer
  must be a canonical *thunk* (made only for address-taken fns); the host can neither
  synthesize one (`WebAssembly.Function` absent in Node/browsers) nor locate one by
  name (binaryen exports no thunks). Only `&function` in C yields the fpcast-correct
  thunk → resolution MUST be guest-side. The GTK-sanctioned static path
  (`gtk_builder_connect_signals_default` source: `g_error`s only for an *unregistered*
  handler) is `gtk_builder_add_callback_symbol(builder,"on_foo",G_CALLBACK(on_foo))`
  per handler — `&on_foo` is the fpcast canonical thunk, and a fully-registered scope
  never opens GModule (the NULL `g_module_open` is harmless). **fork was never the
  blocker here** (orthogonal to #25/#29). **Headline app = gtk3-widget-factory**
  (GTK's own showcase, no new deps, built standalone against cross gtk3 so gtk3
  itself stays cached): it registers 17/18 handlers upstream; the patch adds the one
  it leaves to GModule (`gtk_widget_hide_on_delete`) so the real app autoconnects
  fully, and adds a display-free `--selftest` (a `GtkTextBuffer` `.ui` signal:
  register → `connect_signals` → emit → assert the handler fired through fpcast).
  Gate: `node demo/node/widget-factory-smoke.mjs` matches `/WIDGET-FACTORY-SELFTEST:
  .* OK/` (`buf=1 connected_no_gmodule=1 handler_ran=1 major=3`). The full window
  **RENDERS in the browser** (complete widget showcase, Adwaita theme) once the
  /dev/shm mount + musl `__unmapself` + 1.75 GiB RAM fixes are in.

**`nix.wasm` link/build (`nix-wasm.nix`):**
- `-DBOOST_STACKTRACE_USE_NOOP` (Nix's crash handler pulls unimplementable
  `_Unwind_Backtrace`); `dontUseMesonConfigure` (the meson hook ran a native
  configure first); patch out llhttp's `#if defined(__wasm__)` JS-host-callback
  block (dead/wrong when embedded). The meson `-r` prelink can't emit wasm TLS
  relocs → the custom `.o` link (a real wasm limit; see Architecture).
- **`nuke-refs` the closure** (`nixWasmClean`): `nix.wasm` embeds dead build-path
  refs (openssl/boost-dev/json → transitively native glibc + locales) that balloon
  the served closure to ~258 MB / 18k files; strip them post-build.
- **sqlite `-DSQLITE_OMIT_WAL -DSQLITE_THREADSAFE=0`**: WAL's `-shm` shared-memory
  file is unsupported on the NOMMU guest fs → `SQLITE_IOERR` on the store DB.

**Guest runtime / kernel:**
- **No fork/vfork — clone-with-fn only.** A fresh wasm instance can't resume the
  parent mid-function → `fork()`/`vfork()` SIGILL/abort. Everything that "spawns"
  (busybox, ash, `make`, nix's external `sh` builder) goes through `posix_spawn` /
  clone-with-fn; this is why busybox + ash carry the clone-with-fn patches.
- **9P read-only mounts MUST be `cache=loose,ignoreqv`** (`bootstrap.nix`). Default
  `cache=none` → netfs *unbuffered* reads → `get_user_pages` on the user buffer
  (unsupported on NOMMU/wasm) → `rc=-14`. Loose = buffered page-cache + `copy_to_user`.
- **`/dev/shm` MUST be mounted (ramfs) for GTK/wl_shm clients** (`bootstrap.nix`).
  gdk's wayland backend allocates each window's `wl_shm` buffer via
  `open_shared_memory()` → `memfd_create()` (ENOSYS on the wasm kernel) →
  `shm_open("/dev/shm/…")` fallback; with `/dev/shm` unmounted that fails ENOENT →
  `create_shm_pool` returns NULL → an empty **0×0** window + a per-frame
  `Gdk-CRITICAL` in `_gdk_wayland_display_create_shm_surface` (looks like a render
  crash but is a missing mount). Use **ramfs**, NOT tmpfs: ramfs has explicit NOMMU
  `MAP_SHARED` mmap support (`fs/ramfs/file-nommu.c`) — the same backing `/tmp` uses
  (proven by `wl-anim`'s `mkstemp` shm path) — whereas shmem/tmpfs lacks reliable
  shared-writable mmap on NOMMU. With the mount, `gtk-hello` renders a real window
  ("Hello, GTK on wasm!"); same fix unblocks galculator/widget-factory (identical
  gdk shm path). Rebuilds only the initramfs. (`memfd_create` is still ENOSYS — a
  future kernel could implement it as the more standard primary path.)
- **Detached-thread exit needs a wasm `__unmapself`** (`patches/musl/0008`). A
  DETACHED pthread that exits runs musl `__pthread_exit` → `__unmapself`, whose
  generic path does a native stack-pointer switch (`CRTJMP`) to `munmap` its own
  stack — but the wasm arch stubs `CRTJMP(pc,sp)` to `abort()` → SIGILL (exit 132).
  GLib **GThreadPool** workers (gdk-pixbuf/GTask, so any non-trivial GTK app like
  gtk3-widget-factory) are detached threads, so they crashed on exit; gtk-hello has
  no threads and never hit it. Fix: on wasm, `__unmapself` does `munmap`+`exit`
  inline (no stack switch) — safe because NOMMU `munmap` does NOT invalidate the
  wasm linear-memory bytes the C shadow stack occupies. Validated by
  `.#pthread-exit-test` (spawn+exit 16 detached threads). A musl change → world
  rebuild (musl → stdenv → all guest binaries relink). SAME class as the libffi /
  futex / fpcast wasm-can't-do-native-asm theme.
- **Guest RAM = 1.75 GiB for large GTK windows** (`kernel.nix`
  `CONFIG_BOOT_MEM_PAGES 0x7000`). A GTK app mapping a large window allocates an
  **order-11 (8 MB) GFP_HIGHUSER** `wl_shm` buffer; after the served `/nix` closure
  + glib/gdk init fragment the NOMMU buddy heap below 8 MB, that mmap fails
  (`page allocation failure: order:11`) → no window (gtk3-widget-factory). More RAM
  keeps order-11 blocks whole. MUST stay **under `0x8000` (2 GiB)** — setup.c
  positive-address limit. vmlinux-only rebuild; same NOMMU contiguous-mmap class as
  the 1 GiB bump for the 57 MB clang exec.
- **User stack 8 KiB→4 MiB** (`patches/kernel/0007`): musl `realpath()` alone
  overflows 8 KiB and NOMMU can't grow the stack (was both the "readlink -f
  corrupts long paths" bug and the nix.wasm startup "memory access out of bounds").
  4 MiB (not 8) so the alloc fits an order-11 buddy block.
- **Single-user nix** (`userspace/system.nix`): `build-users-group = ""` +
  `filter-syscalls = false` (no seccomp on wasm) — either otherwise aborts `nix-env`.
- **`store-manifest` splits large files into lazy `store-content/<sha256>` blobs**
  so the ~113 MB toolchain fetches on first exec, not at boot.

**Dead-ends — do NOT retry:**
- `crossSystem.hasSharedLibraries = false` — too aggressive; sqlite eval abort.
- `stdenvAdapters.makeStaticLibraries` — doesn't compose with our
  `replaceCrossStdenv` (`dontAddStaticConfigureFlags` → `null` → eval error).
- Unscoped overlay overrides — poison `buildPackages` (see the `isWasm` guard above).
- `nixos-26.05` pin *locally on aarch64* — triggers from-source LLVM (the aarch64
  cache lacks the exact build). 26.05 is the right pin for **x86_64 CI** only.
- Minimal per-dep derivations — see PRIME DIRECTIVE corollary 1.

**Environment:**
- Pin: `nixos-unstable` @ `9ae611a` (LLVM **21.1.8**); CI should prefer
  `nixos-26.05` (same clang-21.1.8, fully cached on x86_64).
- aarch64 cache lags x86_64 and lacks heavy builds → first local build compiles
  LLVM from source (~1–2 h, then cached locally). Hence corollary 3.
- Known-good oracle: `~/lwbuild/ws/install/*-wasm32_nommu` (read-only; validate
  against it, never rebuild it here).

## Plans & future work

Phases 1–4 of the "NixOS in wasm" vision are done (toolchain → userspace →
guest-clang/cc → kernel); the code + this file + git history are the record.
Remaining work and design notes live as GitHub issues, not in-repo plan files:

- **#2** — Phase 5: CI + binary cache (build wasm outputs on x86_64, guest
  substitutes). The last phase; see the Caching design goal above.
- **#3** — retire the `cc`/`c++` shell wrappers by making `clang`/`clang++`
  their own driver for the wasm target (config file / custom ToolChain), gated on
  whether LLVM's linker spawn uses `posix_spawn` on the NOMMU port.
- **#1** — `nix profile install` rejects the `outPath`-only guest index (use
  `nix-env -iA`); fix folds into #2.

(The executed per-task plans — toolchain, userspace, kernel-nixify, guest-shell
forkshell-ash — the rationale/master-plan docs, and the detailed STATUS log were
removed once done; the code, this file, and git history are the record.)
