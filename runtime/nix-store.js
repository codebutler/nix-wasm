// nix-store.js — a read-only, content-addressed store VFS for `/nix` (Phase E/N1,
// docs/linux.md §3). It's a 9P backend (the async typed-record VFS surface
// server.js consumes: stat/list/readBlob, EROFS on every mutation), served on
// its own mount via the multi-export server (aname=nix → here). The guest mounts
// it at /nix, so a store path /nix/store/<hash>-<name>-<ver>/bin/<prog> resolves
// here and execs straight off the mount (Phase C proved exec-from-9P-VFS).
//
// "Store" semantics, the parts that matter and the parts deferred:
//   - Content-addressed + immutable: each package's directory name carries a
//     hash of its contents, and the whole tree is read-only (writes → EROFS),
//     the Nix invariant. The hash is a real SHA-256 of a deterministic
//     serialization, Nix-base32-encoded — *our* scheme, self-consistent end to
//     end. Byte-exact Nix NAR hashing only matters once we consume/produce a
//     real binary cache, which is N2.5; not needed to lay down + run a seeded
//     store now.
//   - In-memory, re-seeded each boot: the N1 store is derived from committed
//     package data, so there's nothing mutable to persist yet. OPFS-backed
//     persistence belongs at N2.5, when substitution starts *writing* new store
//     paths that must survive a reload. The interface here (read-only CAS, its
//     own mount) is the durable part; the backing swaps in later.
//
// Built on MemVfs (js/linux/ninep/mem-vfs.js) for the in-memory tree, with
// readOnlyPrefixes=["/"] so the whole store rejects writes.

import { MemVfs } from "./ninep/mem-vfs.js";

// Nix's base32 alphabet (RFC 4648 minus e, o, t, u). We use it MSB-first over
// the leading SHA-256 bytes — deterministic + content-addressed; not the exact
// nixbase32 byte-reversal (that's an N2.5 cache-compat concern).
const NIX_B32 = "0123456789abcdfghijklmnpqrsvwxyz";
const HASH_LEN = 32; // store-path hash length, like Nix (32 base32 chars = 160 bits)

function base32(bytes, len) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5 && out.length < len) {
      bits -= 5;
      out += NIX_B32[(value >>> bits) & 31];
      value &= (1 << bits) - 1; // keep only the still-pending low bits
    }
  }
  while (out.length < len) out += NIX_B32[0];
  return out;
}

const enc = new TextEncoder();

// Deterministic serialization of a package's files → SHA-256 → base32. Sorting
// the paths makes the hash independent of insertion order.
async function contentHash(files) {
  const names = Object.keys(files).sort();
  const parts = [];
  for (const name of names) {
    const bytes = files[name];
    const head = enc.encode(name + "\0" + bytes.length + "\0");
    parts.push(head, bytes);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return base32(digest, HASH_LEN);
}

// Expand a flat { "bin/cbhello": bytes } map into a nested folder tree the
// MemVfs seed format understands ({ bin: { cbhello: bytes } }).
function buildTree(files) {
  const root = {};
  for (const [path, bytes] of Object.entries(files)) {
    const segs = path.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      cur[segs[i]] = cur[segs[i]] || {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = bytes;
  }
  return root;
}

function erofs(op) {
  const e = new Error("EROFS: " + op + " on a read-only store");
  // @ts-ignore — server.js maps .code → Linux errno (E.ROFS)
  e.code = "EROFS";
  return e;
}

/**
 * Build a read-only content-addressed store VFS for `/nix`.
 *
 * @param {Array<{ name: string, version?: string, files: Record<string, Uint8Array> }>} [packages]
 *   each package's `files` maps a path-within-the-package (e.g. "bin/cbhello")
 *   to its bytes.
 * @returns {Promise<any>} a VFS (stat/list/readBlob + EROFS mutations) whose tree
 *   is rooted at `/nix` (so `/store/<path>` here is `/nix/store/<path>` in the
 *   guest), plus a `storePaths` array of the absolute guest paths created.
 */
export async function createNixStore(packages = []) {
  const store = {};
  const storePaths = [];
  for (const pkg of packages) {
    const hash = await contentHash(pkg.files);
    const dir = `${hash}-${pkg.name}${pkg.version ? "-" + pkg.version : ""}`;
    store[dir] = buildTree(pkg.files);
    storePaths.push(`/nix/store/${dir}`);
  }
  // Mounted at /nix (aname=nix), so the export root maps to /nix: the tree is
  // { store: … } → /store/… here is /nix/store/… in the guest.
  const tree = MemVfs.from({ store });
  // The store owns its read-only invariant — every mutation rejects with EROFS,
  // rather than leaning on MemVfs's prefix mechanism (which doesn't special-case
  // a "/" root). Reads forward to the in-memory tree.
  return {
    stat: (p) => tree.stat(p),
    list: (p) => tree.list(p),
    readBlob: (p) => tree.readBlob(p),
    async write() {
      throw erofs("write");
    },
    async mkdir() {
      throw erofs("mkdir");
    },
    async move() {
      throw erofs("move");
    },
    async rename() {
      throw erofs("rename");
    },
    async remove() {
      throw erofs("remove");
    },
    isWritablePath: () => false,
    storePaths,
  };
}
