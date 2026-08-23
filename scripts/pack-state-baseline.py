#!/usr/bin/env python3
"""Pack every non-zero sector of a raw disk as a deterministic gzip CBHD."""

import gzip
import json
import struct
import sys

SECTOR = 512
MAGIC = b"CBHD"
VERSION = 1
ZERO = bytes(SECTOR)


def sectors(path):
    with open(path, "rb", buffering=4 * 1024 * 1024) as source:
        index = 0
        while True:
            sector = source.read(SECTOR)
            if not sector:
                break
            if len(sector) != SECTOR:
                raise ValueError("state image is not sector aligned")
            if sector != ZERO:
                yield index, sector
            index += 1


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: pack-state-baseline.py RAW OUT.gz INFO.json")
    source, output, info = sys.argv[1:]
    count = sum(1 for _ in sectors(source))
    unpacked_bytes = 16 + count * (4 + SECTOR)
    with open(output, "wb") as destination:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=6, mtime=0,
                           fileobj=destination) as packed:
            packed.write(struct.pack("<4sIII", MAGIC, VERSION, SECTOR, count))
            for index, sector in sectors(source):
                packed.write(struct.pack("<I", index))
                packed.write(sector)
    with open(info, "w", encoding="utf-8") as destination:
        json.dump({"blocks": count, "unpackedBytes": unpacked_bytes}, destination,
                  separators=(",", ":"), sort_keys=True)
        destination.write("\n")


if __name__ == "__main__":
    main()
