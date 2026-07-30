# The single source of truth for the guest's STARTUP EXPORTS — the functions the
# host bridge (runtime/kernel-worker.js, `user_executable_setup` /
# `user_executable_run`) calls on a freshly instantiated guest image, in order,
# before and around the program's own entry point:
#
#   __mmu_start                (software-MMU only; SYNTHESIZED by the
#                               instrumentation pass from the stripped wasm start
#                               section — never a link-time export, so not listed)
#   __wasm_apply_data_relocs   dylink data relocations
#   __wasm_early_tp_init       seed a valid main-thread pointer (see BELOW)
#   __wasm_call_ctors          C++/init_array static initializers
#   _start                     the program
#   __set_tls_base / __get_tls_base / __libc_clone_callback / __libc_handle_signal
#                              clone/TLS/signal bridge entry points
#
# WHY A SHARED LIST (#179): most guest links use `--export-all` (the cross
# cc-wrapper in wasm-cross.nix, toolchain/make.nix, toolchain/guest-cc-fork.nix,
# toolchain/wasm-clang-config.nix), so they export this set for free. The two
# links that DON'T — toolchain/guest-clang.nix (clang/clang++/wasm-ld: dropping
# --export-all lets --gc-sections strip a ~100MB module) and nix-wasm.nix's
# `wcxx` — carried hand-written copies of the list, and the copies DRIFTED:
# guest-clang.nix never gained `__wasm_early_tp_init` when #166 added it. Because
# the engine's call site is a permissive `if (instance.exports.__X)` guard, the
# missing export was SILENT: `--gc-sections` (ON BY DEFAULT in wasm-ld — it is
# never spelled out in these link lines) stripped the (now unreferenced)
# function outright, clang's libc++ `std::ios_base::Init` ctor ran with
# `__musl_tp == 0`, and the first `errno` store landed on the null `struct
# pthread` — a WRITE to virtual address 0x1c, which is unmapped under CONFIG_MMU
# → SIGSEGV before `_start` (nix-wasm#179; harmless on NOMMU, where page 0 is
# just readable linear memory). Both non-`--export-all` links now consume THIS
# list, so adding a startup export to the engine contract cannot silently miss a
# binary again. guest-clang.nix additionally ASSERTS at build time that its
# shipped binaries really export the required subset — the engine's guard cannot.
#
# `--export-if-defined` (not `--export`) for everything except `_start`: the
# others are legitimately absent from some links (a program with no data
# relocations has no `__wasm_apply_data_relocs`; a C-only program may pull no
# ctors), and `--export` would fail the link. It ALSO roots the symbol against
# `--gc-sections`, which is the half that actually mattered for #179.
rec {
  # Every startup export the host bridge may call. `_start` is exported
  # unconditionally (a program without it cannot run at all).
  names = [
    "__wasm_apply_data_relocs"
    "__wasm_early_tp_init"
    "__wasm_call_ctors"
    "__set_tls_base"
    "__libc_clone_callback"
    "__libc_handle_signal"
  ];

  # The subset a startup-correct guest PROGRAM must actually carry, used as a
  # build-time assertion (see guest-clang.nix's installPhase). Deliberately narrower
  # than `names`: the clone/signal bridge entries are only present in a binary
  # that links the relevant musl paths, whereas these five are startup-critical
  # for every real (libc-linked) guest program — and `__wasm_early_tp_init` being
  # among them is exactly the #179 regression guard.
  requiredNames = [
    "_start"
    "__wasm_call_ctors"
    "__wasm_early_tp_init"
    "__get_tls_base"
    "__set_tls_base"
  ];

  # Exports that must additionally be FORCED INTO the link, because a program can
  # legitimately reference nothing that pulls them in — so neither `--export-all`
  # nor `--export-if-defined` is enough (both only act on what the link already
  # contains). `__get_tls_base`/`__set_tls_base` live in musl's
  # `src/thread/wasm/clone.S`, a LAZY archive member pulled only when something
  # references `__clone`. Every real guest program (busybox, nix.wasm, clang —
  # they all spawn) pulls it incidentally; a trivial `int main(){return 42;}`
  # compiled IN THE GUEST does not, and then the softmmu pass's checked mode
  # refuses the image at `execve` (its fault call needs musl's `tp` operand, which
  # it can only source by CALLING `__get_tls_base` — `__tls_base` itself is an
  # internal global) → the exec-time throw becomes `raise_exception()` →
  # `make_task_dead` in kernel context → "Aiee, killing interrupt handler!". So
  # `-u` (`--undefined`) the two accessors: it pulls the member, and
  # `--export-all`/`--export-if-defined` then exports it. Passing a dummy `tp`
  # instead would be WRONG, not lenient: the syscall FOOT restores user tls FROM
  # pt_regs, so a 0 there clobbers the live thread pointer — `__musl_tp` is itself
  # `_Thread_local`, so even a "no TLS" program has one.
  forcedNames = [
    "__get_tls_base"
    "__set_tls_base"
  ];

  # `-Wl,`-prefixed flags, for a clang driver link line. All three consumers
  # (toolchain/wasm-clang-config.nix's in-guest clang.cfg, toolchain/guest-clang.nix,
  # nix-wasm.nix's wcxx) link through the clang driver; a future consumer that calls
  # wasm-ld directly should map the lists itself rather than growing an unused second
  # rendering here.
  #
  # NOT applied to the other `--export-all` link sites (wasm-cross.nix,
  # toolchain/make.nix, toolchain/guest-cc-fork.nix, userspace/asyncify-cc.nix):
  # every program they build spawns or forks BY CONSTRUCTION, so it references
  # `__clone` and pulls the accessors in anyway — and wasm-cross.nix in particular
  # is keyed into the cc-wrapper store path, so touching it costs a full `cross.*`
  # world rebuild. If one of them ever builds a genuinely minimal program, it needs
  # `ldFlagsForce` too.
  ldFlagsClang =
    "-Wl,--export=_start "
    + builtins.concatStringsSep " " (map (n: "-Wl,--export-if-defined=${n}") names);

  ldFlagsForce = builtins.concatStringsSep " " (map (n: "-Wl,-u,${n}") forcedNames);
}
