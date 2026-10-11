"""Extract shade casters and street furniture from PLATEAU CityGML.

For every Tokyo ward this streams the building (bldg), vegetation (veg),
bridge (brid) and city furniture (frn) files straight out of the remote
PLATEAU archive and keeps only what the shade engine needs:

* prisms: a 2D outline in local metres plus the height band [zlo, zhi]
  above the ground it stands on. Buildings stand on the ground; tree crowns
  start a little above it; bridge decks, bus-stop roofs and arcades float.
* points: bus stops, subway entrances, lifts, escalators, stairs and vending
  machines (somewhere to buy a drink on a hot day).

    python3 geo/plateau.py 13101 13102 ...      (default: all 23 wards)

Writes geo/out/plateau/<ward>.npz and <ward>.json (counts and timings).
"""
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from multiprocessing import Pool

import numpy as np
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
from httpzip import open_remote_zip  # noqa: E402
from proj import to_xy  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "plateau")

KIND_BUILDING, KIND_TREE, KIND_DECK, KIND_ROOF = 0, 1, 2, 3

# City furniture functions (codelists/CityFurniture_function.xml).
FRN_ROOF = {"4010": "shelter", "4030": "arcade"}
FRN_POINT = {
    "4020": 1,  # 地下出入口 subway / underground entrance
    "8010": 2,  # 停留所 bus stop
    "8080": 3,  # 自動販売機 vending machine
    "5020": 4,  # エレベータ lift
    "5030": 5,  # エスカレータ escalator
    "5000": 6,  # 階段 stairs
}

MIN_AREA = 4.0  # m², smaller outlines are noise for shading
SIMPLIFY = 0.4  # m


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def rings_of(el):
    """Every exterior ring under el as an (n, 3) array of lat, lon, z."""
    out = []
    for ext in el.iter():
        if local(ext.tag) != "exterior":
            continue
        for pl in ext.iter():
            if local(pl.tag) == "posList" and pl.text:
                a = np.array(pl.text.split(), dtype=np.float64)
                if a.size >= 9 and a.size % 3 == 0:
                    out.append(a.reshape(-1, 3))
    return out


def poly_xy(ring) -> Polygon | None:
    pts = [to_xy(lon, lat) for lat, lon, _ in ring]
    if len(pts) < 3:
        return None
    p = Polygon(pts)
    if not p.is_valid:
        p = make_valid(p)
    return p


