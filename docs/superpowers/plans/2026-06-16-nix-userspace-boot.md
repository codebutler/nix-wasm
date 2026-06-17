# Nix Userspace Boot (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot the Nix-generated guest userspace from a *real* `wasm-system` closure served read-only over 9P (overlaid with a ramfs upper) until `nix-env -iA sl && sl` renders — replacing the hand-written `pc-init` with a Nix-built initramfs.

**Architecture:** "NixOS without systemd," modeled on busyrc (busybox-init + Nix-generated inittab with `/run/current-system/sw/bin` paths), NixNG (generated activation + run-in-place, no `switch_root`), and not-os (thin initrd, reuse of `etc.nix`). `nix-wasm` builds three guest artifacts — `.#wasm-system` (closure: generated `/etc` symlink tree, profile-path inittab, generated `activate` script, system profile, busybox `init`), `.#wasm-initramfs` (cpio: `cross.busybox` + a generated thin `/init`), and `.#wasm-store-manifest` (the closure exported as a JSON manifest pc can serve at real store paths). The thin `/init` mounts pseudofs + the 9P exports, overlays the served store (9p-ro lower + ramfs upper) → `/nix`, runs `$sys/activate`, then `exec $sys/init`. `pc` gains one new host module (`createNixClosureStore`, serving the real closure preserving real store paths + symlinks), vendors the nix-built cpio, deletes `pc-init`, and wires `nixStore`. `boot.js` is unchanged.

**Tech Stack:** Nix (wasm32 crossSystem), busybox, overlayfs-on-9P (NOMMU, ramfs upper), JS 9P server + MemVfs (symlinks via `type:"alias"`).

**The boundary (why each piece lives where):** code that runs *in the guest* lives in `nix-wasm` (kernel, `/etc`, inittab, activation, `/init`); code that runs *in the browser host* lives in `pc` (`boot.js`, 9P server, kernel host/worker, the closure-store backend). `pc` only ever *vendors + boots* guest artifacts — exactly as it already does for `vmlinux.wasm` (`.#kernel`).

**Divergences from stock NixOS (all constraint-driven, all with precedent), accepted at planning time:** (1) `/nix` served read-only over 9P + ramfs-upper overlay instead of a disk store — the project's caching design goal, standard overlayfs; (2) run-in-place, no `switch_root` — NixNG model, forced by NOMMU + ramfs root; (3) curated `lib.evalModules` + stub module instead of `eval-config.nix` — NixNG-equivalent, forced because activation/systemd can't run on NOMMU; (4) static `passwd`/`group` — single-user non-goal; (5) terminfo trimmed to one entry — size only.

**Testing note (read before starting):** This is Nix-derivation + integration work, not classic unit-testable code. For Phase A, each task's "test" is a `nix build` that must succeed plus an assertion on the output (inspect the store path). For Phase B's `createNixClosureStore`, there are real JS unit tests (`bun test`). The single end-to-end acceptance test is the in-guest boot (Task B4): `sl` renders. Run all `nix` commands as:
```sh
export NIX_CONFIG="experimental-features = nix-command flakes"
echo <sudo-pw> | sudo -S nix build .#<attr> --no-link --print-out-paths
```
(`sudo -E` is ignored on this host; pipe the password per-call — see agent memory. Do NOT run a `nix` status check against a live build — the eval cache is one SQLite db and races "database is busy.")

---

## File Structure

**nix-wasm (guest artifacts):**
- `userspace/init.nix` (MODIFY) — inittab → `/run/current-system/sw/bin` paths; drop FHS paths + the autologin copy.
- `userspace/system.nix` (MODIFY) — add the `autologin` package to the profile; add `/usr/bin` + `/opt/bin` to `/etc/profile` PATH (guest-tool seam).
- `userspace/activate.nix` (CREATE) — the generated activation script (`$sys/activate`): setup-etc symlink tree, `/run/current-system`, mutable dirs.
- `userspace/toplevel.nix` (MODIFY) — assemble the closure: `etc` + `sw` + `init` + `activate`; rewrite the boot contract comment.
- `userspace/bootstrap.nix` (CREATE) — the thin `/init` script (mount + overlay + activate + guest-tool glue + exec).
- `userspace/initramfs.nix` (CREATE) — the cpio derivation (busybox + `/init` + `/bin/sh`).
- `userspace/store-manifest.nix` (CREATE) — export the closure as `store.json` (+ the `var/nix/profiles/system` profile symlink) for pc to serve.
- `flake.nix` (MODIFY) — wire the new files; expose `.#wasm-initramfs`, `.#wasm-store-manifest`.

**pc (host + vendored artifacts):**
- `js/linux/nix-closure-store.js` (CREATE) — `createNixClosureStore(manifestUrl)`: serve the real closure (files + symlinks) preserving real store paths.
- `js/linux/nix-closure-store.test.js` (CREATE) — unit tests.
- `js/linux/kernel-service.js` (MODIFY) — create + pass `nixStore`.
- `vendor/linux-wasm/initramfs.cpio.gz` (REPLACE) — the nix-built cpio.
- `vendor/linux-wasm/store.json[.gz]` (CREATE) — the vendored closure manifest.
- `vendor/linux-wasm/pc-init` (DELETE).
- `vendor/linux-wasm/build.sh` (MODIFY) — drop `install_pc_init` + the initramfs packing; document that the kernel/initramfs/manifest now come from `nix-wasm`.

---

# Phase A — nix-wasm guest artifacts

Phase A is independently buildable and testable (every task ends in a `nix build`). Phase B consumes only two Phase-A outputs: the cpio (`.#wasm-initramfs`) and the manifest (`.#wasm-store-manifest`).

### Task A1: inittab → profile-absolute paths; autologin becomes a profile package

**Files:**
- Modify: `userspace/init.nix`
- Modify: `userspace/system.nix:78-113` (the config module — add the `autologin` package + PATH)

**Why:** The current inittab uses FHS paths (`/sbin/getty`, `/bin/autologin`), which is *exactly* what forces `busybox --install` + the autologin copy in the bootstrap. busyrc's pattern is profile-absolute paths (`/run/current-system/sw/bin/...`), which makes both go away. `getty`/`login`/`syslogd` are busybox applets present in the system profile (`system.path` links `busybox/bin`); `autologin` is a custom script, so it must be delivered *as a package in the profile* to live at `/run/current-system/sw/bin/autologin`.

