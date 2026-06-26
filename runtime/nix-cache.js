// nix-cache.js — a lazy, read-only 9P export that serves a STANDARD Nix binary
// cache (a `file://` store: nix-cache-info + <hash>.narinfo + nar/<hash>.nar) to
// the Linux guest, so in-guest `nix` can SUBSTITUTE host-built wasm32-linux-musl
// packages instead of building them (#141 / #139 task #5).
//
// Registered as the `nixcache` aname in boot.js's multi-export server; pc-init
// mounts it read-only at /nix-cache and points nix.conf's `substituters` at
// `file:///nix-cache`. Nix's LocalBinaryCacheStore fetches files by exact path
// (nix-cache-info, then <storehash>.narinfo, then the nar/ URL from it) — it does
// NOT readdir — so this only needs stat + readBlob.
//
// This is a thin HTTP proxy: each guest file read over 9P becomes a fetch() of
// `baseUrl + "/" + relpath`, so the cache can live anywhere reachable by URL —
// a same-origin path, a CI-published dir, or a CORS/CORP-enabled bucket (a
// different ORIGIN additionally needs cross-origin-isolation-compatible headers,
// since the app runs under COEP: require-corp).
//
// ON-DEMAND probe (no preloaded index): existence is resolved per path by a
// HEAD request (200 → file, 404 → ENOENT), and bytes by a GET, both cached.
// There is NO `manifest.json` file index — the published store is therefore a
// PLAIN STANDARD Nix cache the guest points at like any other (epic #60, Phase 1).
// Trade-off: `readdir`/`ls` on a remote standard cache is not possible (you can't
// enumerate a non-listable remote), but Nix never enumerates a binary cache, so
// this is functionally free. Only the fixed standard-layout dirs are listable.
//
// Surface: the same async VFS the 9P server consumes — stat/list/readBlob, every
// mutation rejected EROFS (a binary cache is immutable, content-addressed data).

function vfsError(code, path) {
  const e = new Error(code + ": " + path);
  // @ts-ignore — augmenting Error with a code, like js/vfs/index.js does
  e.code = code;
  return e;
}

const norm = (path) => (path || "/").replace(/^\/+/, "").replace(/\/+$/, "");

// A fixed mtime: the committed cache is immutable per session, so a constant
// keeps the derived 9P qid version stable (server.js derives it from modifiedAt).
const MTIME = 1_700_000_000_000;

// The standard binary-cache layout dirs. They are reported as existing WITHOUT a
// network probe so that Nix's LocalBinaryCacheStore init — which does
// `mkdir -p <cache>/{nar,realisations,log}` — sees them present and skips the
// mkdir (which would EROFS on this read-only export and abort substitution). They
// also let a Twalk to `nar/<hash>.nar` traverse the `nar` component without an
// HTTP round-trip (no `nar/` object exists as a key, only `nar/<file>` objects).
const SEEDED_DIRS = new Set(["", "nar", "realisations", "log"]);

/**
 * @param {string} baseUrl  URL of the published standard Nix cache dir (serves
 *   nix-cache-info + *.narinfo + nar/* at their relative paths).
 */
export function createNixCacheExport(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, "");
  /** @type {Map<string, Promise<Blob>>} relPath → in-flight/cached blob fetch */
  const blobCache = new Map();
  /** @type {Map<string, Promise<object|null>>} relPath → in-flight/cached HEAD probe */
  const statCache = new Map();

  const folderRec = (p) => ({
    id: "nix-cache:" + (p || "/"),
    type: "folder",
    name: p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p,
    path: "/" + p,
    modifiedAt: MTIME,
  });
  const fileRec = (p) => ({
    id: "nix-cache:" + p,
    type: "file",
    name: p.slice(p.lastIndexOf("/") + 1),
    path: "/" + p,
    mime: "application/octet-stream",
    modifiedAt: MTIME,
  });

  // Probe a path's existence with a HEAD. 200 → fileRec, 404 → null (ENOENT),
  // any other status / network error → throw EIO (and evict so a retry re-probes).
  // The result (file or not-found) is cached because the cache is immutable.
  const probe = (p) => {
    let entry = statCache.get(p);
    if (!entry) {
      entry = fetch(base + "/" + p, { method: "HEAD" }).then((r) => {
        if (r.ok) return fileRec(p);
        if (r.status === 404) return null;
        throw vfsError("EIO", base + "/" + p + " (HTTP " + r.status + ")");
      });
      entry.catch(() => statCache.delete(p)); // evict failures so a later call retries
      statCache.set(p, entry);
    }
    return entry;
  };

  const rofs = (op) => async (path) => {
    throw vfsError("EROFS", "cannot " + op + " " + path + " (read-only nix cache)");
  };

  return {
    async stat(path) {
      const p = norm(path);
      if (SEEDED_DIRS.has(p)) return folderRec(p);
      return probe(p);
    },
    async list(path) {
      const p = norm(path);
      // A remote standard cache isn't enumerable; only the fixed layout dirs are
      // known. Nix never readdirs a binary cache, so this is functionally complete.
      if (!SEEDED_DIRS.has(p)) throw vfsError("ENOTDIR", path);
      if (p === "") return ["nar", "realisations", "log"].map(folderRec);
      return [];
    },
    async readBlob(path) {
      const p = norm(path);
      let blob = blobCache.get(p);
      if (!blob) {
        blob = fetch(base + "/" + p).then((r) => {
          if (!r.ok) {
            if (r.status === 404) throw vfsError("ENOENT", "/" + p);
            throw vfsError("EIO", base + "/" + p + " (HTTP " + r.status + ")");
          }
          return r.blob();
        });
        blob.catch(() => blobCache.delete(p)); // evict failures so a later read re-fetches
        blobCache.set(p, blob);
      }
      return blob;
    },
    write: rofs("write"),
    mkdir: rofs("mkdir"),
    move: rofs("move"),
    remove: rofs("remove"),
  };
}
