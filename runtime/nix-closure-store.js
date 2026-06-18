// nix-closure-store.js — a read-only /nix 9P backend that serves a REAL Nix
// closure at its REAL store paths (unlike nix-store.js, which re-hashes with a
// synthetic scheme). Built from the store.json manifest:
//   { "<relpath-under-/nix>": {t:"d"}
//                           | {t:"f",x,d:<base64>}       (small file, inline)
//                           | {t:"f",x,s:<size>,h:<sha>} (large file, lazy — bytes
//                             fetched from the sibling store-content/<sha> on first
//                             read, like nix-cache.js; keeps boot off the toolchain)
//                           | {t:"l",to:<target>} }
// Mounted by the guest as aname=nix and used as an overlay lowerdir; the symlink
// forest resolves because symlinks are stored as MemVfs alias records and the 9P
// server answers Treadlink (server.js). Parent dirs are created as needed — the
// manifest does not emit every intermediate directory.
import { MemVfs } from "./ninep/mem-vfs.js";

function erofs(op) {
  const e = new Error("EROFS: " + op + " on a read-only store");
  // @ts-ignore — server.js maps .code -> Linux errno
  e.code = "EROFS";
  return e;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ensure all ancestor directories of `path` exist in `fs` (mkdir -p semantics).
 * `path` must be an absolute path like "/a/b/c"; creates "/a" and "/a/b" if absent.
 * Uses `_mkdirSync` which is idempotent for existing folders.
 * @param {MemVfs} fs
 * @param {string} path absolute path whose parent dirs to ensure
 */
function mkdirP(fs, path) {
  // Collect all ancestor paths (excluding root "/")
  const segs = path.replace(/^\//, "").split("/");
  // We want to mkdir every prefix except the last segment (the entry itself).
  for (let i = 1; i < segs.length; i++) {
    const ancestor = "/" + segs.slice(0, i).join("/");
    // _mkdirSync returns the existing record silently if the path is already a
    // folder; it only throws EEXIST if the path exists but is not a folder (a
    // real conflict that should propagate).
    try {
      fs._mkdirSync(ancestor);
    } catch (e) {
      // @ts-ignore
      if (e.code !== "EEXIST") throw e;
      // EEXIST means a non-folder node is in the way — real conflict, rethrow.
    }
  }
}

/**
 * @param {string} manifestUrl URL of store.json.
 * @returns {Promise<any|null>} a read-only VFS (stat/list/readBlob; EROFS
 *   mutations) rooted at /nix (export root), with a `storePaths` array of the
 *   /nix/store/<...> dirs — or `null` if the manifest can't be fetched/parsed.
 *   A null result is NON-FATAL: boot.js only registers the `nix` 9P export when
 *   nixStore is truthy, and the guest /init falls back to a shell when no system
 *   is found. This mirrors how the nix-cache export degrades when absent.
 */
export async function createNixClosureStore(manifestUrl, opts = {}) {
  // Large files live in a sibling store-content/<sha256> dir and are fetched
  // LAZILY (on first read) instead of inlined in the manifest — so boot doesn't
  // download the whole toolchain (~145MB). Derive the content base from the
  // manifest URL (.../store.json → .../store-content/).
  const contentBase = manifestUrl.replace(/store\.json(\?.*)?$/, "store-content/");
  // opts.onProgress({ tool, loaded, total }) / ({ tool, total, done }) / ({ tool,
  // error }) — fired while a lazy blob streams in, so the Linux app's tool-load
  // indicator still works (same shape guest-tools' onProgress used). The big
  // toolchain binaries (clang/wasm-ld/nix) are the only lazy blobs, so this is
  // exactly the "downloading clang" UX, now driven by the closure store.
  const onProgress = opts.onProgress || (() => {});
  /** @type {Map<string,{url:string,size:number,name:string,p:Promise<Uint8Array>|null}>} */
  const lazy = new Map();

  let manifest;
  try {
    const r = await fetch(manifestUrl);
    if (!r.ok) throw new Error("HTTP " + r.status);
    manifest = await r.json();
  } catch (e) {
    console.warn(
      "nix-closure-store: manifest unavailable (" +
        // @ts-ignore — Error.message
        (e && e.message ? e.message : e) +
        ") for " +
        manifestUrl +
        " — booting without a served /nix store",
    );
    return null;
  }

  const fs = new MemVfs();
  const storePaths = [];

  // Insert shallow-first so parents precede children — reduces the number of
  // mkdirP calls needed (parents are often explicit in the manifest for top-level
  // store paths, but not always for intermediate directories).
  const keys = Object.keys(manifest).sort(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
  );

  for (const rel of keys) {
    const e = manifest[rel];
    const path = "/" + rel;

    // Ensure all ancestor directories exist (manifest omits many intermediate dirs).
    mkdirP(fs, path);

    if (e.t === "d") {
      // Explicit directory entry — create it (idempotent if mkdirP already made it).
      fs._mkdirSync(path);
      if (/^\/store\/[^/]+$/.test(path)) {
        storePaths.push("/nix" + path);
      }
    } else if (e.t === "l") {
      // Symlink → MemVfs alias record with `target` field.
      fs._writeSync(path, { type: "alias", target: e.to });
    } else if (e.t === "f") {
      // File → MemVfs file record. The executable bit (e.x) is noted in the
      // manifest but the 9P server (server.js modeOf) always reports 0755 for
      // regular files, so no per-file mode storage is needed.
      if (e.d !== undefined) {
        // Small file: content inlined as base64.
        fs._writeSync(path, {
          type: "file",
          bytes: b64ToBytes(e.d),
          mime: "application/octet-stream",
        });
      } else {
        // Large file: lazy. Register a placeholder (so stat/list see a file) and
        // record where to fetch its bytes on first read. stat() reports e.s as
        // the size so Tgetattr never forces a fetch (server.js sizeOf uses
        // rec.size when present); readBlob() fetches + caches on demand.
        fs._writeSync(path, {
          type: "file",
          bytes: new Uint8Array(0),
          mime: "application/octet-stream",
        });
        lazy.set(path, {
          url: contentBase + e.h,
          size: e.s,
          name: path.split("/").pop() || path,
          p: null,
        });
      }
    }
  }

  // Fetch (once) and cache a lazy file's bytes, streaming so onProgress can drive
  // the tool-load indicator. Cache the in-flight PROMISE (like nix-cache.js) so
  // concurrent Treads for the same file share one fetch.
  function lazyBytes(rec) {
    if (!rec.p) {
      rec.p = (async () => {
        const tool = rec.name;
        try {
          const r = await fetch(rec.url);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const total = rec.size;
          // Stream to report byte progress; fall back to arrayBuffer if the body
          // isn't a readable stream (older runtimes / opaque responses).
          if (r.body && r.body.getReader) {
            const reader = r.body.getReader();
            const chunks = [];
            let loaded = 0;
            onProgress({ tool, loaded: 0, total });
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              loaded += value.length;
              onProgress({ tool, loaded, total });
            }
            const out = new Uint8Array(loaded);
            let off = 0;
            for (const c of chunks) {
              out.set(c, off);
              off += c.length;
            }
            onProgress({ tool, total, done: true });
            return out;
          }
          const out = new Uint8Array(await r.arrayBuffer());
          onProgress({ tool, total, done: true });
          return out;
        } catch (e) {
          onProgress({ tool, error: e });
          throw new Error(
            "nix-closure-store: lazy fetch " + rec.url + " → " + (e && e.message ? e.message : e),
          );
        }
      })();
    }
    return rec.p;
  }

  return {
    async stat(p) {
      const rec = await fs.stat(p);
      // Report the real size for lazy files (the MemVfs placeholder is 0 bytes).
      // server.js sizeOf prefers rec.size, so Tgetattr never triggers a fetch.
      const l = rec && lazy.get(p);
      if (l) rec.size = l.size;
      return rec;
    },
    async list(p) {
      const recs = await fs.list(p);
      for (const rec of recs) {
        const l = rec && rec.path && lazy.get(rec.path);
        if (l) rec.size = l.size;
      }
      return recs;
    },
    // MemVfs.readBlob returns a Blob. server.js sizeOf does
    // `(await vfs.readBlob(path)).size` which requires a Blob (Uint8Array has no
    // .size); readBytes converts Blob → Uint8Array. Lazy files fetch on first read.
    async readBlob(p) {
      const l = lazy.get(p);
      if (l) return new Blob([await lazyBytes(l)]);
      return fs.readBlob(p);
    },
    async write() {
      throw erofs("write");
    },
    async mkdir() {
      throw erofs("mkdir");
    },
    async remove() {
      throw erofs("remove");
    },
    async move() {
      throw erofs("move");
    },
    async rename() {
      throw erofs("rename");
    },
    async symlink() {
      throw erofs("symlink");
    },
    isWritablePath: () => false,
    storePaths,
  };
}