def polygons(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def direct_child(el, name):
    for c in el:
        if local(c.tag) == name:
            return c
    return None


class Sink:
    def __init__(self):
        self.kind, self.zlo, self.zhi, self.base, self.attr = [], [], [], [], []
        self.ring_start, self.ring_len, self.coords = [], [], []
        self.n_coords = 0
        self.points = []  # (code, x, y)

    def add(self, geom, kind, zlo, zhi, base, attr=0):
        for p in polygons(geom):
            if p.area < MIN_AREA:
                continue
            p = p.simplify(SIMPLIFY, preserve_topology=True)
            if p.is_empty or not isinstance(p, Polygon):
                continue
            xy = np.asarray(p.exterior.coords, dtype=np.float32)[:-1]
            if len(xy) < 3:
                continue
            self.kind.append(kind)
            self.zlo.append(zlo)
            self.zhi.append(zhi)
            self.base.append(base)
            self.attr.append(attr)
            self.ring_start.append(self.n_coords)
            self.ring_len.append(len(xy))
            self.coords.append(xy)
            self.n_coords += len(xy)

    def save(self, path):
        np.savez_compressed(
            path,
            kind=np.array(self.kind, dtype=np.uint8),
            zlo=np.array(self.zlo, dtype=np.float32),
            zhi=np.array(self.zhi, dtype=np.float32),
            base=np.array(self.base, dtype=np.float32),
            attr=np.array(self.attr, dtype=np.uint16),
            ring_start=np.array(self.ring_start, dtype=np.uint32),
            ring_len=np.array(self.ring_len, dtype=np.uint16),
            coords=np.concatenate(self.coords) if self.coords else np.zeros((0, 2), np.float32),
            points=np.array(self.points, dtype=np.float32).reshape(-1, 3),
        )


def extent(rings):
    zs = np.concatenate([r[:, 2] for r in rings])
    return float(zs.min()), float(zs.max())


def top_face(rings, zmax, tol=0.05):
    """Footprint of an extruded LOD1 solid: its flat top face(s)."""
    faces = [r for r in rings if np.ptp(r[:, 2]) < tol and abs(r[0, 2] - zmax) < tol]
    return unary_union([p for p in (poly_xy(r) for r in faces) if p is not None]) if faces else None


def flat_high_faces(rings, above):
    """Union of the near-horizontal faces above a height: decks and roofs."""
    keep = []
    for r in rings:
        if r[:, 2].mean() <= above:
            continue
        # Horizontal-ish: small z spread relative to the face's size.
        p = poly_xy(r)
        if p is None or p.area < 1:
            continue
        if np.ptp(r[:, 2]) < 0.5 + 0.02 * np.sqrt(p.area):
            keep.append(p)
    return unary_union(keep) if keep else None


def on_building(el, sink, stats):
    height = None
    mh = direct_child(el, "measuredHeight")
    if mh is not None and mh.text:
        try:
            height = float(mh.text)
        except ValueError:
            height = None
    usage = direct_child(el, "usage")
    attr = int(usage.text) if usage is not None and usage.text and usage.text.isdigit() else 0

    solid = direct_child(el, "lod1Solid")
    base = float("nan")
    footprint = None
    if solid is not None:
        rs = rings_of(solid)
        if rs:
            zmin, zmax = extent(rs)
            base = zmin
            if height is None or height <= 0:
                height = zmax - zmin
            footprint = top_face(rs, zmax)
    edge = direct_child(el, "lod0RoofEdge")
    if edge is None:
        edge = direct_child(el, "lod0FootPrint")
    if edge is not None:
        rs = rings_of(edge)
        if rs:
            footprint = unary_union([p for p in (poly_xy(r) for r in rs) if p is not None])
    if footprint is None:
        if solid is None and edge is None:
            return  # a Building whose geometry sits in its BuildingParts
        stats["no_geometry"] += 1
        return
    if height is None or height <= 0.5:
        stats["no_height"] += 1
        return
    sink.add(footprint, KIND_BUILDING, 0.0, float(height), base, attr)
    stats["buildings"] += 1


def on_vegetation(el, sink, stats):
    geom_el = direct_child(el, "lod1Geometry")
    if geom_el is None:
        geom_el = direct_child(el, "lod1MultiSolid")
    if geom_el is None:
        # About half the trees only carry a detailed LOD3 model; its outline
        # and height are enough for a crown.
        geom_el = el
    # Each solid separately: a PlantCover can hold many.
    solids = [s for s in geom_el.iter() if local(s.tag) == "Solid"] or [geom_el]
    for s in solids:
        rs = rings_of(s)
        if not rs:
            continue
        zmin, zmax = extent(rs)
        h = zmax - zmin
        if h < 2.0:
            continue  # hedges and lawns do not shade a walking person
        fp = top_face(rs, zmax)
        if fp is None or fp.is_empty:
            fp = unary_union([p for p in (poly_xy(r) for r in rs) if p is not None]).convex_hull
        crown_base = max(0.0, min(2.5, 0.35 * h))
        sink.add(fp, KIND_TREE, crown_base, h, zmin)
        stats["trees"] += 1


def on_bridge(el, sink, stats):
    fn = direct_child(el, "function")
    code = int(fn.text) if fn is not None and fn.text and fn.text.isdigit() else 99
    # LOD2 solids point at their surfaces with xlink:href; the coordinates
    # live in boundedBy and outerBridgeConstruction, so read the whole bridge.
    rs = rings_of(el)
    if not rs:
        return
    zmin, zmax = extent(rs)
    if zmax - zmin < 3.0:
        return  # at grade: a bridge over a river, nothing to walk under
    deck = flat_high_faces(rs, zmin + 2.5)
    if deck is None:
        return
    top = zmax - zmin
    sink.add(deck, KIND_DECK, max(2.5, top - 2.5), top, zmin, code)
    stats["decks"] += 1


def on_furniture(el, sink, stats):
    fn = direct_child(el, "function")
    code = fn.text.strip() if fn is not None and fn.text else ""
    if code not in FRN_ROOF and code not in FRN_POINT:
        return
    rs = []
    for name in ("lod1Geometry", "lod2Geometry", "lod3Geometry"):
        g = direct_child(el, name)
        if g is not None:
            rs = rings_of(g)
            if rs:
                break
    if not rs:
        rs = rings_of(el)
    if not rs:
        return
    if code in FRN_POINT:
        pts = np.concatenate(rs)
        x, y = to_xy(float(pts[:, 1].mean()), float(pts[:, 0].mean()))
        sink.points.append((FRN_POINT[code], x, y))
        stats["points"] += 1
        return
    zmin, zmax = extent(rs)
    roof = flat_high_faces(rs, zmin + 1.5)
    if roof is None or roof.is_empty:
        roof = unary_union([p for p in (poly_xy(r) for r in rs) if p is not None]).convex_hull
    top = zmax - zmin if zmax - zmin > 2.0 else 3.0
    sink.add(roof, KIND_ROOF, max(2.0, top - 0.8), top, zmin, int(code))
    stats["roofs"] += 1


HANDLERS = {
    "Building": ("bldg", on_building),
    "BuildingPart": ("bldg", on_building),
    "SolitaryVegetationObject": ("veg", on_vegetation),
    "PlantCover": ("veg", on_vegetation),
    "Bridge": ("brid", on_bridge),
    "CityFurniture": ("frn", on_furniture),
}


def process_ward(code: str):
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, f"{code}.npz")
    if os.path.exists(dest):
        return code, "cached"
    src = json.load(open(os.path.join(HERE, "plateau_sources.json")))[code]
    t0 = time.time()
    z = open_remote_zip(src["url"])
    entries = [
        n
        for n in z.namelist()
        if n.endswith(".gml") and any(f"/{k}/" in n for k in ("bldg", "veg", "brid", "frn"))
    ]
    sink = Sink()
    stats = {k: 0 for k in ("buildings", "no_height", "no_geometry", "trees", "decks", "roofs", "points")}
    stats["files"] = len(entries)
    stats["bytes"] = 0
    for name in entries:
        folder = name.split("/")[-2]
        stats["bytes"] += z.getinfo(name).file_size
        with z.open(name) as f:
            for _, el in ET.iterparse(f, events=("end",)):
                t = local(el.tag)
                h = HANDLERS.get(t)
                if h and h[0] == folder:
                    h[1](el, sink, stats)
                    el.clear()
                elif t in ("cityObjectMember", "appearanceMember", "surfaceDataMember"):
                    el.clear()
    sink.save(dest)
    stats["seconds"] = round(time.time() - t0, 1)
    stats["city"] = src["city"]
    stats["source"] = src["url"]
    json.dump(stats, open(os.path.join(OUT, f"{code}.json"), "w"), ensure_ascii=False, indent=1)
    return code, stats


if __name__ == "__main__":
    wards = sys.argv[1:] or sorted(json.load(open(os.path.join(HERE, "plateau_sources.json"))))
    with Pool(int(os.environ.get("JOBS", "4"))) as pool:
        for code, res in pool.imap_unordered(process_ward, wards):
            print(code, res, flush=True)
