#!/usr/bin/env python3
"""Remove named function exports from a wasm module (nix-wasm#179 test fixture).

    wasm-strip-export.py IN.wasm OUT.wasm SYM [SYM ...]

Rewrites the export section without the named entries (function exports only) and
leaves every other section byte-identical. Exits non-zero if a named SYM was not
exported, so a fixture can never silently become a no-op copy.

WHY: the #179 hardening needs a guest binary the HOST refuses to run while
binfmt_wasm still accepts it — i.e. one that passes the kernel's early
magic/`dylink.0` checks and then fails the software-MMU pass's requirement that
every image export `__get_tls_base`. Deleting the export from a REAL, otherwise
complete guest program models that far more faithfully than a synthetic module,
and the toolchain now deliberately forces those exports in, so a link can no
longer produce one (toolchain/wasm-host-exports.nix `forcedNames`).
"""

import sys


def read_u32(b, i):
    r = 0
    shift = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return r, i


def write_u32(v):
    out = bytearray()
    while True:
        x = v & 0x7F
        v >>= 7
        if v:
            out.append(x | 0x80)
        else:
            out.append(x)
            return bytes(out)


def strip(data, drop):
    if data[0:4] != b"\0asm":
        raise SystemExit("not a wasm module")
    out = bytearray(data[0:8])
    i = 8
    removed = set()
    while i < len(data):
        sec_id = data[i]
        start = i
        i += 1
        size, i = read_u32(data, i)
        body = data[i : i + size]
        i += size
        if sec_id != 7:
            out += data[start:i]
            continue
        # Rebuild the export section without the dropped function exports.
        count, j = read_u32(body, 0)
        kept = bytearray()
        n_kept = 0
        for _ in range(count):
            entry_start = j
            n, j = read_u32(body, j)
            nm = body[j : j + n].decode("utf-8", "replace")
            j += n
            kind = body[j]
            j += 1
            _, j = read_u32(body, j)
            if kind == 0 and nm in drop:
                removed.add(nm)
                continue
            kept += body[entry_start:j]
            n_kept += 1
        new_body = write_u32(n_kept) + bytes(kept)
        out += bytes([7]) + write_u32(len(new_body)) + new_body
    missing = sorted(set(drop) - removed)
    if missing:
        raise SystemExit(f"ERROR: not exported, nothing to strip: {' '.join(missing)}")
    return bytes(out)


def main(argv):
    if len(argv) < 4:
        raise SystemExit(f"usage: {argv[0]} IN.wasm OUT.wasm SYM [SYM ...]")
    with open(argv[1], "rb") as f:
        data = f.read()
    out = strip(data, set(argv[3:]))
    with open(argv[2], "wb") as f:
        f.write(out)
    print(f"wasm-strip-export: {argv[2]} written without {' '.join(argv[3:])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
