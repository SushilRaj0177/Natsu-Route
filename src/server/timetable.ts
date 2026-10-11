import type { NetworkData } from '../shared/network.ts';

/**
 * RAPTOR's view of one day type. Trips that call at the same stops in the
 * same order form a route; within a route trips never overtake each other,
 * so "the first trip leaving after t" is a binary search at any stop.
 */
export interface Timetable {
  nStops: number;
  nRoutes: number;
  /** Stops of route r: routeStops[routeStopStart[r] .. routeStopStart[r+1]) */
  routeStopStart: Int32Array;
  routeStops: Int32Array;
  /** Trips of route r, earliest first: routeTrips[routeTripStart[r] .. routeTripStart[r+1]) are network trip indices. */
  routeTripStart: Int32Array;
  routeTrips: Int32Array;
  /** Stop times of route r begin at timeStart[r]; trip j stop i is at timeStart[r] + j * len + i. Seconds. */
  timeStart: Int32Array;
  arr: Int32Array;
  dep: Int32Array;
  /** Route carries trains that need a surcharge ticket. */
  routeSurcharge: Uint8Array;
  /** Routes through stop s: stopRoutes[stopRouteStart[s] .. stopRouteStart[s+1]) with the stop's position in each. */
  stopRouteStart: Int32Array;
  stopRoutes: Int32Array;
  stopRoutePos: Int32Array;
  /** Walking links out of stop s. */
  footStart: Int32Array;
  footTo: Int32Array;
  footSec: Int32Array;
}

/** Builds RAPTOR's routes from the trips that run, as decided by `runs(trip index)`. */
export function buildTimetable(net: NetworkData, runs: (trip: number) => boolean): Timetable {
  const nStops = net.stations.length;
  const surchargeType = net.trainTypes.map((t) => t.surcharge);

  // Group trips by stop sequence (and surcharge, so those routes can be skipped).
  const groups = new Map<string, number[]>();
  net.trips.forEach((t, i) => {
    if (!runs(i)) return;
    const key = `${surchargeType[t.ty] ? 1 : 0}|${t.s.join(',')}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  });

  const routes: { stops: number[]; trips: number[]; surcharge: boolean }[] = [];
  for (const [key, trips] of groups) {
    const stops = net.trips[trips[0]].s;
    const surcharge = key.startsWith('1');
    const depAt = (trip: number, i: number) => net.trips[trip].t[2 * i + 1];
    const arrAt = (trip: number, i: number) => net.trips[trip].t[2 * i];
    trips.sort((a, b) => depAt(a, 0) - depAt(b, 0));
    // Split into sub-routes so no trip overtakes another (FIFO at every stop).
    const subs: number[][] = [];
    for (const trip of trips) {
      const home = subs.find((sub) => {
        const last = sub[sub.length - 1];
        for (let i = 0; i < stops.length; i++) {
          if (depAt(trip, i) < depAt(last, i) || arrAt(trip, i) < arrAt(last, i)) return false;
        }
        return true;
      });
      if (home) home.push(trip);
      else subs.push([trip]);
    }
    for (const sub of subs) routes.push({ stops, trips: sub, surcharge });
  }

  const nRoutes = routes.length;
  const routeStopStart = new Int32Array(nRoutes + 1);
  const routeTripStart = new Int32Array(nRoutes + 1);
  const timeStart = new Int32Array(nRoutes + 1);
  routes.forEach((r, i) => {
    routeStopStart[i + 1] = routeStopStart[i] + r.stops.length;
    routeTripStart[i + 1] = routeTripStart[i] + r.trips.length;
    timeStart[i + 1] = timeStart[i] + r.stops.length * r.trips.length;
  });
  const routeStops = new Int32Array(routeStopStart[nRoutes]);
  const routeTrips = new Int32Array(routeTripStart[nRoutes]);
  const arr = new Int32Array(timeStart[nRoutes]);
  const dep = new Int32Array(timeStart[nRoutes]);
  const routeSurcharge = new Uint8Array(nRoutes);
  const stopRouteCount = new Int32Array(nStops);
  routes.forEach((r, ri) => {
    routeStops.set(r.stops, routeStopStart[ri]);
    routeTrips.set(r.trips, routeTripStart[ri]);
    routeSurcharge[ri] = r.surcharge ? 1 : 0;
    const len = r.stops.length;
    r.trips.forEach((trip, j) => {
      const t = net.trips[trip].t;
      for (let i = 0; i < len; i++) {
        arr[timeStart[ri] + j * len + i] = t[2 * i] * 60;
        dep[timeStart[ri] + j * len + i] = t[2 * i + 1] * 60;
      }
    });
    for (const s of r.stops) stopRouteCount[s]++;
  });

  const stopRouteStart = new Int32Array(nStops + 1);
  for (let s = 0; s < nStops; s++) stopRouteStart[s + 1] = stopRouteStart[s] + stopRouteCount[s];
  const stopRoutes = new Int32Array(stopRouteStart[nStops]);
  const stopRoutePos = new Int32Array(stopRouteStart[nStops]);
  const fill = new Int32Array(nStops);
  routes.forEach((r, ri) => {
    r.stops.forEach((s, pos) => {
      const k = stopRouteStart[s] + fill[s]++;
      stopRoutes[k] = ri;
      stopRoutePos[k] = pos;
    });
  });

  const footCount = new Int32Array(nStops);
  for (const [a] of net.footpaths) footCount[a]++;
  const footStart = new Int32Array(nStops + 1);
  for (let s = 0; s < nStops; s++) footStart[s + 1] = footStart[s] + footCount[s];
  const footTo = new Int32Array(footStart[nStops]);
  const footSec = new Int32Array(footStart[nStops]);
  const ffill = new Int32Array(nStops);
  for (const [a, b, sec] of net.footpaths) {
    const k = footStart[a] + ffill[a]++;
    footTo[k] = b;
    footSec[k] = sec;
  }

  return {
    nStops, nRoutes, routeStopStart, routeStops, routeTripStart, routeTrips, timeStart, arr, dep,
    routeSurcharge, stopRouteStart, stopRoutes, stopRoutePos, footStart, footTo, footSec,
  };
}
