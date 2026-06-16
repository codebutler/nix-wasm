# The guest system closure in boot layout. The Plan-2 bootstrap symlinks
# /etc -> $out/etc, /run/current-system/sw -> $out/sw, and execs $out/init.
{ pkgs, etc, systemPath, passwd, group, init }:
pkgs.runCommand "wasm-system" { } ''
  mkdir -p $out
  # Real /etc = module-generated etc + our static passwd/group. Preserve the
  # store symlinks inside etc (resolved in-guest, where /nix is mounted).
  cp -a ${etc}/etc $out/etc
  chmod -R u+w $out/etc
  cp ${passwd} $out/etc/passwd
  cp ${group} $out/etc/group
  ln -s ${systemPath} $out/sw
  cp -a ${init}/etc/inittab $out/etc/inittab
  cp -a ${init}/bin/autologin $out/etc/autologin   # bootstrap installs to /bin
  # init entrypoint: busybox init (the bootstrap execs $out/init)
  ln -s ${pkgs.busybox}/bin/busybox $out/init
''
