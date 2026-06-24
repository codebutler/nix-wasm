// nix-cache.js — a lazy, read-only 9P export that serves a committed Nix binary
// cache (a `file://` store: nix-cache-info + <hash>.narinfo + nar/<hash>.nar) to
// the Linux guest, so in-guest `nix` can SUBSTITUTE host-built wasm32-linux-musl
// packages instead of building them (#141 / #139 task #5).
//
// Registered as the `nixcache` aname in boot.js's multi-export server; pc-init
// mounts it read-only at /nix-cache and points nix.conf's `substituters` at
// `file:///nix-cache`. Nix's LocalBinaryCacheStore fetches files by exact path
// (nix-cache-info, then <storehash>.narinfo, then the nar/ URL from it) — it does
// NOT readdir — so this only needs stat + readBlob, but list is supported too.
//
// This is a thin HTTP proxy: each guest file read over 9P becomes a fetch() of
// `baseUrl + "/" + relpath`, so the cache can live anywhere reachable by URL —
// a same-origin path, a CI-published dir, or a CORS/CORP-enabled bucket (a
// different ORIGIN additionally needs cross-origin-isolation-compatible headers,
// since the app runs under COEP: require-corp). `baseUrl` is the only knob.
//
// Lazy fetch: the per-file bytes are fetched (and cached) on first
// access, and the file index (manifest.json — the cache's relative file paths)
// is fetched on the first VFS call. An idle session, or one that never runs nix,
// pays nothing.
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
const parent = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// A fixed mtime: the committed cache is immutable per session, so a constant
// keeps the derived 9P qid version stable (server.js derives it from modifiedAt).
const MTIME = 1_700_000_000_000;

/**
 * @param {string} baseUrl  URL of the committed cache dir (serves manifest.json
 *   + the cache files at the same relative paths).
 */
export function createNixCacheExport(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, "");
  /** @type {Map<string, Promise<Blob>>} relPath → in-flight/cached fetch */
  const blobCache = new Map();
  /** @type {Promise<{files: Set<string>, dirs: Set<string>}>|null} */
  let indexP = null;

  const buildIndex = (list) => {
    const files = new Set();
    // Seed the standard binary-cache layout dirs so they exist even when empty:
    // Nix's LocalBinaryCacheStore init does `mkdir -p <cache>/{nar,realisations,
    // log}`, which on this READ-ONLY export would EROFS and abort substitution.
    // Reporting them as existing dirs makes that mkdir a no-op (nix stats first).
    const dirs = new Set(["", "nar", "realisations", "log"]);
    for (const raw of list) {
      const f = norm(raw);
      if (!f) continue;
      files.add(f);
      for (let d = parent(f); d !== ""; d = parent(d)) dirs.add(d);
    }
    return { files, dirs };
  };

  // Fetch the file index. A missing manifest.json (e.g. no cache committed/
  // published for this deploy) degrades to an EMPTY cache — the export still
  // mounts, but offers nothing to substitute, with no error. So wiring the
  // export in is always safe whether or not a cache is present.
  const ensureIndex = () =>
    (indexP ||= fetch(base + "/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then(buildIndex));

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
  const rofs = (op) => async (path) => {
    throw vfsError("EROFS", "cannot " + op + " " + path + " (read-only nix cache)");
  };

  return {
    async stat(path) {
      const p = norm(path);
      const { files, dirs } = await ensureIndex();
      if (dirs.has(p)) return folderRec(p);
      if (files.has(p)) return fileRec(p);
      return null;
    },
    async list(path) {
      const p = norm(path);
      const { files, dirs } = await ensureIndex();
      if (!dirs.has(p)) throw vfsError("ENOTDIR", path);
      const out = [];
      const seen = new Set();
      const prefix = p === "" ? "" : p + "/";
      for (const d of dirs) {
        if (d !== "" && parent(d) === p && !seen.has(d)) {
          seen.add(d);
          out.push(folderRec(d));
        }
      }
      for (const f of files) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) out.push(fileRec(f));
      }
      return out;
    },
    async readBlob(path) {
      const p = norm(path);
      const { files } = await ensureIndex();
      if (!files.has(p)) throw vfsError("ENOENT", path);
      if (!blobCache.has(p)) {
        blobCache.set(
          p,
          fetch(base + "/" + p).then((r) => {
            if (!r.ok) {
              blobCache.delete(p); // allow a retry
              throw vfsError("EIO", base + "/" + p + " (HTTP " + r.status + ")");
            }
            return r.blob();
          }),
        );
      }
      return blobCache.get(p);
    },
    write: rofs("write"),
    mkdir: rofs("mkdir"),
    move: rofs("move"),
    remove: rofs("remove"),
  };
}
