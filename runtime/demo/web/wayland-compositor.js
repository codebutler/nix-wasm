// web/wayland-compositor.js — self-contained Greenfield Wayland compositor for
// the standalone browser demo. Adapted from pc's js/linux/wayland-compositor.js;
// replaces the pc cb-window layer (mountWindow/closeWindow/activateWindow) with
// bare DOM <div> floating windows so this file has zero non-Greenfield deps.
//
// Each guest Wayland surface → a draggable <div> with a titlebar + <canvas>.
// The canvas is sized to the surface's committed buffer (pixelated 1:1 render).
// Input: pointer + keyboard forwarded from the canvas to the Greenfield seat.
//
// Usage (from main.js):
//   import { getWaylandCompositor } from "./wayland-compositor.js";
//   const c = await getWaylandCompositor();
//   const handle = await bootNixSystem({ ..., wayland: {
//     sendOut: (id, buf, fds) => c.feedFromGuest(id, buf, fds),
//     onClose:  (id)        => c.destroyGuestClient(id),
//   }});
//   c.setPushIn(handle.pushIn);
import { initWasm, createCompositorSession } from "./vendor/greenfield/greenfield.mjs";

/** @type {Promise<WaylandCompositor> | null} */
let sessionPromise = null;

/**
 * Boot (or return) the Greenfield compositor. Idempotent — concurrent callers
 * share one in-flight boot.
 * @returns {Promise<WaylandCompositor>}
 */
export function getWaylandCompositor() {
  return (sessionPromise ||= boot());
}

