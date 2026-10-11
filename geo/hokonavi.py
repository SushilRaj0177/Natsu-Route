"""Merge MLIT's walking-space network data (歩行空間ネットワークデータ, ほこナビDP)
into the OpenStreetMap walking network.

The ministry surveys areas around major stations link by link: roofs,
underground passages, corridors through buildings, stairs, lifts,
escalators, slopes and kerb heights. Where its links run along an
OpenStreetMap path, their attributes are copied onto it; underground
passages and building corridors that OpenStreetMap does not have are added
as new paths, joined to the street network at both ends.

    python3 geo/hokonavi.py

Reads data/raw/hokonavi/*-link.geojson (downloaded by this script when
missing) and geo/out/osm/walk.npz; writes geo/out/osm/walk-hokonavi.npz and
geo/out/hokonavi.json (what changed).
"""
import glob
import json
import math
import os
import sys
import urllib.request

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString

sys.path.insert(0, os.path.dirname(__file__))
from proj import to_xy  # noqa: E402
from osm import F_COVERED, F_ELEVATOR, F_ESCALATOR, F_FOOT_ONLY, F_INDOOR, F_STEPS, F_UNDERGROUND  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw", "hokonavi")
CKAN = "https://ckan.hokonavi.go.jp/api/3/action/package_search?rows=1000"

F_STEEP = 1 << 14  # slope over 5 %
F_KERB = 1 << 15  # a step or kerb over 2 cm

# rt_struct (経路の構造) and route_type (経路の種別), same in the 2018 and 2024 specs.
UNDERGROUND_PASSAGE, FOOTBRIDGE, CORRIDOR = 5, 6, 7
LIFT, ESCALATOR, STAIRS = 4, 5, 6


def fetch():
    os.makedirs(RAW, exist_ok=True)
    if glob.glob(os.path.join(RAW, "*-link.geojson")):
        return
    with urllib.request.urlopen(CKAN, timeout=60) as r:
        res = json.load(r)["result"]["results"]
    for p in res:
        t = p["title"]
        if "歩行空間ネットワーク" not in t or "東京" not in t and "区" not in t:
            continue
        if any(k in t for k in ("川崎", "横浜", "府中")):
            continue
        for r in p["resources"]:
            if "link.geojson" in (r.get("name") or "") or r.get("url", "").endswith("link.geojson"):
                urllib.request.urlretrieve(r["url"], os.path.join(RAW, f"{p['name']}-link.geojson"))


def codes_2024(props):
    """2024 spec when slope or kerb codes only it has appear."""
    return any(p.get("lev_diff") in (3, 4, 5) or p.get("vtcl_slope") in (4, 5, 6, 7, 8) for p in props)


def link_flags(p, new_spec):
    f = 0
    rs = p.get("rt_struct")
    rt = p.get("route_type")
    if p.get("roof") == 2:
        f |= F_COVERED
    if rs == UNDERGROUND_PASSAGE:
        f |= F_UNDERGROUND | F_COVERED
    if rs == CORRIDOR:
        f |= F_INDOOR | F_COVERED
    if rt == STAIRS:
        f |= F_STEPS
    elif rt == LIFT:
        f |= F_ELEVATOR
    elif rt == ESCALATOR:
        f |= F_ESCALATOR
    slope = p.get("vtcl_slope")
    if (new_spec and slope in (3, 4, 5, 6, 7, 8)) or (not new_spec and slope in (2, 3)):
        f |= F_STEEP
    kerb = p.get("lev_diff")
    if (new_spec and kerb in (3, 4, 5)) or (not new_spec and kerb == 2):
        f |= F_KERB
    return f


