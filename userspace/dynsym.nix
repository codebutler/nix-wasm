# dynsym-inject — the SHARED build seam that makes a binary's exported
# functions dlsym-able (#126 Track C / #130), companion to fpcast-emu.nix.
#
# WHY this exists (the fpcast × dlsym coupling — the #33 revert, resolved):
#   dlsym must hand out a function "address" = a table index. Under the
#   `--fpcast-emu` post-link pass only TABLE (elem) entries are canonical
#   thunks; exports stay raw-signature, and wasm-ld only puts ADDRESS-TAKEN
#   functions in the elem segment. GtkBuilder signal handlers (the GModule
#   headline case) are referenced by NAME only — no elem slot, so the runtime
#   loader could only install the raw export, which TRAPS at the first
#   fpcast'd call through it. scripts/wasm-dynsym-inject.py appends every
#   exported function to the elem segment (so the later fpcast pass thunks
#   them) and records the name → slot map in a `cb.dynsym` custom section the
#   runtime loader (runtime/dylink.js) treats as authoritative.
#
# ORDER MATTERS: dynsym_inject FIRST, fpcast_emu SECOND. Injecting after
# fpcast would add raw-signature entries that defeat the whole point.
#
# WHO needs it: any fpcast'd binary whose symbols are resolved BY NAME at
# runtime — GModule users (galculator's gtk_builder_connect_signals), loadable
# gio/gdk-pixbuf modules (#131 slice 2). Non-fpcast binaries don't need it
# (the loader's dynamic raw-export install is signature-correct there), and
# binaries that never serve dlsym can skip it (table/code-size cost: one elem
# slot + one thunk per exported function).
#
# Usage in a derivation (alongside fpcast-emu.nix):
#   { ..., dynsym ? import ./dynsym.nix { inherit cross; } }:
#   { nativeBuildInputs = [ ... dynsym.python3 fpcast.binaryen ];
#     buildPhase = ''
#       $CC ... -o prog.pre
#       ${dynsym.shellFn}
#       ${fpcast.shellFn}
#       dynsym_inject prog.pre prog.mid
#       fpcast_emu prog.mid prog
#     ''; }
{ cross }:
{
  # The native python3 the injector runs under. Add to nativeBuildInputs.
  python3 = cross.buildPackages.python3;

  # A shell function `dynsym_inject <in.wasm> <out.wasm> [--only REGEX]`.
  shellFn = ''
    dynsym_inject() {
      python3 ${../scripts/wasm-dynsym-inject.py} "$@"
    }
  '';
}
