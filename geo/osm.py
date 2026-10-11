"""Walking network, street furniture and tree cover from OpenStreetMap.

Reads the Kanto extract and keeps what a pedestrian needs inside the 23
wards (plus a margin so trips can start just outside):

* the walking graph, split at junctions, with the things that matter on a
  hot day as flags: roofed or underground, indoors, steps, lifts,
  escalators, signalised crossings, and the road class (which decides where
  the pavement is, and so where its shade falls);
* points people look for: toilets, drinking water, vending machines,
  convenience stores, benches, shelters, station and subway entrances,
  bus stops (with shelter and bench tags), hospitals and clinics,
  supermarkets, libraries and other public buildings;
* tree cover: single trees, tree rows and woods, as extra shade casters
  where PLATEAU has no vegetation;
* the outline of the 23 wards (the area where shade is computed).

    python3 geo/osm.py data/raw/osm/kanto.osm.pbf

Writes geo/out/osm/{walk.npz, names.json, pois.json, trees.npz, wards.geojson}.
"""
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict

import numpy as np
import osmium
from shapely import wkb
from shapely.geometry import LineString, Point, mapping
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
from proj import to_xy  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "osm")

# 23 wards plus about 2 km on every side.
BBOX = (139.53, 35.50, 139.95, 35.85)

WARDS = [
    "千代田区", "中央区", "港区", "新宿区", "文京区", "台東区", "墨田区", "江東区",
    "品川区", "目黒区", "大田区", "世田谷区", "渋谷区", "中野区", "杉並区", "豊島区",
    "北区", "荒川区", "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区",
]

WALKABLE = {
    "footway", "path", "pedestrian", "steps", "living_street", "residential",
    "service", "unclassified", "tertiary", "tertiary_link", "secondary",
    "secondary_link", "primary", "primary_link", "trunk", "trunk_link", "track",
    "corridor", "elevator", "cycleway", "road",
}
FOOT_ONLY = {"footway", "path", "pedestrian", "steps", "corridor", "elevator"}

# Road class: decides the default carriageway width, so where the pavement is.
CLASS = {
    "trunk": 1, "trunk_link": 1, "primary": 1, "primary_link": 1,
    "secondary": 2, "secondary_link": 2,
    "tertiary": 3, "tertiary_link": 3,
    "unclassified": 4, "residential": 4, "road": 4,
    "living_street": 5, "service": 5, "track": 5,
    "footway": 6, "path": 6, "pedestrian": 6, "cycleway": 6,
    "steps": 7, "corridor": 8, "elevator": 8,
}

F_COVERED = 1 << 0  # roof overhead: arcade, covered walkway, building passage
F_INDOOR = 1 << 1  # inside a building or station concourse
F_UNDERGROUND = 1 << 2  # below ground
F_STEPS = 1 << 3
F_ELEVATOR = 1 << 4
F_ESCALATOR = 1 << 5
F_SIGNAL = 1 << 6  # signalised crossing on this edge: a wait in the open
F_CROSSING = 1 << 7  # unsignalised crossing
F_SIDEWALK_SEPARATE = 1 << 8  # pavement drawn as its own way nearby
F_FOOT_ONLY = 1 << 9
F_BRIDGE = 1 << 10
F_TUNNEL = 1 << 11
F_RAMP = 1 << 12  # steps with a ramp alongside
F_NO_SIDEWALK = 1 << 13


