# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest, exactly as real Nix
# does against cache.nixos.org. The compiler tools are NOT in the base squashfs;
# they arrive here, on demand.
#
# pkgs     — the NATIVE host pkgs (mkBinaryCache, runCommand, writeText, lib)
# devPaths — the wasm toolchain DERIVATIONS (guestClang, guestCc, guestCxx,
#            makeWasm). The pkgs.nix catalog is GENERATED from these — one attr per
#            package, named by its real `lib.getName` (no hand-written aliases).
#
# REAL-NIXOS MODEL (codebutler/nix-wasm#1): the catalog entries are REAL
# derivations (they carry the real `drvPath`, not just an `outPath`), and the cache
# serves both the OUTPUT closures AND the DERIVER (.drv) closures — so the guest's
# Nix reads each package's actual derivation and substitutes its already-built
# output, identical to how a normal machine installs from cache.nixos.org. The two
# pieces that make this work on the network-less guest, neither of which is a
# bespoke workaround:
#   • `substitute = true` in the guest nix.conf (userspace/system.nix) — the new
#     CLI (`nix profile`/`nix build`) otherwise disables substitution when its
#     Internet probe fails, even for a `file://` cache that needs no network.
#   • the .drv closures below — so `nix profile install` can read the deriver and
#     the stock DerivationGoal substitutes the cache-valid output WITHOUT building.
# `nix-env -iA <name>` and `nix profile install <name>` both work against this.
{
  pkgs,
  devPaths,
}:
let
  inherit (pkgs) lib;

  # Build the binary cache using the nixpkgs-blessed builder. It uses
  # exportReferencesGraph to compute full closures inside the sandbox — no
  # in-sandbox `nix copy` needed. Produces: nix-cache-info + *.narinfo + nar/*.nar.zst.
  #
  # rootPaths includes BOTH the package OUTPUTS and their DERIVERS (`d.drvPath`), so
  # the cache serves the .drv files (+ their input-derivation/source closure) as
  # well as the outputs. `nix profile install` forms a Built{drvPath} from the
  # catalog, substitutes the .drv to read it, then — since the output narinfo is
  # also here — substitutes the prebuilt output instead of building (verified
  # against the Nix 2.34 DerivationGoal: a cache-valid output short-circuits the
  # build). On the host the .drvs are already instantiated, so adding them to the
  # closure is just more paths to copy, not a build.
  rawCache = pkgs.mkBinaryCache {
    name = "wasm-binary-cache";
    rootPaths = devPaths ++ map (drv: drv.drvPath) devPaths;
  };

  # pkgs.nix — the guest's package catalog (its channel substitute). The guest
  # ships no nixpkgs to evaluate, so this generated attrset stands in for one:
  # `nix-env -iA <name>` / `nix profile install -f /nix-cache/pkgs.nix <name>`
  # resolve a package against it. bootstrap.nix copies it to ~/.nix-defexpr at boot.
  #
  # GENERATED from devPaths — one attr per package, named by its real
  # `lib.getName` (e.g. `guest-cc`, `make-wasm32`). Each entry is a REAL derivation
  # value: `type = "derivation"` + name + system + the real `drvPath` + `outPath` +
  # outputs — the same shape Nix's own generated channel/manifest expressions use.
  # The earlier catalog omitted `drvPath` (an "outPath-only fake derivation"), which
  # is exactly why `nix profile install` rejected it with "is not a derivation";
  # carrying the real drvPath makes it a normal derivation both CLIs accept.
  #
  # drvPath/outPath are emitted as plain store-path strings (not `builtins.storePath`)
  # so guest evaluation never has to realise them up front — Nix coerces + substitutes
  # them lazily when it actually installs, the same way the outPath has always been
  # carried. The paths come from the SAME drv objects the cache is built from, so the
  # catalog and the cache can never disagree on a hash.
  entry =
    drv:
    "  ${lib.getName drv} = { "
    + ''type = "derivation"; name = "${drv.name}"; system = "wasm32-linux"; ''
    + ''drvPath = "${drv.drvPath}"; ''
    + ''outPath = "${drv.outPath}"; out = { outPath = "${drv.outPath}"; }; outputs = [ "out" ]; };'';
  pkgsNix = pkgs.writeText "pkgs.nix" ''
    {
    ${lib.concatMapStringsSep "\n" entry devPaths}
    }
  '';
in
# Wrap mkBinaryCache's output: symlink its entire tree into $out and add pkgs.nix.
# This is a PLAIN STANDARD Nix cache (nix-cache-info + *.narinfo + nar/ + pkgs.nix)
# — there is NO bespoke `manifest.json` file index. runtime/nix-cache.js resolves
# files by on-demand HEAD probe (404 → ENOENT), exactly as it would against any
# standard cache, so nothing here enumerates the tree for it (epic #60, Phase 1).
# pkgs.nix is reachable by its exact path (the guest reads /nix-cache/pkgs.nix
# directly at boot — bootstrap.nix copies it to ~/.nix-defexpr).
pkgs.runCommand "wasm-binary-cache" { } ''
  # Symlink the cache content (nix-cache-info + narinfo + nar/ + realisations/ + …)
  # into our $out so the caller gets a single store path for the whole cache.
  mkdir -p "$out"
  for f in ${rawCache}/*; do
    ln -s "$f" "$out/$(basename "$f")"
  done
  # Add the pkgs.nix catalog so the guest's ~/.nix-defexpr resolves installs.
  cp ${pkgsNix} "$out/pkgs.nix"

  # Assert the cache actually SERVES each catalog package's deriver (.drv). The
  # real-NixOS path is: `nix profile install` forms Built{drvPath} from the catalog
  # and substitutes the .drv from the cache to read it. If the .drv narinfo isn't
  # here, the guest fails with "failed to obtain derivation of …guest-cc.drv" — a
  # 30-minutes-later boot failure. Catch it at build time instead (fast + loud).
  # narinfo for /nix/store/<hash>-name.drv is <hash>.narinfo.
  miss=0
  for d in ${lib.concatMapStringsSep " " (drv: drv.drvPath) devPaths}; do
    h=$(basename "$d"); h=''${h%%-*}
    if [ ! -e "$out/$h.narinfo" ]; then
      echo "ERROR: deriver narinfo $h.narinfo ($d) is NOT in the cache — the .drv" \
           "closure was not published; `nix profile install` cannot obtain it." >&2
      miss=1
    fi
  done
  [ "$miss" = 0 ] || { echo "wasm-binary-cache: .drv closures missing — see above" >&2; exit 1; }
  echo "wasm-binary-cache: all catalog .drv narinfos present (deriver closures published)"
''
