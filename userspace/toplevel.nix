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
{ pkgs, busybox, etc, systemPath, passwd, group, inittab, activate }:
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
  # init entrypoint: the PATCHED busybox (the thin /init execs $out/init;
  # basename `init` -> busybox init applet). MUST be the clone-spawn busybox —
  # stock busybox's fork/vfork PID1 SIGILLs on the wasm NOMMU model.
  ln -s ${busybox}/bin/busybox $out/init
''
