import base64, hashlib, json, os, sys

# Emits store.json (the closure manifest) + a store-content/ dir of content-
# addressed blobs for LARGE files. Small files stay inline (base64) in the
# manifest so the common boot path needs no extra fetches; large files (the
# toolchain: clang ~57MB, wasm-ld ~32MB, nix ~20MB, …) are written to
# store-content/<sha256> and referenced by hash, so nix-closure-store.js fetches
# them LAZILY only when the guest first reads them (e.g. exec'ing clang) — not at
# boot. Without this the eager all-inline manifest forced a ~145MB boot download.
store_paths_file, toplevel, out_file, content_dir = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
)
NIX = "/nix/"
# Files >= this go to a lazy content blob; smaller ones inline. 512 KiB keeps the
# manifest small (a handful of big blobs) while avoiding a blob per tiny header.
THRESHOLD = 512 * 1024
entries = {}

os.makedirs(content_dir, exist_ok=True)

def rel(p):
    # /nix/store/xxx/... -> store/xxx/...
    assert p.startswith(NIX), p
    return p[len(NIX):]

def file_entry(full):
    with open(full, "rb") as fh:
        data = fh.read()
    x = bool(os.stat(full).st_mode & 0o111)
    if len(data) >= THRESHOLD:
        h = hashlib.sha256(data).hexdigest()
        blob = os.path.join(content_dir, h)
        if not os.path.exists(blob):  # content-addressed → dedup identical files
            with open(blob, "wb") as bf:
                bf.write(data)
        return {"t": "f", "x": x, "s": len(data), "h": h}
    return {"t": "f", "x": x, "d": base64.b64encode(data).decode("ascii")}

with open(store_paths_file) as f:
    paths = [l.strip() for l in f if l.strip()]

for sp in paths:
    # A store path is not always a directory: `writeText`/`writeScript` outputs
    # (e.g. the activate script) are a single FILE, and some are symlinks. Emit
    # the correct node type for the top-level path, then walk only real dirs.
    if os.path.islink(sp):
        entries[rel(sp)] = {"t": "l", "to": os.readlink(sp)}
        continue
    if os.path.isfile(sp):
        entries[rel(sp)] = file_entry(sp)
        continue
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
                entries[rel(full)] = file_entry(full)

# The system profile symlink the bootstrap reads. The target is ABSOLUTE
# (/nix/store/...) — a relative target would resolve against the symlink's own
# dir (/nix/var/nix/profiles/) and point at the wrong place. /nix is the guest
# mount, so the absolute target resolves correctly in-guest (this is also how
# real Nix profile symlinks are written).
entries["var/nix/profiles/system"] = {"t": "l", "to": os.path.realpath(toplevel)}

with open(out_file, "w") as f:
    json.dump(entries, f)