- [ ] **Step 1: Rewrite `userspace/init.nix` to emit only the inittab, with profile paths.**

```nix
# PID 1 inittab for the wasm guest: busybox `init` reads this. One
# getty->autologin->ash chain per hvc console, plus a file-backed syslogd. All
# program paths are PROFILE-ABSOLUTE (/run/current-system/sw/bin) — busybox's
# applets (getty/login/syslogd/init/sh) and our autologin package all live in
# the system profile, so the guest needs NO `busybox --install` and NO FHS-path
# population. This is the busyrc pattern (systemd-free NixOS prior art).
#
# nrConsoles MUST match the kernel's HVC_WASM_NR_CONSOLES and the JS host's
# HVC_CONSOLES (both 8). Changing it here without the others desyncs consoles.
{ lib, pkgs, nrConsoles ? 8 }:
let
  sw = "/run/current-system/sw/bin";
  # getty passes `xterm-256color` as the termtype so TERM is correct from login
  # on (the pc terminal is Ghostty/xterm-compatible; busybox's bare default
  # vt102 is wrong). -L local line, -i skip issue, -n skip login-name prompt,
  # -l <prog> exec autologin instead of /bin/login. baud 0 = keep line speed.
  consoleLines = lib.concatMapStringsSep "\n"
    (i: "hvc${toString i}::respawn:${sw}/getty -L -i -n -l ${sw}/autologin 0 hvc${toString i} xterm-256color")
    (lib.range 0 (nrConsoles - 1));
in
pkgs.writeText "inittab" ''
  ::respawn:${sw}/sh -c '${sw}/syslogd -n -O /var/log/messages -s 16 -b 1; sleep 5'
  ${consoleLines}
''
```

- [ ] **Step 2: In `userspace/system.nix`, define the `autologin` package and add it to the profile.** In the final config module (the `({ lib, pkgs, ... }: ...)` block, near `terminfoMin`), add:

```nix
        # autologin: getty's `-l` execs this instead of /bin/login (single-user
        # guest, passwordless root). Shipped as a PROFILE package so it resolves
        # at /run/current-system/sw/bin/autologin (no FHS copy). Shebang /bin/sh
        # = the busybox sh baked in the initramfs (persists run-in-place).
        autologin = pkgs.writeTextFile {
          name = "autologin";
          executable = true;
          destination = "/bin/autologin";
          text = ''
            #!/bin/sh
            exec /run/current-system/sw/bin/login -f root
          '';
        };
```

- [ ] **Step 3: Add `autologin` to `environment.systemPackages` and extend the profile PATH.** Change the `environment.systemPackages = lib.mkForce [ ... ]` list to include `autologin`, and update `environment.etc."profile".text`:

```nix
        environment.systemPackages = lib.mkForce [
          pkgs.busybox    # init, ash (the guest shell), coreutils + getty/login/syslogd applets
          terminfoMin     # terminfo for the one supported terminal
          autologin       # /run/current-system/sw/bin/autologin (inittab references it)
        ];
```

```nix
        # /etc/profile: busybox ash sources it as a login shell. PATH order:
        # the nix user profile (nix-env -iA'd pkgs run by name), the system
        # profile, the guest-tool seam (/usr/bin + /opt/bin — the host-provided
        # `nix`/`clang` shims the bootstrap links; NOT part of the Nix system),
        # then the baked initramfs /bin,/sbin. Then source set-environment
        # (TERM, TERMINFO_DIRS) which ash does not auto-source.
        environment.etc."profile".text = ''
          export PATH=/root/.nix-profile/bin:/run/current-system/sw/bin:/usr/bin:/opt/bin:/bin:/sbin
          [ -r /etc/set-environment ] && . /etc/set-environment
        '';
```

- [ ] **Step 4: Build the inittab and assert profile paths.**

Run: `echo <pw> | sudo -S nix build .#wasm-system --no-link --print-out-paths` (this evaluates the whole closure incl. the new init.nix/system.nix; flake wiring is updated in Task A7, so until then build the leaf: `nix eval --raw -f userspace/init.nix` won't work standalone — instead verify in Task A7's build). For now, lint the eval:
Run: `echo <pw> | sudo -S nix eval --impure --expr 'let f = import ./userspace/init.nix; in builtins.typeOf f'`
Expected: `"lambda"` (the file parses).

- [ ] **Step 5: Commit.**

```bash
git add userspace/init.nix userspace/system.nix
git commit -m "userspace: inittab profile-absolute paths + autologin as a profile package"
```

### Task A2: the generated activation script (`userspace/activate.nix`)

**Files:**
- Create: `userspace/activate.nix`

**Why:** In NixOS, stage-2 runs `$systemConfig/activate` (creating `/etc`, `/run/current-system`, mutable dirs) *before* exec'ing PID1. We reproduce that: a Nix-generated script in the closure, run by the thin `/init` before `exec $sys/init`. `/etc` is a per-file symlink tree with the `/etc/static` indirection — the exact `setup-etc.pl` pattern, in shell (no perl). `/bin/sh` is NOT created here — it is baked into the initramfs and persists (run-in-place). Mutable dirs are created here (the tmpfiles role; not-os does the same imperatively).

- [ ] **Step 1: Create `userspace/activate.nix`.**

