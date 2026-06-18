// wl-device.test.js — the Phase 2 (2b) worker→main inversion seam on WlDevice.
// Browser-free: drives _handle() directly (no vring/SharedQueues needed) to
// verify a VFD_SEND routes wayland bytes OUT to the host bridge instead of the
// in-worker WlServer stub, and that the OUT ack stays synchronous (the reply is
// async via injectIn). Also checks the Phase-1 fallback (no bridge → stub) is
// intact so the 1d handshake path still works.
import { test, expect } from "bun:test";
import { WlDevice } from "./wl-device.js";

// virtwl ctrl types / responses (mirror wl-device.js).
const VFD_SEND = 0x102;
const VFD_NEW = 0x100;
const NEW_CTX = 0x104;
const RESP_OK = 0x1000;
const RESP_VFD_NEW = 0x1001;
const SEND_HDR = 16;

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

function buildNewAlloc(vfdId, size) {
  // hdr(8) + vfd_id(4) + flags(4) + pfn(8) + size(4) = 28 bytes.
  const b = new Uint8Array(28);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, VFD_NEW, true);
  dv.setUint32(8, vfdId, true);
  dv.setUint32(24, size, true);
  return b;
}

function makeDevice(extra = {}) {
  // Minimal opts — _handle/_resolveShmFd don't touch the vring; only memory is
  // needed for shm views.
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

test("VFD_SEND routes OUT to the host bridge; the SYNCHRONOUS reply becomes the inReply", () => {
  const out = [];
  // The bridge's onOut is synchronous: it returns the compositor's reply bytes
  // (in the worker it blocks on the SAB until the main thread fills them).
  const reply = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
  const dev = makeDevice({
    waylandBridge: {
      onOut: (cid, data, fds) => {
        out.push({ cid, data, fds });
        return reply;
      },
    },
  });
  const payload = new Uint8Array([1, 0, 0, 0, 0xc, 0, 1, 0]); // wl_display.get_registry-ish
  const { resp, inReply } = dev._handle(buildSend(7, payload));
  // OUT ack is RESP_OK, synchronous.
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_OK);
  // The bytes were posted out, addressed to the ctx vfd_id as clientId.
  expect(out.length).toBe(1);
  expect(out[0].cid).toBe(7);
  expect([...out[0].data]).toEqual([...payload]);
  // The synchronous reply is returned as the inReply for the OUT-service path to
  // inject into the IN vring (in the same worker, so raise_interrupt works).
  expect(inReply).not.toBeNull();
  expect(inReply.vfdId).toBe(7);
  expect([...inReply.data]).toEqual([...reply]);
});

test("VFD_SEND with a bridge returning no reply yields no inReply", () => {
  const dev = makeDevice({ waylandBridge: { onOut: () => null } });
  const { resp, inReply } = dev._handle(buildSend(7, new Uint8Array([1, 0, 0, 0, 8, 0, 0, 0])));
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_OK);
  expect(inReply).toBeNull();
});

test("without a bridge, VFD_SEND falls back to the WlServer stub (Phase 1)", () => {
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
  const dev = makeDevice({ waylandBridge: { onOut: (cid, data, fds) => out.push({ cid, data, fds }) } });
  // Allocate a shm vfd. The host returns RESP_VFD_NEW; record the region.
  const { resp } = dev._handle(buildNewAlloc(9, 4096));
  expect(new DataView(resp.buffer).getUint32(0, true)).toBe(RESP_VFD_NEW);
  // Force a backed offset so the view resolves (the real offset comes from the
  // driver's pfn contract in 2c; here we assert the resolution arithmetic).
  dev.contexts.get(9).region.offset = 8192;
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
