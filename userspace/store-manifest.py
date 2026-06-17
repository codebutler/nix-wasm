import base64, json, os, sys

store_paths_file, toplevel, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
NIX = "/nix/"
entries = {}

def rel(p):
    # /nix/store/xxx/... -> store/xxx/...
    assert p.startswith(NIX), p
    return p[len(NIX):]

with open(store_paths_file) as f:
    paths = [l.strip() for l in f if l.strip()]

for sp in paths:
    # the store dir itself
    entries[rel(sp)] = {"t": "d"}
    for root, dirs, files in os.walk(sp):
        for d in dirs:
            full = os.path.join(root, d)
            if os.path.islink(full):
                entries[rel(full)] = {"t": "l", "to": os.readlink(full)}
            else:
                entries[rel(full)] = {"t": "d"}
        for fn in files:
            full = os.path.join(root, fn)
            if os.path.islink(full):
                entries[rel(full)] = {"t": "l", "to": os.readlink(full)}
            else:
                with open(full, "rb") as fh:
                    data = fh.read()
                entries[rel(full)] = {
                    "t": "f",
                    "x": bool(os.stat(full).st_mode & 0o111),
                    "d": base64.b64encode(data).decode("ascii"),
                }

# The system profile symlink the bootstrap reads. The target is ABSOLUTE
# (/nix/store/...) — a relative target would resolve against the symlink's own
# dir (/nix/var/nix/profiles/) and point at the wrong place. /nix is the guest
# mount, so the absolute target resolves correctly in-guest (this is also how
# real Nix profile symlinks are written).
entries["var/nix/profiles/system"] = {"t": "l", "to": os.path.realpath(toplevel)}

with open(out_file, "w") as f:
    json.dump(entries, f)
