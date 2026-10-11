"""Cooling shelters and cool-share spots in the 23 wards.

Tokyo publishes one list of every designated cooling shelter
(指定暑熱避難施設, under the 2024 amendment to the Climate Change Adaptation
Act) and every TOKYO Cool Share spot, with opening days and how many people
each can take, but without coordinates. The addresses are geocoded with the
Geospatial Information Authority of Japan's address search; results are
cached so reruns only look up new addresses.

    python3 geo/shelters.py

Writes geo/out/shelters.json.
"""
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from proj import to_xy  # noqa: E402
from osm import WARDS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = "https://wbgt.metro.tokyo.lg.jp/assets/data/coolshare.csv"
GSI = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="
CACHE = os.path.join(HERE, "out", "geocode-cache.json")


def geocode(address: str, cache: dict):
    if address in cache:
        return cache[address]
    url = GSI + urllib.parse.quote(address)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                res = json.load(r)
            break
        except Exception:
            time.sleep(2 ** attempt)
    else:
        return None
    hit = None
    if res:
        lon, lat = res[0]["geometry"]["coordinates"]
        hit = {"lat": lat, "lon": lon, "matched": res[0]["properties"]["title"]}
    cache[address] = hit
    time.sleep(0.4)  # be gentle with a free public service
    return hit


def main():
    raw = urllib.request.urlopen(SOURCE, timeout=60).read().decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(raw)))
    head, body = rows[0], rows[1:]
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    out = []
    missed = 0
    for i, r in enumerate(body):
        if len(r) < 10 or r[0] not in WARDS:
            continue
        city, name, address, url, cooling, hours, capacity, share, share_hours, share_place = r[:10]
        full = address if address.startswith("東京都") else f"東京都{city}{address.replace(city, '', 1) if address.startswith(city) else address}"
        g = geocode(full, cache)
        if i % 100 == 0:
            json.dump(cache, open(CACHE, "w"), ensure_ascii=False)
            print(f"{i}/{len(body)}", flush=True)
        if not g:
            missed += 1
            continue
        x, y = to_xy(g["lon"], g["lat"])
        out.append(
            {
                "kind": "cooling",
                "name": name.strip(),
                "ward": city,
                "address": address.strip(),
                "url": url.strip() or None,
                "shelter": cooling.strip() == "〇",
                "coolshare": share.strip() == "〇",
                "hours": (hours or share_hours).strip() or None,
                "capacity": capacity.strip() or None,
                "place": share_place.strip() or None,
                "lat": round(g["lat"], 6),
                "lon": round(g["lon"], 6),
                "x": round(x, 1),
                "y": round(y, 1),
                "src": "tokyo",
            }
        )
    json.dump(cache, open(CACHE, "w"), ensure_ascii=False)
    json.dump(out, open(os.path.join(HERE, "out", "shelters.json"), "w"), ensure_ascii=False)
    print(f"shelters: {len(out)} placed, {missed} addresses not found; columns {head}")


if __name__ == "__main__":
    main()
