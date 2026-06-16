# PID 1 for the wasm guest: busybox `init` + a generated inittab. One
# getty->autologin->ash chain per hvc console, plus a file-backed syslogd. No
# systemd, no services.
#
# nrConsoles MUST match the kernel's HVC_WASM_NR_CONSOLES and the JS host's
# HVC_CONSOLES (both 8 today). Changing it here without changing those desyncs
# the consoles silently, so keep the three in lockstep.
{ lib, pkgs, nrConsoles ? 8 }:
let
  # getty passes `xterm-256color` as the termtype arg so TERM is correct from
  # login on — the pc terminal is Ghostty (xterm-compatible); busybox getty's
  # bare default would otherwise be the wrong `vt102`.
  consoleLines = lib.concatMapStringsSep "\n"
    (i: "hvc${toString i}::respawn:/sbin/getty -L -i -n -l /bin/autologin 0 hvc${toString i} xterm-256color")
    (lib.range 0 (nrConsoles - 1));
  inittab = pkgs.writeText "inittab" ''
    ::respawn:/bin/sh -c '/sbin/syslogd -n -O /var/log/messages -s 16 -b 1; sleep 5'
    ${consoleLines}
  '';
  # autologin: getty's `-l` execs this instead of /bin/login (single-user guest).
  # Shebang is /bin/sh (busybox ash, present in-guest) — NOT writeShellScript,
  # whose runtimeShell resolves to the repo's NATIVE host bash (wrong arch/path
  # for the guest). A standalone writeText keeps the shebang at column 0 without
  # depending on heredoc indentation. /var/log is created (writable) by the boot
  # bootstrap before init runs the syslogd line above.
  autologin = pkgs.writeText "autologin" ''
    #!/bin/sh
    exec /bin/login -f root
  '';
in
pkgs.runCommand "wasm-init" { } ''
  mkdir -p $out/etc $out/bin
  cp ${inittab} $out/etc/inittab
  cp ${autologin} $out/bin/autologin
  chmod +x $out/bin/autologin
''
