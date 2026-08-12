#!/usr/bin/env python3
"""Assert that a wasm module's allow-list-governed imports are all on an
allow-list (nix-wasm#131 slice-1 PR-2 — the busybox-fork `--import-undefined`
hardening).

    wasm-check-imports.py MODULE.wasm ALLOWLIST.txt [EXTRA_SYM ...]

ALLOWLIST.txt is the one-name-per-line file toolchain/wasm-host-imports.nix
generates (the shared no-undef contract, #52) — the SAME file every other
guest link passes to wasm-ld via --allow-undefined-file. EXTRA_SYM are names
allowed in addition to the file's contents, for a link that also has its own
narrow undefined import (e.g. busybox-fork's `capture_stack`, the asyncify
unwind seam) on top of the shared set.

Exits 0 when every governed import is in (allowlist file ∪ extras), else
prints the violating names (plus the full accepted set, so a typo is
obvious) and exits 1.

WHY a build-time check exists at all: `busybox-fork.nix` links with the
blanket `-Wl,--import-undefined` (never `--allow-undefined-file`) because the
asyncify seam's `capture_stack` must stay an undefined import — but a blanket
flag is exactly the hazard CLAUDE.md's no-undef contract (#52) warns about:
ANY unresolved symbol silently becomes an import instead of failing the
link, which is how #36's removed `fork` became the #50 dangling `env.fork`
LinkError instead of a build error. This script restores that "stray symbol
fails loudly" contract on the ONE binary that can't use --allow-undefined-file
directly, by checking the FINAL shipped binary (after asyncify, which may
add/keep imports) against the same shared allow-list plus the one documented
extra name.

WHAT IS GOVERNED — two import shapes, not one:

  1. `env.<name>` FUNCTION imports — the classic case: an unresolved DIRECT
     CALL becomes an env function import.
  2. `GOT.func.<name>` / `GOT.mem.<name>` imports — under `-shared` PIC (every
     guest link, incl. this one) an unresolved symbol that is only
     ADDRESS-TAKEN, never called directly (busybox's `applet_main[]`
     function-pointer-table shape is exactly this), does NOT become an env
     function import at all: wasm-ld emits a `GOT.func.<name>` (or, for a
     data symbol, `GOT.mem.<name>`) import instead — a mutable GLOBAL holding
     the resolved address, not a function. A checker that only looks at
     `env.*` function imports never sees this. Reproduced directly: a probe
     TU with `extern void f(void); void *t[] = { (void*)&f };` linked with
     `--import-undefined` through the real cross cc-wrapper emits exactly
     `GOT.func.f` (kind=global) and NO env-function counterpart — confirmed
     empirically before this fix existed, and it is why the check parses
     module names, not just kind==0. (kernel-worker.js resolves unknown
     `GOT.func.*`/`GOT.mem.*` imports to 0 rather than failing, so this class
     instantiates fine and only traps later, at the `call_indirect` that
     dereferences the null address — silently, exactly the failure mode the
     no-undef contract exists to turn into a loud build-time error instead.)

  A FUNCTION import from any module OTHER than `env`/`GOT.func`/`GOT.mem` is
  ALSO governed (and reported qualified as `<module>.<name>`) rather than
  silently ignored — an unexpected import module is itself suspicious enough
  to fail loudly on. Non-function `env.*` imports (`env.memory`,
  `env.__indirect_function_table`, `env.__stack_pointer`, `env.__memory_base`,
  `env.__table_base`) are dylink plumbing (--import-memory/--import-table/PIC
  base globals), not per-symbol relocations, and stay exempt.

Parses the wasm IMPORT section directly (no name section needed — imports are
always named, unlike the export-section case in wasm-check-exports.py, but we
match its raw-section-parsing style rather than shelling out to
objdump/wasm-objdump), and asserts the section is consumed EXACTLY to its
declared end — an entry-decoding desync (e.g. a value type this parser
doesn't expect) fails loudly instead of silently reading garbage for every
entry after it.
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


def read_str(b, i):
    """length-prefixed UTF-8 string -> (value, next index)."""
    n, i = read_u32(b, i)
    s = b[i : i + n].decode("utf-8", "replace")
    return s, i + n


def parse_imports(b):
    """Parse the wasm IMPORT section.

    Returns (checked, total): `checked` is the set of allow-list-governed
    import names (see the module docstring for exactly which imports that
    is), and `total` is the raw count of ALL import entries of any
    module/kind — used to catch a parse that silently found nothing (a real
    dylink module always imports at least `env.memory`, so total==0 means
    the parse went wrong, not that the module truly has no imports).
    """
    if b[0:4] != b"\0asm":
        raise SystemExit("not a wasm module")
    i = 8
    while i < len(b):
        sec_id = b[i]
        i += 1
        size, i = read_u32(b, i)
        if sec_id != 2:  # not the import section
            i += size
            continue
        section_end = i + size
        j = i
        count, j = read_u32(b, j)
        checked = set()
        total = 0
        for _ in range(count):
            mod, j = read_str(b, j)
            name, j = read_str(b, j)
            kind = b[j]
            j += 1
            if kind == 0:  # function: importdesc is a single typeidx
                _, j = read_u32(b, j)
            elif kind == 1:  # table: elemtype byte + limits
                j += 1
                flags = b[j]
                j += 1
                _, j = read_u32(b, j)
                if flags & 1:
                    _, j = read_u32(b, j)
            elif kind == 2:  # memory: limits only
                flags = b[j]
                j += 1
                _, j = read_u32(b, j)
                if flags & 1:
                    _, j = read_u32(b, j)
            elif kind == 3:  # global: valtype byte + mutability byte
                j += 2
            else:
                raise SystemExit(f"unknown import kind {kind} in {mod}.{name}")
            total += 1
            if mod in ("GOT.func", "GOT.mem"):
                # PIC relocation import (any kind — in practice always a
                # mutable global): the field IS the underlying symbol name,
                # not dylink plumbing. The function-pointer form of the same
                # no-undef contract — see the module docstring.
                checked.add(name)
            elif kind == 0:
                # A FUNCTION import. env.* is the normal host-call surface
                # (bare name, checked against the allow-list as-is);
                # anything else is an unexpected import module and must not
                # be silently exempt — qualify it so it reads clearly in an
                # error and so it can never coincidentally collide with an
                # allow-listed bare name.
                checked.add(name if mod == "env" else f"{mod}.{name}")
            # kind in (1, 2, 3) under mod == "env" (memory/table/globals like
            # __stack_pointer/__memory_base/__table_base) is dylink plumbing,
            # not per-symbol relocation surface, and stays exempt.
        if j != section_end:
            raise SystemExit(
                f"import section parse desync: consumed to byte {j}, but the "
                f"section header declares it ends at {section_end}. This means "
                "an import entry decoded wrong (e.g. an unexpected value-type "
                "encoding) and every entry after it was read from the wrong "
                "offset — do not trust partial results from this parse."
            )
        return checked, total
    return set(), 0


def main(argv):
    if len(argv) < 3:
        raise SystemExit(f"usage: {argv[0]} MODULE.wasm ALLOWLIST.txt [EXTRA_SYM ...]")
    path, allowlist_path = argv[1], argv[2]
    extra = argv[3:]
    with open(path, "rb") as f:
        present, total = parse_imports(f.read())
    if total == 0:
        raise SystemExit(
            f"ERROR: {path} has zero wasm import-section entries of ANY kind. "
            "A real dylink module always imports at least env.memory, so this "
            "means the parse failed (or ran on the wrong file), not that the "
            "module genuinely has no imports — treating it as a pass would "
            "silently skip the check it exists to perform."
        )
    with open(allowlist_path) as f:
        allowed = {line.strip() for line in f if line.strip()}
    allowed |= set(extra)
    violators = sorted(present - allowed)
    if violators:
        print(
            f"ERROR: {path} has allow-list-governed imports NOT on the allow-list: "
            f"{' '.join(violators)}\n"
            "  This binary links with a blanket -Wl,--import-undefined (kept only\n"
            "  for the asyncify capture_stack seam), which silently turns ANY\n"
            "  unresolved symbol into an import instead of failing the link\n"
            "  (exactly how #36's removed `fork` became the #50 dangling `env.fork`\n"
            "  LinkError instead of a build failure — nix-wasm CLAUDE.md's no-undef\n"
            "  contract, #52). This covers BOTH shapes an unresolved symbol can take\n"
            "  under -shared PIC: a direct call (env.<name> function import) and a\n"
            "  bare address-of (GOT.func.<name> / GOT.mem.<name> global import,\n"
            "  busybox's applet_main[] function-pointer-table shape) — a violator\n"
            "  here means something is silently unresolved that should have failed\n"
            "  to link.\n"
            f"  allow-list ({allowlist_path}) + extras: {' '.join(sorted(allowed))}\n"
            f"  governed imports found: {' '.join(sorted(present))}",
            file=sys.stderr,
        )
        return 1
    print(
        f"wasm-check-imports: {path}: {len(present)} allow-list-governed imports "
        f"(env.* functions + GOT.func.*/GOT.mem.*), all allowed: "
        f"{' '.join(sorted(present))}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
