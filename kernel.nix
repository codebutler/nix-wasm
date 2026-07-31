# The wasm guest kernel: vmlinux.wasm, built reproducibly from the pinned
# joelseverin/linux source (the out-of-tree wasm Linux arch port) with stock
# clang-21 + the kernel-only patched wasm-ld (GNU linker-script support), via
# the fake-llvm-equivalent wrappers in kernelCC.
#
# This is the Nix port of pc's build.sh `build_kernel`: configure
# (wasm32_nommu_defconfig + the host-integration toggles), `make … vmlinux`,
# then `cp build/vmlinux $out/vmlinux.wasm` (wasm-ld emits the .wasm directly —
# no ELF->wasm step). The 6 kernel patches are pc's host-integration set (9p
# trans_cb, hvc multi-console + winsize, single-CPU pin, 16K stack, force-max-
# order). The config toggle list mirrors build.sh `configure_kernel()`: NET + 9P
# + the host-callback transport, devtmpfs (for /dev/hvcN), POSIX file locking,
# the stack-end canary (#118), a 128MB buddy max order (#139 — NOMMU exec needs
# the whole binary in one contiguous allocation), PLUS CONFIG_OVERLAY_FS (Plan 2:
# read-only served /nix store + ramfs upper; see the toggle comment below).
#
# It is the NEW exec ABI (039e5f3e: wasm_create_and_run_task / wasm_load_
# executable / wasm_release_task / wasm_serialize_tasks; NO wasm_exec_*), and it
# BOOTS + execs userspace with the forward-ported JS runtime (pc commit
# c6a33dbd: kernel-worker.js/kernel-host.js compile the user binary directly
# from the kernel memory range the new ABI passes).
{ pkgs, kernelSrc, kernelCC, mmu ? false, a2 ? false, debugTrace ? false }:
pkgs.stdenv.mkDerivation {
  pname = if a2 then "vmlinux-wasm-mmu-a2" else if mmu then "vmlinux-wasm-mmu" else "vmlinux-wasm";
  version = "7.0-039e5f3e";

  src = kernelSrc;

  patches = [
    # NOTE: the bespoke hvc_wasm console backend (formerly patches 0002/0003) is
    # RETIRED (issue #83). The guest console is now the stock virtio-console
    # driver (CONFIG_VIRTIO_CONSOLE, patch 0019) over 8 single-port virtio-console
    # devices; CONFIG_HVC_WASM is disabled in configurePhase below so the first
    # virtio-console device owns hvc0.
    ./patches/kernel/0004-wasm-pin-user-tasks-single-cpu.patch
    ./patches/kernel/0005-wasm-enlarge-kernel-stack.patch
    ./patches/kernel/0006-wasm-force-max-order.patch
    # User stack 8KiB->8MiB: the 8KiB stack overflowed on a single musl realpath()
    # (8KiB of buffers) and crashed nix at startup; NOMMU stacks can't grow.
    ./patches/kernel/0007-wasm-enlarge-user-stack.patch
    # Toolchain flags moved INTO the kernel source (replacing the fake-llvm argv
    # shim): arch/wasm/Makefile carries the wasm cc + LDFLAGS_vmlinux flags, and
    # three small generic-kbuild guards drop what wasm-ld/llvm-objcopy reject
    # (--build-id/-z noexecstack, --start-group, --set-section-flags/symbol-strip).
    ./patches/kernel/0008-wasm-arch-toolchain-flags.patch
    ./patches/kernel/0009-wasm-skip-buildid-noexecstack.patch
    ./patches/kernel/0010-wasm-link-vmlinux-no-group.patch
    ./patches/kernel/0011-wasm-strip-relocs-section-only.patch
    ./patches/kernel/0012-wasm-vmlinux-o-no-group.patch
    # Wayland Phase 1 (1a): a minimal virtio transport over Wasm host callbacks
    # (drivers/virtio/virtio_wasm.c) + an in-kernel echo self-test that proves
    # the guest<->host vring round-trip AND host->guest used-buffer interrupt
    # delivery via raise_interrupt(). Enabled by CONFIG_VIRTIO_WASM below.
    ./patches/kernel/0013-wasm-virtio-wasm-transport.patch
    # Wayland (idle wake): export wasm_raised_irqs_ptr(cpu) so the JS host can
    # deliver a virtio used-buffer interrupt to a FULLY IDLE guest by replicating
    # raise_interrupt() (OR irq bit + memory.atomic.notify on raised_irqs[cpu])
    # directly on shared memory from the main thread — the owning Worker is parked
    # in arch_cpu_idle()'s wait64 and can't run JS to service an unsolicited event.
    ./patches/kernel/0014-wasm-export-raised-irqs-ptr.patch
    # futex_time64 (422) is the generic 6-arg sys_futex, but userspace invokes it
    # with 4 args (glib's g_cond/g_mutex via g_futex_simple, FUTEX_WAIT/WAKE) →
    # the strictly-typed wasm call_indirect traps on the arity mismatch. A 4-arg
    # sys_wasm32_futex trampoline (mirroring the sys_wasm32_* u64-split overrides)
    # forwards to sys_futex with the requeue args zeroed. Unblocks glib (M3a/GTK).
    ./patches/kernel/0015-wasm-futex-time64-4arg-trampoline.patch
    # !MMU: a read-only MAP_SHARED file mmap (e.g. libxkbcommon's XKB rules,
    # SQLite mmap, fontconfig) has nothing to share-write, so satisfy it with a
    # private copy when the backing (9p / the served Nix store) can't be mapped
    # directly, instead of failing with -ENODEV. File mmap then works like a
    # normal system — the correct shared fix, NOT a per-package workaround.
    ./patches/kernel/0016-wasm-nommu-ro-shared-mmap-copy.patch
    # Squashfs/virtio-blk spike (#43 Task 1): register VW_DEV_BLK (index 3) on
    # the wasm virtio transport so CONFIG_VIRTIO_BLK can drive a squashfs image
    # served via a host-side virtio-blk device (VIRTIO_ID_BLOCK = 2).
    ./patches/kernel/0017-wasm-virtio-blk-device.patch
    # Issue #10 (host<->guest bridge consolidation onto virtio): register
    # virtio-9p channels (VIRTIO_ID_9P = 9) on the wasm virtio transport so the
    # stock mainline 9P-over-virtio transport (CONFIG_NET_9P_VIRTIO) can carry
    # the guest's filesystem mounts, replacing the bespoke trans_cb SAB-ring
    # transport. VW_DEV_9P_ROOT (4, tag "pcroot") + VW_DEV_9P_NIXCACHE (5, tag
    # "nixcache"); the host serves the tag/feature (runtime/virtio/ninep-device.js).
    ./patches/kernel/0018-wasm-virtio-9p-device.patch
    # Issue #10 (option 2) / #83: register a virtio-console device
    # (VIRTIO_ID_CONSOLE = 3) on the wasm virtio transport so the stock mainline
    # virtio-console driver (CONFIG_VIRTIO_CONSOLE) carries the guest's consoles.
    # This is now the SOLE console path (the bespoke hvc_wasm backend is retired):
    # the transport registers 8 featureless single-port virtio-console devices
    # (VW_DEV_CONSOLE_BASE..+8, host idx 8..15; the host serves each via
    # runtime/virtio/console-device.js), so the stock driver registers hvc0..hvc7
    # SYNCHRONOUSLY at probe (one per pc Terminal window). Single-port (not
    # multiport) because multiport adds its ports async via the control vq, which
    # races init to death on single-CPU wasm boot.
    ./patches/kernel/0019-wasm-virtio-console-device.patch
    # Issue #10 option 3 (the vsock piece): register a virtio-vsock device
    # (VIRTIO_ID_VSOCK = 19) on the wasm virtio transport so the stock mainline
    # virtio-vsock transport (CONFIG_VIRTIO_VSOCKETS riding CONFIG_VSOCKETS)
    # gives the guest→host /Ctl desktop-control bridge a standard AF_VSOCK
    # socket channel. VW_DEV_VSOCK is pinned to host index 7; the host serves
    # the guest CID + drives the rx/tx/event vqs (runtime/virtio/vsock-device.js).
    ./patches/kernel/0020-wasm-virtio-vsock-device.patch
    # #75: a SIGALRM handler installed with SA_RESTART (busybox ping via signal())
    # was never delivered when it interrupted a blocking syscall — the C restart
    # loop in WASM_SYSCALL_N re-entered the syscall before the asm FOOT could run
    # the queued handler, so the syscall hung (one packet then hang). Fix: lift
    # the restart loop to the asm FOOT (entry.S) — deliver the queued handler at
    # the FOOT (the only safe context) and then re-invoke the syscall, so the
    # restart happens AFTER the handler (transparent SA_RESTART, real replies, no
    # -EINTR). In-kernel change only — no host/engine ABI change.
    ./patches/kernel/0021-wasm-sa-restart-deliver-signal.patch
    # #94: !MMU ramfs can't re-mmap a GROWN file — it allocates one contiguous
    # block at first-map time (size==0) and a later grow only truncate_setsize()s,
    # so mmap() of the grown file fails -ENODEV. libwayland-cursor's cursor-theme
    # wl_shm pool grows as cursors load, so every cursor after the first grow
    # failed ("Unable to load <name> from the cursor theme"). Fix: on a grow of an
    # inode set up for shared mmap, re-allocate a larger contiguous block and copy
    # the data across (only marked inodes; ordinary ramfs growth is unaffected).
    ./patches/kernel/0022-wasm-nommu-ramfs-regrow-shared-mmap.patch
    # Issue #145 (guest audio): register a virtio-snd device (VIRTIO_ID_SOUND =
    # 25) on the wasm virtio transport so the stock mainline virtio-snd driver
    # (sound/virtio/, CONFIG_SND_VIRTIO) gives the guest a sound card —
    # /dev/snd/* appears and ALSA userspace (alsa-lib, libcanberra) works
    # unmodified. VW_DEV_SND is pinned to host index 6 (the previously-unused
    # slot between the 9P channels and vsock); the host serves the stream
    # counts + drives the control/event/tx/rx vqs (runtime/virtio/snd-device.js:
    # one s16 48kHz playback stream, capture out of scope).
    ./patches/kernel/0027-wasm-virtio-snd-device.patch
    # Boot-time wall clock: implement read_persistent_clock64 off the engine's
    # existing wasm_cpu_clock_get_monotonic import (epoch-anchored:
    # performance.timeOrigin + performance.now() ns). Without it CLOCK_REALTIME
    # boots at the 1970 epoch and TLS breaks — every certificate is "not yet
    # valid" (curl 60), so the guest's Cachix substitution fails right after the
    # CA-bundle fix exposed real verification. No new import → no ENGINE_ABI
    # bump; the epoch anchoring of the import is now load-bearing (documented in
    # the patch + at the formula in runtime/kernel-worker.js). Gated by
    # clock-smoke.mjs.
    ./patches/kernel/0028-wasm-persistent-clock.patch
    # #177 (installed NixOS persistence): second virtio-blk at host index 1
    # (VW_DEV_BLK_STATE — reclaims the echo self-test slot) for the RW state
    # disk (/dev/vdb). Seed squashfs stays at VW_DEV_BLK=3 (/dev/vda).
    # ENGINE_ABI 12.
    ./patches/kernel/0029-wasm-virtio-blk-state-device.patch
  ] ++ pkgs.lib.optionals mmu [
    # #128 Track A: the CONFIG_MMU=y software-MMU arch layer (applied last).
    ./patches/kernel/0023-wasm-software-mmu.patch
    # #129 Track B: real fork() on the MMU foundation — wasm_fork_current +
    # fork_ctl plumbing through switch_stack/wasm_create_and_run_task
    # (ENGINE_ABI 10). COW isolation needs the A2 checked translate; the A1
    # (populate-everything, unchecked) build carries the export but a fork
    # there would write through shared pages — fork is exercised under a2.
    ./patches/kernel/0026-wasm-mmu-fork.patch
  ] ++ pkgs.lib.optionals a2 [
    # #128 A2: drop the A1 full-populate so the checked translate demand-pages.
    ./patches/kernel/0024-wasm-mmu-a2-demand-paging.patch
  ] ++ pkgs.lib.optionals debugTrace [
    # #128 A2 DEBUG: bounded printk trace of the __wasm_mmu_fault path.
    ./patches/kernel/0025-mmu-debug-trace.patch
  ];

  # Guard against silent patch-fuzz corruption of the virtio device enum (the #84
  # nix:true boot regression). Patches 0017-0020 each insert into the same enum +
  # virtio_wasm_transport_init() regions; `patch`'s fuzzy matching can mis-apply a
  # stacked hunk WITHOUT failing the build — which is exactly what dropped the
  # VW_DEV_9P_ROOT/9P_NIXCACHE virtio_wasm_register() calls. Assert the post-patch
  # source is correct; runs in patchPhase (minutes), so a re-fuzz fails fast and
  # loud instead of producing a subtly-broken kernel.
  #
  # Layout (issue #83 + #177): WL=0, BLK_STATE=1 (RW state disk), NET=2,
  # BLK=3 (seed), 9P_ROOT=4, 9P_NIXCACHE=5, SND=6, VSOCK=7, then 8 single-port
  # virtio-console devices at VW_DEV_CONSOLE_BASE=8..15. The console
  # registrations are a `for (i<8) virtio_wasm_register_cfg(VW_DEV_CONSOLE_BASE
  # + i, …)` loop, so the assertion checks VW_DEV_CONSOLE_BASE (the enum + the
  # loop), not a per-device VW_DEV_CONSOLE call.
  postPatch = ''
    vw=drivers/virtio/virtio_wasm.c
    echo "== virtio_wasm.c device enum (post-patch) =="
    awk '/^enum \{/{f=1} f{print} f&&/VW_DEV_COUNT/{exit}' "$vw"
    echo "== virtio_wasm_register() calls (post-patch) =="
    grep -nE 'virtio_wasm_register(_cfg)?\(VW_DEV_' "$vw" || true

    # 1) Every non-console device the host serves MUST keep its registration call.
    for d in VW_DEV_BLK VW_DEV_BLK_STATE VW_DEV_9P_ROOT VW_DEV_9P_NIXCACHE VW_DEV_SND VW_DEV_VSOCK; do
      grep -q "virtio_wasm_register($d," "$vw" || {
        echo "ERROR: $vw is missing virtio_wasm_register($d, …) — a kernel patch" \
             "(0017-0020, 0027, 0029) applied with fuzz and dropped a device registration." >&2
        exit 1
      }
    done
    # Echo self-test MUST be gone from the registration path (slot reclaimed).
    if grep -q 'virtio_wasm_register(VW_DEV_ECHO,' "$vw"; then
      echo "ERROR: VW_DEV_ECHO is still registered — patch 0029 should reclaim it" \
           "for VW_DEV_BLK_STATE." >&2
      exit 1
    fi
    # The 8 single-port consoles register via a VW_DEV_CONSOLE_BASE + i loop,
    # using the config-irq-aware variant (terminal resize).
    grep -qE 'virtio_wasm_register_cfg\(VW_DEV_CONSOLE_BASE \+ i,' "$vw" || {
      echo "ERROR: $vw is missing the VW_DEV_CONSOLE_BASE + i console registration" \
           "loop — patch 0019 (console) applied with fuzz." >&2
      exit 1
    }
    # The console resize path (patch 0013): the config-change irq handler + the
    # pinned config-irq base must survive a fuzzy apply, or resize silently dies.
    grep -q 'vw_config_interrupt' "$vw" || {
      echo "ERROR: $vw is missing vw_config_interrupt — patch 0013 config-change" \
           "handler dropped (terminal resize would break)." >&2
      exit 1
    }
    grep -qE 'VW_CONSOLE_CONFIG_IRQ_BASE[[:space:]]+24' "$vw" || {
      echo "ERROR: VW_CONSOLE_CONFIG_IRQ_BASE is not pinned to 24 in $vw" \
           "(must match CONSOLE_CONFIG_IRQ_BASE in runtime/virtio/console-device.js)." >&2
      exit 1
    }

    # 2) Enum order must be ...9P_NIXCACHE(5) < VSOCK(7) < CONSOLE_BASE(8) < COUNT so
    #    the indices match runtime/virtio/console-device.js (CONSOLE_BASE=8) +
    #    kernel-host.js/kernel-worker.js (VW_DEV_VSOCK=7). A fuzzy apply that puts
    #    CONSOLE_BASE before VSOCK is rejected.
    enum=$(awk '/^enum \{/{f=1} f{print} f&&/VW_DEV_COUNT/{exit}' "$vw")
    con=$(printf '%s\n' "$enum" | grep -n 'VW_DEV_CONSOLE_BASE\b' | head -1 | cut -d: -f1)
    vso=$(printf '%s\n' "$enum" | grep -n 'VW_DEV_VSOCK\b' | head -1 | cut -d: -f1)
    if [ -n "$con" ] && [ -n "$vso" ] && [ "$vso" -ge "$con" ]; then
      echo "ERROR: virtio device enum has VW_DEV_CONSOLE_BASE before VW_DEV_VSOCK" \
           "(fuzzy patch apply). VSOCK must be index 7, CONSOLE_BASE index 8." >&2
      exit 1
    fi
    # 3) The explicit pinned indices must match the host engine constants.
    grep -qE 'VW_DEV_BLK_STATE[[:space:]]*=[[:space:]]*1,' "$vw" || {
      echo "ERROR: VW_DEV_BLK_STATE is not pinned to 1 in $vw (must match" \
           "VW_DEV_BLK_STATE in runtime/kernel-worker.js — patch 0029?)" >&2
      exit 1; }
    grep -qE 'VW_DEV_NET[[:space:]]*=[[:space:]]*2,' "$vw" || {
      echo "ERROR: VW_DEV_NET is not pinned to 2 in $vw" >&2; exit 1; }
    grep -qE 'VW_DEV_BLK[[:space:]]*=[[:space:]]*3,' "$vw" || {
      echo "ERROR: VW_DEV_BLK is not pinned to 3 in $vw" >&2; exit 1; }
    grep -qE 'VW_DEV_SND[[:space:]]*=[[:space:]]*6,' "$vw" || {
      echo "ERROR: VW_DEV_SND is not pinned to 6 in $vw (must match VW_DEV_SND in" \
           "runtime/kernel-worker.js / kernel-host.js — patch 0027 applied with fuzz?)" >&2
      exit 1; }
    grep -qE 'VW_DEV_VSOCK[[:space:]]*=[[:space:]]*7,' "$vw" || {
      echo "ERROR: VW_DEV_VSOCK is not pinned to 7 in $vw" >&2; exit 1; }
    grep -qE 'VW_DEV_CONSOLE_BASE[[:space:]]*=[[:space:]]*8,' "$vw" || {
      echo "ERROR: VW_DEV_CONSOLE_BASE is not pinned to 8 in $vw" >&2; exit 1; }
    echo "virtio_wasm.c device enum + registrations OK (blk/blk-state/9P/snd/vsock/8-console present, order correct)"

    # ---- #179 hardening: a host-REJECTED exec image kills the task, not the kernel ----
    #
    # The engine hands the exec'd image to the host at start_thread() ->
    # wasm_load_executable(). If the host cannot run it — e.g. the software-MMU
    # instrumentation pass refuses a binary that does not export __get_tls_base
    # (nix-wasm#179) — the old contract had no way to say so: the JS threw, the
    # rejection surfaced LATER from the promise chain via raise_exception() with no
    # kernel context, and make_task_dead() panicked the whole guest with
    # "Aiee, killing interrupt handler!". One unsupported user binary took down the
    # system.
    #
    # Fix: wasm_load_executable now RETURNS a status (0 = loaded, nonzero =
    # rejected) and start_thread checks it. We are past begin_new_exec() here, so
    # -ENOEXEC is no longer reachable (bprm's point of no return has passed) — the
    # correct Linux response is to kill THIS task, exactly as bprm_execve() does
    # for a late load_binary failure. Skipping _TIF_RELOAD_PROGRAM is the
    # load-bearing half: the engine holds no image, so asking it to reload would
    # crash it instead.
    #
    # WIRE COMPATIBILITY (why this is NOT an ENGINE_ABI bump): only the RETURN TYPE
    # of an existing import changes, no import is added or removed. New kernel +
    # old engine: the JS returns undefined, which ToWebAssemblyValue coerces to 0
    # for an i32 result => "loaded", i.e. exactly today's behaviour. Old kernel +
    # new engine: the import is declared () -> () so wasm discards the returned
    # status => also today's behaviour. Compatible in both directions.
    #
    # Done as substituteInPlace, NOT a patch hunk: patches 0023/0026 already
    # rewrite this very region of process.c (and only under mmu/a2), so a stacked
    # hunk here is exactly the silent fuzzy-apply hazard documented for 0017-0020.
    # Each --replace-fail below is config-INDEPENDENT (it matches text 0023/0026
    # leave alone) and fails the build loudly if the upstream text ever drifts.
    substituteInPlace arch/wasm/include/asm/wasm.h \
      --replace-fail 'extern void wasm_load_executable(' \
                     'extern int wasm_load_executable('

    substituteInPlace arch/wasm/kernel/process.c \
      --replace-fail '#include <linux/printk.h>' \
                     '#include <linux/printk.h>
#include <linux/sched/signal.h>'

    # `wasm_exec_status` is file-scope because under CONFIG_MMU patch 0023 wraps
    # the call in its own `{ … }` block, so a local would not be visible at the
    # check below. Safe: the store and the load are ADJACENT statements of the same
    # start_thread() invocation with no scheduling point between them (and the wasm
    # arch pins user tasks to a single CPU).
    substituteInPlace arch/wasm/kernel/process.c \
      --replace-fail 'void start_thread(struct pt_regs *regs, unsigned long stack_pointer)' \
                     '/* #179: status of the last wasm_load_executable() — see kernel.nix postPatch. */
static int wasm_exec_status;

void start_thread(struct pt_regs *regs, unsigned long stack_pointer)'

    substituteInPlace arch/wasm/kernel/process.c \
      --replace-fail 'wasm_load_executable(current->mm->start_code' \
                     'wasm_exec_status = wasm_load_executable(current->mm->start_code'

    substituteInPlace arch/wasm/kernel/process.c \
      --replace-fail '	/* Reload the program when the current syscall exits. */
	current_thread_info()->flags |= _TIF_RELOAD_PROGRAM;' \
                     '	if (wasm_exec_status) {
		/* #179: the host cannot run this image. Past begin_new_exec()
		 * there is no route back to -ENOEXEC, so kill this task the way
		 * bprm_execve() does after the point of no return. Deliberately
		 * do NOT set _TIF_RELOAD_PROGRAM: there is no loaded image. */
		pr_err("wasm: host rejected exec image for %s[%d]\n",
			current->comm, task_pid_nr(current));
		force_fatal_sig(SIGSEGV);
		return;
	}

	/* Reload the program when the current syscall exits. */
	current_thread_info()->flags |= _TIF_RELOAD_PROGRAM;'

    # Assert all four landed (substituteInPlace --replace-fail already errors on a
    # miss, but pin the RESULT too: a future refactor must not quietly drop the
    # check and go back to panicking the guest).
    grep -q 'wasm_exec_status = wasm_load_executable' arch/wasm/kernel/process.c || {
      echo "ERROR: #179 exec-reject wiring missing (status capture)" >&2; exit 1; }
    grep -q 'force_fatal_sig(SIGSEGV)' arch/wasm/kernel/process.c || {
      echo "ERROR: #179 exec-reject wiring missing (kill on reject)" >&2; exit 1; }
    grep -q 'extern int wasm_load_executable' arch/wasm/include/asm/wasm.h || {
      echo "ERROR: #179 exec-reject wiring missing (return type)" >&2; exit 1; }
    echo "#179 exec-reject wiring OK (wasm_load_executable returns a status; start_thread kills on reject)"
  '';

  nativeBuildInputs = [
    pkgs.gnumake
    pkgs.bison
    pkgs.flex
    pkgs.bc
    pkgs.python3
    pkgs.perl
    pkgs.rsync
    pkgs.gcc
    kernelCC
  ];

  # kbuild resolves CC=clang, AR=llvm-ar, OBJCOPY=llvm-objcopy, … from LLVM=<dir>/
  # (the symlink farm). CROSS_COMPILE=wasm32-unknown-unknown- makes kbuild pass
  # --target=wasm32-unknown-unknown (a triple clang accepts). HOSTCC=gcc keeps the
  # native host tools (fixdep, kallsyms) on the build platform; HOSTLD defaults to
  # the farm's ld.lld (ELF — fine for host ELF). LD is overridden to wasm-ld: lld
  # dispatches on argv[0], and the default LLVM= LD=ld.lld is the ELF driver, which
  # can't link the wasm target objects — wasm-ld is the wasm driver.
  makeFlags = [
    "ARCH=wasm"
    "O=build"
    "LLVM=${kernelCC}/bin/"
    "LD=${kernelCC}/bin/wasm-ld"
    "HOSTCC=gcc"
    "CROSS_COMPILE=wasm32-unknown-unknown-"
    # scripts/Makefile.clang hardcodes CLANG_TARGET_FLAGS_wasm := wasm-linux-musl,
    # which clang REJECTS (wasm needs wasm32). Override it (command-line wins over
    # the Makefile :=) to the triple clang accepts; arch/wasm/Makefile re-adds the
    # -D__linux__/__unix__ the bare triple drops. (No patch to the generic file.)
    "CLANG_TARGET_FLAGS_wasm=wasm32-unknown-unknown"
  ];

  # Fixed identity so the build is deterministic (kbuild otherwise embeds the
  # builder's user/host/timestamp into the kernel).
  KBUILD_BUILD_USER = "nix";
  KBUILD_BUILD_HOST = "nix-wasm";
  KBUILD_BUILD_TIMESTAMP = "Thu Jan  1 00:00:00 UTC 1970";

  enableParallelBuilding = true;

  configurePhase = ''
    runHook preConfigure

    # The kernel ships scripts with `#!/usr/bin/env …` shebangs the sandbox
    # has no /usr/bin/env for; rewrite them to absolute store paths.
    patchShebangs scripts

    make $makeFlags wasm32_nommu_defconfig

    # build.sh configure_kernel() toggle set + overlayfs (installer fallback) +
    # EXT2/EXT4 for the RW state disk (#177 G1). After install, /nix mounts
    # directly from /dev/vdb (ext2); the ramfs-overlay path remains only for
    # seed-only / recovery boots without a state disk.
    # NOMMU caveat: CONFIG_TMPFS depends on CONFIG_SHMEM and mainline gates SHMEM
    # behind MMU, so olddefconfig SILENTLY DROPS both here — we request them
    # anyway (harmless; auto-enables if a future MMU/EXPERT change allows tmpfs).
    # CONFIG_OVERLAY_FS itself compiles cleanly on this NOMMU kernel.
    bash ./scripts/config --file build/.config \
      `# 9P rides the stock mainline 9P-over-virtio transport (NET_9P_VIRTIO) on` \
      `# the virtio_wasm transport (patch 0018) — the guest looks like a standard` \
      `# virtualized Linux at the 9P layer. The bespoke trans_cb (NET_9P_CB)` \
      `# SAB-ring transport it replaced is gone (#10).` \
      --enable CONFIG_NET --enable CONFIG_NET_9P \
      --enable CONFIG_NET_9P_VIRTIO --enable CONFIG_9P_FS \
      --enable CONFIG_DEVTMPFS --enable CONFIG_DEVTMPFS_MOUNT \
      --enable CONFIG_FILE_LOCKING \
      `# Wayland Phase 1 (1a/1b): virtio core + the Wasm host-callback transport` \
      `# (patch 0013), its 2-vq echo self-test, and the virtio_wl driver` \
      `# (/dev/wl0). VIRTIO/VIRTIO_MENU are off in wasm32_nommu_defconfig; turn` \
      `# them on so virtio.c/virtio_ring.c build, then enable our transport +` \
      `# drivers. No DMA layer is needed — the transport withholds` \
      `# VIRTIO_F_ACCESS_PLATFORM so vring uses identity nommu offsets.` \
      --enable CONFIG_VIRTIO --enable CONFIG_VIRTIO_MENU --enable CONFIG_VIRTIO_WASM \
      `# #177: echo self-test slot (host index 1) is reclaimed for VW_DEV_BLK_STATE.` \
      --disable CONFIG_VIRTIO_WASM_ECHO --enable CONFIG_VIRTIO_WL \
      `# Issue #10 (option 2) / #83: stock mainline virtio-console driver` \
      `# (drivers/char/virtio_console.c) over the virtio_wasm transport` \
      `# (patch 0019) is the guest's SOLE console. The transport registers 8` \
      `# featureless single-port virtio-console devices (VW_DEV_CONSOLE_BASE..+8,` \
      `# host idx 8..15); each takes the SYNCHRONOUS non-multiport probe path so the` \
      `# driver registers hvc0..hvc7 (one per Terminal window) before init runs —` \
      `# multiport adds ports async via the control vq and races init to death on` \
      `# single-CPU wasm boot. CONFIG_VIRTIO_CONSOLE selects HVC_DRIVER and depends` \
      `# on VIRTIO + TTY.` \
      --enable CONFIG_VIRTIO_CONSOLE \
      `# Issue #83: retire the bespoke hvc_wasm backend (patches 0002/0003 dropped).` \
      `# Disabling it removes its device_initcall (which else claimed hvc0 and the` \
      `# wasm_driver_hvc_* host imports), so virtio-console's first console port` \
      `# becomes hvc0 and carries 'console=hvc'. HVC_DRIVER stays on (selected by` \
      `# VIRTIO_CONSOLE above), so the hvc framework remains for virtio-console.` \
      --disable CONFIG_HVC_WASM \
      `# Guest networking (Phase 1): stock drivers/net/virtio_net.c over the` \
      `# virtio_wasm transport (dev 2, VW_DEV_NET), IPv4+ICMP, and AF_PACKET raw` \
      `# sockets (busybox udhcpc/ping). CONFIG_NET is already on above.` \
      `# CONFIG_NETDEVICES is the gate: drivers/net/Kconfig wraps VIRTIO_NET in` \
      `# 'if NETDEVICES', so olddefconfig SILENTLY DROPS VIRTIO_NET without it.` \
      --enable CONFIG_NETDEVICES \
      --enable CONFIG_VIRTIO_NET \
      --enable CONFIG_INET --enable CONFIG_PACKET \
      --enable CONFIG_SCHED_STACK_END_CHECK \
      `# MAX_ORDER=15 → 128MB max buddy block. nix-env substituting the 96MB` \
      `# guest-clang NAR calls mmap(MAP_ANON, ~134MB) internally (malloc for NAR` \
      `# extraction buffer); this needs order 16 (256MB) = above the 128MB cap,` \
      `# so it always fails. Raise to 16 → 256MB max buddy block, which covers` \
      `# the 134MB nix-env allocation and any future large-binary mmap. The` \
      `# Kconfig allows up to 17 (arch/wasm/Kconfig range 10 17).` \
      --set-val CONFIG_ARCH_FORCE_MAX_ORDER 16 \
      `# Boot RAM: arch/wasm head.S grows the wasm Memory to CONFIG_BOOT_MEM_PAGES` \
      `# (64KiB pages) and that becomes the kernel's physical RAM. The default` \
      `# 0x2000 = 512MiB is too tight for in-guest compilation: exec'ing the 57MB` \
      `# clang.wasm needs a single contiguous mmap, and the cc wrapper's sysroot` \
      `# unpack fragments the NOMMU buddy allocator below 57MB first (only 4 order-15` \
      `# blocks at 512MiB, all spoiled). 0x4000 = 1GiB doubles the order-15 block` \
      `# count so a contiguous 57MB survives. 0x7000 = 1.75GiB: GTK apps that map a` \
      `# large window allocate an order-11 (8MB) GFP_HIGHUSER wl_shm buffer, and after` \
      `# the served /nix closure + glib/gdk init fragment the heap below 8MB, that mmap` \
      `# fails ("page allocation failure: order:11") → no window (gtk3-widget-factory).` \
      `# 0x7FFF = 1.99GiB (max under setup.c's 0x80000000/2GiB positive-address limit):` \
      `# with MAX_ORDER=16 (256MB blocks) we need enough RAM to have a free 256MB region` \
      `# after boot + squashfs load; 1.99GiB gives ~1.6GB free which the buddy allocator` \
      `# coalesces into 256MB+ blocks. 0x7FFF is the safe maximum.` \
      --set-val CONFIG_BOOT_MEM_PAGES 0x7FFF \
      --enable CONFIG_SHMEM --enable CONFIG_TMPFS --enable CONFIG_OVERLAY_FS \
      `# Squashfs/virtio-blk spike (#43 Task 1): block layer + virtio-blk driver +` \
      `# squashfs filesystem (with ZSTD decompression). CONFIG_BLOCK is the gate for` \
      `# CONFIG_VIRTIO_BLK (drivers/block/Kconfig is wrapped in 'if BLOCK'), so both` \
      `# must be enabled or olddefconfig silently drops VIRTIO_BLK.` \
      `# CONFIG_MISC_FILESYSTEMS is the gate for CONFIG_SQUASHFS (fs/Kconfig wraps` \
      `# squashfs in 'if MISC_FILESYSTEMS'); wasm32_nommu_defconfig explicitly sets it` \
      `# to 'n', so olddefconfig silently drops SQUASHFS without this enable.` \
      --enable CONFIG_BLOCK \
      --enable CONFIG_VIRTIO_BLK \
      --enable CONFIG_MISC_FILESYSTEMS \
      --enable CONFIG_SQUASHFS \
      --enable CONFIG_SQUASHFS_ZSTD \
      --enable CONFIG_ZSTD_DECOMPRESS \
      `# #177 G1: writable block-backed FS for the installed /nix on /dev/vdb.` \
      `# EXT2 is the format busybox mkfs.ext2 writes; EXT4 mounts it (and is` \
      `# the upgrade path). JBD2 comes along with EXT4.` \
      --enable CONFIG_EXT2_FS \
      --enable CONFIG_EXT4_FS \
      --enable CONFIG_JBD2 \
      `# Issue #10 option 3: AF_VSOCK + the stock virtio-vsock transport` \
      `# (net/vmw_vsock/virtio_transport.c) on the virtio_wasm transport (patch` \
      `# 0020, VW_DEV_VSOCK=7, VIRTIO_ID_VSOCK=19) — a standard socket channel` \
      `# for the guest→host /Ctl bridge. CONFIG_VSOCKETS is the AF_VSOCK core;` \
      `# CONFIG_VIRTIO_VSOCKETS is the guest driver (it selects` \
      `# CONFIG_VIRTIO_VSOCKETS_COMMON automatically). CONFIG_VSOCKETS depends on` \
      `# CONFIG_NET (already on above); CONFIG_VIRTIO_VSOCKETS depends on both` \
      `# CONFIG_VSOCKETS and CONFIG_VIRTIO (both on above), or olddefconfig` \
      `# silently drops the driver.` \
      --enable CONFIG_VSOCKETS \
      --enable CONFIG_VIRTIO_VSOCKETS \
      --enable CONFIG_VIRTIO_VSOCKETS_COMMON \
      `# Issue #145: guest audio — ALSA core + the stock virtio-snd driver` \
      `# (sound/virtio/, patch 0027, VW_DEV_SND=6, VIRTIO_ID_SOUND=25).` \
      `# CONFIG_SOUND is the gate (depends on HAS_IOMEM — default y on wasm);` \
      `# CONFIG_SND is the ALSA core; CONFIG_SND_VIRTIO selects SND_PCM +` \
      `# SND_JACK (+ SND_TIMER via SND_PCM) automatically. OSS emulation stays` \
      `# off (defaults). CONFIG_SND_VIRTIO depends on SOUND+SND+VIRTIO, so all` \
      `# three must be enabled or olddefconfig silently drops the driver —` \
      `# asserted below like CONFIG_MMU.` \
      --enable CONFIG_SOUND \
      --enable CONFIG_SND \
      --enable CONFIG_SND_PCM \
      --enable CONFIG_SND_VIRTIO

    ${pkgs.lib.optionalString mmu ''
      # #128: enable the software MMU + disable binfmt_elf (the guest execs wasm).
      bash ./scripts/config --file build/.config \
        --enable CONFIG_MMU \
        --disable CONFIG_BINFMT_ELF
    ''}

    make $makeFlags olddefconfig

    # Issue #145: a silently-dropped CONFIG_SND_VIRTIO would ship a kernel with
    # no sound card and nothing would fail until the snd smoke — fail here.
    grep -qE "^CONFIG_SND_VIRTIO=y" build/.config \
      || { echo "ERROR: CONFIG_SND_VIRTIO did not stick (olddefconfig dropped it" \
                "— check the CONFIG_SOUND/CONFIG_SND gates)" >&2; exit 1; }

    # #177 G1: writable FS on virtio-blk — EXT2 (mkfs.ext2) + EXT4 must stick.
    grep -qE "^CONFIG_EXT2_FS=y" build/.config \
      || { echo "ERROR: CONFIG_EXT2_FS did not stick (olddefconfig dropped it)" >&2; exit 1; }
    grep -qE "^CONFIG_EXT4_FS=y" build/.config \
      || { echo "ERROR: CONFIG_EXT4_FS did not stick (olddefconfig dropped it)" >&2; exit 1; }
    # Echo slot must stay disabled (reclaimed for VW_DEV_BLK_STATE).
    grep -qE "^# CONFIG_VIRTIO_WASM_ECHO is not set|^CONFIG_VIRTIO_WASM_ECHO=n" build/.config \
      || { echo "ERROR: CONFIG_VIRTIO_WASM_ECHO must stay disabled (#177)" >&2; exit 1; }

    ${pkgs.lib.optionalString mmu ''
      grep -qE "^CONFIG_MMU=y" build/.config \
        || { echo "ERROR: CONFIG_MMU did not stick" >&2; exit 1; }
    ''}

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make $makeFlags -j$NIX_BUILD_CORES vmlinux
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp build/vmlinux $out/vmlinux.wasm
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