def main():
    fetch()
    d = dict(np.load(os.path.join(HERE, "out", "osm", "walk.npz")))
    node_xy = d["node_xy"]
    geom = d["geom"]
    n_edges = len(d["u"])
    lines = []
    for e in range(n_edges):
        s = d["gstart"][e]
        lines.append(LineString(geom[s : s + d["glen"][e]]))
    tree = STRtree(lines)
    flags = d["flags"].astype(np.uint32)
    matched_len = np.zeros(n_edges)
    roofed_len = np.zeros(n_edges)
    stats = {"areas": 0, "links": 0, "matched": 0, "added": 0, "covered": 0, "underground": 0, "steps": 0, "lifts": 0, "steep": 0, "kerbs": 0}
    added = []  # (xy list, flags)

    for path in sorted(glob.glob(os.path.join(RAW, "*-link.geojson"))):
        fc = json.load(open(path))
        feats = [f for f in fc["features"] if f.get("geometry") and f["geometry"]["type"] in ("LineString", "MultiLineString")]
        props = [f["properties"] for f in feats]
        new_spec = codes_2024(props)
        stats["areas"] += 1
        for f in feats:
            stats["links"] += 1
            parts = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiLineString" else [f["geometry"]["coordinates"]]
            lf = link_flags(f["properties"], new_spec)
            for coords in parts:
                xy = [to_xy(c[0], c[1]) for c in coords]
                if len(xy) < 2:
                    continue
                link = LineString(xy)
                if link.length < 0.5:
                    continue
                hits = match(link, lines, tree)
                if hits:
                    stats["matched"] += 1
                    for e, share in hits:
                        flags[e] |= lf & ~F_COVERED
                        matched_len[e] += share
                        if lf & F_COVERED:
                            roofed_len[e] += share
                elif lf & (F_UNDERGROUND | F_INDOOR):
                    added.append((xy, lf | F_FOOT_ONLY))

    # Roofed when most of the matched length is roofed.
    edge_len = np.array([ln.length for ln in lines])
    roof = (roofed_len > 0) & (roofed_len >= 0.5 * np.minimum(matched_len, edge_len))
    flags[roof] |= F_COVERED

    # New underground and indoor paths, joined to the nearest network node (within 15 m) at each end.
    from scipy.spatial import cKDTree  # noqa: E402

    kd = cKDTree(node_xy)
    extra_nodes = []
    new_u, new_v, new_geom, new_flags, new_len = [], [], [], [], []

    def node_for(p):
        dist, idx = kd.query(p)
        if dist <= 15:
            return int(idx)
        return None

    for xy, lf in added:
        a = node_for(xy[0])
        b = node_for(xy[-1])
        if a is None or b is None or a == b:
            continue
        line = [tuple(node_xy[a])] + xy[1:-1] + [tuple(node_xy[b])]
        length = sum(math.dist(line[i], line[i + 1]) for i in range(len(line) - 1))
        new_u.append(a)
        new_v.append(b)
        new_geom.append(line)
        new_flags.append(lf)
        new_len.append(length)
    stats["added"] = len(new_u)

    out = dict(d)
    flags16 = (flags & 0xFFFF).astype(np.uint16)
    if new_u:
        gstart = list(d["gstart"])
        glen = list(d["glen"])
        g = [geom]
        n = len(geom)
        for line in new_geom:
            gstart.append(n)
            glen.append(len(line))
            g.append(np.array(line, dtype=np.float32))
            n += len(line)
        out["u"] = np.concatenate([d["u"], np.array(new_u, dtype=np.uint32)])
        out["v"] = np.concatenate([d["v"], np.array(new_v, dtype=np.uint32)])
        out["length"] = np.concatenate([d["length"], np.array(new_len, dtype=np.float32)])
        flags16 = np.concatenate([flags16, np.array(new_flags, dtype=np.uint16)])
        out["cls"] = np.concatenate([d["cls"], np.full(len(new_u), 8, np.uint8)])
        out["width"] = np.concatenate([d["width"], np.zeros(len(new_u), np.float32)])
        out["name"] = np.concatenate([d["name"], np.full(len(new_u), -1, np.int32)])
        out["signals"] = np.concatenate([d["signals"], np.zeros(len(new_u), np.uint8)])
        out["gstart"] = np.array(gstart, dtype=np.uint32)
        out["glen"] = np.array(glen, dtype=np.uint16)
        out["geom"] = np.concatenate(g).astype(np.float32)
    out["flags"] = flags16
    before = d["flags"]
    stats["covered"] = int(((flags16[:n_edges] & F_COVERED) > 0).sum() - ((before & F_COVERED) > 0).sum())
    stats["underground"] = int(((flags16[:n_edges] & F_UNDERGROUND) > 0).sum() - ((before & F_UNDERGROUND) > 0).sum())
    stats["steps"] = int(((flags16[:n_edges] & F_STEPS) > 0).sum() - ((before & F_STEPS) > 0).sum())
    stats["lifts"] = int(((flags16[:n_edges] & F_ELEVATOR) > 0).sum() - ((before & F_ELEVATOR) > 0).sum())
    stats["steep"] = int(((flags16 & F_STEEP) > 0).sum())
    stats["kerbs"] = int(((flags16 & F_KERB) > 0).sum())
    np.savez_compressed(os.path.join(HERE, "out", "osm", "walk-hokonavi.npz"), **out)
    json.dump(stats, open(os.path.join(HERE, "out", "hokonavi.json"), "w"), indent=1)
    print(stats)


def match(link, lines, tree, max_d=6.0):
    """OSM edges running along the link: close and parallel. Returns (edge, metres shared)."""
    out = []
    for e in tree.query(link.buffer(max_d)):
        ln = lines[e]
        # Sample the shorter of the two along the longer.
        short, long_ = (link, ln) if link.length <= ln.length else (ln, link)
        n = max(2, int(short.length / 4))
        close = 0
        for k in range(n + 1):
            p = short.interpolate(k / n, normalized=True)
            if long_.distance(p) <= max_d:
                close += 1
        if close / (n + 1) < 0.7:
            continue
        if abs(direction_cos(link, ln)) < 0.8:
            continue
        out.append((int(e), min(short.length, ln.length)))
    return out


def direction_cos(a, b):
    (ax0, ay0), (ax1, ay1) = a.coords[0], a.coords[-1]
    (bx0, by0), (bx1, by1) = b.coords[0], b.coords[-1]
    va = (ax1 - ax0, ay1 - ay0)
    vb = (bx1 - bx0, by1 - by0)
    na = math.hypot(*va)
    nb = math.hypot(*vb)
    if na < 0.5 or nb < 0.5:
        return 1.0
    return (va[0] * vb[0] + va[1] * vb[1]) / (na * nb)


if __name__ == "__main__":
    main()
