// wl-device.test.js — the Phase 4f worker↔host split on WlDevice. Browser-free:
// drives _handle() directly (no vring/SharedQueues needed) to verify a VFD_SEND
// routes wayland bytes OUT to the host bridge FIRE-AND-FORGET (the OUT ack stays
// synchronous; there is no inReply — the response comes back asynchronously via
// injectIn on the host side). Also checks the Phase-1 fallback (no bridge → the
// in-worker WlServer stub, which still uses inReply) and the host-side injectIn
// IN-delivery (bytes, and server→client fds → VFD_NEW + VFD_RECV).
import { test, expect } from "bun:test";
import { WlDevice } from "./wl-device.js";

// virtwl ctrl types / responses (mirror wl-device.js).
const VFD_SEND = 0x102;
const VFD_NEW = 0x100;
const VFD_RECV = 0x103;
const RESP_OK = 0x1000;
const RESP_VFD_NEW = 0x1001;
const SEND_HDR = 16;
const VFD_HOST_ID_BIT = 0x40000000;

/** Build a ctrl_vfd_send: hdr(type,flags) + vfd_id + vfd_count + [vfds] + data. */
function buildSend(vfdId, data, vfds = []) {
  const b = new Uint8Array(SEND_HDR + vfds.length * 4 + data.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, VFD_SEND, true);
  dv.setUint32(8, vfdId, true);
  dv.setUint32(12, vfds.length, true);
  vfds.forEach((v, i) => dv.setUint32(SEND_HDR + i * 4, v, true));
  b.set(data, SEND_HDR + vfds.length * 4);
  return b;
}

function buildNewAlloc(vfdId, size, pfn = 0) {
  // hdr(8) + vfd_id(4) + flags(4) + pfn(8) + size(4) = 28 bytes.
  // The guest sends its own physical pfn (== linear-memory offset >> PAGE_SHIFT,
  // virt_to_phys identity on nommu); the host records a region over pfn*4096.
  const b = new Uint8Array(28);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, VFD_NEW, true);
  dv.setUint32(8, vfdId, true);
  dv.setBigUint64(16, BigInt(pfn), true);
  dv.setUint32(24, size, true);
  return b;
}

function makeDevice(extra = {}) {
  // Minimal opts — _handle/_resolveShmFd don't touch the vring; injectIn's
  // _flushPendingIn no-ops when the IN queue isn't set up (get → null), leaving
  // the messages queued in _pendingIn where the tests can inspect them.
  return new WlDevice({
    dev: 0,
    irq: 8,
    memory: new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true }),
    raiseInterrupt: () => {},
    sharedQueues: { set() {}, get: () => null, clear() {}, loadLastAvail: () => 0, storeLastAvail() {} },
    log: () => {},
    ...extra,
  });
}

test("VFD_SEND routes OUT to the host bridge FIRE-AND-FORGET; OUT ack is RESP_OK, no inReply", () => {
  const out = [];
  // Phase 4f: the bridge's sendOut is fire-and-forget (void). The compositor's
  // response arrives later, asynchronously, via the host's injectIn — NOT as a
  // synchronous reply here.
  const dev = makeDevice({
    waylandBridge: { sendOut: (cid, data, fds) => out.push({ cid, data, fds }) },
  });
  const payload = new Uint8Array([1, 0, 0, 0, 0xc, 0, 1, 0]); // wl_display.get_registry-ish
  const { resp, inReply } = dev._handle(buildSend(7, payload));
  // OUT ack is RESP_OK, synchronous (the guest's SEND completes on it).
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_OK);
  // No synchronous reply: the bridge path never produces an inReply now.
  expect(inReply).toBeNull();
  // The bytes were posted out, addressed to the ctx vfd_id as clientId.
  expect(out.length).toBe(1);
  expect(out[0].cid).toBe(7);
  expect([...out[0].data]).toEqual([...payload]);
});

