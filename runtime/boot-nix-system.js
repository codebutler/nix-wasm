// boot-nix-system.js — the high-level boot every consumer uses. Resolves the
// nix-wasm build artifacts under a single baseUrl, wires the read-only squashfs
// base-system image (virtio-blk) + /nix-cache binary cache, then boots. Returns
// the same handle as bootLinux.
//
// Artifact layout under baseUrl (nix-wasm's build-output contract):
//   vmlinux.wasm  initramfs.cpio.gz  base.squashfs  nix-cache/
import { bootLinux } from "./boot.js";
import { createNixCacheExport } from "./nix-cache.js";

/**
 * @param {{
 *   vfs: any,
 *   baseUrl: string|URL,              // dir holding the artifacts (trailing slash optional)
 *   squashfs?: ArrayBuffer | (() => Promise<ArrayBuffer>),  // pc's disc-package system passes the verified, persisted bytes; standalone harnesses/dev/CI omit it and we fetch base.squashfs from baseUrl
 *   onDownload?: (ev: any) => void,   // reserved (was lazy-blob fetch progress from the closure store)
 *   onModuleCached?: () => void,      // a streamed user binary finished compiling+caching host-side (close a "loading <tool>…" indicator)
 *   consoleCount?: number,
 *   cmdline?: string,
 *   onLog?: (text: string) => void,
 *   nix?: boolean,                    // default true; false → busybox-only, no /nix
 *   wayland?: { sendOut: (clientId:number, buffer:Uint8Array, fds:Uint8Array[])=>void, onClose?: (clientId:number)=>void },  // Phase 4f: worker→main Greenfield bridge (fire-and-forget); onClose = guest closed a ctx
 * }} opts
 * @returns {ReturnType<import('./boot.js').bootLinux>}
 */
export async function bootNixSystem(opts) {
  const base = new URL(
    String(opts.baseUrl).endsWith("/") ? String(opts.baseUrl) : String(opts.baseUrl) + "/",
    // absolute baseUrl is used as-is; this resolves relative ones against cwd-style callers
    "file:///",
  );
  const u = (p) => new URL(p, base).href;
  const useNix = opts.nix !== false;

  // The base store squashfs: pc's disc-package system passes the verified,
  // persisted bytes via opts.squashfs (ArrayBuffer or a provider fn); standalone
  // harnesses/dev/CI omit it and we fetch base.squashfs from baseUrl.
  let squashfs;
  if (useNix) {
    if (typeof opts.squashfs === "function") squashfs = await opts.squashfs();
    else if (opts.squashfs) squashfs = opts.squashfs;
    else squashfs = await (await fetch(u("base.squashfs"))).arrayBuffer();
  }

  return bootLinux({
    vfs: opts.vfs,
    vmlinuxUrl: u("vmlinux.wasm"),
    initrdUrl: u("initramfs.cpio.gz"),
    consoleCount: opts.consoleCount,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
    onModuleCached: opts.onModuleCached,
    wayland: opts.wayland,
    squashfs,
    nixCache: useNix ? createNixCacheExport(u("nix-cache")) : undefined,
  });
}
