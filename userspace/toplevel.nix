# The guest system closure in boot layout. Host-built; SERVED read-only into the
# guest /nix store as a squashfs image (base.squashfs) over a read-only virtio-blk
# device, mounted as the overlay lowerdir for /nix.
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
# nrConsoles=8 is baked into inittab — keep it in lockstep with the count of
# single-port virtio-console devices (CONSOLE_DEVICES / HVC_CONSOLES, see init.nix).
#
# #177 G6: $out/boot/{vmlinux.wasm,initramfs.cpio.gz,manifest.json} are generation
# artifacts the host bootloader mirrors after activate (G5 / pc-bootloader).
{ pkgs, busybox, etc, systemPath, passwd, group, inittab, activate
, kernel, initramfs, kernelAbi, pcBootloader }:
let
  # nix-wasm#202 PR-1: the EARLIEST point that has all three of kernel,
  # initramfs, and busybox in hand at once — so it is also the earliest point
  # a mismatched process-model pairing can be caught, before even building the
  # squashfs (userspace/base-squashfs.nix, which only ever sees `toplevel` and
  # so can't itself compare kernel against busybox directly). A NOMMU kernel
  # booting a real-fork busybox (or the reverse) corrupts the guest's own
  # memory model at boot — see kernel.nix's passthru.processModel comment and
  # docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md. This is
  # belt-and-braces with userspace/linux-image.nix's OWN assert (item 4's
  # "three members" gate on kernel/initramfs/squashfs): that one catches a
  # mismatch introduced by mixing outputs from two DIFFERENT toplevel builds
  # at the linux-image call site; this one catches a mismatch already present
  # among THIS toplevel's own three inputs.
  reqProcessModel = name: drv: drv.processModel or (throw
    "userspace/toplevel.nix: the `${name}` derivation has no "
    + "passthru.processModel — wire it before assembling a boot image");
  kernelModel = reqProcessModel "kernel" kernel;
  initramfsModel = reqProcessModel "initramfs" initramfs;
  busyboxModel = reqProcessModel "busybox" busybox;
  # A PLAIN `let processModel = if ... then ... else throw ...;` bound only
  # into `passthru.processModel` does NOT force this check: `passthru` is
  # merged into the derivation attrset lazily by `mkDerivation`/`runCommand`,
  # so nothing evaluates `.processModel` merely because `.#wasm-system{,-fork}`
  # (or anything that only references `${toplevel}` for its store path, e.g.
  # base-squashfs.nix's `closureInfo`) got built — found by review, which
  # noted CI's actual MMU boot-smoke path builds `.#kernel-mmu-a2` +
  # `.#wasm-initramfs-fork` + `.#wasm-base-squashfs-fork` as THREE INDEPENDENT
  # `nix build` invocations (nix-wasm.yml), so a lazy-only check could sit
  # unevaluated through the very CI runs it exists to guard. `assert`, unlike
  # a passthru-embedded value, is forced the moment the ENCLOSING expression
  # is evaluated to any degree (even WHNF) — which happens the instant
  # anything, including a bare `${toplevel}` interpolation, needs this
  # derivation's outPath.
  processModelCoherent =
    if kernelModel == initramfsModel && initramfsModel == busyboxModel
    then true
    else throw ''
      userspace/toplevel.nix: process-model MISMATCH assembling this boot
      image: kernel=${kernelModel} initramfs=${initramfsModel} busybox=${busyboxModel}.
      A NOMMU spawn-contract kernel paired with a real-fork userspace (or the
      reverse) corrupts the guest's own memory model at boot. This assert
      exists so a future attr-rename (e.g. pairing .#kernel-mmu-a2 with the
      NOMMU busybox, or the reverse) fails at EVAL time instead of shipping a
      silently-broken image.
    '';
in
assert processModelCoherent;
pkgs.runCommand "wasm-system" { passthru.processModel = kernelModel; } ''
  mkdir -p $out $out/boot
  # Real /etc = module-generated etc + our static passwd/group + profile inittab.
  # Preserve the store symlinks inside etc (resolved in-guest, /nix mounted).
  cp -a ${etc}/etc $out/etc
  chmod -R u+w $out/etc
  cp ${passwd} $out/etc/passwd
  cp ${group} $out/etc/group
  cp ${inittab} $out/etc/inittab
  ln -s ${systemPath} $out/sw
  ln -s ${activate} $out/activate
  ln -s ${pcBootloader} $out/pc-bootloader
  # init entrypoint: the PATCHED busybox (the thin /init execs $out/init;
  # basename `init` -> busybox init applet). MUST be the clone-spawn busybox —
  # stock busybox's fork/vfork PID1 SIGILLs on the wasm NOMMU model.
  ln -s ${busybox}/bin/busybox $out/init
  # Bootloader artifacts (G6): copy bytes so the paths stay under $out/boot
  # even if the kernel/initramfs store paths move across rebuilds.
  cp ${kernel}/vmlinux.wasm $out/boot/vmlinux.wasm
  cp ${initramfs}/initramfs.cpio.gz $out/boot/initramfs.cpio.gz
  # Manifest stamped with this closure's store path + ENGINE_ABI. generation=1
  # for the seed profile (single system symlink); bump when real system-N-link
  # generations exist.
  cat > $out/boot/manifest.json <<EOF
{"kernelAbi":${toString kernelAbi},"generation":1,"system":"$out"}
EOF
''