```nix
# The guest activation script ($sys/activate), generated by Nix and run by the
# thin /init AFTER the store overlay is mounted and BEFORE `exec $sys/init`
# (busybox init). This is the NixOS stage-2 activation role, systemd-free:
#   - /run/current-system + sw  (the profile indirection inittab/profile use)
#   - /etc  = a per-file symlink tree with /etc/static indirection (setup-etc.pl
#            pattern, in shell): each $sys/etc/<f> -> /etc/static/<f> -> store.
#   - mutable runtime dirs (/var/log, /var/run, /tmp, /root) + utmp/wtmp (the
#     tmpfiles role; login(1) records sessions into utmp, wtmp is never auto-made)
# Takes the system path as $1 (the thin /init passes it). /bin/sh is NOT made
# here — it is baked into the initramfs and persists (run-in-place, no switch_root).
#
# writeText, NOT writeShellScript: writeShellScript embeds a bash store-path
# shebang, and `cross.bash` is the NATIVE host bash (deps-overlay maps
# bash/runtimeShell -> buildPackages), which drags native bash+glibc (~50MB,
# verified) into the guest closure. The thin /init runs this as
# `sh "$sys/activate" "$sys"`, so the shebang is cosmetic; busybox ash honours
# `set -eu`. (BUILD-CONFIRMED: writeShellScript -> 70MB closure; writeText -> 2.4MB.)
{ pkgs }:
pkgs.writeText "activate" ''
  #!/bin/sh
  set -eu
  sys="$1"

  # Profile indirection: inittab + /etc/profile reference /run/current-system/sw.
  mkdir -p /run
  ln -sfn "$sys" /run/current-system
  # $sys/sw -> the system profile (system.path); see toplevel.nix.

  # /etc as a symlink tree (NixOS setup-etc pattern). /etc/static -> the store
  # etc dir (atomic-switch indirection); each entry -> /etc/static/<name>.
  mkdir -p /etc
  ln -sfn "$sys/etc" /etc/static
  for f in "$sys"/etc/*; do
    name=$(basename "$f")
    ln -sfn "/etc/static/$name" "/etc/$name"
  done

  # Mutable runtime state (cannot live in the immutable store).
  mkdir -p /var/log /var/run /tmp /root
  : > /var/run/utmp
  : > /var/log/wtmp
''
```

> NOTE for the implementer: `pkgs.writeShellScript` here uses the wasm `cross` shell only as the `#!` — but this script is interpreted by the guest's busybox `sh` at runtime, not executed as a cross binary at build. To keep the shebang correct for the guest, the thin `/init` invokes it as `sh "$sys/activate" "$sys"` (Task A4 Step 1) rather than relying on the writeShellScript shebang. The `writeShellScript` wrapper is fine because we re-invoke via `sh`; if a future reviewer prefers, swap to `pkgs.writeText "activate"` with a literal `#!/bin/sh` first line. Either is acceptable; the plan uses `writeShellScript` for the `set -eu` safety it injects.

- [ ] **Step 2: Verify it parses.**
Run: `echo <pw> | sudo -S nix eval --impure --expr 'builtins.typeOf (import ./userspace/activate.nix)'`
Expected: `"lambda"`.

- [ ] **Step 3: Commit.**
```bash
git add userspace/activate.nix
git commit -m "userspace: generated activation script (setup-etc + mutable dirs)"
```

### Task A3: assemble the closure (`userspace/toplevel.nix`)

**Files:**
- Modify: `userspace/toplevel.nix`

**Why:** The closure dir is the guest system. It must expose `etc/` (the module-generated etc + our static passwd/group + the profile-path inittab), `sw` (the system profile, the inittab/profile target), `init` (busybox, the entrypoint), and `activate` (Task A2). The autologin copy and the `busybox --install` contract are GONE (autologin is now in the profile; inittab uses profile paths).

- [ ] **Step 1: Rewrite `userspace/toplevel.nix`.**

```nix
# The guest system closure in boot layout. Host-built; SERVED read-only into the
# guest /nix store over 9P (overlay lowerdir) by pc's createNixClosureStore.
#
# Boot-layout CONTRACT (what the thin /init does — see nix-wasm initramfs):
#   1. mount pseudofs + the 9P exports; overlay the served store -> /nix.
#   2. sys=$(readlink -f /nix/var/nix/profiles/system)   # this closure
#   3. sh "$sys/activate" "$sys"   # setup-etc tree, /run/current-system, mut dirs
#   4. exec "$sys/init"            # busybox init (basename `init` -> init applet),
#                                  # reads /etc/inittab (profile-absolute paths)
# No `busybox --install`, no /bin/autologin copy, no blanket /etc symlink: the
# inittab references /run/current-system/sw/bin/{getty,login,syslogd,autologin},
# all present in `sw` (system.path); /etc is a per-file symlink tree (activate).
# nrConsoles=8 is baked into inittab — keep kernel HVC_WASM_NR_CONSOLES and host
# HVC_CONSOLES in lockstep (see init.nix).
{ pkgs, etc, systemPath, passwd, group, inittab, activate }:
pkgs.runCommand "wasm-system" { } ''
  mkdir -p $out
  # Real /etc = module-generated etc + our static passwd/group + profile inittab.
  # Preserve the store symlinks inside etc (resolved in-guest, /nix mounted).
  cp -a ${etc}/etc $out/etc
  chmod -R u+w $out/etc
  cp ${passwd} $out/etc/passwd
  cp ${group} $out/etc/group
  cp ${inittab} $out/etc/inittab
  ln -s ${systemPath} $out/sw
  ln -s ${activate} $out/activate
  # init entrypoint: busybox (the thin /init execs $out/init; basename `init`).
  ln -s ${pkgs.busybox}/bin/busybox $out/init
''
```

- [ ] **Step 2:** (build deferred to Task A7, which wires the new args.)

- [ ] **Step 3: Commit.**
```bash
git add userspace/toplevel.nix
git commit -m "userspace: closure layout for profile-path boot (drop install/autologin-copy contract)"
```

### Task A4: the thin `/init` bootstrap (`userspace/bootstrap.nix`)

**Files:**
- Create: `userspace/bootstrap.nix`

**Why:** This is the irreducible bootstrap — the only guest code that must exist *before* the store is reachable (chicken-and-egg). It mounts pseudofs + the 9P exports, overlays the served store → `/nix`, runs activation, wires the host-provided guest tools (`nix`), then execs the closure's init. It is GENERATED by Nix and baked into the initramfs (Task A5) — `pc` authors none of it. The overlay upper is ramfs (NOMMU has no tmpfs); the lower is the read-only 9P store.

- [ ] **Step 1: Create `userspace/bootstrap.nix`.**

