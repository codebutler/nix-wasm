# Guest DHCP via udhcpc — NOMMU spike verdict (Task 2.5)

**Date:** 2026-06-21
**Verdict:** **PASS — udhcpc is the v1 path** (no static fallback needed),
*with* two NOMMU-specific launch workarounds baked into `/init`.

## What was tested

The guest busybox already ships `udhcpc`/`ip`/`ifconfig`/`ping`. The open
question (this is a `CONFIG_NOMMU=y` busybox where `vfork` is a known landmine):
does udhcpc's exec of its lease script — and udhcpc itself — work on this
wasm32 NOMMU guest, or do we need to fall back to static config?

Spike: `runtime/demo/node/dhcp-spike.mjs`. Boots the busybox guest (`nix:false`)
with a freshly-rebuilt initramfs, stands up a `tcpip.js` stack as the gateway
`10.0.2.1/24` with a tap + `createDhcp(stack.udp).serve(...)` DHCP server
(pool `10.0.2.100-10.0.2.200`, the Task 2.3 options), pipes the guest NIC frame
stream (`handle.net`) ↔ tap, then waits for the guest to acquire a lease and
ping the gateway.

(tcpip note: nix-wasm's `tcpip` dep is 0.4.0, which predates the DHCP server, so
the spike imports pc's vendored `tcpip` bundle — which bundles `createStack` +
`createDhcp` — by path via `PC_TCPIP_BUNDLE`. That bundle's node wasm loader
(`Readable.toWeb`) is broken on node 24; the spike run used a one-line patched
copy that reads the sibling `tcpip.wasm` with `fs.readFileSync` instead. This is
a *harness*-only detail — it doesn't touch the guest or the vendored pc runtime.)

## Result — PASS

```
[dhcp-spike] DHCP server up on 10.0.2.1 (pool 10.0.2.100-10.0.2.200)
[dhcp-spike] server leased 10.0.2.100 to 52:54:00:cb:00:02
[dhcp-spike] guest eth0 inet: 10.0.2.100
[dhcp-spike] guest acquired 10.0.2.100 via DHCP (no manual ip addr)
[dhcp-spike] guest->gateway ping: OK
[dhcp-spike] VERDICT: PASS — udhcpc leased 10.0.2.100, ping OK
```

The guest, on boot alone, ran udhcpc, completed DISCOVER → OFFER → REQUEST →
ACK, ran the lease script to set `inet 10.0.2.100` on `eth0`, installed the
default route + `/etc/resolv.conf`, and `ping -c1 10.0.2.1` replied — with **no
manual `ip addr`**.

## NOMMU details (what works, what doesn't)

The DHCP *protocol* and the *lease-script exec* work on NOMMU. The lease script
is exec'd via busybox `spawn_and_wait` → libbb `spawn()`, which `patches/busybox/
0004-libbb-spawn-clone.patch` converts to `clone(CLONE_VM|CLONE_VFORK|SIGCHLD)`
with a child fn — the same NOMMU-safe mechanism the shell/tar/heredoc paths use.
So `default.script`'s `ifconfig`/`ip route`/`resolv.conf` all run.

Two launch paths DO NOT work and the `/init` routes around them (both reproduced
with the diagnostic variants of the spike):

1. **`udhcpc -b` (self-daemonize) silently dies.** With `-b`, udhcpc's own
   `bb_daemonize_or_rexec` path is taken; on this guest it never even sends a
   DISCOVER — no console output, no lease. **Fix:** use `-f` (stay foreground).

2. **Backgrounding udhcpc with `&` *directly from `/init`* then `exec`-ing the
   next stage races the job away.** After `udhcpc … & ; exec /bin/sh`, the
   process table showed *no* udhcpc — the just-forked background job is lost
   across the `exec`. **Fix:** wrap the launch in `sh -c '… udhcpc … &'`, which
   detaches udhcpc into its own shell that fully spawns it before `/init`
   continues. With that wrapper, the lease is acquired reliably.

Foreground udhcpc backgrounded by a *shell* (interactive prompt or `sh -c`) is
the working combination, and it does run the lease script and configure `eth0`.

## Baked configuration

- Lease script: `/usr/share/udhcpc/default.script` (Nix `writeText` in
  `userspace/initramfs.nix`), `chmod +x`. Handles `deconfig` (iface up, no addr)
  and `bound`/`renew` (`ifconfig $interface $ip netmask $subnet`, default route
  via `$router`, `nameserver $dns` → `/etc/resolv.conf`).
- Boot launch (`userspace/bootstrap.nix` `/init`, on the common path before both
  the `exec "$sys/init"` and `exec /bin/sh` handoffs):

  ```sh
  if [ -e /sys/class/net/eth0 ]; then
    sh -c 'ip link set eth0 up 2>/dev/null; udhcpc -i eth0 -f -t 0 -A 2 >/dev/null 2>&1 &'
  fi
  ```

  `-t 0` retries DISCOVER forever (the host DHCP server may come up after the
  guest), `-A 2` is a short inter-round wait, no `-q` so udhcpc stays resident
  and re-runs the script on renew. Guarded on the NIC existing so a no-NIC
  kernel still boots.

## Static fallback (NOT used)

Not needed — udhcpc passed. For the record, the fallback would have been, in
place of the udhcpc line:

```sh
ip addr add 10.0.2.2/24 dev eth0; ip link set eth0 up
ip route add default via 10.0.2.1
echo nameserver 10.0.2.1 > /etc/resolv.conf
```

## Reproduce

```
cd nix-wasm
sudo nix build .#wasm-initramfs --extra-experimental-features 'nix-command flakes' --print-out-paths --no-link
# drop the built initramfs.cpio.gz + a current vmlinux.wasm into one dir, then:
PC_TCPIP_BUNDLE="file:///…/pc/vendor/tcpip/tcpip.mjs" \
LINUX_WASM_ARTIFACTS="file:///…/that-dir/" \
  node runtime/demo/node/dhcp-spike.mjs
# exit 0 = PASS
```