async function boot() {
  // Load the inlined Emscripten wasm libs (libpixman / libxkbcommon).
  await initWasm();

  // floating = built-in xdg_toplevel move/resize semantics (what GTK apps expect)
  const session = await createCompositorSession({ mode: "floating" });
  session.userShell.events.notify = (variant, message) =>
    console.warn("[greenfield]", variant, message);

  // Greenfield needs ONE driver canvas for its renderer. Keep it off-screen.
  const driverCanvas = document.createElement("canvas");
  driverCanvas.width = 1;
  driverCanvas.height = 1;
  Object.assign(driverCanvas.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    width: "1px",
    height: "1px",
    pointerEvents: "none",
  });
  document.body.appendChild(driverCanvas);
  session.userShell.actions.initScene(() => ({ canvas: driverCanvas, id: "driver" }));

  // Advertise wl_compositor / wl_shm / wl_seat / xdg_wm_base.
  session.globals.register();

  // key → SurfaceRecord
  /** @type {Map<string, {canvas: HTMLCanvasElement|null, ctx: CanvasRenderingContext2D|null, win: HTMLElement|null, pending: object[]|null, cs: any, clientId: any, destroying: boolean}>} */
  const surfaces = new Map();
  /** @type {Map<string, {title?:string, appId?:string}>} */
  const titleMeta = new Map();
  const keyOf = (cs) => `${cs.client.id}:${cs.id}`;
  const metaFor = (key) => {
    let m = titleMeta.get(key);
    if (!m) titleMeta.set(key, (m = {}));
    return m;
  };
  const bestTitle = (key) => {
    const m = titleMeta.get(key);
    return (m && (m.title || m.appId)) || "Wayland";
  };

  // --- DOM windowing ---------------------------------------------------------
  // Each surface gets a floating <div class="wl-win"> with a draggable titlebar
  // and a <canvas> body. Windows stack by z-index (click to raise).

  const container =
    document.getElementById("wl-windows") ||
    (() => {
      const el = document.createElement("div");
      el.id = "wl-windows";
      Object.assign(el.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "10",
      });
      document.body.appendChild(el);
      return el;
    })();

  // Inject minimal styles once.
  if (!document.getElementById("wl-win-style")) {
    const s = document.createElement("style");
    s.id = "wl-win-style";
    s.textContent = `
      .wl-win {
        position: absolute;
        display: flex;
        flex-direction: column;
        border: 1px solid #555;
        background: #1e1e1e;
        box-shadow: 0 4px 24px #0008;
        pointer-events: auto;
        min-width: 80px;
        min-height: 40px;
      }
      .wl-win-titlebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #2d2d2d;
        padding: 0 6px;
        height: 24px;
        cursor: move;
        user-select: none;
        flex-shrink: 0;
      }
      .wl-win-title { color: #ccc; font: 12px/24px system-ui, sans-serif; }
      .wl-win-close {
        color: #aaa;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 14px;
        line-height: 24px;
        padding: 0 2px;
      }
      .wl-win-close:hover { color: #fff; }
      .wl-win canvas {
        display: block;
        image-rendering: pixelated;
        flex: 1;
        outline: none;
      }
    `;
    document.head.appendChild(s);
  }

  let nextZ = 100;
  let winCount = 0;

  function mountSurfaceWindow(record, key) {
    const win = document.createElement("div");
    win.className = "wl-win";
    win.style.left = 80 + (winCount % 5) * 30 + "px";
    win.style.top = 80 + (winCount % 5) * 30 + "px";
    win.style.zIndex = String(nextZ++);
    winCount++;

    const titlebar = document.createElement("div");
    titlebar.className = "wl-win-titlebar";

    const titleEl = document.createElement("span");
    titleEl.className = "wl-win-title";
    titleEl.textContent = bestTitle(key);

    const closeBtn = document.createElement("button");
    closeBtn.className = "wl-win-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => {
      if (record.destroying) {
        win.remove();
        return;
      }
      record.destroying = true;
      try {
        session.userShell.actions.requestSurfaceClose(record.cs);
      } catch {
        win.remove();
      }
      // Safety net in case the guest ignores close.
      setTimeout(() => {
        if (!surfaces.has(key)) return;
        try {
          session.userShell.actions.closeClient({ id: record.clientId });
        } catch {}
        win.remove();
      }, 2000);
    });

    titlebar.appendChild(titleEl);
    titlebar.appendChild(closeBtn);
    win.appendChild(titlebar);

    // Draggable titlebar.
    let drag = null;
    titlebar.addEventListener("pointerdown", (ev) => {
      if (ev.target === closeBtn) return;
      drag = { x: ev.clientX - win.offsetLeft, y: ev.clientY - win.offsetTop };
      titlebar.setPointerCapture(ev.pointerId);
      win.style.zIndex = String(nextZ++);
    });
    titlebar.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      win.style.left = ev.clientX - drag.x + "px";
      win.style.top = ev.clientY - drag.y + "px";
    });
    titlebar.addEventListener("pointerup", () => {
      drag = null;
    });
    titlebar.addEventListener("pointercancel", () => {
      drag = null;
    });

    // Click anywhere on the window to raise it.
    win.addEventListener("pointerdown", () => {
      win.style.zIndex = String(nextZ++);
    });

    // Surface canvas.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    win.appendChild(canvas);
    container.appendChild(win);

    const ctx = canvas.getContext("2d");
    record.win = win;
    record.canvas = canvas;
    record.ctx = ctx;
    record._titleEl = titleEl;

    wireInput(record);

    // Drain any frames queued before the window was ready.
    const pending = record.pending;
    record.pending = null;
    for (const content of pending) paintSurface(record, content);
  }

  // --- popup overlays (xdg_popup / subsurface) -------------------------------
  // Combobox dropdowns, menus, tooltips are child surfaces positioned relative to
  // their parent. They are not desktop surfaces (no titlebar, not draggable), so
  // they get a bare absolutely-positioned <canvas> overlay in `container`, anchored
  // to the parent window's content canvas + the popup's parent-relative offset.
  function mountPopupOverlay(key, parent) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    Object.assign(canvas.style, {
      position: "fixed",
      zIndex: String(100000 + nextZ++),
      boxShadow: "0 4px 24px #0008",
      imageRendering: "pixelated",
      pointerEvents: "none", // input is routed through Greenfield, not the DOM
    });
    container.appendChild(canvas);
    const record = {
      win: canvas, // surfaceDestroyed removes record.win
      canvas,
      ctx: canvas.getContext("2d"),
      pending: null,
      isPopup: true,
      parentKey: `${parent.client}:${parent.id}`,
      destroying: false,
    };
    surfaces.set(key, record);
    return record;
  }

  function positionPopupOverlay(record, parent) {
    const parentRec = surfaces.get(record.parentKey);
    const anchor = parentRec?.canvas;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const sx = r.width / (anchor.width || 1); // CSS px per buffer px
    const sy = r.height / (anchor.height || 1);
    record.canvas.style.left = r.left + (parent?.dx ?? 0) * sx + "px";
    record.canvas.style.top = r.top + (parent?.dy ?? 0) * sy + "px";
    // Match the parent's on-screen scale so the popup lines up 1:1.
    record._scale = { sx, sy };
  }

  // --- input forwarding (canvas → Greenfield seat) ---------------------------

  function surfaceCoords(record, ev) {
    const { canvas } = record;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
      y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function wireInput(record) {
    const { canvas, cs } = record;
    if (!canvas) return;
    const actions = session.userShell.actions;
    const focus = () => {
      try {
        actions.activateSurface?.(cs);
      } catch {}
    };
    canvas.addEventListener("pointermove", (ev) => {
      const p = surfaceCoords(record, ev);
      if (!p) return;
      try {
        actions.pointerMotion(cs, p.x, p.y);
      } catch {}
    });
    canvas.addEventListener("pointerenter", focus);
    // Map browser MouseEvent.button (0 left / 1 middle / 2 right) to Greenfield's
    // ButtonCode enum (MAIN/AUX/SECONDARY = 0/1/2). Ignore other buttons.
    const toButtonCode = (b) => (b === 0 || b === 1 || b === 2 ? b : null);
    canvas.addEventListener("pointerdown", (ev) => {
      focus();
      canvas.focus();
      const code = toButtonCode(ev.button);
      if (code === null) return;
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {}
      try {
        actions.pointerButton(cs, code, false);
      } catch {}
    });
    canvas.addEventListener("pointerup", (ev) => {
      const code = toButtonCode(ev.button);
      if (code === null) return;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {}
      try {
        actions.pointerButton(cs, code, true);
      } catch {}
    });
    canvas.addEventListener("pointerleave", () => {
      try {
        actions.pointerLeave?.(cs);
      } catch {}
    });
    canvas.addEventListener("keydown", (ev) => {
      try {
        actions.notifyKey(ev, true);
      } catch {}
    });
    canvas.addEventListener("keyup", (ev) => {
      try {
        actions.notifyKey(ev, false);
      } catch {}
    });
  }

  // --- surface lifecycle events ----------------------------------------------

  const events = session.userShell.events;

  events.surfaceCreated = (compositorSurface) => {
    const key = keyOf(compositorSurface);
    if (surfaces.has(key)) return;
    const record = {
      win: null,
      canvas: null,
      ctx: null,
      pending: [],
      cs: compositorSurface,
      clientId: String(compositorSurface.client?.id),
      destroying: false,
      _titleEl: null,
    };
    surfaces.set(key, record);
    mountSurfaceWindow(record, key);
  };

  events.surfaceContentUpdated = (compositorSurface, content) => {
    const key = keyOf(compositorSurface);
    let record = surfaces.get(key);
    // A child surface (xdg_popup / subsurface — combobox dropdowns, menus) carries
    // `content.parent`. It is NOT a desktop surface, so surfaceCreated never fired;
    // mount it lazily as a positioned overlay anchored to its parent window.
    if (!record && content.parent) {
      record = mountPopupOverlay(key, content.parent);
    }
    if (!record) return;
    if (!record.ctx) {
      if (record.pending) record.pending = [content]; // coalesce
      return;
    }
    if (record.isPopup) {
      positionPopupOverlay(record, content.parent);
      paintSurface(record, content);
      const s = record._scale || { sx: 1, sy: 1 };
      record.canvas.style.width = record.canvas.width * s.sx + "px";
      record.canvas.style.height = record.canvas.height * s.sy + "px";
      return;
    }
    paintSurface(record, content);
  };

  events.surfaceTitleUpdated = (compositorSurface, title) => {
    const key = keyOf(compositorSurface);
    metaFor(key).title = title;
    const record = surfaces.get(key);
    if (record?._titleEl) record._titleEl.textContent = title || metaFor(key).appId || "Wayland";
  };

  events.surfaceAppIdUpdated = (compositorSurface, appId) => {
    const key = keyOf(compositorSurface);
    metaFor(key).appId = appId;
    const record = surfaces.get(key);
    if (record?._titleEl && !metaFor(key).title) record._titleEl.textContent = appId;
  };

  events.surfaceActivationUpdated = (compositorSurface, active) => {
    if (!active) return;
    const record = surfaces.get(keyOf(compositorSurface));
    if (record?.win) record.win.style.zIndex = String(nextZ++);
  };

  events.surfaceDestroyed = (compositorSurface) => {
    const key = keyOf(compositorSurface);
    const record = surfaces.get(key);
    if (!record) return;
    surfaces.delete(key);
    titleMeta.delete(key);
    record.destroying = true;
    record.win?.remove();
  };

  // --- guest wl-wire bridge (mirrors pc's Phase 4f wiring) -------------------
  //
  // feedFromGuest  — guest VFD_SEND bytes → Greenfield client.connection.message()
  // setPushIn      — install the kernel handle's pushIn so Greenfield→guest replies flow back
  // destroyGuestClient — guest closed the ctx; tear down Greenfield client + windows

  /** clientId (string) → { client } */
  const guestClients = new Map();

  /** @type {((clientId: string|number, bytes: Uint8Array, fds?: Uint8Array[]) => void) | null} */
  let pushIn = null;

  function guestClientFor(clientId) {
    const key = String(clientId);
    let entry = guestClients.get(key);
    if (entry) return entry;
    const client = session.display.createClient(key);
    client.userData = { inputOutput: makeGuestInputOutput() };
    entry = { client };
    guestClients.set(key, entry);
    client.connection.onFlush = (wireMessages) => {
      let total = 0;
      for (const m of wireMessages) total += m.bufferOffset ?? m.buffer.byteLength;
      const out = new Uint8Array(total);
      let off = 0;
      const fdPayloads = [];
      for (const m of wireMessages) {
        const len = m.bufferOffset ?? m.buffer.byteLength;
        out.set(new Uint8Array(m.buffer, 0, len), off);
        off += len;
        for (const fd of m.fds || []) {
          const payload = guestFdPayload(fd);
          if (payload) fdPayloads.push(payload);
          else console.warn("[wayland] server→client fd is not a guest carrier; dropping", fd);
        }
      }
      if (!out.length && !fdPayloads.length) return;
      if (pushIn) pushIn(key, out, fdPayloads.length ? fdPayloads : undefined);
      else console.warn("[wayland] no pushIn yet; dropping", out.length, "B server→guest");
    };
    client.onClose?.().then?.(() => guestClients.delete(key));
    return entry;
  }

  function feedFromGuest(clientId, buffer, fds) {
    const { client } = guestClientFor(clientId);
    const aligned = buffer.byteLength % 4 === 0 ? buffer : padTo4(buffer);
    const u32 = new Uint32Array(
      aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength),
    );
    try {
      client.connection.message({ buffer: u32, fds: fds || [] });
    } catch (e) {
      console.error(`[wayland] feedFromGuest failed for client=${clientId}`, e);
    }
  }

  function destroyGuestClient(clientId) {
    const key = String(clientId);
    guestClients.delete(key);
    try {
      session.userShell.actions.closeClient({ id: key });
    } catch {}
    for (const [k, rec] of surfaces) {
      if (rec.clientId !== key) continue;
      surfaces.delete(k);
      titleMeta.delete(k);
      rec.destroying = true;
      rec.win?.remove();
    }
  }

  /** @type {WaylandCompositor} */
  const compositor = {
    feedFromGuest,
    destroyGuestClient,
    setPushIn(fn) {
      pushIn = fn;
    },
  };
  return compositor;
}