```nix
# The thin initramfs /init for the wasm guest, GENERATED by Nix and baked into
# .#wasm-initramfs. It is the only hand-shaped guest code, and it is irreducible:
# it must mount the served /nix store before anything in the store is reachable.
# Roles: mount pseudofs + pc's 9P exports, overlay the read-only served store
# with a ramfs upper -> /nix, run the closure's activation, link the host-
# provided guest `nix` onto PATH (the guest-tool seam — NOT the Nix system),
# then exec the closure's init. Run-in-place: no switch_root (NOMMU; the
# initramfs ramfs stays the root, so the baked /bin/sh persists).
#
# 9P: trans=cb -> net/9p/trans_cb.c -> the JS 9P server. msize 512K = the kernel
# transport cap (P9_CB_MAXSIZE). Exports (boot.js): "/"=pc VFS, tools, nixcache,
# nix=the served wasm-system closure (createNixClosureStore).
{ pkgs }:
pkgs.writeText "init" ''
  #!/bin/sh
  # busybox is on /bin (baked); call applets via PATH.
  export PATH=/bin:/sbin

  mount -t proc none /proc
  mount -t sysfs none /sys
  mount -t devtmpfs none /dev 2>/dev/null
  mkdir -p /dev/pts && mount -t devpts none /dev/pts 2>/dev/null

  M="trans=cb,version=9p2000.L,msize=524288"

  # pc's VFS (user files) at /mnt/pc.
  mkdir -p /mnt/pc
  mount -t 9p -o "$M,aname=/" cb /mnt/pc 2>/dev/null || echo "pc: /mnt/pc 9p mount failed"

  # Host-provided large guest tools (nix.wasm, clang, …), lazy + read-only.
  mkdir -p /opt/bin
  mount -t 9p -o "$M,aname=tools" cb /opt/bin 2>/dev/null || true

  # Nix binary cache (substituter for `nix-env -iA`), read-only.
  mkdir -p /nix-cache
  mount -t 9p -o "$M,aname=nixcache" cb /nix-cache 2>/dev/null || true

  # The served wasm-system closure: real /nix store paths, read-only (9p) ->
  # overlay lower; ramfs upper makes /nix writable for nix-env. NOMMU has no
  # tmpfs, so the upper is ramfs (always available, backs the initramfs root).
  mkdir -p /mnt/nix-ro /run/nix-upper /run/nix-work /nix
  if mount -t 9p -o "$M,aname=nix" cb /mnt/nix-ro 2>/dev/null; then
    mount -t overlay overlay \
      -o lowerdir=/mnt/nix-ro,upperdir=/run/nix-upper,workdir=/run/nix-work /nix \
      || { echo "pc: /nix overlay failed; falling back to ramfs /nix"; mkdir -p /nix/store; }
  else
    echo "pc: served store not mounted; booting empty ramfs /nix"
    mkdir -p /nix/store
  fi

  # Resolve + activate the system, then guest-tool seam, then hand off to init.
  sys=$(readlink -f /nix/var/nix/profiles/system 2>/dev/null)
  if [ -n "$sys" ] && [ -e "$sys/init" ]; then
    sh "$sys/activate" "$sys"

    # Guest-tool seam (host-provided binaries, NOT the Nix system): expose the
    # nix multi-call entry points (dispatch on argv[0]) on /usr/bin, on PATH via
    # /etc/profile. /opt/bin is a read-only 9p mount, so link into writable /usr/bin.
    mkdir -p /usr/bin
    if [ -e /opt/bin/nix ]; then
      for t in nix nix-env nix-build nix-store nix-shell nix-instantiate nix-channel nix-collect-garbage; do
        ln -sf /opt/bin/nix "/usr/bin/$t"
      done
      [ -e /opt/bin/make ] && ln -sf /opt/bin/make /usr/bin/make
      [ -e /opt/bin/clang ] && ln -sf /opt/bin/clang /usr/bin/clang
      [ -e /opt/bin/wasm-ld ] && ln -sf /opt/bin/wasm-ld /usr/bin/wasm-ld
      [ -e /opt/bin/cc ] && { cp /opt/bin/cc /usr/bin/cc 2>/dev/null && chmod +x /usr/bin/cc; }
    fi
    # nix-env default expr from the cache index (resolves `nix-env -iA <name>`).
    [ -f /nix-cache/pkgs.nix ] && cp /nix-cache/pkgs.nix /root/.nix-defexpr 2>/dev/null || true

    echo "pc: booting Nix userspace from $sys"
    exec "$sys/init"
  fi

  echo "pc: no Nix system found at /nix/var/nix/profiles/system — dropping to a shell"
  exec /bin/sh
''
```

- [ ] **Step 2: Verify it parses.**
Run: `echo <pw> | sudo -S nix eval --impure --expr 'builtins.typeOf (import ./userspace/bootstrap.nix)'`
Expected: `"lambda"`.

- [ ] **Step 3: Commit.**
```bash
git add userspace/bootstrap.nix
git commit -m "userspace: generated thin /init (mount + overlay served store + activate + exec)"
```

### Task A5: the initramfs cpio (`userspace/initramfs.nix`)

**Files:**
- Create: `userspace/initramfs.nix`

**Why:** `pc` boots `initramfs.cpio.gz`. It must contain the generated `/init` (Task A4), a busybox to run it, and all applet symlinks the initramfs `/init` + `activate` use (`sh`, `mount`, `mkdir`, `ln`, `readlink`, `basename`, `cp`, `chmod`, `echo`, …) — the initrd's own toolset (like NixOS stage-1's extraUtils), NOT the runtime `busybox --install` anti-pattern we removed. **We do NOT run `busybox --install`**: a wasm32 busybox can't execute on the x86 build host. Instead we `cp -a` `cross.busybox/bin/.` — nixpkgs busybox already ships the complete set of applet symlinks (relative → `busybox`) in its `$out/bin`, so a recursive copy gives the binary + every applet, deterministically and with no guest execution. `/bin/sh` comes along in that copy (it persists run-in-place for `#!/bin/sh` shebangs — the one FHS path NixOS keeps). The cpio is packed with native `cpio`/`gzip` (host tools archiving guest files).

- [ ] **Step 1: Create `userspace/initramfs.nix`.**

