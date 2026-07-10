#!/usr/bin/env python3
"""wasm-dynsym-inject — make every exported function dlsym-able under fpcast.

The problem (#126 Track C / #130, the #33 revert): a function pointer on wasm
is a table index, and a binary that goes through the `--fpcast-emu` post-link
pass (userspace/fpcast-emu.nix) has its call_indirect ABI rewritten to one
canonical wide signature, with only the TABLE (elem) entries replaced by
canonical thunks — exports keep the original raw-signature functions. So the
runtime loader (runtime/dylink.js) can only hand out a correct function
"address" for a symbol that has an elem-segment slot; a raw export pushed into
a grown table slot traps at the first fpcast'd call through it.

wasm-ld only puts ADDRESS-TAKEN functions in the elem segment. GtkBuilder
signal handlers (the GModule/dlsym headline case) are referenced by NAME only,
never address-taken, so they have no slot.

This tool closes the gap at build time, BEFORE the fpcast pass runs:
    exported functions not already in the elem segment are appended to it
(plus the bookkeeping that keeps the module consistent: the table import's
initial size and the dylink.0 MEM_INFO tableSize grow by the same amount),
    and the name → elem-slot map is recorded in a `cb.dynsym` custom section.
The custom section is REQUIRED because the fpcast pass replaces every elem
entry with a NEW thunk function (fresh function indices), severing the
export-index ↔ elem-entry link a loader could otherwise derive from the final
binary — but slot POSITIONS are preserved (in-place replacement), so the map
recorded here stays valid. binaryen passes unknown custom sections through
(verified). runtime/dylink.js prefers cb.dynsym when present and falls back to
export-index matching for plain wasm-ld output.

cb.dynsym format: uleb32 count, then per entry: uleb32 name length, name bytes
(UTF-8), uleb32 slot offset (relative to the module's __table_base).

On a non-fpcast module the injection is harmless (the loader's dynamic
fallback would also have worked) — but running it keeps table layout identical
across a package's fpcast/non-fpcast variants.

Usage: wasm-dynsym-inject.py IN.wasm OUT.wasm [--only REGEX]
  --only REGEX  restrict injection to export names matching REGEX (a size
                lever for huge --export-all binaries; default: all exports).

Build-seam usage (userspace/dynsym.nix): run this, THEN fpcast_emu.
"""

import re
import struct
import sys

SEC_CUSTOM = 0
SEC_IMPORT = 2
SEC_EXPORT = 7
SEC_ELEM = 9

KIND_FUNC = 0
KIND_TABLE = 1
KIND_MEM = 2
KIND_GLOBAL = 3
KIND_TAG = 4

WASM_DYLINK_MEM_INFO = 1


def read_uleb(b, i):
    r = 0
    s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        s += 7
        if not (x & 0x80):
            return r, i


def read_sleb(b, i):
    r = 0
    s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        s += 7
        if not (x & 0x80):
            if s < 64 and (x & 0x40):
                r |= -1 << s
            return r, i


def write_uleb(v):
    out = bytearray()
    while True:
        x = v & 0x7F
        v >>= 7
        if v:
            out.append(x | 0x80)
        else:
            out.append(x)
            return bytes(out)


def read_name(b, i):
    n, i = read_uleb(b, i)
    return b[i : i + n].decode("utf-8"), i + n


class Section:
    def __init__(self, sid, body):
        self.id = sid
        self.body = body  # bytes, WITHOUT the id/size header

    def encode(self):
        return bytes([self.id]) + write_uleb(len(self.body)) + self.body


def parse_sections(b):
    if b[:4] != b"\0asm":
        sys.exit("error: not a wasm module")
    sections = []
    i = 8
    while i < len(b):
        sid = b[i]
        i += 1
        size, i = read_uleb(b, i)
        sections.append(Section(sid, b[i : i + size]))
        i += size
    return sections


