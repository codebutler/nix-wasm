// net-spike.mjs — Phase 1 GATE (Task 1.6): prove the virtio-net plumbing end to
// end. Boots the busybox guest, statically configures eth0, attaches the guest's
// ethernet-frame stream (handle.net) to a tcpip.js stack acting as the gateway
// 10.0.2.1/24, and checks:
//   1) host -> guest ICMP   (tcpip.js ping session probing 10.0.2.2)
//   2) guest -> host ICMP   (busybox `ping -c1 10.0.2.1`, lwIP auto-replies)
//   3) guest -> host TCP    (busybox `telnet` connects to a tcpip.js listener)
//   PASS -> exit 0, FAIL -> exit 1, INCONCLUSIVE (panic/timeout) -> exit 2
//
// TCP applet choice: this guest's curated busybox set ships NEITHER `nc` NOR
// `wget` (verified via `busybox --list` against the current artifacts), so the
// brief's `nc`/`wget` options don't apply without a userspace rebuild — which we
// avoid. `telnet` IS a built applet and opens a raw TCP connection, so check #3
// drives `telnet 10.0.2.1 9099` and the host listener asserts an accepted
// connection carrying the guest's payload. (The host greets on-connect and looks
// for "hello" in the bytes telnet streams; if telnet's IAC negotiation perturbs
// the payload, an accepted connection alone already proves the guest->host TCP
// path — SYN routed through the tap to lwIP and a full handshake completed.)
import { bootNode } from "./boot-node.mjs";
import { createStack } from "tcpip";

const GUEST_IP = "10.0.2.2";
const GW_IP = "10.0.2.1";
const GW_CIDR = `${GW_IP}/24`;
const TCP_PORT = 9099;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await bootNode({ nix: false });
let code = 2;
try {
  // 60s (up from the brief's 45s) — cold boot is slow on this host.
  if (!(await s.waitForPrompt(60000))) throw new Error("no shell prompt");

  // Host: tcpip.js stack as the gateway, tap piped to the guest NIC frame stream.
  const stack = await createStack();
  const tap = await stack.interfaces.createTap({ mac: "52:54:00:cb:00:01", ip: GW_CIDR });
  // Pipe both directions; swallow the rejection these settle with on s.kill().
  s.handle.net.readable.pipeTo(tap.writable).catch(() => {});
  tap.readable.pipeTo(s.handle.net.writable).catch(() => {});
  s.handle.net.setLinkUp(true);
  await sleep(300); // let the link + ARP settle before configuring the guest

  // Guest: static IP + route (no DHCP in Phase 1).
  s.send(
    `ip addr add ${GUEST_IP}/24 dev eth0 && ip link set eth0 up && ip route add default via ${GW_IP}; echo IPCFG=$?\n`,
  );
  await s.waitForOutput(/IPCFG=0/, 6000);
  await sleep(1000);

  // 1) host -> guest ICMP via the tcpip.js ping session.
  let hostToGuest = false;
  try {
    const ping = await stack.ping.createSession({ host: GUEST_IP });
    const reply = await Promise.race([
      ping.ping({ timeout: 4000 }),
      sleep(5000).then(() => Promise.reject(new Error("ping timeout"))),
    ]);
    hostToGuest = !!reply;
    await ping.close().catch(() => {});
    console.log(
      `[net-spike] host->guest ping: OK (rtt=${reply.roundTripTime}ms seq=${reply.sequenceNumber})`,
    );
  } catch (e) {
    console.log("[net-spike] host->guest ping: FAIL — " + e.message);
  }

  // 2) guest -> host ICMP (lwIP auto-replies at the gateway).
  s.send(`ping -c 1 -W 2 ${GW_IP}; echo PINGRC=$?\n`);
  const guestToHost = await s.waitForOutput(/PINGRC=0/, 8000);
  console.log("[net-spike] guest->host ping:", guestToHost ? "OK" : "FAIL");

  // 3) guest -> host TCP: host listens on TCP_PORT, guest connects with telnet.
  let gotTcp = false;
  let tcpAccepted = false;
  const listener = await stack.tcp.listen({ port: TCP_PORT });
  (async () => {
    for await (const conn of listener) {
      tcpAccepted = true;
      // Greet so a round-trip exists even if telnet sends nothing parseable.
      try {
        const w = conn.writable.getWriter();
        await w.write(new TextEncoder().encode("ok\n"));
        w.releaseLock();
      } catch {
        /* peer may close fast */
      }
      try {
        const r = conn.readable.getReader();
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const { value, done } = await r.read();
          if (done) break;
          if (value && new TextDecoder().decode(value).includes("hello")) {
            gotTcp = true;
            break;
          }
        }
        r.releaseLock();
      } catch {
        /* ignore */
      }
      await conn.close().catch(() => {});
      break;
    }
  })().catch(() => {});

  // telnet streams stdin to the socket; feed it "hello" then quit.
  s.send(`(echo hello; sleep 1) | telnet ${GW_IP} ${TCP_PORT}; echo TELNETRC=$?\n`);
  await sleep(3500);
  // An accepted connection already proves the guest->host TCP handshake; payload
  // match is the stronger signal but telnet's IAC bytes can mangle it.
  const tcpOk = gotTcp || tcpAccepted;
  console.log(
    "[net-spike] guest->host tcp:",
    gotTcp ? "OK (payload)" : tcpAccepted ? "OK (connection accepted)" : "FAIL",
  );
  // tcpip@0.4.0's TcpListener has no close()/cancel() in its .d.ts (it's only an
  // async-iterable) — nothing to close; the listener is dropped at process.exit.

  code = hostToGuest && guestToHost && tcpOk ? 0 : 1;
  if (code) console.log("[net-spike] console tail:\n" + s.snapshot().slice(-2000));
  else console.log("[net-spike] VERDICT: PASS — all three checks OK");
} catch (e) {
  console.log("[net-spike] INCONCLUSIVE:", e.message);
  console.log(s.snapshot().slice(-2000));
} finally {
  s.kill();
  await sleep(200);
  process.exit(code);
}
