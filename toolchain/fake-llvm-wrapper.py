#!/usr/bin/env python3
# Transcribed VERBATIM from pc's fake-llvm shim
# (vendor/linux-wasm/.build/linux-wasm/tools/fake-llvm/llvm-wrapper.py).
# The only change from the original: REAL_LLVM is read from the @REAL_LLVM@
# build-time substitution (the kernel-cc.nix derivation rewrites it) instead of
# the environment, and clang++ is routed through rewrite_clang too. The argv
# rewrites (rewrite_triple / rewrite_clang / rewrite_lld / rewrite_objcopy) are
# byte-for-byte the upstream logic.
import sys
import os
from pathlib import Path

# Substituted by toolchain/kernel-cc.nix at build time.
REAL_LLVM = "@REAL_LLVM@"

MAX_MEMORY_WASM32 = 1 << 32
# 1 << 64 does not work but 1 << 34 should do as 16 GB is an usual runtime limit anyway.
MAX_MEMORY_WASM64 = 1 << 34


def rewrite_triple(original_args):
    # A default -march is needed as some parts of kbuild only set the triple.
    arch = "wasm32"
    for arg in original_args:
        if arg.startswith("-march="):
            # The last one wins if multiple.
            arch = arg[len("-march=") :]

    if arch not in ("wasm32", "wasm64"):
        raise RuntimeError(f"unknown -march= specified: {arch}")

    args = []
    triple_os = "none"
    triple_abi = "none"
    for arg in original_args:
        if arg.startswith("--target="):
            args.append(f"--target={arch}-unknown-unknown")

            if "-linux-" in arg or arg.endswith("-linux"):
                triple_os = "linux"

            if arg.endswith("-gnu"):
                triple_abi = "gnu"
            elif arg.endswith("-musl"):
                triple_abi = "musl"

        elif arg.startswith("-march="):
            pass  # Drop any -march=*.

        else:
            args.append(arg)

    if triple_os == "linux":
        args.append("-D__linux__")
        args.append("-D__unix__")
        args.append("-D__unix")

    if triple_abi == "gnu":
        args.append("-D__gnu_linux__")

    return args, arch


def get_linker_flags(max_memory, shared):
    return [
        "-no-gc-sections",  # No idea why this was written with only one -dash.
        "--no-merge-data-segments",
        "--no-entry",
        "--export-all",
        "--import-memory",
        "--shared-memory",
        f"--max-memory={max_memory}",
        "--import-undefined",
    ] + (["--import-table"] if shared else [])


def rewrite_clang(original_args):
    args, arch = rewrite_triple(original_args)

    # These flags are needed so that wasm-ld can be run with --shared-memory.
    for feature in ("atomics", "bulk-memory"):
        args += f"-Xclang -target-feature -Xclang +{feature}".split(" ")

    # Transforms code like __builtin_return_address(0) to (void*)(0). Note that
    # __builtin_return_address is allow return an unspecified value for other
    # arguments than 0 (indeed __builtin_return_address(0) is only ever used).
    args.append("-D__builtin_return_address=(void*)")

    # Filter out -mwasm32 and -mwasm64 that some applications may concat on from
    # LDFLGAGS. If we get them we link with the clang driver by -Wl,-mwasm32/64.
    args = ["-Wl," + arg if arg.startswith("-mwasm") else arg for arg in args]

    def is_linking(flags):
        for flag in flags:
            if flag.startswith("-l"):
                return True
        return False

    if is_linking(args):
        # -shared is the correct clang driver option, except llvm thinks we got a reactor (crt1-reactor.o).
        # We can solve that by convering it to -Wl,-shared so that it's passed right into the linker.
        args = ["-Wl,-shared" if arg == "-shared" else arg for arg in args]

        max_memory = MAX_MEMORY_WASM32 if arch == "wasm32" else MAX_MEMORY_WASM64
        args.extend(
            [
                "-Wl," + flag
                for flag in get_linker_flags(max_memory, "-Wl,-shared" in args)
            ]
        )

    return args


def rewrite_lld(original_args):
    if "-v" in original_args or "--version" in original_args:
        return original_args[:]

    args = []
    group = None
    is_m = False
    max_memory = MAX_MEMORY_WASM32
    simple_arg_preamble = None
    drop_next = False
    for arg, peek in zip(original_args, original_args[1:] + [None]):
        if drop_next:
            drop_next = False
            continue

        if len(arg) > 1 and arg[0] == "-" and arg[1] != "-":
            simple_arg_preamble = arg[1:]
            if len(arg) > 2:
                simple_arg = (arg[0:2], arg[2:])
            else:
                simple_arg = (arg, peek)
        else:
            if simple_arg_preamble is None:
                simple_arg = None
            else:
                simple_arg = (simple_arg_preamble, arg)
            simple_arg_preamble = None

        if group is not None:
            if arg == "--end-group":
                # Workaround: we add it twice, which hopefully is enough.
                args.extend(group)
                args.extend(group)
                group = None
            elif arg.startswith("-"):
                raise RuntimeError(f"argument inside --start/end-group: {arg}")
            else:
                group.append(arg)
                continue

        elif arg == "--start-group":
            if group is not None:
                raise RuntimeError("nested --start-group not allowed")
            group = []

        elif arg == "--end-group":
            # Positive cases should be handled in the flow above instead (to avoid self-trigger).
            raise RuntimeError("stray --end-group without start")

        elif arg.startswith("--build-id="):
            # Tracked in LLVM D107662.
            # Drop for now.
            continue

        elif simple_arg == ("-z", "noexecstack"):
            if arg == "-z":
                drop_next = True
            continue

        elif arg == "-X":
            # Means discard locals (C goto / asm jump labels). Not used in Wasm.
            continue

        else:
            args.append(arg)

        if arg == "-m":
            is_m = True
        elif arg == ("" if is_m else "-m") + "wasm64":
            is_m = False
            max_memory = MAX_MEMORY_WASM64

    args.append("--error-limit=0")

    # Only add these for the final link, i.e. not at relocatable pre-link stages.
    if not "-r" in args:
        args.extend(get_linker_flags(max_memory, "-shared" in args))

    return args


def rewrite_objcopy(original_args):
    args = []
    section_flags = False
    for arg in original_args:
        if arg == "--set-section-flags":
            section_flags = True
            continue

        elif section_flags and arg != "":
            section_flags = False
            if arg != ".modinfo=noload":
                raise RuntimeError(
                    "--set-section-flags not supported - normally suppressed, but unknown arg {arg}"
                )
            continue

        elif arg == "--strip-unneeded-symbol=__mod_device_table__*":
            continue

        args.append(arg)

    return args


def main():
    real_bin_dir = REAL_LLVM
    if not real_bin_dir:
        raise RuntimeError("REAL_LLVM is not set")

    args = sys.argv[1:]
    tool = Path(sys.argv[0]).name
    if tool == "clang" or tool == "clang++":
        args = rewrite_clang(args)
    elif tool == "ld.lld" or tool == "wasm-ld":
        tool = "wasm-ld"
        args = rewrite_lld(args)
    elif tool == "llvm-objcopy":
        args = rewrite_objcopy(args)
    else:
        pass  # Passthrough other parts of the toolchain.

    real_tool = Path(real_bin_dir) / tool
    if not real_tool.exists():
        raise RuntimeError(f"real tool not found: {real_tool}")
    if real_tool.resolve() == Path(__file__).resolve():
        raise RuntimeError("wrapper resolves to itself")

    print(f"{tool} -> {real_tool}:", args, file=sys.stderr)

    os.execv(str(real_tool), [str(real_tool)] + args)


if __name__ == "__main__":
    main()
