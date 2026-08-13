#!/usr/bin/env python3
"""Assert that a wasm module's allow-list-governed imports are all on an
allow-list (nix-wasm#131 slice-1 PR-2 — the busybox-fork `--import-undefined`
hardening), OR run the Phase-2 spawn-contract sweep (--fork-contract).

    wasm-check-imports.py MODULE.wasm ALLOWLIST.txt [EXTRA_SYM ...]
    wasm-check-imports.py --fork-contract=PROFILE --exports-script=PATH MODULE.wasm [MODULE.wasm ...]

ALLOWLIST.txt is the one-name-per-line file toolchain/wasm-host-imports.nix
generates (the shared no-undef contract, #52) — the SAME file every other
guest link passes to wasm-ld via --allow-undefined-file. EXTRA_SYM are names
allowed in addition to the file's contents, for a link that also has its own
narrow undefined import (e.g. busybox-fork's `capture_stack`, the asyncify
unwind seam) on top of the shared set.

Exits 0 when every governed import is in (allowlist file ∪ extras), else
prints the violating names (plus the full accepted set, so a typo is
obvious) and exits 1.

--fork-contract=PROFILE is the guest-closure-wide gate the fork-default flip
(#202 PR-1) needs BEFORE it's safe to flip toolchain/musl.nix's default: it
checks the two-sided capture_stack/asyncify contract described in the module
docstring below, over one or more real shipped modules, in one of two
profiles. --exports-script=PATH (REQUIRED in this mode) is the path to
wasm-check-exports.py — passed explicitly, never guessed from this script's
own location, because in a Nix build the caller may have interpolated only
THIS file into the store (busybox-fork.nix's existing call does exactly
that for the OTHER mode), which would leave no sibling to find:

  nommu-spawn — the profile that SHIPS today: NO module may import
    `capture_stack` at all (the default guest libc has fork()/vfork()
    removed at the symbol level — see toolchain/musl.nix's `fork ? false` —
    so nothing should ever reference the asyncify seam).

  mmu-fork — the #129/#131 real-fork guest (`.#kernel-mmu-a2` +
    `.#wasm-initramfs-fork` / `.#wasm-base-squashfs-fork`): a module MAY
    import `capture_stack` (musl-fork's `_Fork()` seam), but if it does it
    MUST ALSO export the full Binaryen asyncify ABI the engine drives
    (runtime/asyncify.js's `makeCaptureStack`/`isPendingUnwind`/
    `stopUnwind`/`startRewind`): `asyncify_get_state`, `asyncify_start_unwind`,
    `asyncify_stop_unwind`, `asyncify_start_rewind`, `asyncify_stop_rewind`.
    A module that imports capture_stack WITHOUT that export set would
    instantiate fine (wasm only wires the imports a module asks for) and
    then crash with a TypeError the first time fork() actually runs — this
    mode restores build-time loudness for exactly that failure mode. See
    the "WHY THIS GATE EXISTS" note below for the full mechanism.

WHY THIS GATE EXISTS (the finding it protects against — nix-wasm#202): Phase 2
flips `toolchain/musl.nix`'s default from `fork ? false` to `fork = true`.
That does not make fork() WORK — it makes it LINK. The engine provides
`env.capture_stack` to every module unconditionally
(runtime/kernel-worker.js's per-worker import object — "wasm wires only the
imports a module asks for" is a real WebAssembly property, so providing it
unconditionally is harmless for modules that never reference it). Its
implementation (runtime/asyncify.js's `makeCaptureStack`) immediately calls
`inst.exports.asyncify_get_state()` on the FIRST call — which exists ONLY on a
module that was run through `wasm-opt --asyncify`. A module that imports
capture_stack (because it links against musl-fork and calls fork()
somewhere on its call graph) but was never asyncify'd links and instantiates
fine, then TypeErrors the first time fork() actually executes — replacing
today's loud link-time `undefined symbol: fork` with a late, silent runtime
crash. This sweep is the mechanical guard that makes that impossible: run it
over the WHOLE guest closure (every shipped .wasm module) in CI, in both
profiles, so a future rebuild that produces a capture_stack-importing,
non-asyncified module fails the BUILD, not a boot.

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

WHAT IS GOVERNED — three import shapes, not one:

  1. `env.<name>` FUNCTION imports — the classic case: an unresolved DIRECT
     CALL becomes an env function import.
  2. `env.<name>` TAG imports (wasm-EH, import kind 4 — e.g. `__cpp_exception`,
     already on the shared allow-list) — a `-fwasm-exceptions` module IMPORTS
     the exception tag it throws/catches with rather than defining it (every
     C++ guest binary does this, so this shape is common, not exotic).
     Governed exactly like a function import: found by name, `env.<name>`
     bare or `<module>.<name>` qualified. Added for THIS gate — the
     closure-wide sweep (#202 PR-1) is the first caller to run this parser
     over real C++ binaries (nix.wasm and its `-fork` twin); every prior
     caller only ever checked busybox, which has no C++ in it and so never
     exercised this import kind. Without this case the parser raised
     `SystemExit("unknown import kind 4 …")` on the very first C++ module it
     saw — found by running the sweep against the real `nix-wasm-fork`
     binary, not by inspection.
  3. `GOT.func.<name>` / `GOT.mem.<name>` imports — under `-shared` PIC (every
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
            elif kind == 4:  # tag (wasm-EH): attribute byte (0=exception) + typeidx
                j += 1
                _, j = read_u32(b, j)
            else:
                raise SystemExit(f"unknown import kind {kind} in {mod}.{name}")
            total += 1
            if mod in ("GOT.func", "GOT.mem"):
                # PIC relocation import (any kind — in practice always a
                # mutable global): the field IS the underlying symbol name,
                # not dylink plumbing. The function-pointer form of the same
                # no-undef contract — see the module docstring.
                checked.add(name)
            elif kind in (0, 4):
                # A FUNCTION (0) or TAG (4) import — both name a real host-
                # provided symbol, not dylink plumbing (see the module
                # docstring's "WHAT IS GOVERNED" case 2 for the tag case,
                # e.g. env.__cpp_exception). env.* is the normal host-call
                # surface (bare name, checked against the allow-list as-is);
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


# ---------------------------------------------------------------------------
# --fork-contract=PROFILE (nix-wasm#202 PR-1). See the module docstring for
# the full mechanism/rationale.

# The exact Binaryen asyncify export names the ENGINE calls, verified against
# runtime/asyncify.js (makeCaptureStack/isPendingUnwind/stopUnwind/
# startRewind) — not written from memory. Keep this list and that file in
# sync; a name here that drifts from what the engine actually calls would
# make this gate pass a module that still TypeErrors at runtime.
ASYNCIFY_EXPORTS = (
    "asyncify_get_state",
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
)

FORK_CONTRACT_PROFILES = ("nommu-spawn", "mmu-fork")


def _load_exported_funcs(exports_script):
    """Return wasm-check-exports.py's `exported_funcs`, loaded from
    `exports_script` by path (not by `import` — the filename has a hyphen, so
    it isn't a valid Python module name) rather than re-implementing a second
    export-section parser here. Both scripts already duplicate the trivial
    `read_u32` LEB128 reader (an established convention in this directory —
    see wasm-strip-export.py too); the export-section WALK itself (name +
    kind + index decoding, the part actually worth not tripling) is reused
    for real via this loader instead.

    `exports_script` MUST be passed explicitly by the caller — this used to
    guess it via `os.path.dirname(os.path.abspath(__file__))`, which is
    exactly wrong in a Nix build: interpolating a path to THIS file alone
    (`${../scripts/wasm-check-imports.py}`, the shape busybox-fork.nix's own
    unrelated call already uses) copies only that one file into the store as
    its own singleton `/nix/store/<hash>-wasm-check-imports.py`; siblings are
    NOT copied alongside it. `__file__`-relative lookup would then raise
    FileNotFoundError inside the Nix sandbox the first time anything called
    `--fork-contract` mode that way — found by review, reproduced with a
    minimal flake of identical shape (nix-wasm#202). Every caller — this
    script's own `--fork-contract` CLI mode and scripts/wasm-closure-sweep.py
    — must now say explicitly where wasm-check-exports.py lives; there is no
    silent same-directory fallback to regress back into.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location("wasm_check_exports", exports_script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.exported_funcs


def fork_contract_check(path, data, profile, exported_funcs):
    """Check ONE module's data against `profile`. Returns a list of violation
    strings (empty = the module is clean) plus a bool `has_capture_stack` for
    the caller's summary."""
    present, total = parse_imports(data)
    if total == 0:
        return (
            [f"{path}: zero wasm import-section entries of ANY kind (parse failed?)"],
            False,
        )
    has_capture_stack = "capture_stack" in present
    violations = []
    if profile == "nommu-spawn":
        if has_capture_stack:
            violations.append(
                f"{path}: imports capture_stack, but the nommu-spawn profile's "
                "guest libc has fork()/vfork() removed at the symbol level "
                "(toolchain/musl.nix `fork ? false`) — nothing in this profile "
                "should ever reference the asyncify fork seam. A module here "
                "means either musl.nix's default flipped without this module "
                "moving to the mmu-fork closure, or something references "
                "capture_stack outside the fork seam entirely."
            )
    elif profile == "mmu-fork":
        if has_capture_stack:
            exported = exported_funcs(data)
            missing = [n for n in ASYNCIFY_EXPORTS if n not in exported]
            if missing:
                violations.append(
                    f"{path}: imports capture_stack but does NOT export the full "
                    f"Binaryen asyncify ABI — missing: {' '.join(missing)}. "
                    "This is exactly the #202 finding: the engine's capture_stack "
                    "import (runtime/kernel-worker.js) calls "
                    "inst.exports.asyncify_get_state() unconditionally on first "
                    "use (runtime/asyncify.js's makeCaptureStack) — a module that "
                    "imports the seam without having been run through "
                    "`wasm-opt --asyncify` links and instantiates fine, then "
                    "TypeErrors the first time fork() actually executes. Route "
                    "this module's link through the asyncify pass (see "
                    "userspace/busybox-fork.nix / userspace/asyncify-cc.nix / "
                    "nix-wasm.nix's realFork) before shipping it in the mmu-fork "
                    "closure."
                )
    return violations, has_capture_stack


def run_fork_contract(profile, exports_script, paths):
    if profile not in FORK_CONTRACT_PROFILES:
        raise SystemExit(
            f"ERROR: --fork-contract profile must be one of {FORK_CONTRACT_PROFILES}, got {profile!r}"
        )
    if exports_script is None:
        raise SystemExit(
            "usage: wasm-check-imports.py --fork-contract=PROFILE "
            "--exports-script=PATH/to/wasm-check-exports.py MODULE.wasm [MODULE.wasm ...]\n"
            "  --exports-script is REQUIRED (no same-directory guessing — see "
            "_load_exported_funcs's docstring for why)."
        )
    if not paths:
        raise SystemExit("usage: wasm-check-imports.py --fork-contract=PROFILE --exports-script=PATH MODULE.wasm [MODULE.wasm ...]")
    exported_funcs = _load_exported_funcs(exports_script)
    all_violations = []
    fork_users = []
    for path in paths:
        with open(path, "rb") as f:
            data = f.read()
        violations, has_capture_stack = fork_contract_check(path, data, profile, exported_funcs)
        all_violations += violations
        if has_capture_stack:
            fork_users.append(path)
        status = "capture_stack" if has_capture_stack else "-"
        print(f"wasm-check-imports --fork-contract={profile}: {path}: {status}")
    if all_violations:
        print(
            f"ERROR: --fork-contract={profile} spawn-contract VIOLATIONS "
            f"({len(all_violations)} of {len(paths)} modules):",
            file=sys.stderr,
        )
        for v in all_violations:
            print(f"  {v}", file=sys.stderr)
        return 1
    print(
        f"wasm-check-imports --fork-contract={profile}: {len(paths)} modules clean "
        f"({len(fork_users)} import capture_stack: {' '.join(fork_users) if fork_users else '(none)'})"
    )
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1].startswith("--fork-contract="):
        profile = argv[1].split("=", 1)[1]
        exports_script = None
        paths = []
        for arg in argv[2:]:
            if arg.startswith("--exports-script="):
                exports_script = arg.split("=", 1)[1]
            else:
                paths.append(arg)
        return run_fork_contract(profile, exports_script, paths)
    if len(argv) < 3:
        raise SystemExit(
            f"usage: {argv[0]} MODULE.wasm ALLOWLIST.txt [EXTRA_SYM ...]\n"
            f"   or: {argv[0]} --fork-contract=PROFILE --exports-script=PATH MODULE.wasm [MODULE.wasm ...]"
        )
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
