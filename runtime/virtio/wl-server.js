// wl-server.js — a MINIMAL host-side Wayland SERVER, just enough to answer a
// registry handshake (Linux/Wasm, "pc" Wayland Phase 1 1d). NOT a compositor:
// no surfaces, no buffers, no rendering (that is Phase 2 / Greenfield). It speaks
// just enough of the wl_display / wl_registry / wl_callback protocol that a stock
// libwayland client's wl_display_connect() + wl_display_get_registry() +
// wl_display_roundtrip() + registry enumeration succeed.
//
// Wire format (libwayland, little-endian, host byte order = LE on wasm):
//   message header (8 bytes): u32 object_id; u32 (size<<16)|opcode
//     - size is the TOTAL message size in bytes, header included.
//   args follow, each 32-bit aligned:
//     uint   -> u32
//     new_id -> u32
//     object -> u32
//     string -> u32 length (incl. trailing NUL) + bytes + NUL, padded to 4
//     array  -> u32 length + bytes, padded to 4
//
// Server-side object ids: a client allocates ids in [1, 0xFEFFFFFF]; the server
// allocates ids in [0xFF000000, 0xFFFFFFFF]. The registry's globals are server
// state; the objects the client binds/creates carry client-allocated ids that we
// just record.
//
// This module is browser-free and dependency-light (no DOM / storage) so it can
// be unit-tested under `bun test`.

// --- well-known protocol object / opcodes ----------------------------------
const WL_DISPLAY_ID = 1; // the implicit object every client starts with

// wl_display requests (client -> server)
const WL_DISPLAY_SYNC = 0;
const WL_DISPLAY_GET_REGISTRY = 1;

// wl_display events (server -> client)
const WL_DISPLAY_EVT_DELETE_ID = 1;

// wl_registry requests (client -> server)
const WL_REGISTRY_BIND = 0;

// wl_registry events (server -> client)
const WL_REGISTRY_EVT_GLOBAL = 0;

// wl_callback events (server -> client)
const WL_CALLBACK_EVT_DONE = 0;

// The globals this stub advertises. Real bind handlers come in Phase 2; for the
// handshake the client only needs to SEE them (and optionally bind one, which we
// accept without further protocol). Versions are deliberately conservative.
const GLOBALS = [
  { name: 1, interface: "wl_compositor", version: 4 },
  { name: 2, interface: "wl_shm", version: 1 },
  { name: 3, interface: "wl_seat", version: 5 },
  { name: 4, interface: "xdg_wm_base", version: 2 },
];

const enc = new TextEncoder();

/** Round n up to the next multiple of 4. */
function align4(n) {
  return (n + 3) & ~3;
}

/**
 * Build one Wayland message into a Uint8Array.
 * @param {number} objectId   target object id
 * @param {number} opcode     event opcode
 * @param {Array<{u32?:number, str?:string}>} args  ordered argument list
 */
function buildMessage(objectId, opcode, args) {
  // First pass: compute body size.
  let body = 0;
  for (const a of args) {
    if (a.u32 !== undefined) body += 4;
    else if (a.str !== undefined) {
      const bytes = enc.encode(a.str).length + 1; // + NUL
      body += 4 + align4(bytes);
    }
  }
  const size = 8 + body;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, objectId >>> 0, true);
  dv.setUint32(4, ((size << 16) | (opcode & 0xffff)) >>> 0, true);
  let off = 8;
  for (const a of args) {
    if (a.u32 !== undefined) {
      dv.setUint32(off, a.u32 >>> 0, true);
      off += 4;
    } else if (a.str !== undefined) {
      const sb = enc.encode(a.str);
      const len = sb.length + 1; // includes trailing NUL
      dv.setUint32(off, len, true);
      off += 4;
      buf.set(sb, off);
      // remaining bytes (NUL + padding) are already zero
      off += align4(len);
    }
  }
  return buf;
}

/** Concatenate Uint8Arrays. */
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * A per-connection minimal Wayland server. Feed it the client's request bytes
 * (one SEND may carry several concatenated messages); it returns the reply bytes
 * to push back to the client (may be empty). Keeps the tiny bit of object state
 * the handshake needs.
 */
