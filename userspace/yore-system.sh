#!/bin/sh
# Manage the installed system profile and publish its boot generation.
set -e

PROFILE=${YORE_SYSTEM_PROFILE:-/nix/var/nix/profiles/system}
STORE_PREFIX=${YORE_STORE_PREFIX:-/nix/store}
CURRENT_SYSTEM=${YORE_CURRENT_SYSTEM:-/run/current-system}
NIX_ENV=${YORE_NIX_ENV:-nix-env}

usage() {
  echo "usage: yore-system switch /nix/store/...-wasm-system" >&2
  echo "       yore-system rollback" >&2
  echo "       yore-system list-generations" >&2
  echo "       yore-system generation" >&2
  exit 2
}

profile_generation() {
  target=$(readlink "$PROFILE" 2>/dev/null || true)
  case "$target" in system-[0-9]*-link) ;; *) return 1 ;; esac
  n=${target#system-}; n=${n%-link}
  case "$n" in *[!0-9]*|'') return 1 ;; esac
  printf '%s\n' "$n"
}

ensure_generation_profile() {
  target=$(readlink "$PROFILE" 2>/dev/null || true)
  case "$target" in
    "$STORE_PREFIX"/*)
      profile_dir=${PROFILE%/*}
      if [ ! -e "$profile_dir/system-1-link" ]; then
        ln -s "$target" "$profile_dir/system-1-link"
      fi
      ln -sfn system-1-link "$PROFILE"
      ;;
  esac
}

resolve_profile() {
  target=$(readlink "$PROFILE" 2>/dev/null || true)
  [ -n "$target" ] || return 1
  case "$target" in
    /*) printf '%s\n' "$target" ;;
    *) readlink "${PROFILE%/*}/$target" ;;
  esac
}

manifest_number() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$1" | head -n 1
}

manifest_string() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

validate_system() {
  candidate="$1"
  case "$candidate" in "$STORE_PREFIX"/*) ;; *) echo "yore-system: system must be in $STORE_PREFIX" >&2; return 1 ;; esac
  manifest="$candidate/boot/manifest.json"
  [ -x "$candidate/init" ] || { echo "yore-system: missing init in $candidate" >&2; return 1; }
  [ -f "$candidate/activate" ] || { echo "yore-system: missing activate in $candidate" >&2; return 1; }
  [ -f "$candidate/boot/vmlinux.wasm" ] || { echo "yore-system: missing kernel" >&2; return 1; }
  [ -f "$candidate/boot/initramfs.cpio.gz" ] || { echo "yore-system: missing initramfs" >&2; return 1; }
  [ -f "$manifest" ] || { echo "yore-system: missing boot manifest" >&2; return 1; }

  candidate_mode=$(manifest_string "$manifest" mode)
  candidate_abi=$(manifest_number "$manifest" kernelAbi)
  candidate_system=$(manifest_string "$manifest" system)
  [ "$candidate_system" = "$candidate" ] || { echo "yore-system: manifest system mismatch" >&2; return 1; }
  case "$candidate_mode" in mmu|nommu) ;; *) echo "yore-system: invalid mode" >&2; return 1 ;; esac
  case "$candidate_abi" in *[!0-9]*|'') echo "yore-system: invalid kernel ABI" >&2; return 1 ;; esac

  current="$CURRENT_SYSTEM/boot/manifest.json"
  if [ -f "$current" ]; then
    current_mode=$(manifest_string "$current" mode)
    current_abi=$(manifest_number "$current" kernelAbi)
    [ "$candidate_mode" = "$current_mode" ] || {
      echo "yore-system: candidate mode $candidate_mode does not match running mode $current_mode" >&2
      return 1
    }
    [ "$candidate_abi" = "$current_abi" ] || {
      echo "yore-system: candidate ABI $candidate_abi does not match running ABI $current_abi" >&2
      return 1
    }
  fi
}

activate_selected() {
  selected=$(resolve_profile) || { echo "yore-system: cannot resolve system profile" >&2; return 1; }
  validate_system "$selected"
  sh "$selected/activate" "$selected"
}

restore_profile() {
  old_target="$1"
  ln -sfn "$old_target" "$PROFILE"
  old_system=$(resolve_profile) || return 1
  sh "$old_system/activate" "$old_system"
}

cmd=${1:-}
case "$cmd" in
  switch)
    [ "$#" -eq 2 ] || usage
    candidate=$2
    validate_system "$candidate"
    ensure_generation_profile
    old_target=$(readlink "$PROFILE")
    "$NIX_ENV" --profile "$PROFILE" --set "$candidate"
    if ! activate_selected; then
      echo "yore-system: activation failed; restoring previous generation" >&2
      restore_profile "$old_target" || true
      exit 1
    fi
    echo "switched to generation $(profile_generation) ($candidate)"
    ;;
  rollback)
    [ "$#" -eq 1 ] || usage
    ensure_generation_profile
    old_target=$(readlink "$PROFILE")
    "$NIX_ENV" --profile "$PROFILE" --rollback
    if [ "$(readlink "$PROFILE")" = "$old_target" ]; then
      echo "yore-system: no previous generation" >&2
      exit 1
    fi
    if ! activate_selected; then
      echo "yore-system: rollback activation failed; restoring previous selection" >&2
      restore_profile "$old_target" || true
      exit 1
    fi
    echo "rolled back to generation $(profile_generation) ($(resolve_profile))"
    ;;
  list-generations)
    [ "$#" -eq 1 ] || usage
    exec "$NIX_ENV" --profile "$PROFILE" --list-generations
    ;;
  generation)
    [ "$#" -eq 1 ] || usage
    profile_generation || { echo "yore-system: profile is not generational" >&2; exit 1; }
    ;;
  *) usage ;;
esac
