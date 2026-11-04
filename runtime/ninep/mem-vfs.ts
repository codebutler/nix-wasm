// MemVfs — an in-memory implementation of the (async, typed-record) `js/vfs`
// subset the 9P server (server.js) consumes. It exists so the whole 9P stack
// runs headless under `bun test` with no IndexedDB/DOM (docs/linux.md §16.1:
// "back vfs.* with an in-memory adapter").
//
// It is NOT the WASI `MemVfs` from js/kernel/wasi/sync-vfs.js — that one is the
// sync byte-range shape V1 needs. This one mirrors the async record API:
// stat/list/readBlob/write/mkdir/remove/move(+rename)/isWritablePath, returning
// `{ id, type, name, path, modifiedAt, size?, target? }` records with stable
// string `id`s (the inodes the server interns into qid paths).
//
// Records carry a `type` ('folder' | 'alias' | anything-else = a byte file).
// Errors are thrown as `Error` with a `.code` (ENOENT/EEXIST/EROFS/…), matching
// how the real dispatcher surfaces write-policy violations.

import type { NinePVfs, VfsRecord, VfsWriteRecord } from "./server.ts";

/** Options for a MemVfs. */
export interface MemVfsOptions {
  readOnlyPrefixes?: string[];
}

/** A `MemVfs.from` seed: string or bytes → a byte file, nested object → a folder. */
export interface MemSeedTree {
  [name: string]: string | Uint8Array<ArrayBuffer> | MemSeedTree;
}

// One stored node. Folders carry a children Map(name→id); byte files `bytes`
// (+ `mime`); aliases (symlinks) a `target`. `type` and `modifiedAt` are set
// by every writer, right after a fresh node is made.
interface MemNode {
  id: string;
  type?: string;
  name: string;
  modifiedAt?: number;
  children?: Map<string, string>;
  bytes?: Uint8Array<ArrayBuffer>;
  target?: string;
  mime?: string;
}

function vfsError(code: string, path: string): Error & { code: string } {
  // Augments Error with a code, like js/vfs/index.js does.
  return Object.assign(new Error(code + ": " + path), { code });
}

const ROOT_ID = "__root__";
const enc = new TextEncoder();