test("without a bridge, VFD_SEND falls back to the WlServer stub (Phase 1, still uses inReply)", () => {
  const dev = makeDevice();
  // wl_display.get_registry(new_id=2): obj=1, opcode=1, new_id arg=2.
  const msg = new Uint8Array(12);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, 1, true); // object_id = wl_display
  dv.setUint32(4, (12 << 16) | 1, true); // size<<16 | opcode(get_registry)
  dv.setUint32(8, 2, true); // new_id
  const { resp, inReply } = dev._handle(buildSend(7, msg));
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_OK);
  // The stub produces a registry reply to push over IN.
  expect(inReply).not.toBeNull();
  expect(inReply.vfdId).toBe(7);
  expect(inReply.data.length).toBeGreaterThan(0);
});

test("NEW_ALLOC records a shm region; SEND with that vfd yields a Uint8Array fd view", () => {
  const out = [];
  const dev = makeDevice({ waylandBridge: { sendOut: (cid, data, fds) => out.push({ cid, data, fds }) } });
  // Allocate a shm vfd. The guest passes its physical pfn (2 → offset 8192,
  // within the 4-page test memory); the host returns RESP_VFD_NEW and records a
  // region over pfn*4096. This is the driver's NEW_ALLOC pfn contract (2c).
  const { resp } = dev._handle(buildNewAlloc(9, 4096, /*pfn*/ 2));
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_VFD_NEW);
  // The region resolves at pfn*4096 = 8192 (no manual poke — the offset comes
  // straight from the guest pfn in the NEW_ALLOC request).
  expect(dev.contexts.get(9).region.offset).toBe(8192);
  // wl_shm.create_pool carries the shm vfd in the SEND's trailing fd list.
  dev._handle(buildSend(7, new Uint8Array([0]), [9]));
  expect(out.length).toBe(1);
  expect(out[0].fds.length).toBe(1);
  const fd = out[0].fds[0];
  expect(fd).toBeInstanceOf(Uint8Array);
  expect(fd.byteOffset).toBe(8192);
  expect(fd.byteLength).toBe(4096);
  expect(fd.buffer).toBe(dev.memory.buffer); // a live VIEW, not a copy
});

test("injectIn (bytes only) queues ONE VFD_RECV addressed to the ctx vfd_id", () => {
  const dev = makeDevice();
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  dev.injectIn(7, bytes); // no IN vring set up → stays in _pendingIn
  expect(dev._pendingIn.length).toBe(1);
  const entry = dev._pendingIn[0];
  expect(entry.raw).toBeUndefined();
  expect(entry.vfdId).toBe(7);
  expect([...entry.data]).toEqual([...bytes]);
});

test("injectIn with server→client fds builds VFD_NEW(host-id) per fd + one VFD_RECV", () => {
  const dev = makeDevice();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const keymap = new Uint8Array(1234); // an fd payload (only its length matters)
  dev.injectIn(7, bytes, [keymap]); // → 2 raw ctrl messages: VFD_NEW then VFD_RECV
  expect(dev._pendingIn.length).toBe(2);
  // 1) a host→guest VFD_NEW with the HOST id bit and the keymap byte length.
  const newMsg = dev._pendingIn[0].raw;
  const ndv = new DataView(newMsg.buffer, newMsg.byteOffset, newMsg.byteLength);
  expect(ndv.getUint32(0, true)).toBe(VFD_NEW);
  const newVfdId = ndv.getUint32(8, true);
  expect(newVfdId & VFD_HOST_ID_BIT).toBe(VFD_HOST_ID_BIT);
  expect(ndv.getUint32(24, true)).toBe(keymap.length); // size = keymap length
  // 2) a VFD_RECV on the ctx vfd_id carrying vfd_count=1 referencing that id,
  //    then the wayland bytes.
  const recvMsg = dev._pendingIn[1].raw;
  const rdv = new DataView(recvMsg.buffer, recvMsg.byteOffset, recvMsg.byteLength);
  expect(rdv.getUint32(0, true)).toBe(VFD_RECV);
  expect(rdv.getUint32(8, true)).toBe(7); // ctx vfd_id
  expect(rdv.getUint32(12, true)).toBe(1); // vfd_count
  expect(rdv.getUint32(SEND_HDR, true)).toBe(newVfdId); // the trailing vfd id
  expect([...recvMsg.subarray(SEND_HDR + 4)]).toEqual([...bytes]);
});