def in_bbox(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def walkable(tags) -> bool:
    hw = tags.get("highway")
    if hw not in WALKABLE:
        return False
    foot = tags.get("foot")
    access = tags.get("access")
    if foot in ("no", "private", "use_sidepath"):
        return False
    if access in ("no", "private") and foot not in ("yes", "designated", "permissive"):
        return False
    if hw == "cycleway" and foot not in ("yes", "designated", "permissive"):
        return False
    if hw in ("trunk", "trunk_link") and tags.get("sidewalk") in ("no", "none"):
        return False
    if tags.get("area") == "yes" and hw not in ("pedestrian", "footway"):
        return False
    return True


def level_below_ground(tags) -> bool:
    for key in ("layer", "level"):
        v = tags.get(key, "")
        try:
            if float(v.split(";")[0]) < 0:
                return True
        except ValueError:
            pass
    return tags.get("location") in ("underground",) or tags.get("tunnel") in ("yes",) and tags.get("highway") in FOOT_ONLY


def way_flags(tags) -> int:
    hw = tags.get("highway")
    f = 0
    covered = tags.get("covered", "no")
    tunnel = tags.get("tunnel", "no")
    if covered not in ("no", "") or tunnel == "building_passage" or tags.get("arcade") in ("yes", "both", "left", "right"):
        f |= F_COVERED
    if tags.get("indoor") in ("yes", "corridor", "room", "area") or hw == "corridor":
        f |= F_INDOOR | F_COVERED
    if level_below_ground(tags):
        f |= F_UNDERGROUND | F_COVERED
    if tunnel not in ("no", "", "building_passage"):
        f |= F_TUNNEL | F_COVERED
    if hw == "steps":
        if tags.get("conveying"):
            f |= F_ESCALATOR
        else:
            f |= F_STEPS
            if tags.get("ramp") == "yes" or tags.get("ramp:wheelchair") == "yes" or tags.get("ramp:stroller") == "yes":
                f |= F_RAMP
    if hw == "elevator":
        f |= F_ELEVATOR
    if tags.get("footway") == "crossing" or tags.get("crossing"):
        f |= F_SIGNAL if tags.get("crossing") in ("traffic_signals",) or tags.get("crossing_ref") == "pelican" else F_CROSSING
    if tags.get("sidewalk") == "separate" or tags.get("sidewalk:both") == "separate":
        f |= F_SIDEWALK_SEPARATE
    if tags.get("sidewalk") in ("no", "none"):
        f |= F_NO_SIDEWALK
    if hw in FOOT_ONLY:
        f |= F_FOOT_ONLY
    if tags.get("bridge") not in (None, "no"):
        f |= F_BRIDGE
    return f


def width_of(tags) -> float:
    w = tags.get("width") or tags.get("est_width")
    if w:
        try:
            return float(w.replace("m", "").strip())
        except ValueError:
            pass
    lanes = tags.get("lanes")
    if lanes and lanes.isdigit():
        return 3.25 * int(lanes)
    return 0.0  # unknown: decided later from the road class


POI_RULES = [
    # (kind, predicate)
    ("toilet", lambda t: t.get("amenity") == "toilets"),
    ("water", lambda t: t.get("amenity") == "drinking_water"),
    ("vending", lambda t: t.get("amenity") == "vending_machine" and ("drink" in t.get("vending", "") or not t.get("vending"))),
    ("konbini", lambda t: t.get("shop") == "convenience"),
    ("bench", lambda t: t.get("amenity") == "bench" or t.get("leisure") == "picnic_table"),
    ("shelter", lambda t: t.get("amenity") == "shelter"),
    ("subway_entrance", lambda t: t.get("railway") in ("subway_entrance", "train_station_entrance")),
    ("entrance", lambda t: t.get("entrance") is not None and t.get("railway") is None and (t.get("public_transport") == "station" or "駅" in t.get("name", ""))),
    ("bus_stop", lambda t: t.get("highway") == "bus_stop" or (t.get("public_transport") == "platform" and t.get("bus") == "yes")),
    ("elevator", lambda t: t.get("highway") == "elevator"),
    ("hospital", lambda t: t.get("amenity") in ("hospital", "clinic", "doctors") or t.get("healthcare") in ("hospital", "clinic", "doctor")),
    ("pharmacy", lambda t: t.get("amenity") == "pharmacy"),
    ("supermarket", lambda t: t.get("shop") in ("supermarket", "department_store", "mall")),
    ("library", lambda t: t.get("amenity") == "library"),
    ("public", lambda t: t.get("amenity") in ("townhall", "community_centre", "social_facility", "post_office")),
    ("station", lambda t: t.get("railway") == "station" or (t.get("public_transport") == "station" and t.get("railway") is not None)),
    ("park", lambda t: t.get("leisure") == "park" and t.get("name")),
]
POI_KEEP_TAGS = ("name", "name:en", "name:ja-Hira", "ref", "wheelchair", "shelter", "bench", "opening_hours", "brand", "operator", "level", "toilets:wheelchair", "diaper", "changing_table")


def poi_kind(tags):
    for kind, pred in POI_RULES:
        try:
            if pred(tags):
                return kind
        except Exception:
            pass
    return None


def main(path):
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()

    # Pass 1: areas (ward outlines, woods and parks).
    ward_polys = {}
    woods = []
    fp = osmium.FileProcessor(path).with_areas(
        osmium.filter.KeyFilter("boundary", "natural", "landuse")
    ).with_filter(osmium.filter.KeyFilter("boundary", "natural", "landuse"))
    wkbf = osmium.geom.WKBFactory()
    for o in fp:
        if not o.is_area():
            continue
        tags = dict(o.tags)
        try:
            if tags.get("boundary") == "administrative" and tags.get("admin_level") == "7" and tags.get("name") in WARDS:
                g = wkb.loads(wkbf.create_multipolygon(o), hex=True)
                ward_polys[tags["name"]] = g
            elif tags.get("natural") == "wood" or tags.get("landuse") == "forest":
                g = wkb.loads(wkbf.create_multipolygon(o), hex=True)
                c = g.centroid
                if in_bbox(c.x, c.y) and g.area < 0.0005:  # skip huge mountain forests
                    woods.append(g)
        except Exception:
            continue
    print(f"areas: {len(ward_polys)} wards, {len(woods)} woods ({time.time() - t0:.0f}s)", flush=True)

    # Pass 2: ways and tagged nodes.
    ways = []  # (node ids, coords, tags)
    pois = []
    trees = []  # (x, y, height, crown radius)
    tree_rows = []
    signal_nodes = set()
    crossing_nodes = set()
    elevator_nodes = set()
    fp = osmium.FileProcessor(path).with_locations().with_filter(
        osmium.filter.KeyFilter(
            "highway", "railway", "amenity", "shop", "natural", "public_transport",
            "entrance", "leisure", "healthcare", "crossing",
        )
    )
    for o in fp:
        if o.is_node():
            loc = o.location
            if not loc.valid() or not in_bbox(loc.lon, loc.lat):
                continue
            tags = dict(o.tags)
            hw = tags.get("highway")
            if hw == "traffic_signals" or tags.get("crossing") == "traffic_signals":
                signal_nodes.add(o.id)
            elif hw == "crossing":
                crossing_nodes.add(o.id)
            if hw == "elevator":
                elevator_nodes.add(o.id)
            if tags.get("natural") == "tree":
                x, y = to_xy(loc.lon, loc.lat)
                h = parse_m(tags.get("height"), 8.0)
                r = parse_m(tags.get("diameter_crown"), 6.0) / 2
                trees.append((x, y, h, r))
            kind = poi_kind(tags)
            if kind:
                pois.append(make_poi(kind, tags, loc.lon, loc.lat, f"n{o.id}"))
        elif o.is_way():
            tags = dict(o.tags)
            try:
                coords = [(n.lon, n.lat) for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if not coords or not any(in_bbox(*c) for c in coords):
                continue
            if walkable(tags):
                ways.append(([n.ref for n in o.nodes], coords, tags))
            if tags.get("natural") == "tree_row":
                tree_rows.append(coords)
            kind = poi_kind(tags)
            if kind and len(coords) >= 2:
                lon = sum(c[0] for c in coords) / len(coords)
                lat = sum(c[1] for c in coords) / len(coords)
                pois.append(make_poi(kind, tags, lon, lat, f"w{o.id}"))
    print(f"ways: {len(ways)}, pois: {len(pois)}, trees: {len(trees)} ({time.time() - t0:.0f}s)", flush=True)

    build_graph(ways, signal_nodes, crossing_nodes, elevator_nodes)
    save_pois(pois)
    save_trees(trees, tree_rows, woods)
    save_wards(ward_polys)
    print(f"done in {time.time() - t0:.0f}s")


def parse_m(v, default):
    if not v:
        return default
    try:
        return float(str(v).replace("m", "").split(";")[0].strip())
    except ValueError:
        return default


def make_poi(kind, tags, lon, lat, osm_id):
    x, y = to_xy(lon, lat)
    p = {"kind": kind, "x": round(x, 1), "y": round(y, 1), "lon": round(lon, 6), "lat": round(lat, 6), "osm": osm_id}
    for k in POI_KEEP_TAGS:
        if k in tags:
            p[k.replace(":", "_")] = tags[k]
    return p


def build_graph(ways, signal_nodes, crossing_nodes, elevator_nodes):
    use = Counter()
    for refs, _, _ in ways:
        use.update(refs)
        use[refs[0]] += 1
        use[refs[-1]] += 1
    junction = {nid for nid, c in use.items() if c >= 2} | (elevator_nodes & set(use))
    node_index = {}
    node_xy = []

    def nidx(ref, lon, lat):
        i = node_index.get(ref)
        if i is None:
            i = len(node_xy)
            node_index[ref] = i
            node_xy.append(to_xy(lon, lat))
        return i

    names = []
    name_index = {}
    e_u, e_v, e_len, e_flags, e_class, e_width, e_name, e_gstart, e_glen, e_signals = ([] for _ in range(10))
    geom = []
    n_geom = 0
    for refs, coords, tags in ways:
        flags = way_flags(tags)
        cls = CLASS.get(tags.get("highway"), 4)
        width = width_of(tags)
        nm = tags.get("name")
        ni = -1
        if nm:
            ni = name_index.get(nm)
            if ni is None:
                ni = len(names)
                name_index[nm] = ni
                names.append({"ja": nm, "en": tags.get("name:en")})
        start = 0
        for k in range(1, len(refs)):
            if refs[k] in junction or k == len(refs) - 1:
                seg_refs = refs[start : k + 1]
                seg = coords[start : k + 1]
                if refs[start] == refs[k] and len(seg) <= 2:
                    start = k
                    continue
                xy = [to_xy(*c) for c in seg]
                length = sum(math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1))
                if length <= 0.01:
                    start = k
                    continue
                f = flags
                inner = seg_refs[1:-1] if len(seg_refs) > 2 else []
                sig = sum(1 for r in seg_refs if r in signal_nodes)
                if sig:
                    f |= F_SIGNAL
                if any(r in crossing_nodes for r in inner):
                    f |= F_CROSSING
                if seg_refs[0] in elevator_nodes or seg_refs[-1] in elevator_nodes:
                    f |= F_ELEVATOR
                e_u.append(nidx(refs[start], *coords[start]))
                e_v.append(nidx(refs[k], *coords[k]))
                e_len.append(length)
                e_flags.append(f)
                e_class.append(cls)
                e_width.append(width)
                e_name.append(ni)
                e_signals.append(min(sig, 255))
                e_gstart.append(n_geom)
                e_glen.append(len(xy))
                geom.extend(xy)
                n_geom += len(xy)
                start = k
    np.savez_compressed(
        os.path.join(OUT, "walk.npz"),
        node_xy=np.array(node_xy, dtype=np.float32),
        u=np.array(e_u, dtype=np.uint32),
        v=np.array(e_v, dtype=np.uint32),
        length=np.array(e_len, dtype=np.float32),
        flags=np.array(e_flags, dtype=np.uint16),
        cls=np.array(e_class, dtype=np.uint8),
        width=np.array(e_width, dtype=np.float32),
        name=np.array(e_name, dtype=np.int32),
        signals=np.array(e_signals, dtype=np.uint8),
        gstart=np.array(e_gstart, dtype=np.uint32),
        glen=np.array(e_glen, dtype=np.uint16),
        geom=np.array(geom, dtype=np.float32),
    )
    json.dump(names, open(os.path.join(OUT, "names.json"), "w"), ensure_ascii=False)
    fl = np.array(e_flags)
    print(
        f"graph: {len(node_xy)} nodes, {len(e_u)} edges, {sum(e_len) / 1000:.0f} km; "
        f"covered {int((fl & F_COVERED > 0).sum())}, steps {int((fl & F_STEPS > 0).sum())}, "
        f"lifts {int((fl & F_ELEVATOR > 0).sum())}, signals {int((fl & F_SIGNAL > 0).sum())}",
        flush=True,
    )


def save_pois(pois):
    json.dump(pois, open(os.path.join(OUT, "pois.json"), "w"), ensure_ascii=False)
    print("pois:", dict(Counter(p["kind"] for p in pois)), flush=True)


def save_trees(trees, tree_rows, woods):
    """Tree crowns as polygons: circles for single trees, buffered rows, woods."""
    polys, heights = [], []
    for x, y, h, r in trees:
        polys.append(Point(x, y).buffer(max(1.5, min(r, 8.0)), quad_segs=3))
        heights.append(h)
    for coords in tree_rows:
        xy = [to_xy(*c) for c in coords]
        if len(xy) >= 2:
            polys.append(LineString(xy).buffer(3.0, quad_segs=2))
            heights.append(8.0)
    for g in woods:
        xy = shapely_to_xy(g)
        for p in getattr(xy, "geoms", [xy]):
            if p.area > 20:
                polys.append(p.simplify(1.0))
                heights.append(12.0)
    ring_start, ring_len, coords, hs = [], [], [], []
    n = 0
    for p, h in zip(polys, heights):
        if p.is_empty or p.geom_type != "Polygon":
            continue
        c = np.asarray(p.exterior.coords, dtype=np.float32)[:-1]
        ring_start.append(n)
        ring_len.append(len(c))
        coords.append(c)
        hs.append(h)
        n += len(c)
    np.savez_compressed(
        os.path.join(OUT, "trees.npz"),
        height=np.array(hs, dtype=np.float32),
        ring_start=np.array(ring_start, dtype=np.uint32),
        ring_len=np.array(ring_len, dtype=np.uint16),
        coords=np.concatenate(coords) if coords else np.zeros((0, 2), np.float32),
    )
    print(f"tree casters: {len(hs)}", flush=True)


def shapely_to_xy(g):
    import shapely

    from proj import LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON

    return shapely.transform(g, lambda c: np.column_stack(((c[:, 0] - LON0) * M_PER_DEG_LON, (c[:, 1] - LAT0) * M_PER_DEG_LAT)))


def save_wards(ward_polys):
    feats = []
    for name, g in sorted(ward_polys.items(), key=lambda kv: WARDS.index(kv[0])):
        feats.append({"type": "Feature", "properties": {"name": name}, "geometry": mapping(g.simplify(0.0001))})
    union = unary_union(list(ward_polys.values())).simplify(0.0002) if ward_polys else None
    out = {"type": "FeatureCollection", "features": feats}
    if union is not None:
        out["features"].append({"type": "Feature", "properties": {"name": "23区"}, "geometry": mapping(union)})
    json.dump(out, open(os.path.join(OUT, "wards.geojson"), "w"), ensure_ascii=False)
    missing = [w for w in WARDS if w not in ward_polys]
    print(f"wards: {len(ward_polys)} (missing: {missing})", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "data", "raw", "osm", "kanto.osm.pbf"))
