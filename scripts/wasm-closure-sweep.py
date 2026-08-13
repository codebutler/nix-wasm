#!/usr/bin/env python3
"""Walk one or more store-path roots, find every real wasm module (by magic
bytes, not extension or a name allow-list — busybox's applet farm is
hundreds of symlinks to ONE binary, so realpath-deduping finds it exactly
once), and run wasm-check-imports.py's --fork-contract=PROFILE check
(nix-wasm#202 PR-1) over the whole set in one pass.

    wasm-closure-sweep.py PROFILE [--expect-capture-stack-count=N] \
        [--roots-file=FILE] [ROOT ...]

PROFILE is "nommu-spawn" or "mmu-fork" (see wasm-check-imports.py's module
docstring for the two-sided contract each profile enforces). ROOT is a
directory (or a single file) to walk recursively; typical callers pass a
guest package's own $out plus the base-system closure's store-paths (see
userspace/spawn-contract-sweep.nix, the Nix derivation wrapper this is meant
to run inside). --roots-file=FILE reads additional roots, one per line, from
FILE — the same shape `pkgs.closureInfo`'s `store-paths` output has, so a
closure with thousands of entries doesn't need to fit on one argv (the
`nix-wasm` codebase's own convention for this, e.g. userspace/
base-squashfs.nix's `while read -r p; do ...; done < ${closure}/store-paths`
loop — this script takes the same file directly instead of re-deriving that
loop in shell).

--expect-capture-stack-count=N additionally asserts EXACTLY N of the swept
modules import capture_stack (not merely that each one that does is
asyncify-clean — the #202 PR-1 plan's own "exactly 2 modules" expectation,
MEASURED, not assumed: see the flake.nix callers for how this was pinned).
Omit it to leave the count unasserted (only the per-module contract is
checked) — the right choice when the exact membership of the fork-using set
is still in flux.

Reuses wasm-check-imports.py's parser/checker directly (loaded by path, like
that script reuses wasm-check-exports.py) rather than a fourth wasm parser.
THIS script's own directory is the anchor for both sibling scripts, so the
Nix caller MUST interpolate the whole `scripts/` DIRECTORY (e.g.
`${../scripts}/wasm-closure-sweep.py`), not just this one file
(`${../scripts/wasm-closure-sweep.py}`) — the latter copies only this file
into the store and both sibling `importlib` loads below then raise
FileNotFoundError (nix-wasm#202, found by review; see
userspace/spawn-contract-sweep.nix's comment on its own interpolation).
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "wasm_check_imports", os.path.join(_HERE, "wasm-check-imports.py")
)
wci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wci)
_EXPORTS_SCRIPT = os.path.join(_HERE, "wasm-check-exports.py")


def has_dylink_section(data):
    """True if `data` (a wasm module's bytes) carries a `dylink.0` (or the
    legacy `dylink`) custom section — i.e. it is a FINAL, linked dylink
    module, not a relocatable object file (crt1.o/crti.o/crtn.o/Scrt1.o/
    rcrt1.o and similar `.o`s also start with the `\\0asm` magic and carry a
    real import section, so the magic-byte filter alone lets them through).
    A relocatable object's undefined references show up as ordinary
    functions with NO defining body at this stage — wasm-ld hasn't run yet
    — which the import-section parser cannot distinguish from a genuine
    host-import; a shipped `_Fork.o` post-split (PR-2) would otherwise be a
    guaranteed false positive here. Custom sections have id 0, followed by a
    length-prefixed NAME then the section payload — this checks the name
    only, cheaply, without parsing the payload.
    """
    if data[0:4] != b"\0asm":
        return False
    i = 8
    while i < len(data):
        sec_id = data[i]
        i += 1
        size, i = wci.read_u32(data, i)
        if sec_id == 0:
            name, _ = wci.read_str(data, i)
            if name in ("dylink.0", "dylink"):
                return True
        i += size
    return False


def find_wasm_modules(roots):
    """Yield (realpath, data) for every distinct file under `roots` whose
    first 4 bytes are the wasm magic AND which carries a dylink section (see
    has_dylink_section) — i.e. every real, FINAL-LINKED guest module, never
    an intermediate relocatable object. Dedupes via realpath so a symlink
    farm (every busybox applet -> the one busybox binary) is visited once.
    Yields the already-read bytes too (module sizes run into the tens of MB
    and the caller needs them again for the actual check — no reason to open
    every module twice)."""
    seen = set()
    for root in roots:
        paths = [root] if os.path.isfile(root) else None
        if paths is None:
            paths = []
            for dirpath, _dirnames, filenames in os.walk(root):
                for fn in filenames:
                    paths.append(os.path.join(dirpath, fn))
        for p in paths:
            if not os.path.isfile(p):  # dangling symlink, device node, ...
                continue
            rp = os.path.realpath(p)
            if rp in seen:
                continue
            seen.add(rp)
            try:
                with open(rp, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if data[0:4] == b"\0asm" and has_dylink_section(data):
                yield rp, data


def main(argv):
    if len(argv) < 3:
        raise SystemExit(
            f"usage: {argv[0]} PROFILE [--expect-capture-stack-count=N] "
            "[--roots-file=FILE] [ROOT ...]"
        )
    profile = argv[1]
    if profile not in wci.FORK_CONTRACT_PROFILES:
        raise SystemExit(
            f"ERROR: PROFILE must be one of {wci.FORK_CONTRACT_PROFILES}, got {profile!r}"
        )
    expect_count = None
    roots = []
    for arg in argv[2:]:
        if arg.startswith("--expect-capture-stack-count="):
            expect_count = int(arg.split("=", 1)[1])
        elif arg.startswith("--roots-file="):
            roots_file = arg.split("=", 1)[1]
            with open(roots_file) as f:
                roots += [line.strip() for line in f if line.strip()]
        else:
            roots.append(arg)
    if not roots:
        raise SystemExit("ERROR: no ROOT paths given to sweep")

    modules = sorted(find_wasm_modules(roots), key=lambda pd: pd[0])
    if not modules:
        raise SystemExit(
            "ERROR: found ZERO wasm modules under the given roots — the sweep "
            "found nothing to check, which almost certainly means a root path "
            "is wrong, not that the closure genuinely has no wasm binaries."
        )

    exported_funcs = wci._load_exported_funcs(_EXPORTS_SCRIPT)
    all_violations = []
    fork_users = []
    for path, data in modules:
        violations, has_capture_stack = wci.fork_contract_check(path, data, profile, exported_funcs)
        all_violations += violations
        if has_capture_stack:
            fork_users.append(path)
        print(f"wasm-closure-sweep --fork-contract={profile}: {path}: "
              f"{'capture_stack' if has_capture_stack else '-'}")

    print(
        f"wasm-closure-sweep --fork-contract={profile}: {len(modules)} distinct wasm "
        f"modules swept, {len(fork_users)} import capture_stack"
    )
    for p in fork_users:
        print(f"  capture_stack: {p}")

    if expect_count is not None and len(fork_users) != expect_count:
        all_violations.append(
            f"expected EXACTLY {expect_count} modules importing capture_stack, "
            f"found {len(fork_users)}: {fork_users}. A boot-path binary gaining "
            "(or losing) asyncify instrumentation must be a deliberate, "
            "reviewed change — update the pinned count alongside it, don't "
            "silently accept a drift."
        )

    if all_violations:
        print(f"ERROR: {len(all_violations)} violation(s):", file=sys.stderr)
        for v in all_violations:
            print(f"  {v}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
