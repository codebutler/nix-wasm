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
