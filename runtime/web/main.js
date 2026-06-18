// main.js — browser demo entry point.
// Boots the linux-wasm guest and renders its console through ghostty-web.
// Artifacts are expected at ./artifacts/ relative to this page (symlink to
// the nix-wasm build output, e.g.:
//   ln -sfn /path/to/pc/vendor/linux-wasm runtime/web/artifacts
// The four required files: vmlinux.wasm, initramfs.cpio.gz, store.json, nix-cache/
import { init, Terminal, FitAddon } from "./vendor/ghostty/ghostty.mjs";
import { bootNixSystem, MemVfs } from "../index.js";

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

  const vfs = MemVfs.from({ Home: {} });
  // Artifacts served from the same origin as this page.
  const baseUrl = new URL("./artifacts/", document.baseURI).href;
  const handle = await bootNixSystem({ vfs, baseUrl, nix: true });

  const con = handle.console(0);
  con.onData((bytes) => {
    window._termLog += dec.decode(bytes, { stream: true });
    term.write(bytes);
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
