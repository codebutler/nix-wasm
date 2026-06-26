// vsock-ctl-smoke.mjs — end-to-end proof of the /Ctl desktop-control bridge over
// AF_VSOCK (issue #60 Phase 2 / nix-wasm#10 option 3): the guest agent `pcctl`
// (userspace/pcctl.c) talking to a host /Ctl listener on the virtio-vsock device.
//
// It boots busybox-only (nix:false — kernel + initramfs, no /nix overlay needed),
// registers a host listener on CTL_PORT via the `vsock.onReady(device)` boot hook,
// and drives the guest shell to run `pcctl` for each verb:
//
//   pcctl open calc      → host seam records open=["calc"]
//   pcctl notify hello   → host seam records notify=["hello"]
//   pcctl clipset world  → host clipboard becomes "world"
//   pcctl clipget        → guest prints the host clipboard ("world") back
//
// PASS iff every verb reaches the host seams AND the CLIPGET reply round-trips to
// the guest's stdout — proving the full guest→host→guest vsock path.
//
// The host-side framing/dispatch below mirrors pc's js/linux/ctl-vsock.js (the
// AUTHORITATIVE /Ctl consumer; nix-wasm is transport-only). This smoke proves the
// guest binary speaks that exact wire protocol; if the two drift, it fails here.
//
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const CTL_PORT = 1024; // MUST match pc CTL_PORT and userspace/pcctl.c.
const enc = new TextEncoder();
const dec = new TextDecoder();

// What the host saw — the injected /Ctl "seams", recorded for assertions.
const seen = { open: [], notify: [], clipboard: "host-clip" };

function concat(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Frame a reply: "<status> <len>\n" + payload bytes (mirrors ctl-vsock.js).
function frameReply(status, payloadStr) {
  const payload = enc.encode(payloadStr || "");
  return concat(enc.encode(`${status} ${payload.length}\n`), payload);
}

// Run one request against the recorded seams; return the framed reply bytes.
function dispatch(verb, text) {
  switch (verb) {
    case "OPEN":
      if (text.trim()) seen.open.push(text.trim());
      return frameReply("OK", "");
    case "NOTIFY":
      if (text.trim()) seen.notify.push(text.trim());
      return frameReply("OK", "");
    case "CLIPGET":
      return frameReply("OK", seen.clipboard);
    case "CLIPSET":
      seen.clipboard = text; // empty clears (data node, literal)
      return frameReply("OK", "");
    default:
      return frameReply("ERR", `unknown verb: ${verb}`);
  }
}

// Bind a VsockConnection to the /Ctl protocol: accumulate guest→host bytes, parse
// complete length-prefixed frames, dispatch, and write the framed reply.
function handleConnection(conn) {
  let buf = new Uint8Array(0);
  conn.onData((chunk) => {
    buf = concat(buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break; // header line incomplete
      const header = dec.decode(buf.subarray(0, nl));
      const sp = header.indexOf(" ");
      const verb = (sp < 0 ? header : header.slice(0, sp)).trim();
      const len = Number(sp < 0 ? "0" : header.slice(sp + 1).trim());
      const start = nl + 1;
      if (!Number.isInteger(len) || len < 0) {
        conn.write(frameReply("ERR", "malformed header"));
        return;
      }
      if (buf.length < start + len) break; // payload incomplete — wait
      const text = dec.decode(buf.subarray(start, start + len));
      buf = buf.slice(start + len);
      conn.write(dispatch(verb, text));
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label);
}

const s = await bootNode({
  nix: false,
  vsock: {
    onReady: (device) => device.listen(CTL_PORT, handleConnection),
  },
});

let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[vsock-ctl-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // 1. open <app id> → host openApp seam.
  s.send("pcctl open calc\n");
  await waitFor(() => seen.open.includes("calc"), 15000, "OPEN calc");

  // 2. notify <text> → host notify seam.
  s.send("pcctl notify hello\n");
  await waitFor(() => seen.notify.includes("hello"), 15000, "NOTIFY hello");

  // 3. clipset <text> → host clipboard set.
  s.send("pcctl clipset world\n");
  await waitFor(() => seen.clipboard === "world", 15000, "CLIPSET world");

  // 4. clipget → host reply round-trips to the guest's stdout.
  s.send("echo CLIP=$(pcctl clipget)\n");
  const got = await s.waitForOutput(/CLIP=world\b/, 15000);
  if (!got) throw new Error("CLIPGET reply did not reach the guest (expected CLIP=world)");

  pass = true;
} catch (e) {
  console.log("[vsock-ctl-smoke] " + (e && e.message ? e.message : e));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}

console.log("\n[vsock-ctl-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