```nix
# .#wasm-initramfs — the guest initramfs.cpio.gz, built by Nix (replaces pc's
# build.sh initramfs path). Contents: the generated /init (bootstrap.nix) + the
# cross-built busybox and its full applet symlink set (the initrd's own toolset,
# baked at build — NOT the runtime busybox --install we deleted). newc cpio +
# gzip, the format the kernel's initramfs loader expects.
#
# `cross` is the wasm guest pkg set (busybox is a guest binary); native cpio/gzip
# come from `pkgs` (host tools that just archive the guest files).
#
# We DON'T run `busybox --install`: a wasm32 busybox can't exec on the x86 host.
# nixpkgs busybox already ships every applet as a RELATIVE symlink (-> busybox)
# in $out/bin, so `cp -a` of that dir gives the real binary + all applets +
# /bin/sh, deterministically and without executing any guest code.
{ pkgs, cross, init }:
pkgs.runCommand "wasm-initramfs"
  {
    nativeBuildInputs = [ pkgs.cpio pkgs.gzip ];
  }
  ''
    root=$(mktemp -d)
    mkdir -p "$root/bin" "$root/sbin" "$root/proc" "$root/sys" "$root/dev" \
             "$root/mnt" "$root/nix" "$root/run" "$root/etc" "$root/root" "$root/tmp"

    # busybox binary + its complete applet symlink set (relative -> busybox).
    cp -a ${cross.busybox}/bin/. "$root/bin/"
    # /bin/sh is among them; ensure it exists even if a future busybox drops it.
    [ -e "$root/bin/sh" ] || ln -sf busybox "$root/bin/sh"

    # the generated /init (entrypoint; kernel cmdline init=/init).
    cp ${init} "$root/init"
    chmod +x "$root/init"

    # mktemp -d creates the root 0700; an initramfs / must be traversable.
    chmod 0755 "$root"

    # pack newc cpio + gzip. --owner=0:0 records root:root (the build runs as an
    # unprivileged nixbld user; without it every entry carries the builder uid
    # and the kernel unpacks the initramfs verbatim).
    mkdir -p $out
    ( cd "$root" && find . -print0 \
        | cpio --null -o --format=newc --owner=0:0 --quiet ) \
        | gzip -9 > $out/initramfs.cpio.gz
  ''
```

> NOTE: `cp -a` preserves the relative applet symlinks (`ls`→`busybox`, etc.) and copies `busybox` itself as a real file (the store ships it as a real binary, not a symlink), so the initramfs `/bin` is fully self-contained before `/nix` is mounted. If `cross.busybox/bin` unexpectedly does NOT contain the applet symlinks (verify with `ls -la $(nix path-info .#... )` during the A7 build), fall back to an explicit relative-symlink loop over the applets the bootstrap/activate need: `for a in sh mount mkdir ln readlink basename cp chmod echo cat; do ln -sf busybox "$root/bin/$a"; done` (still no guest exec). Report which path was used.

- [ ] **Step 2:** (build deferred to Task A7.)

- [ ] **Step 3: Commit.**
```bash
git add userspace/initramfs.nix
git commit -m "userspace: nix-built initramfs.cpio.gz (busybox + generated /init)"
```

### Task A6: export the closure as a manifest (`userspace/store-manifest.nix`)

**Files:**
- Create: `userspace/store-manifest.nix`

