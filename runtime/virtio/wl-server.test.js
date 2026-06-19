// @ts-nocheck
// wl-server.test.js — unit tests for the minimal host Wayland server's wire
// parsing + event generation (Wayland Phase 1 1d). Pure, browser-free; runs
// under `bun test`.
import { test, expect } from "bun:test";
import { WlServer, _internals } from "./wl-server.js";

const { buildMessage, align4 } = _internals;

function u32(dv, off) {
  return dv.getUint32(off, true);
}

test("align4 rounds up to 4", () => {
  expect(align4(0)).toBe(0);
  expect(align4(1)).toBe(4);
  expect(align4(4)).toBe(4);
  expect(align4(5)).toBe(8);
});

test("buildMessage encodes header (object id + size<<16|opcode)", () => {
  const m = buildMessage(2, 0, [{ u32: 7 }]);
  const dv = new DataView(m.buffer);
  expect(u32(dv, 0)).toBe(2); // object id
  const so = u32(dv, 4);
  expect(so >>> 16).toBe(12); // size = 8 header + 4 arg
  expect(so & 0xffff).toBe(0); // opcode
  expect(u32(dv, 8)).toBe(7); // arg
  expect(m.length).toBe(12);
});

test("buildMessage encodes a string arg padded to 4", () => {
  const m = buildMessage(1, 0, [{ str: "wl_shm" }]);
  const dv = new DataView(m.buffer);
  // "wl_shm" = 6 bytes + NUL = 7, padded to 8. total = 8 hdr + 4 len + 8 = 20
  expect(m.length).toBe(20);
  expect(u32(dv, 4) >>> 16).toBe(20);
  expect(u32(dv, 8)).toBe(7); // string length incl NUL
  expect(new TextDecoder().decode(m.subarray(12, 18))).toBe("wl_shm");
  expect(m[18]).toBe(0); // NUL
});

// Build a get_registry(new_id=2) request like libwayland/wlclient sends.
function getRegistryReq(registryId = 2) {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1, true); // wl_display
  dv.setUint32(4, ((12 << 16) | 1) >>> 0, true); // size<<16 | get_registry(1)
  dv.setUint32(8, registryId, true);
  return b;
}

function syncReq(callbackId = 3) {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1, true); // wl_display
  dv.setUint32(4, ((12 << 16) | 0) >>> 0, true); // sync(0)
  dv.setUint32(8, callbackId, true);
  return b;
}

// Parse a stream of wayland messages into {objectId, opcode, size}.
function parseMessages(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let off = 0;
  while (off + 8 <= bytes.length) {
    const objectId = dv.getUint32(off, true);
    const so = dv.getUint32(off + 4, true);
    const size = so >>> 16;
    const opcode = so & 0xffff;
    out.push({ objectId, opcode, size, off });
    off += size;
  }
  return out;
}

test("get_registry emits one wl_registry.global per advertised global", () => {
  const s = new WlServer();
  const reply = s.handle(getRegistryReq(2));
  const msgs = parseMessages(reply);
  expect(msgs.length).toBe(_internals.GLOBALS.length);
  // all addressed to the registry object (id 2), opcode 0 (global)
  for (const m of msgs) {
    expect(m.objectId).toBe(2);
    expect(m.opcode).toBe(0);
  }
  expect(s.globalsSeen).toBe(_internals.GLOBALS.length);
});

test("global events carry name/interface/version readable back", () => {
  const s = new WlServer();
  const reply = s.handle(getRegistryReq(2));
  const dv = new DataView(reply.buffer);
  // first global event body starts at offset 8
  const name = dv.getUint32(8, true);
  const strLen = dv.getUint32(12, true);
  const iface = new TextDecoder().decode(reply.subarray(16, 16 + strLen - 1));
  expect(name).toBe(_internals.GLOBALS[0].name);
  expect(iface).toBe(_internals.GLOBALS[0].interface);
});

test("sync emits wl_callback.done + wl_display.delete_id", () => {
  const s = new WlServer();
  const reply = s.handle(syncReq(3));
  const msgs = parseMessages(reply);
  expect(msgs.length).toBe(2);
  // wl_callback.done addressed to callback id 3, opcode 0
  expect(msgs[0].objectId).toBe(3);
  expect(msgs[0].opcode).toBe(0);
  // wl_display.delete_id addressed to wl_display (1), opcode 1
  expect(msgs[1].objectId).toBe(1);
  expect(msgs[1].opcode).toBe(1);
});

test("a get_registry + sync in one buffer is handled as a stream", () => {
  const s = new WlServer();
  const stream = new Uint8Array(getRegistryReq(2).length + syncReq(3).length);
  stream.set(getRegistryReq(2), 0);
  stream.set(syncReq(3), getRegistryReq(2).length);
  const reply = s.handle(stream);
  const msgs = parseMessages(reply);
  // N globals + done + delete_id
  expect(msgs.length).toBe(_internals.GLOBALS.length + 2);
});

test("bind records the new id without erroring", () => {
  const s = new WlServer();
  s.handle(getRegistryReq(2)); // create registry 2
  // wl_registry.bind(name=2, interface="wl_shm", version=1, new_id=5)
  const iface = "wl_shm";
  const ib = new TextEncoder().encode(iface);
  const ilen = ib.length + 1;
  const body = 4 + 4 + align4(ilen) + 4 + 4;
  const b = new Uint8Array(8 + body);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 2, true); // registry object
  dv.setUint32(4, (((8 + body) << 16) | 0) >>> 0, true); // bind(0)
  let off = 8;
  dv.setUint32(off, 2, true); // name
  off += 4;
  dv.setUint32(off, ilen, true);
  off += 4;
  b.set(ib, off);
  off += align4(ilen);
  dv.setUint32(off, 1, true); // version
  off += 4;
  dv.setUint32(off, 5, true); // new_id
  const reply = s.handle(b);
  expect(reply.length).toBe(0); // bind produces no event
  expect(s.boundIds.has(5)).toBe(true);
});
