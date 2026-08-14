#!/usr/bin/env python3
"""Walk one or more store-path roots, find every real wasm module (by magic
bytes, not extension or a name allow-list — busybox's applet farm is
hundreds of symlinks to ONE binary, so realpath-deduping finds it exactly
once), and run wasm-check-imports.py's --fork-contract=PROFILE check
(nix-wasm#202 PR-1) over the whole set in one pass.

    wasm-closure-sweep.py PROFILE [--expect-capture-stack-count=N] \
        [--expect-capture-stack=NAME[,NAME...]] [--expect-min-modules=N] \
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

--expect-capture-stack=NAME[,NAME...] additionally asserts the capture_stack
IMPORTERS are exactly the modules with these basenames (order-independent,
comma-separated) — a stronger check than the count alone. A count match
alone cannot tell "the right 2 modules use fork" from "some OTHER 2 modules
gained a fork path while one of the real ones lost it" (e.g. after a musl TU
split, busybox-fork could stop pulling _Fork.c while some unrelated binary
picks up capture_stack some other way — count stays 2, this identity check
is what actually catches it). Compares against
`sorted(os.path.basename(p) for p in fork_users)` — basenames, not full
paths, since the real on-disk file (after realpath-dedup through any
symlink farm) is what matters, not its containing store path.

--expect-min-modules=N additionally asserts AT LEAST N modules were swept in
total (after the dylink-section filter below) — a floor against silently
sweeping far fewer modules than expected (e.g. a root path typo that still
happens to resolve to SOME files, or a future change that narrows the root
set without anyone noticing). Distinct from the "zero modules is always an
error" check below, which catches the total-collapse case unconditionally;
this is an explicit, per-profile regression floor.

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


def _walk_onerror(err):
    """os.walk's default onerror=None SWALLOWS a walk failure (e.g. a
    nonexistent or unreadable directory) — it just yields nothing for that
    subtree, no exception, no message. That silently degrades a genuine
    sweep root (a mistyped path, a permissions problem, a root that
    disappeared between listing and stat) into "found zero modules there",
    indistinguishable from "this subtree really only has non-wasm files"
    (nix-wasm#202, found by review — reproduced: a bogus extra root path
    silently vanished from a real sweep with rc=0). Raise instead, so a
    walk failure fails the sweep loudly, the same as the explicit
    os.path.exists check in find_wasm_modules covers the top-level root
    itself not existing at all.
    """
    raise SystemExit(f"ERROR: sweep failed walking a root directory: {err}")


def find_wasm_modules(roots, skipped):
    """Yield the realpath of every distinct, FINAL-LINKED guest wasm module
    (wasm magic + a dylink section — see has_dylink_section) under `roots`.
    Dedupes via realpath so a symlink farm (every busybox applet -> the one
    busybox binary) is visited once. Appends to `skipped` (a list mutated in
    place) the realpath of every distinct file that carries the wasm magic
    but is NOT a final-linked dylink module (e.g. cc-sysroot's crt*.o
    relocatable objects) — counted and reported by the caller rather than
    silently dropped (nix-wasm#202, found by review: the pre-existing filter
    had no counter and no log, so a change that started skipping MORE files
    than expected — e.g. a link flag regression that stopped producing
    dylink sections — would have been invisible here).

    Only ever reads a candidate file's full bytes once it has already
    confirmed the first 4 bytes are the wasm magic — the closure of a real
    nix-wasm store commonly holds gigabytes of non-wasm files (headers,
    docs, other architectures' objects, ...) that this must not read in
    full just to reject.  Yields PATHS ONLY (not the module bytes) — a
    prior revision yielded `(path, data)` pairs and the caller `sorted()`ed
    the whole generator, which holds EVERY swept module's full bytes in
    memory simultaneously (measured at 2.23 GB of distinct wasm modules
    across the cross outputs in a real store, nix-wasm#202, found by
    review); the caller now re-reads each module's bytes one at a time,
    inside its own per-module loop, well after this generator (and its
    `seen`/`skipped` bookkeeping) has finished."""
    seen = set()
    for root in roots:
        if not os.path.exists(root):
            raise SystemExit(
                f"ERROR: sweep root does not exist: {root!r} — a mistyped "
                "root path must fail the sweep loudly, not silently "
                "contribute zero modules and let the sweep pass on "
                "whatever the OTHER roots happened to provide (nix-wasm#202, "
                "found by review)."
            )
        paths = [root] if os.path.isfile(root) else None
        if paths is None:
            paths = []
            for dirpath, _dirnames, filenames in os.walk(root, onerror=_walk_onerror):
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
                    magic = f.read(4)
                    if magic != b"\0asm":
                        continue
                    data = magic + f.read()
            except OSError:
                continue
            if has_dylink_section(data):
                yield rp
            else:
                skipped.append(rp)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(
            f"usage: {argv[0]} PROFILE [--expect-capture-stack-count=N] "
            "[--expect-capture-stack=NAME[,NAME...]] [--expect-min-modules=N] "
            "[--roots-file=FILE] [ROOT ...]"
        )
    profile = argv[1]
    if profile not in wci.FORK_CONTRACT_PROFILES:
        raise SystemExit(
            f"ERROR: PROFILE must be one of {wci.FORK_CONTRACT_PROFILES}, got {profile!r}"
        )
    expect_count = None
    expect_names = None
    expect_min_modules = None
    roots = []
    # Every recognized flag is matched by an EXACT prefix (including its
    # trailing `=`) below; anything else that starts with `--` is REJECTED
    # loudly rather than falling through to `roots.append(arg)`. Before this
    # fix, a typo'd flag (e.g. `--expect-capture-stack-count 2` with a space
    # instead of `=`, or a plain misspelling) silently became a ROOT PATH —
    # `os.walk` on a nonexistent path used to yield nothing with no error
    # (see _walk_onerror above), so the count assertion was quietly dropped
    # AND the bogus "root" vanished, and the sweep still exited 0 (nix-wasm
    # #202, found by review, reproduced exactly this way: a typo'd
    # `--expect-capture-stack-cnt=2` flag disabled the count pin entirely
    # with the gate still passing). The space form of any flag is REJECTED
    # by the same mechanism (it never matches an exact `--foo=` prefix,
    # falls through to the `--`-prefixed catch-all below) rather than
    # silently accepted as some other meaning.
    for arg in argv[2:]:
        if arg.startswith("--expect-capture-stack-count="):
            expect_count = int(arg.split("=", 1)[1])
        elif arg.startswith("--expect-capture-stack="):
            expect_names = sorted(
                n for n in arg.split("=", 1)[1].split(",") if n
            )
        elif arg.startswith("--expect-min-modules="):
            expect_min_modules = int(arg.split("=", 1)[1])
        elif arg.startswith("--roots-file="):
            roots_file = arg.split("=", 1)[1]
            with open(roots_file) as f:
                roots += [line.strip() for line in f if line.strip()]
        elif arg.startswith("--"):
            raise SystemExit(
                f"ERROR: unrecognized flag {arg!r}. Recognized flags: "
                "--expect-capture-stack-count=N, --expect-capture-stack=NAME[,NAME...], "
                "--expect-min-modules=N, --roots-file=FILE. A mistyped or "
                "space-separated flag must fail loudly here, not silently be "
                "treated as a ROOT path (nix-wasm#202, found by review)."
            )
        else:
            roots.append(arg)
    if not roots:
        raise SystemExit("ERROR: no ROOT paths given to sweep")

    skipped = []
    modules = sorted(find_wasm_modules(roots, skipped))
    if not modules:
        raise SystemExit(
            "ERROR: found ZERO wasm modules under the given roots — the sweep "
            "found nothing to check, which almost certainly means a root path "
            "is wrong, not that the closure genuinely has no wasm binaries."
        )
    print(
        f"wasm-closure-sweep --fork-contract={profile}: {len(skipped)} wasm-magic "
        "file(s) skipped (no dylink.0/dylink section — relocatable objects, "
        "e.g. crt*.o, not final-linked modules)"
    )
    for p in skipped:
        print(f"  skipped (no dylink section): {p}")

    exported_funcs = wci._load_exported_funcs(_EXPORTS_SCRIPT)
    all_violations = []
    fork_users = []
    for path in modules:
        with open(path, "rb") as f:
            data = f.read()
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

    if expect_names is not None:
        got_names = sorted(os.path.basename(p) for p in fork_users)
        if got_names != expect_names:
            all_violations.append(
                f"expected the capture_stack importers to be EXACTLY "
                f"{expect_names} (by basename), found {got_names}. A count "
                "match alone cannot tell 'the right modules use fork' from "
                "'some OTHER module gained a fork path while one of the real "
                "ones lost it' (e.g. after a musl TU split, one binary could "
                "silently stop pulling the fork seam while an unrelated one "
                "picks it up some other way, leaving the COUNT unchanged) — "
                "this identity check is what catches that (nix-wasm#202, "
                "found by review)."
            )

    if expect_min_modules is not None and len(modules) < expect_min_modules:
        all_violations.append(
            f"expected AT LEAST {expect_min_modules} swept wasm modules, found "
            f"only {len(modules)}. A shrinking swept-module count usually means "
            "a root path regressed (typo, narrowed root set, a build that "
            "stopped producing dylink sections) rather than that the guest "
            "closure genuinely lost binaries — update the pinned floor "
            "alongside a deliberate, reviewed removal."
        )

    if all_violations:
        print(f"ERROR: {len(all_violations)} violation(s):", file=sys.stderr)
        for v in all_violations:
            print(f"  {v}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