**Why:** `pc` must serve the *real* closure at *real* store paths (its `createNixStore` can't — it re-hashes with a synthetic scheme). We export the full runtime closure of the toplevel as a single JSON manifest describing every entry (dir / file+base64+exec-bit / symlink+target) at its real `/nix/...` path, plus the `var/nix/profiles/system` profile symlink the bootstrap reads. `pkgs.closureInfo` gives the path list; a python pass emits the JSON. (Eager/base64 is the simple first cut; a lazy/binary format is a later optimization — log the size.)

- [ ] **Step 1: Create `userspace/store-manifest.nix`.**

```nix
# .#wasm-store-manifest — the wasm-system closure exported as store.json for pc's
# createNixClosureStore to serve at REAL store paths (overlay lowerdir). Format:
#   { "store/<hash>-name/...": {t:"d"} | {t:"f",x:bool,d:"<base64>"} | {t:"l",to:"<target>"} , ... ,
#     "var/nix/profiles/system": {t:"l", to:"store/<hash>-wasm-system"} }
# Keys are RELATIVE to /nix (pc mounts the export at /nix). Includes the full
# runtime closure (busybox, ncurses, terminfo, etc) so /run/current-system/sw
# and the /etc symlink tree resolve in-guest.
{ pkgs, toplevel }:
let
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "wasm-store-manifest"
  { nativeBuildInputs = [ pkgs.python3 ]; }
  ''
    mkdir -p $out
    python3 ${./store-manifest.py} \
      "${closure}/store-paths" "${toplevel}" "$out/store.json"
    # report size (eager base64 is the first cut; optimize to lazy/binary later).
    echo "store.json: $(du -h $out/store.json | cut -f1)"
  ''
```

- [ ] **Step 2: Create `userspace/store-manifest.py`** (referenced above):

```python
import base64, json, os, sys

store_paths_file, toplevel, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
NIX = "/nix/"
entries = {}

def rel(p):
    # /nix/store/xxx/... -> store/xxx/...
    assert p.startswith(NIX), p
    return p[len(NIX):]

with open(store_paths_file) as f:
    paths = [l.strip() for l in f if l.strip()]

for sp in paths:
    # the store dir itself
    entries[rel(sp)] = {"t": "d"}
    for root, dirs, files in os.walk(sp):
        for d in dirs:
            full = os.path.join(root, d)
            if os.path.islink(full):
                entries[rel(full)] = {"t": "l", "to": os.readlink(full)}
            else:
                entries[rel(full)] = {"t": "d"}
        for fn in files:
            full = os.path.join(root, fn)
            if os.path.islink(full):
                entries[rel(full)] = {"t": "l", "to": os.readlink(full)}
            else:
                with open(full, "rb") as fh:
                    data = fh.read()
                entries[rel(full)] = {
                    "t": "f",
                    "x": bool(os.stat(full).st_mode & 0o111),
                    "d": base64.b64encode(data).decode("ascii"),
                }

# the system profile symlink the bootstrap reads.
entries["var/nix/profiles/system"] = {"t": "l", "to": rel(os.path.realpath(toplevel))}

with open(out_file, "w") as f:
    json.dump(entries, f)
```

> NOTE: `os.walk` does not recurse INTO symlinked dirs (good — symlinks are recorded as `l` entries with their raw target; the target store path is itself in `store-paths` and walked independently). Symlink targets are stored verbatim (absolute `/nix/store/...` or relative) — `createNixClosureStore` (Task B1) returns them as-is via `Treadlink`, and the guest kernel resolves them against the mounted `/nix`. Confirm in Task B4 that `system.path`'s relative symlinks resolve in-guest; if absolute-vs-relative causes a miss, normalize here.

- [ ] **Step 3:** (build deferred to Task A7.)

- [ ] **Step 4: Commit.**
```bash
git add userspace/store-manifest.nix userspace/store-manifest.py
git commit -m "userspace: export wasm-system closure as store.json (real paths + symlinks)"
```

### Task A7: wire everything into the flake and build it

**Files:**
- Modify: `flake.nix:50-62, 95-140` (the `wasm*` lets + `packages` set — exact lines per the current file)

**Why:** Connect the new/changed leaves and expose the two outputs Phase B consumes.

- [ ] **Step 1: Update the `let` bindings in `flake.nix`.** Replace the `wasmInit`/`wasmToplevel` block with:

```nix
      wasmSystem = import ./userspace/system.nix { inherit nixpkgs cross; };
      wasmPasswd = import ./userspace/passwd.nix {
        lib = cross.lib; pkgs = cross; config = wasmSystem.config;
      };
      wasmInittab = import ./userspace/init.nix { lib = cross.lib; pkgs = cross; };
      wasmActivate = import ./userspace/activate.nix { pkgs = cross; };
      wasmToplevel = import ./userspace/toplevel.nix {
        pkgs = cross;
        etc = wasmSystem.config.system.build.etc;
        systemPath = wasmSystem.config.system.path;
        passwd = wasmPasswd.passwd;
        group = wasmPasswd.group;
        inittab = wasmInittab;
        activate = wasmActivate;
      };
      wasmBootstrap = import ./userspace/bootstrap.nix { pkgs = cross; };
      wasmInitramfs = import ./userspace/initramfs.nix {
        inherit pkgs cross; init = wasmBootstrap;
      };
      wasmStoreManifest = import ./userspace/store-manifest.nix {
        inherit pkgs; toplevel = wasmToplevel;
      };
```

> NOTE: `initramfs.nix` takes BOTH `pkgs` (native cpio/gzip) and `cross` (guest busybox). Confirm the flake has a native `pkgs` and the wasm `cross` in scope at this point (it does — `cross` is used just above for `wasmSystem`; `pkgs` is the native host set used elsewhere for `runCommand`).

- [ ] **Step 2: Expose the outputs in `packages.${system}`.** Add:

```nix
        wasm-system = wasmToplevel;
        wasm-initramfs = wasmInitramfs;
        wasm-store-manifest = wasmStoreManifest;
```

(Keep the existing `userspace-etc`/`userspace-path`/`userspace-passwd` debug attrs.)

- [ ] **Step 3: Build the closure.**
Run: `echo <pw> | sudo -S nix build .#wasm-system --no-link --print-out-paths`
Expected: a `/nix/store/...-wasm-system` path. Inspect: `ls -la <path>` shows `etc/ sw init activate`; `cat <path>/etc/inittab` shows `/run/current-system/sw/bin/getty ... -l /run/current-system/sw/bin/autologin ...` (NO `/sbin/getty`); `ls <path>/sw/bin/autologin` exists.

- [ ] **Step 4: Build the initramfs.**
Run: `echo <pw> | sudo -S nix build .#wasm-initramfs --no-link --print-out-paths`
Expected: a path with `initramfs.cpio.gz`. Verify: `zcat <path>/initramfs.cpio.gz | cpio -tv 2>/dev/null | grep -E ' (init|bin/sh|bin/busybox)$'` lists all three.

- [ ] **Step 5: Build the manifest.**
Run: `echo <pw> | sudo -S nix build .#wasm-store-manifest --no-link --print-out-paths`
Expected: a path with `store.json`; the build log prints its size. Verify: `python3 -c "import json;d=json.load(open('<path>/store.json'));print(len(d));print(d['var/nix/profiles/system'])"` prints the entry count and the profile symlink → `store/...-wasm-system`.

- [ ] **Step 6: Assert no systemd/perl/python in the closure (the litmus).**
Run: `echo <pw> | sudo -S nix path-info -r .#wasm-system 2>/dev/null | grep -Ei 'systemd|-perl-|python3-' || echo "CLEAN"`
Expected: `CLEAN`.

- [ ] **Step 7: Commit.**
```bash
git add flake.nix
git commit -m "flake: wire .#wasm-system/.#wasm-initramfs/.#wasm-store-manifest"
```

---

# Phase B — pc: serve the real closure, vendor, boot

Phase B depends only on Phase A's `.#wasm-initramfs` and `.#wasm-store-manifest`. Work happens in the `pc` repo (branch `linux-wasm-cleanup`).

### Task B1: `createNixClosureStore` — serve the real closure

**Files:**
- Create: `js/linux/nix-closure-store.js`
- Test: `js/linux/nix-closure-store.test.js`

**Why:** The existing `createNixStore` re-hashes packages (synthetic paths) and can't serve a real closure with internal cross-references. This new backend fetches the Task-A6 `store.json` and builds a `MemVfs` preserving REAL store paths, with symlinks as `type:"alias"` records (the 9P server already maps those to `QT.SYMLINK` + `Treadlink`). Read-only (EROFS on mutation), same VFS surface (`stat/list/readBlob`) as `createNixStore`/`createGuestTools`.

- [ ] **Step 1: Write the failing test.** `js/linux/nix-closure-store.test.js`:

```js
import { describe, test, expect } from "bun:test";
import { createNixClosureStore } from "./nix-closure-store.js";

// A tiny fake manifest server: createNixClosureStore takes a manifestUrl, so we
// pass a data: URL (fetch supports it) carrying the JSON.
function manifestUrl(obj) {
  return "data:application/json," + encodeURIComponent(JSON.stringify(obj));
}
const b64 = (s) => Buffer.from(s).toString("base64");

describe("createNixClosureStore", () => {
  test("serves files, dirs, and symlinks at real store paths", async () => {
    const store = await createNixClosureStore(manifestUrl({
      "store/abc-foo": { t: "d" },
      "store/abc-foo/bin": { t: "d" },
      "store/abc-foo/bin/hello": { t: "f", x: true, d: b64("#!/bin/sh\necho hi\n") },
      "var/nix/profiles/system": { t: "l", to: "store/abc-foo" },
    }));

    // file contents (mounted at /nix -> export root, so "/store/.." is "/nix/store/..")
    const blob = await store.readBlob("/store/abc-foo/bin/hello");
    expect(new TextDecoder().decode(blob)).toContain("echo hi");

    // dir listing
    const ls = await store.list("/store/abc-foo/bin");
    expect(ls.map((r) => r.name)).toContain("hello");

    // symlink: stat is a symlink, readlink returns the target
    const st = await store.stat("/var/nix/profiles/system");
    expect(st.type).toBe("alias");
    expect(st.target).toBe("store/abc-foo");
  });

  test("is read-only (EROFS on write)", async () => {
    const store = await createNixClosureStore(manifestUrl({ "store/x": { t: "d" } }));
    await expect(store.write("/store/x/y", new Uint8Array())).rejects.toThrow(/EROFS/);
  });
});
```

- [ ] **Step 2: Run it; verify it fails.**
Run: `cd ~/Code/pc && bun test js/linux/nix-closure-store.test.js`
Expected: FAIL — `createNixClosureStore` not found.

- [ ] **Step 3: Implement `js/linux/nix-closure-store.js`.**

```js
// nix-closure-store.js — a read-only /nix 9P backend that serves a REAL Nix
// closure at its REAL store paths (unlike nix-store.js, which re-hashes with a
// synthetic scheme). Built from the Task-A6 store.json manifest:
//   { "<relpath-under-/nix>": {t:"d"} | {t:"f",x,d:<base64>} | {t:"l",to:<target>} }
// Mounted by the guest as aname=nix and used as an overlay lowerdir; the symlink
// forest (system.path, the /etc tree, the toplevel) resolves because MemVfs
// records symlinks as type:"alias" and the 9P server answers Treadlink (server.js).
import { MemVfs } from "./ninep/mem-vfs.js";

function erofs(op) {
  const e = new Error("EROFS: " + op + " on a read-only store");
  // @ts-ignore — server.js maps .code -> Linux errno
  e.code = "EROFS";
  return e;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {string} manifestUrl URL of the Task-A6 store.json.
 * @returns {Promise<any>} a read-only VFS (stat/list/readBlob; EROFS mutations)
 *   whose tree is rooted at /nix (export root). `storePaths` lists the top-level
 *   /nix/store/<...> dirs created.
 */
export async function createNixClosureStore(manifestUrl) {
  const r = await fetch(manifestUrl);
  if (!r.ok) throw new Error("nix-closure-store: HTTP " + r.status + " for " + manifestUrl);
  /** @type {Record<string, {t:string,x?:boolean,d?:string,to?:string}>} */
  const manifest = await r.json();

  // Seed a MemVfs directly via its write primitives, preserving real paths.
  // MemVfs records: folder | alias(target) | file(bytes). We build under "/".
  const fs = new MemVfs();
  const storePaths = [];
  // ensure parent dirs exist before children — sort by depth (shallow first).
  const keys = Object.keys(manifest).sort(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
  );
  for (const rel of keys) {
    const e = manifest[rel];
    const path = "/" + rel; // export root maps to /nix in-guest
    if (e.t === "d") {
      fs.mkdirSync ? fs.mkdirSync(path) : fs._writeSync(path, { type: "folder" });
      if (/^store\/[^/]+$/.test(rel)) storePaths.push("/nix/" + rel);
    } else if (e.t === "l") {
      fs._writeSync(path, { type: "alias", target: e.to });
    } else if (e.t === "f") {
      fs._writeSync(path, {
        type: "file",
        bytes: b64ToBytes(e.d || ""),
        mime: "application/octet-stream",
        // executable bit: server.js derives mode from the record; carry x.
        executable: !!e.x,
      });
    }
  }

  return {
    stat: (p) => fs.stat(p),
    list: (p) => fs.list(p),
    readBlob: (p) => fs.readBlob(p),
    async write() { throw erofs("write"); },
    async mkdir() { throw erofs("mkdir"); },
    async remove() { throw erofs("remove"); },
    async rename() { throw erofs("rename"); },
    async symlink() { throw erofs("symlink"); },
    storePaths,
  };
}
```

> NOTE — verify MemVfs's write primitives before finalizing: the test will tell you whether `MemVfs` exposes `_writeSync(path, record)` and auto-creates parents, and whether the file record uses `bytes` + `executable` (read `js/linux/ninep/mem-vfs.js:71-160` — the `from`/`_writeSync` paths and how `server.js:219` derives mode/exec from the record). If `_writeSync` is not the right entry point, build the nested tree object (folders as objects, files as byte arrays, aliases as `{type:"alias",target}`) and pass it to `MemVfs.from(tree)` instead — `from` is the public seed API. If the server derives the exec bit from a `mode` field rather than `executable`, set `mode: e.x ? 0o755 : 0o644`. Make the test pass; match the actual MemVfs/server contract.

- [ ] **Step 4: Run the test; iterate until green.**
Run: `cd ~/Code/pc && bun test js/linux/nix-closure-store.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit.**
```bash
cd ~/Code/pc
git add js/linux/nix-closure-store.js js/linux/nix-closure-store.test.js
git commit -m "linux: createNixClosureStore — serve a real Nix closure at real store paths"
```

### Task B2: wire `nixStore` into the boot

**Files:**
- Modify: `js/linux/kernel-service.js:124-141` (the `ensureBooted` body)

**Why:** `boot.js` already registers `opts.nixStore` as the `nix` 9P export — it just isn't passed. Create the closure store from the vendored manifest and pass it.

- [ ] **Step 1: Add the import + URL near the other `*_URL` consts** (top of `kernel-service.js`, beside `CC_SYSROOT_URL`):

```js
import { createNixClosureStore } from "./nix-closure-store.js";
const STORE_MANIFEST_URL = new URL("../../vendor/linux-wasm/store.json", import.meta.url).href;
```

- [ ] **Step 2: Create + pass `nixStore` in `ensureBooted`.** Just before `bootPromise = bootLinux({`:

```js
    const nixStore = await createNixClosureStore(STORE_MANIFEST_URL);
```
and add `nixStore,` to the `bootLinux({ ... })` options object (beside `guestTools, nixCache,`).

> NOTE: `ensureBooted` is currently synchronous-ish (returns `bootPromise`). Awaiting the manifest fetch makes it async — wrap the `createNixClosureStore` + `bootLinux` in an async IIFE assigned to `bootPromise`, or make `ensureBooted` async and `await` it at the one call site (`openConsole` already `await`s `ensureBooted()`). Keep the single-flight `if (bootPromise) return bootPromise` guard.

- [ ] **Step 3: Typecheck/lint.**
Run: `cd ~/Code/pc && bun run typecheck && bun run lint`
Expected: no new errors.

- [ ] **Step 4: Commit.**
```bash
cd ~/Code/pc
git add js/linux/kernel-service.js
git commit -m "linux: boot with the served wasm-system closure as the /nix export"
```

### Task B3: vendor the nix-built artifacts; delete `pc-init`

**Files:**
- Replace: `vendor/linux-wasm/initramfs.cpio.gz`
- Create: `vendor/linux-wasm/store.json`
- Delete: `vendor/linux-wasm/pc-init`
- Modify: `vendor/linux-wasm/build.sh` (drop `install_pc_init` + initramfs packing)

**Why:** `pc` consumes guest artifacts; it no longer builds them. Same model as `vmlinux.wasm` (already `.#kernel`).

- [ ] **Step 1: Copy the nix-built artifacts into the vendor dir.**
```bash
cd ~/Code/nix-wasm
INITRD=$(echo <pw> | sudo -S nix build .#wasm-initramfs --no-link --print-out-paths)
MAN=$(echo <pw> | sudo -S nix build .#wasm-store-manifest --no-link --print-out-paths)
cp "$INITRD/initramfs.cpio.gz" ~/Code/pc/vendor/linux-wasm/initramfs.cpio.gz
cp "$MAN/store.json"          ~/Code/pc/vendor/linux-wasm/store.json
```

- [ ] **Step 2: Delete `pc-init`.**
```bash
cd ~/Code/pc && git rm vendor/linux-wasm/pc-init
```

- [ ] **Step 3: Remove `install_pc_init` and the initramfs packing from `build.sh`.** Delete the `install_pc_init()` function (the `cp "$HERE/pc-init" ...` block) and its call inside `build_userspace`; replace the `build-initramfs` step + cpio copy with a comment that the initramfs + kernel + manifest are now produced by `nix-wasm` (`.#wasm-initramfs`, `.#kernel`, `.#wasm-store-manifest`) and vendored. Keep musl/busybox source builds only if still used elsewhere; if `build_userspace` exists solely to pack the initramfs, reduce it to an echo pointing at `nix-wasm`.

> NOTE: read `build.sh` around `install_pc_init` (≈line 325), `build_userspace` (≈line 330-365), and `repack_initramfs` (≈line 664-672) and the `usage`/dispatch (≈line 700-722). Remove the `initramfs` subcommand path or repoint it to "copy from nix-wasm". Do not break the other subcommands (`toolchain`, `kernel`, `llvm-src`, …) — only the initramfs/userspace path changes.

- [ ] **Step 4: Commit.**
```bash
cd ~/Code/pc
git add vendor/linux-wasm/initramfs.cpio.gz vendor/linux-wasm/store.json vendor/linux-wasm/build.sh
git commit -m "linux-wasm: vendor nix-built initramfs + store manifest; delete pc-init"
```

### Task B4: end-to-end boot — `sl` renders (acceptance)

**Files:** none (verification).

**Why:** The whole point. Boot the Nix userspace, confirm the generated activation/inittab/init work, the served closure overlays correctly, and a package installs + renders.

- [ ] **Step 1: Boot to a shell.** Run the project's in-guest boot harness (the same one used for the overlay verification — a foreground bun+playwright run with an adequate timeout; kill zombie bun processes first if a prior run left any). Confirm: hvc0 reaches a login → autologin root → shell prompt; `cat /proc/mounts` shows the `overlay` on `/nix`; `ls -la /etc/passwd` is a symlink → `/etc/static/passwd` → the store.

- [ ] **Step 2: Confirm the environment.** In-guest: `echo $PATH` includes `/run/current-system/sw/bin`; `echo $TERM` = `xterm-256color`; `getty`/`sh` resolve under `/run/current-system/sw/bin`. Confirm there was NO `busybox --install` step (no full `/bin` applet forest beyond the baked initramfs set).

- [ ] **Step 3: Install + render.** In-guest: `nix --version`; `nix-env -iA sl` (or the two-step `nix copy` + `nix-env` if NOMMU 9P memory pressure bites — that's the documented reliable path); then `sl`. Expected: the train renders correctly (no terminfo/TERM garbage) — this closes the loop that started the whole redesign.

- [ ] **Step 4: Fallback check.** Boot with no `nix` export registered (or point the harness at a config without `nixStore`): confirm the bootstrap prints "no Nix system found" and drops to a shell rather than panicking.

- [ ] **Step 5: Push both repos.**
```bash
cd ~/Code/nix-wasm && git push origin master
cd ~/Code/pc && git push origin linux-wasm-cleanup
```

---

## Self-Review (completed at authoring)

**Spec coverage** (against `docs/superpowers/specs/2026-06-16-nix-userspace-design.md` + the research):
- Generated inittab, profile-absolute paths, no `busybox --install` → A1. ✓
- Generated activation (setup-etc tree, mutable dirs) → A2. ✓
- Closure layout / boot contract → A3. ✓
- Thin generated `/init` in `nix-wasm`, baked into the initramfs (the agreed boundary) → A4, A5. ✓
- Serve the REAL closure over 9P + overlay (the chosen "serve now" option) → A6, B1, B2. ✓
- `/etc` per-file symlink tree (NixOS pattern, not blanket symlink) → A2. ✓
- `/bin/sh` baked, persists run-in-place (NixOS keeps only `/bin/sh`) → A5. ✓
- `pc` owns only host code; vendors guest artifacts; `pc-init` deleted → B3. ✓
- Acceptance `sl` renders → B4. ✓

**Known risk flags (surfaced, not hidden):**
1. `cross.busybox --install -s` on the host (A5) may fail if the host can't exec the guest busybox → explicit symlink-loop fallback documented.
2. `MemVfs` write-primitive contract (B1) — exact API (`_writeSync` vs `MemVfs.from`, `executable` vs `mode`) verified by the unit test; NOTE documents both.
3. Symlink target absolute-vs-relative resolution in-guest (A6/B4) — confirm `system.path`'s relative links resolve; normalize in the python pass if not.
4. Manifest is eager base64 (~closure size) — fine for first boot; lazy/binary is a logged future optimization, not a blocker.
5. `nix-env -iA sl` under NOMMU 9P memory pressure — two-step `nix copy` + `nix-env` is the documented reliable fallback (orthogonal kernel issue).

**Placeholder scan:** none — every code step has complete content; the `NOTE`s point at real files to verify an external contract, not at unwritten code.

**Type/name consistency:** `createNixClosureStore(manifestUrl)` (B1) ↔ called in B2; `store.json` key schema (`t`/`x`/`d`/`to`) identical in A6 (emit) and B1 (consume); `var/nix/profiles/system` produced in A6, read in A4.
