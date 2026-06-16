# The guest system closure in boot layout. Host-built; substituted into the
# guest /nix store over 9P. The Plan-2 bootstrap (in the `pc` repo) consumes it.
#
# Boot-layout CONTRACT (what the bootstrap must do — the entrypoint is busybox
# init, NOT a `wasm-init` wrapper):
#   1. exec the PATH `$sys/init` (this symlink, basename `init`) — busybox
#      dispatches on argv[0] basename, so it runs the `init` applet. Do NOT exec
#      the resolved busybox target (wrong applet). busybox init reads /etc/inittab.
#   2. busybox --install  -> creates /bin/sh, /bin/login, /sbin/getty, /sbin/syslogd
#      etc. (applets that inittab + autologin reference).
#   3. install $sys/etc/autologin -> /bin/autologin (+x). autologin is a CUSTOM
#      script, not a busybox applet, so --install will NOT create it, yet inittab
#      references /bin/autologin by absolute path.
#   4. create a writable /var/log before init runs (syslogd writes /var/log/messages).
#   5. symlink /etc -> $sys/etc and /run/current-system/sw -> $sys/sw, with /nix
#      mounted (the store-symlinks inside etc, plus sw and init, resolve in-guest).
#   6. nrConsoles=8 is baked into inittab — keep kernel HVC_WASM_NR_CONSOLES and
#      host HVC_CONSOLES in lockstep (see init.nix).
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
