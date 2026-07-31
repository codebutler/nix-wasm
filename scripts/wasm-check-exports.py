#!/usr/bin/env python3
"""Assert that a wasm module exports every named function (nix-wasm#179).

    wasm-check-exports.py MODULE.wasm SYM [SYM ...]

Exits 0 when every SYM is exported as a FUNCTION, else prints what is missing
(plus the exports that ARE present, so a typo is obvious) and exits 1.

WHY a build-time check exists at all: the host bridge calls the guest's startup
exports through permissive guards (`if (instance.exports.__X) ...`) so that an
older guest libc still boots. That makes a MISSING startup export SILENT in the
engine — it surfaces only as a crash before `_start`. #179 was exactly this: a
link that dropped `--export-all` carried a hand-written export list that never
gained `__wasm_early_tp_init`, `--gc-sections` then stripped the function, and
clang's libc++ `ios_base::Init` ctor stored `errno` through a null `struct
pthread` (a WRITE to virtual address 0x1c) — tolerated on NOMMU, SIGSEGV under
the software MMU.

Parses the export section directly rather than shelling out to objdump/wasm-objdump:
the guest binaries are linked `--strip-all`, so the name section is gone and only
the export section carries these names — and a plain `grep` for the symbol would
also match an unrelated data string.
"""

import sys


def read_u32(b, i):
    """LEB128 unsigned -> (value, next index)."""
    r = 0
    shift = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return r, i


def exported_funcs(b):
    """The set of names exported with kind 0 (function)."""
    if b[0:4] != b"\0asm":
        raise SystemExit("not a wasm module")
    i = 8
    while i < len(b):
        sec_id = b[i]
        i += 1
        size, i = read_u32(b, i)
        if sec_id != 7:  # not the export section
            i += size
            continue
        j = i
        count, j = read_u32(b, j)
        names = set()
        for _ in range(count):
            n, j = read_u32(b, j)
            name = b[j : j + n].decode("utf-8", "replace")
            j += n
            kind = b[j]
            j += 1
            _, j = read_u32(b, j)  # index
            if kind == 0:
                names.add(name)
        return names
    return set()


def main(argv):
    if len(argv) < 3:
        raise SystemExit(f"usage: {argv[0]} MODULE.wasm SYM [SYM ...]")
    path, wanted = argv[1], argv[2:]
    with open(path, "rb") as f:
        present = exported_funcs(f.read())
    missing = [s for s in wanted if s not in present]
    if missing:
        print(
            f"ERROR: {path} does not export: {' '.join(missing)}\n"
            "  The host bridge (runtime/kernel-worker.js) calls the guest's startup\n"
            "  exports through `if (instance.exports.__X)` guards, so a missing one is\n"
            "  SILENT there and shows up only as a crash before _start (nix-wasm#179).\n"
            "  Check that toolchain/wasm-host-exports.nix is wired into this link — a\n"
            "  link without --export-all must name each export (which also roots it\n"
            f"  against --gc-sections).\n  exported functions found: {' '.join(sorted(present))}",
            file=sys.stderr,
        )
        return 1
    print(f"wasm-check-exports: {path} exports all of: {' '.join(wanted)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
