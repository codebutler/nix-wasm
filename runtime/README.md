# linux-wasm-runtime

JS runtime that boots the linux-wasm guest kernel in Node and the browser. It
provides the kernel host, the 9P server (host↔guest filesystem bridge), the Nix
store wiring, and the high-level `bootNixSystem` entry point that most consumers
call.

pc vendors this package via `runtime/sync-to-pc.sh`.

## Public API

```js
import {
  bootNixSystem, // high-level — what most callers use
  bootLinux, // low-level
  makeConsoleSession,
  createNixClosureStore,
  createNixCacheExport,
  createNixStore,
  MemVfs,
  HVC_CONSOLES,
  DEFAULT_CMDLINE,
} from "./index.js";
```

### `bootNixSystem(opts)` → `Promise<handle>`

The one call most consumers make. Resolves the four nix-wasm build artifacts
(`vmlinux.wasm`, `initramfs.cpio.gz`, `store.json`, `nix-cache/`) under
`baseUrl`, wires the Nix closure store and binary cache, and returns a boot
handle.

```js
const handle = await bootNixSystem({
  vfs, // required — see VFS contract below
  baseUrl, // required — absolute URL of the dir holding the four artifacts
  onDownload, // optional (ev) => void — lazy-blob fetch progress from the closure store
  consoleCount, // optional number — hvc consoles to expose (default HVC_CONSOLES = 8)
  cmdline, // optional string — kernel command line
  onLog, // optional (text: string) => void — host/diagnostic log sink
  nix, // optional boolean — default true; false = busybox-only, no /nix
});
```

### `bootLinux(opts)` → `Promise<handle>`

Low-level boot. `vmlinuxUrl` and `initrdUrl` are required; all other fields are
optional.

```js
const handle = await bootLinux({
  vfs, // required
  vmlinuxUrl, // required — URL of the kernel wasm
  initrdUrl, // required — URL of the initramfs.cpio.gz
  nixStore, // optional — return value of createNixClosureStore(...)
  nixCache, // optional — return value of createNixCacheExport(...)
  consoleCount, // optional number
  cmdline, // optional string
  onLog, // optional (text: string) => void
});
```

### Boot handle

```ts
{
  consoleCount: number,
  console(vtermno: number): {
    write(b: Uint8Array | string): void,
    onData(cb: (b: Uint8Array) => void): () => void,  // returns unsub
    resize(cols: number, rows: number): void,
    reset(): void,
  },
  kill(): void,
}
```

`console(0)` is the primary terminal (also carries kernel boot log).
`console(1)` … `console(consoleCount - 1)` are additional terminals.
Output that arrives before `onData` is called is buffered per console.

### Building blocks

| Export                                                 | Description                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `createNixClosureStore(storeJsonUrl, { onProgress? })` | Read-only 9P VFS for the `/nix` closure (lazy blobs from `nix-cache/`)    |
| `createNixCacheExport(cacheDirUrl)`                    | Read-only 9P VFS for `/nix-cache` (in-guest binary cache substituter)     |
| `createNixStore(packages?)`                            | Minimal in-memory nix store for tests                                     |
| `makeConsoleSession(console, hooks?)`                  | Wraps a console handle with `write`, `onData`, `resize`, `kill`, `hangup` |
| `MemVfs`                                               | In-memory VFS — reference implementation and test double                  |
| `HVC_CONSOLES`                                         | Default console count (8)                                                 |
| `DEFAULT_CMDLINE`                                      | Default kernel command line                                               |

### VFS contract

The `vfs` object the engine calls into over 9P. `MemVfs` is the reference
implementation; pc's `vfs` from `js/vfs/index.js` satisfies the same shape.

```ts
interface Vfs {
  stat(path: string): Promise<VfsEntry>;
  list(path: string): Promise<VfsEntry[]>;
  readBlob(path: string): Promise<Blob>;
  write(path: string, rec: object): Promise<void>;
  mkdir(path: string): Promise<void>;
}
```

`VfsEntry` fields: `{ id, type, name, path, modifiedAt, size?, target? }`.
`type` is `'folder'` | `'alias'` | anything else (a byte file).
Errors are thrown as `Error` with a `.code` (`ENOENT`, `EEXIST`, `EROFS`, …).

## Running

### Prerequisites

Artifacts (`vmlinux.wasm`, `initramfs.cpio.gz`, `store.json`, `nix-cache/`) are
**not committed** — they are `nix build` outputs from the nix-wasm repo. Point
at them via:

- `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/` for the Node CLI.
- A symlink `web/artifacts → /path/to/artifacts` for the browser demo.

For local dev without a fresh `nix build`, both default to pc's vendored set
(`vendor/linux-wasm/` in a pc checkout).

### Engine unit tests (bun:test, no kernel/artifacts needed)

```sh
cd runtime
bun run test        # 79 tests across 7 files — ninep/, nix-closure-store, nix-store
```

### Node integration tests

```sh
cd runtime
node --test node/   # boot tests via node:test
```

### Full-nix smoke test

```sh
cd runtime
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/smoke.mjs
# Exit 0 pass / 1 fail / 2 inconclusive (kernel panic — re-run)
```

Boots a full nix system, exercises 8 checks (prompt, 9P read/write/ls,
`nix-env -iA sl`), and exits 0 on success.

### Interactive shell

```sh
cd runtime
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/attach.mjs
# --no-nix flag = busybox-only boot (faster, skips /nix overlay)
# Ctrl-] to detach and quit
```

### Browser demo

```sh
cd runtime
ln -sfn /path/to/artifacts web/artifacts
node web/serve.mjs [port]   # default port 8090
# open http://localhost:8090/web/
```

Headless Playwright smoke (asserts `WEB_OK` appears in the terminal):

```sh
cd runtime
ln -sfn /path/to/artifacts web/artifacts
node web/smoke.mjs
```

## CI gates (all four must pass)

```sh
cd runtime
bun run test            # engine unit tests (79/7)
bun run lint            # oxlint, zero warnings tolerated
bun run format:check    # oxfmt
bun run typecheck       # tsc
```

Auto-fix shortcuts: `bun run format` (formatting), `bun run lint:fix` (lint).

Note: `node/` and `web/` are tooling/demo — excluded from tsc (`jsconfig.json`).
`web/vendor/ghostty` is vendored and excluded from all three static gates.

## Syncing to pc

```sh
runtime/sync-to-pc.sh /path/to/pc
```

Copies the engine subset (excludes `node/`, `web/`, tests, package config) into
`pc/vendor/linux-wasm/runtime/` and stamps the source commit into
`pc/vendor/linux-wasm/SOURCE.md`.
