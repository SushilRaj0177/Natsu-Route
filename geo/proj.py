"""Local flat projection shared by every layer (Python pipeline and TS server).

Equirectangular around Tokyo Station. Across the 23 wards the local scale
error stays under 0.3 %, far below what matters for shadows, and all layers
use exactly the same formula so they line up with each other.
"""
LAT0 = 35.6812
LON0 = 139.7671
M_PER_DEG_LAT = 110953.1
M_PER_DEG_LON = 90528.3


def to_xy(lon: float, lat: float) -> tuple[float, float]:
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_lonlat(x: float, y: float) -> tuple[float, float]:
    return LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT
