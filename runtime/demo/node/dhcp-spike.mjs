// dhcp-spike.mjs — Task 2.5 SPIKE: prove the guest auto-configures eth0 via
// busybox `udhcpc` against the host's tcpip.js DHCP server, under wasm32 NOMMU.
//
// Shape mirrors net-spike.mjs (Task 1.6), except the guest gets its IP from
// udhcpc (launched by the baked /init) instead of a manual `ip addr add`. The
// host side stands up a tcpip.js stack as the gateway 10.0.2.1/24 with a tap +
// DHCP server (createDhcp(...).serve(...)), pipes the guest NIC frame stream
// (handle.net) <-> tap, brings the link up, then WAITS for the guest to acquire
// a lease and ping the gateway.
//
//   PASS         -> exit 0  (guest got a 10.0.2.x lease AND ping replies)
//   FAIL         -> exit 1  (link wired but no lease / no ping — the NOMMU verdict)
//   INCONCLUSIVE -> exit 2  (panic / timeout / boot failure)
//
// The NOMMU question: udhcpc execs its lease script (/usr/share/udhcpc/
// default.script) via libbb spawn() — which patch 0004 converts to
// clone-with-a-fn (CLONE_VM|CLONE_VFORK|SIGCHLD) on NOMMU, the same mechanism
// the shell/tar/heredoc paths use. If that path holds, udhcpc configures eth0
// and this passes; if it crashes on the vfork landmine, this fails and the
// /init falls back to static config (documented in the spike doc).
//
// tcpip bundle: nix-wasm's `tcpip` dep (0.4.0) predates the DHCP server, so we
// import pc's vendored tcpip bundle (createStack + createDhcp + createTap in one
// build) by absolute path. It has a node loader (createReadStream) and ships its
// own tcpip.wasm beside it, so it runs headless here.
import { bootNode } from "./boot-node.mjs";

const TCPIP =
  process.env.PC_TCPIP_BUNDLE ||
  "file:///home/vbvntv/Code/pc-worktrees/guest-networking/vendor/tcpip/tcpip.mjs";
const { createStack, createDhcp } = await import(TCPIP);

const GW_IP = "10.0.2.1";
const GW_CIDR = `${GW_IP}/24`;
const GW_MAC = "52:54:00:cb:00:01";
const LEASE_START = "10.0.2.100";
const LEASE_END = "10.0.2.200";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// New artifacts dir (env override): the rebuilt initramfs beside the current vmlinux.
const ARTIFACTS = process.env.LINUX_WASM_ARTIFACTS;
const s = await bootNode({ nix: false });
let code = 2;
try {
  if (!(await s.waitForPrompt(60000))) throw new Error("no shell prompt");

  // Host: tcpip.js gateway stack + tap, piped to the guest NIC frame stream.
  const stack = await createStack();
  const tap = await stack.interfaces.createTap({ mac: GW_MAC, ip: GW_CIDR });
  s.handle.net.readable.pipeTo(tap.writable).catch(() => {});
  tap.readable.pipeTo(s.handle.net.writable).catch(() => {});
  s.handle.net.setLinkUp(true);
  await sleep(300); // let the link + ARP settle

  // Host: DHCP server on the gateway (matches pc's vnet config / Task 2.3).
  const { serve } = await createDhcp(stack.udp);
  const dhcpServer = await serve({
    leaseRange: { start: LEASE_START, end: LEASE_END },
    serverIdentifier: GW_IP,
    netmask: "255.255.255.0",
    router: GW_IP,
    dnsServers: [GW_IP],
  });
  console.log(`[dhcp-spike] DHCP server up on ${GW_IP} (pool ${LEASE_START}-${LEASE_END})`);

  // The baked /init already launched `udhcpc -i eth0 -f -q -t 0 -A 2 &` (shell-
  // backgrounded foreground udhcpc — see bootstrap.nix for the NOMMU rationale).
  // With -t 0 it retries DISCOVER forever, so even if the server came up after
  // boot it will eventually get a lease. Poll BOTH the server-side lease map and
  // the guest's `ip addr` each round, giving udhcpc time to DISCOVER/REQUEST/ACK
  // and run the lease script.
  let leaseIp = null;
  let guestIp = null;
  const deadline = Date.now() + 75000;
  let round = 0;
  while (Date.now() < deadline) {
    // Server-side: did we hand out a lease?
    for (const [mac, lease] of dhcpServer.leases) {
      if (lease?.ip?.startsWith("10.0.2.")) {
        leaseIp = lease.ip;
        console.log(`[dhcp-spike] server leased ${lease.ip} to ${mac}`);
        break;
      }
    }
    // Guest-side: did the lease script configure eth0?
    s.send(`echo ===P${round}===; ip -o addr show eth0 2>/dev/null; echo ===EP${round}===\n`);
    await s.waitForOutput(new RegExp(`===EP${round}===`), 4000);
    const m = s.snapshot().match(/inet (10\.0\.2\.\d+)/);
    if (m) guestIp = m[1];
    round++;
    if (leaseIp && guestIp) break;
    await sleep(2000);
  }
  console.log(`[dhcp-spike] guest eth0 inet: ${guestIp || "(none)"}`);

  if (!leaseIp && !guestIp) {
    console.log("[dhcp-spike] no DHCP lease acquired — udhcpc did NOT configure eth0");
    code = 1;
  } else {
    const ip = guestIp || leaseIp;
    console.log(`[dhcp-spike] guest acquired ${ip} via DHCP (no manual ip addr)`);

    // guest -> host ICMP (lwIP auto-replies at the gateway).
    s.send(`ping -c 1 -W 3 ${GW_IP}; echo PINGRC=$?\n`);
    const pingOk = await s.waitForOutput(/PINGRC=0/, 10000);
    console.log("[dhcp-spike] guest->gateway ping:", pingOk ? "OK" : "FAIL");

    code = guestIp && pingOk ? 0 : 1;
    if (code) {
      console.log("[dhcp-spike] console tail:\n" + s.snapshot().slice(-2500));
    } else {
      console.log(`[dhcp-spike] VERDICT: PASS — udhcpc leased ${guestIp}, ping OK`);
    }
  }
} catch (e) {
  console.log("[dhcp-spike] INCONCLUSIVE:", e.message);
  console.log(s.snapshot().slice(-2500));
} finally {
  console.log("[dhcp-spike] artifacts:", ARTIFACTS || "(default)");
  s.kill();
  await sleep(200);
  process.exit(code);
}
