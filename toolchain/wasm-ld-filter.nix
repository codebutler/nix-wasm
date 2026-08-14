# The one filtered wasm-ld used by every host-side wasm link.
#
# nixpkgs and build systems routinely inject ELF/GNU-ld-only flags. wasm-ld
# rejects them, but they have no wasm semantics, so dropping them is correct.
# Keep this filter shared: the cross cc-wrapper and custom raw-clang links such
# as nix-wasm.nix must not drift or bypass one another (#209).
{ pkgs, wasmLd ? "${pkgs.llvmPackages_21.bintools-unwrapped}/bin/wasm-ld" }:

pkgs.writeShellScriptBin "wasm-ld" ''
  args=(); skip=; has_r=
  for a in "$@"; do
    case "$a" in -r) has_r=1;; esac
  done
  for a in "$@"; do
    if [ -n "$skip" ]; then skip=; continue; fi
    case "$a" in
      --undefined-version|--no-undefined-version) continue;;
      --version-script=*|--dynamic-list=*|-soname=*|--soname=*) continue;;
      --version-script|--dynamic-list|-soname|--soname) skip=1; continue;;
      --build-id|--build-id=*|--eh-frame-hdr|--hash-style=*) continue;;
      --compress-debug-sections=*) continue;;
      --compress-debug-sections) skip=1; continue;;
      --warn-shared-textrel|-z) skip=1; continue;;
      -z*) continue;;
      # -r (partial/relocatable link) is incompatible with --shared-memory:
      # busybox uses -r to produce built-in.o; wasm-ld rejects the combo.
      # The final dylink module still gets --shared-memory on its real link.
      --shared-memory) if [ -n "$has_r" ]; then continue; fi;;
      # GNU archive groups are unnecessary in lld (it resolves archives to a
      # fixpoint) and unsupported by wasm-ld. Meson emits them around static
      # dependency lists, including nix-wasm's intermediate library links.
      --start-group|--end-group) continue;;
      # GNU-ld-only diagnostics and ELF DSO dependency pruning.
      --warn-common|--as-needed|--no-as-needed) continue;;
    esac
    args+=("$a")
  done
  exec ${wasmLd} "''${args[@]}"
''
