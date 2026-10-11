"""A tiny container for typed arrays, read by src/server/pack.ts.

Layout: "NRPK" magic, uint32 header length, a JSON header, then each array's
raw little-endian bytes, every one starting on an 8-byte boundary.

    {"meta": {...}, "arrays": {"name": {"dtype": "f4", "shape": [n, 2], "offset": o}}}

Offsets count from the start of the data section (after the header).
"""
import json
import struct

import numpy as np

DTYPES = {"u1", "u2", "u4", "i4", "f4", "f8", "i2", "i1"}


def write_pack(path: str, arrays: dict, meta: dict | None = None) -> None:
    entries = {}
    blobs = []
    offset = 0
    for name, a in arrays.items():
        a = np.ascontiguousarray(a)
        dt = a.dtype.str.lstrip("<|=")
        if dt not in DTYPES:
            raise ValueError(f"{name}: unsupported dtype {a.dtype}")
        pad = (-offset) % 8
        if pad:
            blobs.append(b"\0" * pad)
            offset += pad
        entries[name] = {"dtype": dt, "shape": list(a.shape), "offset": offset}
        raw = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        blobs.append(raw)
        offset += len(raw)
    header = json.dumps({"meta": meta or {}, "arrays": entries}, ensure_ascii=False).encode()
    header += b" " * ((-(len(header) + 8)) % 8)
    with open(path, "wb") as f:
        f.write(b"NRPK")
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        for b in blobs:
            f.write(b)


def read_pack(path: str):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:4] == b"NRPK"
    (n,) = struct.unpack("<I", data[4:8])
    header = json.loads(data[8 : 8 + n])
    base = 8 + n
    out = {}
    for name, e in header["arrays"].items():
        count = int(np.prod(e["shape"])) if e["shape"] else 1
        out[name] = np.frombuffer(data, dtype="<" + e["dtype"], count=count, offset=base + e["offset"]).reshape(e["shape"])
    return header["meta"], out
