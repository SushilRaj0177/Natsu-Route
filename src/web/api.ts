import type { HeatLevel, Names, PlaceHit, PlanQuery, PlanResponse, StatusResponse, TimeOfDayPoint } from '../shared/api.ts';

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface HeatResponse {
  point: Names;
  inSeason: boolean;
  now: { wbgt: number; level: HeatLevel; kind: string } | null;
  hours: { at: string; wbgt: number; level: HeatLevel; kind: string }[];
  alert: { today: 'none' | 'alert' | 'special'; tomorrow: string; issuedFor: string } | null;
  replay: { date: string; label: Names } | null;
}

export interface ReplayDay {
  date: string;
  label: Names;
  alert: string;
  peak: number;
}

export interface AboutResponse {
  data: { builtAt: string; timetableIssued: string; geoBuiltAt?: string };
  shade: { count?: number; byKind?: Record<string, number>; byWard?: Record<string, number> };
  walk: { nodes?: number; edges?: number };
  transit: { stations: number; busStops: number; railTrips: number; busTrips: number; busRoutes: number; entrances: number; stationsWithEntrances: number };
  pois: Record<string, number>;
  operators: { name: Names; licence: string; bus: boolean; silver: boolean; fares: boolean }[];
  replays: { date: string; label: Names }[];
  contact: string | null;
}

export const api = {
  places: (q: string, near?: { lat: number; lon: number }, signal?: AbortSignal) =>
    get<PlaceHit[]>(`/api/places?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`, signal),
  reverse: (lat: number, lon: number) => get<{ name: string | null }>(`/api/reverse?lat=${lat}&lon=${lon}`),
  plan: (q: PlanQuery, signal?: AbortSignal) => post<PlanResponse>('/api/plan', q, signal),
  bestTime: (q: PlanQuery, signal?: AbortSignal) => post<TimeOfDayPoint[]>('/api/best-time', q, signal),
  heat: (lat: number, lon: number, replay?: string) => get<HeatResponse>(`/api/heat?lat=${lat}&lon=${lon}${replay ? `&replay=${replay}` : ''}`),
  replays: () => get<ReplayDay[]>('/api/replays'),
  status: () => get<StatusResponse>('/api/status'),
  about: () => get<AboutResponse>('/api/about'),
};