// --- server→client fd passing (keymap carrier) --------------------------------
// Mirrors pc's wayland-compositor.js exactly.

const GUEST_FD_TAG = Symbol("guest-fd");

function makeGuestInputOutput() {
  return {
    async mkstempMmap(data) {
      const bytes = new Uint8Array(await data.arrayBuffer());
      return makeCarrier(bytes);
    },
    async mkfifo() {
      throw new Error("[wayland] mkfifo unsupported");
    },
    wrapFD(fd) {
      if (fd instanceof Uint8Array) return makeCarrier(fd);
      throw new Error("[wayland] wrapFD unsupported");
    },
  };
}

function makeCarrier(bytes) {
  const carrier = {
    [GUEST_FD_TAG]: bytes,
    async write() {},
    async read() {
      return new Blob([bytes]);
    },
    async readBlob() {
      return new Blob([bytes]);
    },
    async readStream() {
      return new Blob([bytes]).stream();
    },
    async close() {},
  };
  carrier.fd = carrier;
  return carrier;
}

function guestFdPayload(fd) {
  if (fd && fd[GUEST_FD_TAG]) return fd[GUEST_FD_TAG];
  if (fd && fd.fd && fd.fd[GUEST_FD_TAG]) return fd.fd[GUEST_FD_TAG];
  return null;
}

function padTo4(buf) {
  const padded = new Uint8Array((buf.byteLength + 3) & ~3);
  padded.set(buf);
  return padded;
}

function paintSurface(record, content) {
  const { bitmap, width, height } = content;
  const w = width || bitmap.width;
  const h = height || bitmap.height;
  const { canvas, ctx } = record;
  if (!canvas || !ctx) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
}
