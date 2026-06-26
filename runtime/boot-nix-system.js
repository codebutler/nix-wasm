// boot-nix-system.js — the high-level boot every consumer uses. Two artifact
// sources:
//   • bytes-mode (pc#315): the caller passes vmlinux/initramfs/squashfs bytes
//     (read out of the mounted `linux` image — offline-capable) and a
//     `nixCacheBaseUrl` (the lazy R2 toolchain cache).
//   • baseUrl-mode (standalone harnesses/dev/CI): everything is fetched from a
//     single baseUrl holding vmlinux.wasm / initramfs.cpio.gz / base.squashfs /
//     nix-cache/.
// Returns the same handle as bootLinux.
//
// NOTE: bytes-mode uses URL.createObjectURL + fetch(blob:) — available in the
// browser/worker (where pc runs) and in bun; not in plain Node. Node harnesses
// use baseUrl-mode.
import { bootLinux } from "./boot.js";
import { createNixCacheExport } from "./nix-cache.js";

/**
 * @param {{
 *   vfs: any,
 *   baseUrl?: string|URL,             // baseUrl-mode: dir holding the artifacts
 *   vmlinux?: ArrayBuffer|Blob,       // bytes-mode: kernel wasm bytes
 *   initramfs?: ArrayBuffer|Blob,     // bytes-mode: initramfs.cpio.gz bytes
 *   squashfs?: ArrayBuffer | (() => Promise<ArrayBuffer>),
 *   nixCacheBaseUrl?: string,         // bytes-mode: the lazy nix-cache base URL
 *   onModuleCached?: () => void,
 *   consoleCount?: number,
 *   cmdline?: string,
 *   onLog?: (text: string) => void,
 *   nix?: boolean,                    // default true; false → busybox-only, no /nix
 *   wayland?: { sendOut: (clientId:number, buffer:Uint8Array, fds:Uint8Array[])=>void, onClose?: (clientId:number)=>void },
 *   vsock?: { onReady: (device: import("./virtio/vsock-device.js").VsockVirtioDevice) => void },  // issue #10 option 3: AF_VSOCK /Ctl bridge hook, passed through to bootLinux
 *   _bootLinux?: typeof bootLinux,    // test seam
 * }} opts
 * @returns {ReturnType<import('./boot.js').bootLinux>}
 */
export async function bootNixSystem(opts) {
  const bl = opts._bootLinux || bootLinux;
  const useNix = opts.nix !== false;

  const hasBaseUrl = opts.baseUrl != null;
  const base = hasBaseUrl
    ? new URL(
        String(opts.baseUrl).endsWith("/") ? String(opts.baseUrl) : String(opts.baseUrl) + "/",
        "file:///",
      )
    : null;
  const u = (p) => new URL(p, base).href;

  const toUrl = (bytesOrBlob) =>
    URL.createObjectURL(bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob]));

  const vmlinuxUrl = opts.vmlinux != null ? toUrl(opts.vmlinux) : u("vmlinux.wasm");
  const initrdUrl = opts.initramfs != null ? toUrl(opts.initramfs) : u("initramfs.cpio.gz");

  // The base store squashfs: caller-provided bytes (pc) or fetched from baseUrl.
  let squashfs;
  if (useNix) {
    if (typeof opts.squashfs === "function") squashfs = await opts.squashfs();
    else if (opts.squashfs) squashfs = opts.squashfs;
    else squashfs = await (await fetch(u("base.squashfs"))).arrayBuffer();
  }

  const nixCacheBase =
    opts.nixCacheBaseUrl != null ? opts.nixCacheBaseUrl : hasBaseUrl ? u("nix-cache") : null;

  return bl({
    vfs: opts.vfs,
    vmlinuxUrl,
    initrdUrl,
    consoleCount: opts.consoleCount,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
    onModuleCached: opts.onModuleCached,
    wayland: opts.wayland,
    vsock: opts.vsock,
    squashfs,
    nixCache: useNix && nixCacheBase ? createNixCacheExport(nixCacheBase) : undefined,
  });
}