function normalize(path: string): string {
  const segs: string[] = [];
  for (const s of String(path || "/").split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") segs.pop();
    else segs.push(s);
  }
  return "/" + segs.join("/");
}
function basename(path: string): string {
  const p = normalize(path);
  return p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1);
}
function dirname(path: string): string {
  const p = normalize(path);
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export class MemVfs implements NinePVfs {
  _seq: number;
  _clock: number;
  _readOnly: string[];
  /** node-by-id; folders carry a children Map(name→id) */
  nodes: Map<string, MemNode>;

  constructor(opts: MemVfsOptions = {}) {
    this._seq = 0;
    this._clock = 1_700_000_000_000; // deterministic mtimes
    this._readOnly = (opts.readOnlyPrefixes || []).map(normalize);
    this.nodes = new Map();
    this.nodes.set(ROOT_ID, {
      id: ROOT_ID,
      type: "folder",
      name: "",
      children: new Map(),
      modifiedAt: this._tick(),
    });
  }

  _tick(): number {
    return (this._clock += 1000);
  }
  _id(): string {
    return "n" + ++this._seq;
  }

  /** Seed from a nested literal: string → byte file, object → folder. */
  static from(tree: MemSeedTree, opts?: MemVfsOptions): MemVfs {
    const fs = new MemVfs(opts);
    const build = (parentPath: string, obj: MemSeedTree) => {
      for (const [name, val] of Object.entries(obj)) {
        const path = parentPath === "/" ? "/" + name : parentPath + "/" + name;
        if (val && typeof val === "object" && !(val instanceof Uint8Array)) {
          fs._mkdirSync(path);
          build(path, val);
        } else {
          const bytes = val instanceof Uint8Array ? val : enc.encode(String(val));
          fs._writeSync(path, { type: "file", bytes, mime: "application/octet-stream" });
        }
      }
    };
    build("/", tree);
    return fs;
  }

  _resolve(path: string): MemNode | null {
    const p = normalize(path);
    if (p === "/") return this.nodes.get(ROOT_ID);
    let cur = this.nodes.get(ROOT_ID);
    for (const seg of p.slice(1).split("/")) {
      if (!cur || cur.type !== "folder") return null;
      const childId = cur.children.get(seg);
      if (!childId) return null;
      cur = this.nodes.get(childId);
    }
    return cur || null;
  }

  _record(node: MemNode, path: string): VfsRecord {
    const rec: VfsRecord = {
      id: node.id,
      type: node.type,
      name: basename(path) || node.name,
      path: normalize(path),
      modifiedAt: node.modifiedAt,
    };
    if (node.type !== "folder" && node.type !== "alias")
      rec.size = node.bytes ? node.bytes.length : 0;
    if (node.type === "alias") rec.target = node.target;
    if (node.mime) rec.mime = node.mime;
    return rec;
  }

  _assertWritable(op: string, path: string): void {
    const p = normalize(path);
    if (this._readOnly.some((ro) => p === ro || p.startsWith(ro + "/"))) {
      throw vfsError("EROFS", "cannot " + op + " " + p + " (read-only)");
    }
  }

  _parentFolder(path: string): MemNode {
    const parent = this._resolve(dirname(path));
    if (!parent) throw vfsError("ENOENT", dirname(path));
    if (parent.type !== "folder") throw vfsError("ENOTDIR", dirname(path));
    return parent;
  }

  _mkdirSync(path: string): VfsRecord {
    const existing = this._resolve(path);
    if (existing) {
      if (existing.type === "folder") return this._record(existing, path);
      throw vfsError("EEXIST", path);
    }
    const parent = this._parentFolder(path);
    const node: MemNode = {
      id: this._id(),
      type: "folder",
      name: basename(path),
      children: new Map(),
      modifiedAt: this._tick(),
    };
    this.nodes.set(node.id, node);
    parent.children.set(basename(path), node.id);
    return this._record(node, path);
  }

  _writeSync(path: string, record: VfsWriteRecord): VfsRecord {
    const parent = this._parentFolder(path);
    const name = basename(path);
    const existingId = parent.children.get(name);
    const node: MemNode = existingId ? this.nodes.get(existingId) : { id: this._id(), name };
    node.type = record.type || "file";
    node.modifiedAt = this._tick();
    if (node.type === "folder") {
      node.children = node.children || new Map();
    } else if (node.type === "alias") {
      node.target = record.target || "";
      delete node.bytes;
    } else {
      node.bytes = record.bytes || new Uint8Array(0);
      node.mime = record.mime;
      delete node.children;
    }
    this.nodes.set(node.id, node);
    parent.children.set(name, node.id);
    return this._record(node, path);
  }

  // ── async API (the surface server.js calls) ─────────────────────────────

  async stat(path: string): Promise<VfsRecord | null> {
    const node = this._resolve(path);
    return node ? this._record(node, path) : null;
  }

  async list(path: string): Promise<VfsRecord[]> {
    const node = this._resolve(path);
    if (!node) throw vfsError("ENOENT", path);
    if (node.type !== "folder") throw vfsError("ENOTDIR", path);
    const base = normalize(path);
    const out: VfsRecord[] = [];
    for (const [name, id] of node.children) {
      const child = this.nodes.get(id);
      out.push(this._record(child, base === "/" ? "/" + name : base + "/" + name));
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  async readBlob(path: string): Promise<Blob> {
    const node = this._resolve(path);
    if (!node) throw vfsError("ENOENT", path);
    if (node.type === "folder") throw vfsError("EISDIR", path);
    return new Blob([node.bytes || new Uint8Array(0)]);
  }

  async write(path: string, record: VfsWriteRecord): Promise<VfsRecord> {
    this._assertWritable("write", path);
    // Convert a Blob payload into raw bytes (what we store internally).
    let bytes: Uint8Array<ArrayBuffer> = record.bytes;
    if (!bytes && record.blob instanceof Blob)
      bytes = new Uint8Array(await record.blob.arrayBuffer());
    if (!bytes && typeof record.body === "string") bytes = enc.encode(record.body);
    return this._writeSync(path, { ...record, bytes });
  }

  async mkdir(path: string): Promise<VfsRecord> {
    this._assertWritable("mkdir", path);
    return this._mkdirSync(path);
  }

  async remove(path: string): Promise<void> {
    this._assertWritable("remove", path);
    const node = this._resolve(path);
    if (!node) throw vfsError("ENOENT", path);
    if (node.type === "folder" && node.children.size > 0) throw vfsError("ENOTEMPTY", path);
    const parent = this._resolve(dirname(path));
    parent.children.delete(basename(path));
    this.nodes.delete(node.id);
  }

  async move(srcPath: string, dstPath: string): Promise<VfsRecord> {
    this._assertWritable("move", srcPath);
    this._assertWritable("move", dstPath);
    const node = this._resolve(srcPath);
    if (!node) throw vfsError("ENOENT", srcPath);
    const srcParent = this._resolve(dirname(srcPath));
    const dstParent = this._parentFolder(dstPath);
    const dstName = basename(dstPath);
    // Clobber any existing destination (move semantics).
    const clashId = dstParent.children.get(dstName);
    if (clashId && clashId !== node.id) this.nodes.delete(clashId);
    srcParent.children.delete(basename(srcPath));
    node.name = dstName;
    node.modifiedAt = this._tick();
    dstParent.children.set(dstName, node.id);
    return this._record(node, dstPath);
  }

  async rename(srcPath: string, dstPath: string): Promise<VfsRecord> {
    return this.move(srcPath, dstPath);
  }

  isWritablePath(path: string): boolean {
    const p = normalize(path);
    return !this._readOnly.some((ro) => p === ro || p.startsWith(ro + "/"));
  }
}