def main():
    args = sys.argv[1:]
    only = None
    if "--only" in args:
        k = args.index("--only")
        only = re.compile(args[k + 1])
        del args[k : k + 2]
    if len(args) != 2:
        sys.exit(__doc__.strip().split("\n")[0] + "\nusage: wasm-dynsym-inject.py IN OUT [--only REGEX]")
    src, dst = args

    with open(src, "rb") as f:
        data = f.read()
    sections = parse_sections(data)

    # --- gather -----------------------------------------------------------
    exported_funcs = []  # (name, func_index)
    elem_sec = None
    import_sec = None
    dylink_sec = None
    for sec in sections:
        if sec.id == SEC_EXPORT:
            b = sec.body
            n, i = read_uleb(b, 0)
            for _ in range(n):
                name, i = read_name(b, i)
                kind = b[i]
                i += 1
                idx, i = read_uleb(b, i)
                if kind == KIND_FUNC:
                    exported_funcs.append((name, idx))
        elif sec.id == SEC_ELEM:
            elem_sec = sec
        elif sec.id == SEC_IMPORT:
            import_sec = sec
        elif sec.id == SEC_CUSTOM:
            name, _ = read_name(sec.body, 0)
            if name == "dylink.0":
                dylink_sec = sec

    if dylink_sec is None:
        sys.exit("error: no dylink.0 section (not a -shared dylink module)")

    # --- parse the elem segment (wasm-ld emits at most one, flags=0) -------
    elem_funcs = []
    elem_offset_expr = b"\x41\x00\x0b"  # i32.const 0; end (used only if creating)
    if elem_sec is not None:
        b = elem_sec.body
        n, i = read_uleb(b, 0)
        if n != 1:
            sys.exit(f"error: expected 1 elem segment, found {n}")
        flags, i = read_uleb(b, i)
        if flags != 0:
            sys.exit(f"error: unsupported elem segment flags {flags}")
        expr_start = i
        op = b[i]
        i += 1
        if op == 0x41:  # i32.const
            _, i = read_sleb(b, i)
        elif op == 0x23:  # global.get
            _, i = read_uleb(b, i)
        else:
            sys.exit(f"error: unsupported elem offset opcode {op:#x}")
        if b[i] != 0x0B:
            sys.exit("error: elem offset expr not terminated")
        i += 1
        elem_offset_expr = b[expr_start:i]
        cnt, i = read_uleb(b, i)
        for _ in range(cnt):
            fi, i = read_uleb(b, i)
            elem_funcs.append(fi)

    # --- decide what to add + build the name → slot map -----------------------
    slot_of = {fi: slot for slot, fi in reversed(list(enumerate(elem_funcs)))}
    added = []
    dynsym = []  # (name, slot)
    for name, idx in exported_funcs:
        if idx in slot_of:
            dynsym.append((name, slot_of[idx]))
            continue
        if only and not only.search(name):
            continue
        slot_of[idx] = len(elem_funcs) + len(added)
        dynsym.append((name, slot_of[idx]))
        added.append(idx)

    # --- rebuild the elem section -------------------------------------------
    new_elem = bytearray()
    new_elem += write_uleb(1)  # one segment
    new_elem += write_uleb(0)  # flags=0
    new_elem += elem_offset_expr
    new_elem += write_uleb(len(elem_funcs) + len(added))
    for fi in elem_funcs + added:
        new_elem += write_uleb(fi)
    if elem_sec is None:
        # No elem segment: create one right before the code section.
        elem_sec = Section(SEC_ELEM, bytes(new_elem))
        for k, sec in enumerate(sections):
            if sec.id > SEC_ELEM and sec.id != SEC_CUSTOM:
                sections.insert(k, elem_sec)
                break
        else:
            sections.append(elem_sec)
    else:
        elem_sec.body = bytes(new_elem)

    # --- bump the table import's initial size --------------------------------
    if import_sec is not None:
        b = import_sec.body
        out = bytearray()
        n, i = read_uleb(b, 0)
        out += write_uleb(n)
        for _ in range(n):
            start = i
            _, i = read_name(b, i)
            _, i = read_name(b, i)
            kind = b[i]
            i += 1
            if kind == KIND_TABLE:
                out += b[start : i + 1]  # names + kind + reftype
                i += 1
                flags, i = read_uleb(b, i)
                initial, i = read_uleb(b, i)
                out += write_uleb(flags)
                out += write_uleb(initial + len(added))
                if flags & 1:
                    mx, i = read_uleb(b, i)
                    out += write_uleb(mx + len(added))
                continue
            if kind == KIND_FUNC:
                _, i = read_uleb(b, i)
            elif kind == KIND_MEM:
                flags, i = read_uleb(b, i)
                _, i = read_uleb(b, i)
                if flags & 1:
                    _, i = read_uleb(b, i)
            elif kind == KIND_GLOBAL:
                i += 2
            elif kind == KIND_TAG:
                i += 1
                _, i = read_uleb(b, i)
            else:
                sys.exit(f"error: unknown import kind {kind}")
            out += b[start:i]
        import_sec.body = bytes(out)

    # --- bump dylink.0 MEM_INFO tableSize -------------------------------------
    b = dylink_sec.body
    name, i = read_name(b, 0)
    out = bytearray(b[:i])
    while i < len(b):
        sub = b[i]
        i += 1
        sub_size, i = read_uleb(b, i)
        sub_end = i + sub_size
        if sub == WASM_DYLINK_MEM_INFO:
            mem_size, j = read_uleb(b, i)
            mem_align, j = read_uleb(b, j)
            table_size, j = read_uleb(b, j)
            table_align, j = read_uleb(b, j)
            body = (
                write_uleb(mem_size)
                + write_uleb(mem_align)
                + write_uleb(table_size + len(added))
                + write_uleb(table_align)
            )
            out += bytes([sub]) + write_uleb(len(body)) + body
        else:
            out += bytes([sub]) + write_uleb(sub_size) + b[i:sub_end]
        i = sub_end
    dylink_sec.body = bytes(out)

    # --- append the cb.dynsym custom section ----------------------------------
    sym_body = bytearray()
    sec_name = b"cb.dynsym"
    sym_body += write_uleb(len(sec_name))
    sym_body += sec_name
    sym_body += write_uleb(len(dynsym))
    for name, slot in dynsym:
        nb = name.encode("utf-8")
        sym_body += write_uleb(len(nb))
        sym_body += nb
        sym_body += write_uleb(slot)
    sections = [s for s in sections if not (s.id == SEC_CUSTOM and read_name(s.body, 0)[0] == "cb.dynsym")]
    sections.append(Section(SEC_CUSTOM, bytes(sym_body)))

    with open(dst, "wb") as f:
        f.write(b"\0asm" + struct.pack("<I", 1))
        for sec in sections:
            f.write(sec.encode())
    print(
        f"wasm-dynsym-inject: {len(dynsym)} dynsym entr(ies); added {len(added)} elem slot(s) "
        f"({len(elem_funcs)} were already present)"
    )


if __name__ == "__main__":
    main()
