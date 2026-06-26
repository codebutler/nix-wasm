// main.js — browser demo entry point.
// Boots the linux-wasm guest, renders its console through ghostty-web, and wires
// the Greenfield Wayland compositor so GTK apps (galculator, gtk-hello, …) open
// as floating draggable windows on the page.
//
// Artifacts are expected at ./artifacts/ relative to this page (symlink to the
// nix-wasm build output, e.g.:
//   ln -sfn /path/to/nix-wasm/.artifacts runtime/web/artifacts
// The required files: vmlinux.wasm, initramfs.cpio.gz, base.squashfs, nix-cache/
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
  // Artifacts served from the same origin as this page. A PR preview ships a
  // ./preview.json that points at its content-addressed cas/<buildhash>/ prefix;
  // local dev has no preview.json and uses the ./artifacts/ symlink.
  let baseUrl = new URL("./artifacts/", document.baseURI).href;
  try {
    const r = await fetch("./preview.json", { cache: "no-store" });
    if (r.ok) {
      const { artifactsBase } = await r.json();
      if (artifactsBase) baseUrl = new URL(artifactsBase, document.baseURI).href;
    }
  } catch {
    // no preview.json (local dev) — keep ./artifacts/
  }
  const handle = await bootNixSystem({
    vfs,
    baseUrl,
    nix: true,
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
  // control shell to start waylandproxyd. Fire-and-forget.
  const wlConsole = handle.console(handle.consoleCount - 1);
  const startProxy = () =>
    new Promise((resolve) => {
      // mkdir the dirs the redirect/socket need before using them (the squashfs
      // base may not pre-create /var/log on a fresh boot).
      wlConsole.write("mkdir -p /tmp /var/log\n");
      wlConsole.write("export XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0\n");
      wlConsole.write("waylandproxyd >/var/log/waylandproxyd.log 2>&1 &\n");
      setTimeout(resolve, 1000);
    });

  const con = handle.console(0);
  let proxyStarted = false;
  let bootBuf = "";
  con.onData((bytes) => {
    const s = dec.decode(bytes, { stream: true });
    window._termLog += s;
    term.write(bytes);
    // Start the proxy once the autologin SHELL is actually up — NOT on the first
    // byte. hvc is a kernel console (`console=hvc` in the cmdline), so hvc0's first
    // output is the kernel boot log, emitted long before getty/autologin spawns a
    // shell on the reserved control console; writing the proxy commands then drops
    // them on the floor (no shell to read them → no proxy → "cannot open display").
    // Wait for hvc0's shell prompt (autologin done across all consoles), then a beat
    // for the control console to settle, before driving it.
    if (!proxyStarted) {
      bootBuf += s;
      if (/root@[^\n]*#/.test(bootBuf)) {
        proxyStarted = true;
        setTimeout(
          () => startProxy().catch((e) => console.warn("[wayland] proxy start failed", e)),
          1500,
        );
      }
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