export class WlServer {
  /** @param {(s:string)=>void} [log] */
  constructor(log) {
    this.log = log || (() => {});
    this.registries = new Set(); // registry object ids the client created
    this.boundIds = new Set(); // ids bound via wl_registry.bind
    this.callbacks = new Set(); // wl_callback ids created via wl_display.sync
    this.globalsSeen = 0; // diagnostic: how many global events we emitted
  }

  /**
   * Process all messages in `bytes` and return the concatenated reply bytes.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array}
   */
  handle(bytes) {
    const replies = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    while (off + 8 <= bytes.length) {
      const objectId = dv.getUint32(off, true);
      const sizeOpcode = dv.getUint32(off + 4, true);
      const size = sizeOpcode >>> 16;
      const opcode = sizeOpcode & 0xffff;
      if (size < 8 || off + size > bytes.length) {
        this.log(`[wl-server] truncated/garbage message at off=${off} size=${size} — stopping`);
        break;
      }
      const body = new Uint8Array(bytes.buffer, bytes.byteOffset + off + 8, size - 8);
      const reply = this._dispatch(objectId, opcode, body);
      if (reply && reply.length) replies.push(reply);
      off += size;
    }
    return replies.length ? concat(replies) : new Uint8Array(0);
  }

  _dispatch(objectId, opcode, body) {
    if (objectId === WL_DISPLAY_ID) {
      if (opcode === WL_DISPLAY_GET_REGISTRY) return this._getRegistry(body);
      if (opcode === WL_DISPLAY_SYNC) return this._sync(body);
      this.log(`[wl-server] wl_display unknown opcode ${opcode}`);
      return null;
    }
    if (this.registries.has(objectId)) {
      if (opcode === WL_REGISTRY_BIND) return this._bind(body);
      this.log(`[wl-server] wl_registry unknown opcode ${opcode}`);
      return null;
    }
    this.log(`[wl-server] request for unknown object ${objectId} opcode ${opcode}`);
    return null;
  }

  /** wl_display.get_registry(new_id registry): record the registry id, emit a
   *  wl_registry.global for each advertised global. */
  _getRegistry(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const registryId = dv.getUint32(0, true);
    this.registries.add(registryId);
    this.log(
      `[wl-server] get_registry -> registry id=${registryId}, advertising ${GLOBALS.length} globals`,
    );
    const parts = [];
    for (const g of GLOBALS) {
      parts.push(
        buildMessage(registryId, WL_REGISTRY_EVT_GLOBAL, [
          { u32: g.name },
          { str: g.interface },
          { u32: g.version },
        ]),
      );
      this.globalsSeen++;
    }
    return concat(parts);
  }

  /** wl_registry.bind(name, interface, version, new_id): record the new id. The
   *  handshake needs nothing further from the bound object. */
  _bind(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    // args: u32 name, string interface, u32 version, new_id (u32)
    const name = dv.getUint32(0, true);
    let off = 4;
    const strLen = dv.getUint32(off, true);
    off += 4 + align4(strLen);
    const version = dv.getUint32(off, true);
    off += 4;
    const newId = dv.getUint32(off, true);
    this.boundIds.add(newId);
    this.log(`[wl-server] bind name=${name} v=${version} -> new id=${newId}`);
    return null; // no event needed for the handshake
  }

  /** wl_display.sync(new_id callback): emit wl_callback.done(serial) then
   *  wl_display.delete_id(callback) so the client frees it. This is what
   *  wl_display_roundtrip() waits on. */
  _sync(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const callbackId = dv.getUint32(0, true);
    this.callbacks.add(callbackId);
    this.log(`[wl-server] sync -> callback id=${callbackId}, emitting done + delete_id`);
    const done = buildMessage(callbackId, WL_CALLBACK_EVT_DONE, [{ u32: 0 /* serial */ }]);
    const del = buildMessage(WL_DISPLAY_ID, WL_DISPLAY_EVT_DELETE_ID, [{ u32: callbackId }]);
    return concat([done, del]);
  }
}

export const _internals = { buildMessage, align4, GLOBALS };
