// main.js — browser demo entry point.
// Boots the linux-wasm guest, renders its console through ghostty-web, and wires
// the Greenfield Wayland compositor so GTK apps (galculator, gtk-hello, …) open
// as floating draggable windows on the page.
//
// Artifacts are expected at ./artifacts/ relative to this page (symlink to the
// nix-wasm build output, e.g.:
//   ln -sfn /path/to/nix-wasm/.artifacts runtime/web/artifacts
// The four required files: vmlinux.wasm, initramfs.cpio.gz, store.json, nix-cache/
import { init, Terminal, FitAddon } from "./vendor/ghostty/ghostty.mjs";
import { bootNixSystem, MemVfs } from "../../index.js";
import { getWaylandCompositor } from "./wayland-compositor.js";

const status = document.getElementById("status");
const dec = new TextDecoder();
const enc = new TextEncoder();

// window._termLog accumulates raw terminal output as a string (ANSI sequences
// included). Smoke tests poll this to detect prompts without needing canvas access.
window._termLog = "";

async function boot() {
  await init();
  const term = new Terminal();
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  fit.fit();

  // Pre-warm the Greenfield compositor in parallel with the kernel boot so it is
  // ready before the guest's waylandproxyd starts up (compositor load is ~12 MB).
  const compositorPromise = getWaylandCompositor().catch((e) => {
    console.error("[wayland] compositor failed to init; Wayland surfaces disabled", e);
    return null;
  });

  const vfs = MemVfs.from({ Home: {} });
  // Artifacts served from the same origin as this page.
  const baseUrl = new URL("./artifacts/", document.baseURI).href;
  // `?nonix` boots busybox-only (no /nix overlay) — a fast boot for smoke tests
  // that only need the initramfs (e.g. the fork acceptance programs). Default is
  // the full nix system.
  const nix = !new URLSearchParams(location.search).has("nonix");
  const handle = await bootNixSystem({
    vfs,
    baseUrl,
    nix,
    wayland: {
      sendOut: async (clientId, buffer, fds) => {
        const c = await compositorPromise;
        if (c) c.feedFromGuest(clientId, buffer, fds);
        else console.warn("[wayland] no compositor; dropping OUT for client", clientId);
      },
      onClose: async (clientId) => {
        const c = await compositorPromise;
        if (c) c.destroyGuestClient(clientId);
      },
    },
  });

  // Once the kernel is up, wire pushIn so Greenfield→guest replies flow back.
  compositorPromise.then((c) => {
    if (c && handle.pushIn) c.setPushIn(handle.pushIn);
  });

  // Mirror pc's ensureWaylandProxy(): use the last hvc console as a hidden
  // control shell to start waylandproxyd. We wait until the user console (hvc0)
  // produces its first output — that means the autologin shell is up on all
  // consoles — then write to the control console and give the proxy 1 s to bind
  // the socket (same pattern as pc's kernel-service.js). Fire-and-forget.
  const wlConsole = handle.console(handle.consoleCount - 1);
  const startProxy = () =>
    new Promise((resolve) => {
      wlConsole.write("export XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0\n");
      wlConsole.write("mkdir -p /tmp\n");
      wlConsole.write("waylandproxyd >/var/log/waylandproxyd.log 2>&1 &\n");
      setTimeout(resolve, 1000);
    });

  const con = handle.console(0);
  let proxyStarted = false;
  con.onData((bytes) => {
    window._termLog += dec.decode(bytes, { stream: true });
    term.write(bytes);
    // Start the proxy on the first byte of output from hvc0 (shell is awake).
    if (!proxyStarted) {
      proxyStarted = true;
      startProxy().catch((e) => console.warn("[wayland] proxy start failed", e));
    }
  });
  term.onData((data) => con.write(typeof data === "string" ? enc.encode(data) : data));
  const sync = () => con.resize(term.cols, term.rows);
  // FitAddon.onResize is available in some versions; guard for compat.
  fit.onResize?.(() => sync());
  window.addEventListener("resize", () => {
    fit.fit();
    sync();
  });
  sync();
  status.remove();
}

boot().catch((e) => {
  status.textContent = "boot failed: " + e.message;
  console.error(e);
});
