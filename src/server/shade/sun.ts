/**
 * Where the sun is, from NOAA's solar position equations (the ones behind
 * the NOAA Solar Calculator; accurate to well under a degree for any date
 * this century, which is far below what a building outline resolves).
 */

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Degrees above the horizon, corrected for atmospheric refraction. */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

export function sunPosition(time: Date | number, lat: number, lon: number): SunPosition {
  const ms = typeof time === 'number' ? time : time.getTime();
  const jd = ms / 86_400_000 + 2_440_587.5;
  const T = (jd - 2_451_545) / 36_525;

  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));

  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 /
    RAD *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));

  const minutesUtc = mod(ms / 60_000, 1440);
  const trueSolar = mod(minutesUtc + eqTime + 4 * lon, 1440);
  let hourAngle = trueSolar / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const latR = lat * RAD;
  const cosZ = clamp(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle * RAD), -1, 1);
  const zenith = Math.acos(cosZ);
  const elev = 90 - zenith / RAD;

  let azimuth: number;
  const denom = Math.cos(latR) * Math.sin(zenith);
  if (Math.abs(denom) < 1e-9) azimuth = lat > 0 ? 180 : 0;
  else {
    const a = Math.acos(clamp((Math.sin(latR) * cosZ - Math.sin(decl)) / denom, -1, 1)) / RAD;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  return { elevation: elev + refraction(elev), azimuth };
}

/** Sun direction in the local x (east) / y (north) frame used by the shade engine. */
export interface SunVector {
  up: boolean;
  dx: number;
  dy: number;
  tanEl: number;
  elevation: number;
  azimuth: number;
}

export function sunVector(p: SunPosition): SunVector {
  const up = p.elevation > 0.5;
  return {
    up,
    dx: Math.sin(p.azimuth * RAD),
    dy: Math.cos(p.azimuth * RAD),
    tanEl: up ? Math.tan(p.elevation * RAD) : 0,
    elevation: p.elevation,
    azimuth: p.azimuth,
  };
}

function refraction(elev: number): number {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec: number;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.774 / te;
  return arcsec / 3600;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
