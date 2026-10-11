"""Merge the extracted layers into the files the server loads.

    python3 geo/pack.py

Reads geo/out/{plateau/*.npz, osm/*} (with the Hokonavi-merged network and
geo/out/shelters.json when present) and writes data/build/geo/:

* casters.pack  every shade caster: buildings, tree crowns, decks, roofs
* walk.pack     the walking network
* pois.json     points along the way (rest stops, water, toilets, entrances)
* wards.geojson the 23 wards (the area where shade is computed)
"""
import glob
import json
import os
import shutil
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from packfile import write_pack  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "build", "geo")

# Caster kinds, shared with src/server/shade/casters.ts.
BUILDING, TREE, DECK, ROOF, OSM_TREE = 0, 1, 2, 3, 4
PLATEAU_POINT = {1: "subway_entrance", 2: "bus_stop", 3: "vending", 4: "elevator", 5: "escalator", 6: "stairs"}


def pack_casters():
    kinds, zlo, zhi, attr, rstart, rlen, coords = [], [], [], [], [], [], []
    n = 0
    stats = {}
    points = []
    for path in sorted(glob.glob(os.path.join(HERE, "out", "plateau", "*.npz"))):
        d = np.load(path)
        ward = os.path.basename(path)[:5]
        kinds.append(d["kind"])
        zlo.append(d["zlo"])
        zhi.append(d["zhi"])
        attr.append(d["attr"])
        rstart.append(d["ring_start"].astype(np.uint64) + n)
        rlen.append(d["ring_len"])
        coords.append(d["coords"])
        n += len(d["coords"])
        stats[ward] = int(len(d["kind"]))
        for code, x, y in d["points"]:
            points.append({"kind": PLATEAU_POINT[int(code)], "x": round(float(x), 1), "y": round(float(y), 1), "src": "plateau"})
    t = np.load(os.path.join(HERE, "out", "osm", "trees.npz"))
    kinds.append(np.full(len(t["height"]), OSM_TREE, np.uint8))
    crown_base = np.minimum(2.5, 0.35 * t["height"]).astype(np.float32)
    zlo.append(crown_base)
    zhi.append(t["height"].astype(np.float32))
    attr.append(np.zeros(len(t["height"]), np.uint16))
    rstart.append(t["ring_start"].astype(np.uint64) + n)
    rlen.append(t["ring_len"])
    coords.append(t["coords"])
    n += len(t["coords"])

    kind = np.concatenate(kinds)
    ring_start = np.concatenate(rstart)
    assert ring_start.max() < 2**32
    ring_start = ring_start.astype(np.uint32)
    ring_len = np.concatenate(rlen).astype(np.uint16)
    xy = np.concatenate(coords).astype(np.float32)
    # Bounding boxes, for the spatial grid the server builds on load.
    idx = np.repeat(np.arange(len(kind)), ring_len.astype(np.int64))
    bbox = np.empty((len(kind), 4), np.float32)
    bbox[:, 0] = np.minimum.reduceat(xy[:, 0], ring_start)
    bbox[:, 1] = np.minimum.reduceat(xy[:, 1], ring_start)
    bbox[:, 2] = np.maximum.reduceat(xy[:, 0], ring_start)
    bbox[:, 3] = np.maximum.reduceat(xy[:, 1], ring_start)
    del idx
    meta = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": int(len(kind)),
        "byKind": {k: int((kind == v).sum()) for k, v in (("building", BUILDING), ("tree", TREE), ("deck", DECK), ("roof", ROOF), ("osmTree", OSM_TREE))},
        "byWard": stats,
        "extent": [float(bbox[:, 0].min()), float(bbox[:, 1].min()), float(bbox[:, 2].max()), float(bbox[:, 3].max())],
    }
    write_pack(
        os.path.join(OUT, "casters.pack"),
        {
            "kind": kind.astype(np.uint8),
            "zlo": np.concatenate(zlo).astype(np.float32),
            "zhi": np.concatenate(zhi).astype(np.float32),
            "attr": np.concatenate(attr).astype(np.uint16),
            "ring_start": ring_start,
            "ring_len": ring_len,
            "coords": xy,
            "bbox": bbox,
        },
        meta,
    )
    print("casters:", meta["byKind"], f"{len(xy)} vertices", flush=True)
    return points


def pack_walk():
    # The network with MLIT's walking-space data merged in, when it has been built.
    merged = os.path.join(HERE, "out", "osm", "walk-hokonavi.npz")
    d = np.load(merged if os.path.exists(merged) else os.path.join(HERE, "out", "osm", "walk.npz"))
    arrays = {k: d[k] for k in d.files}
    meta = {"nodes": int(len(arrays["node_xy"])), "edges": int(len(arrays["u"]))}
    hk = os.path.join(HERE, "out", "hokonavi.json")
    if os.path.exists(merged) and os.path.exists(hk):
        meta["hokonavi"] = json.load(open(hk))
    write_pack(os.path.join(OUT, "walk.pack"), arrays, meta)
    shutil.copy(os.path.join(HERE, "out", "osm", "names.json"), os.path.join(OUT, "street-names.json"))
    print("walk:", meta, flush=True)


def pack_pois(plateau_points):
    pois = json.load(open(os.path.join(HERE, "out", "osm", "pois.json")))
    for p in pois:
        p["src"] = "osm"
    pois.extend(plateau_points)
    sh = os.path.join(HERE, "out", "shelters.json")
    if os.path.exists(sh):
        pois.extend(json.load(open(sh)))
    json.dump(pois, open(os.path.join(OUT, "pois.json"), "w"), ensure_ascii=False)
    from collections import Counter

    print("pois:", dict(Counter(p["kind"] for p in pois)), flush=True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    pts = pack_casters()
    pack_walk()
    pack_pois(pts)
    shutil.copy(os.path.join(HERE, "out", "osm", "wards.geojson"), os.path.join(OUT, "wards.geojson"))
