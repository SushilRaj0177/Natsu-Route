/**
 * Local flat projection, identical to geo/proj.py: equirectangular around
 * Tokyo Station, metres east (x) and north (y). Every layer uses it.
 */
export const LAT0 = 35.6812;
export const LON0 = 139.7671;
export const M_PER_DEG_LAT = 110953.1;
export const M_PER_DEG_LON = 90528.3;

export function toXY(lon: number, lat: number): [number, number] {
  return [(lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT];
}

export function toLonLat(x: number, y: number): [number, number] {
  return [LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT];
}
