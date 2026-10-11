/**
 * What the API returns. Shared by the server and the web app.
 * Times are ISO 8601 strings with the Tokyo offset (+09:00).
 */
import type { Names } from './network.ts';

export type { Names };
export type DayType = 'weekday' | 'saturday' | 'holiday';

export interface DataStamp {
  builtAt: string;
  timetableIssued: string;
}

export type HeatLevel = 'safe' | 'caution' | 'warning' | 'severe' | 'danger';
export type AlertLevel = 'none' | 'alert' | 'special';
/** What the walk avoids: sun (summer), shade (winter), rain, or nothing. */
export type Preference = 'cool' | 'warm' | 'rain' | 'neutral';

export interface HeatInfo {
  /** WBGT (暑さ指数), °C. */
  wbgt: number;
  level: HeatLevel;
  kind: 'actual' | 'forecast' | 'replay';
  point: Names;
  /** Highest WBGT expected for the rest of the day, and when. */
  peak?: { wbgt: number; level: HeatLevel; at: string };
  alert: AlertLevel;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LineRef {
  railway: string;
  name: Names;
  color: string;
  code?: string;
  operator: Names;
  mode: 'rail' | 'bus';
}

export interface StopRef {
  station: number;
  place: number;
  name: Names;
  code?: string;
  lat: number;
  lon: number;
  line: LineRef;
  /** Bus stop pole number, where there are several poles. */
  pole?: string;
}

/** A stretch of walking with one street name, side and kind. */
export interface WalkSegment {
  name?: Names;
  metres: number;
  seconds: number;
  /** Seconds in direct sun along it. */
  sunSeconds: number;
  /** Pavement to use, where the two sides differ: relative to the direction of walking. */
  side: 'left' | 'right' | 'either';
  /** Covered: arcade, roofed walkway; underground: below street level; indoor: inside a building. */
  shelter?: 'covered' | 'underground' | 'indoor';
  stairs?: boolean;
  escalator?: boolean;
  elevator?: boolean;
  /** Signalised crossings along it (a wait in the open). */
  signals?: number;
  /** Turn to make at the start of this segment. */
  turn?: 'left' | 'right' | 'slight-left' | 'slight-right' | 'back' | 'straight';
  /** Share of the segment's time in sun, 0..1; null outside the area with building data. */
  sun: number | null;
  /** [lon, lat] points. */
  line: [number, number][];
}

export type RestKind = 'cooling' | 'konbini' | 'water' | 'toilet' | 'bench' | 'vending' | 'library' | 'shelter';

export interface RestStop {
  kind: RestKind;
  name?: Names;
  lat: number;
  lon: number;
  /** Metres from the walk. */
  off: number;
  /** Minutes into the walk where it is passed. */
  atMinute: number;
  /** Official cooling shelter (指定暑熱避難施設). */
  designated?: boolean;
  hours?: string;
  stepFree?: boolean;
}

export interface WalkLeg {
  kind: 'walk';
  /** 'access': home to the first stop; 'transfer': between vehicles; 'egress': last stop to the door; 'direct': the whole trip on foot. */
  role: 'access' | 'transfer' | 'egress' | 'direct';
  from: Names;
  to: Names;
  dep: string;
  arr: string;
  metres: number;
  seconds: number;
  sunSeconds: number;
  /** Seconds where shade could not be worked out (outside the 23 wards). */
  unknownSeconds: number;
  segments: WalkSegment[];
  rest: RestStop[];
  /** Station entrance used, with its exit number. */
  entrance?: { exit?: string; stepFree: boolean | null; lat: number; lon: number };
  /** Rail-to-rail change inside one station: indoors, no route drawn. */
  inStation?: boolean;
}

export interface Wait {
  seconds: number;
  /** At a bus stop in the open (false: on a station platform). */
  outdoor: boolean;
  /** Share of the wait in direct sun, 0..1. */
  sun: number;
  /** The stop has a roof (null: not known). */
  sheltered: boolean | null;
  bench: boolean | null;
}

export interface RideLeg {
  kind: 'ride';
  mode: 'rail' | 'bus';
  line: LineRef;
  /** Train type for trains ("Rapid"), route name already in `line` for buses. */
  service: Names;
  destination: Names;
  from: StopRef;
  to: StopRef;
  dep: string;
  arr: string;
  /** Stops travelled, including the one where you get off. */
  stops: number;
  platform?: string;
  /** Step-free (non-step) bus scheduled. */
  nonStep?: boolean;
  /** Free with the Tokyo Silver Pass. */
  silverPass: boolean;
  /** Wait before boarding. */
  wait: Wait;
  /** Encoded polyline (precision 5) of the ride. */
  line5?: string;
  live?: { delayMinutes: number; asOf: string };
  trip: number;
}

export type Leg = WalkLeg | RideLeg;

export interface Fare {
  ic: number;
  ticket: number;
  /** Fare with the Silver Pass (only the legs it does not cover). */
  withSilverPass: number;
  /** Operators with no published fare (not included above). */
  missing: Names[];
}

/** coolest (summer), sunniest (winter), driest (rain): the option that best avoids what the walker wants to avoid. */
export type OptionLabel = 'coolest' | 'sunniest' | 'driest' | 'fastest' | 'easiest' | 'walk';

export interface TripOption {
  id: string;
  labels: OptionLabel[];
  /** When to leave home. */
  leave: string;
  arrive: string;
  seconds: number;
  /** Minutes in direct sun: walking plus waiting at stops. */
  sunSeconds: number;
  /** Time outdoors without a roof, sun or shade. */
  outdoorSeconds: number;
  walkMetres: number;
  walkSeconds: number;
  transfers: number;
  stairs: number;
  /** Highest heat level met while outdoors. */
  heatPeak?: { wbgt: number; level: HeatLevel };
  fare: Fare;
  legs: Leg[];
  /** Compared with the fastest option: door-to-door time, arrival, and sun. */
  vsFastest?: { extraSeconds: number; laterSeconds: number; lessSunSeconds: number };
  /** Some walking lies outside the area with building data. */
  partialShade: boolean;
}

export interface PlanQuery {
  from: LatLon & { name?: Names };
  to: LatLon & { name?: Names };
  /** ISO time; departure, or arrival with arriveBy. */
  at: string;
  arriveBy?: boolean;
  /** Walking speed, m/s. */
  speed?: number;
  stairs?: 'ok' | 'avoid' | 'never';
  maxWalkMinutes?: number;
  mode?: 'auto' | Preference;
  priority?: 'cool' | 'balanced' | 'fast';
  silverPass?: boolean;
  /** Replay a past summer day's heat and sun (YYYY-MM-DD from /api/replays). */
  replay?: string;
}

export interface PlanResponse {
  query: { at: string; arriveBy: boolean; serviceDate: string; dayType: DayType };
  preference: Preference;
  heat: HeatInfo | null;
  sun: { elevation: number; azimuth: number };
  options: TripOption[];
  replay?: { date: string; label: Names; timetableDate: string };
  /** Plain notes about the answer (e.g. "the walk starts outside the area with building data"). */
  notes: Names[];
  data: DataStamp;
}

export interface TimeOfDayPoint {
  leave: string;
  sunSeconds: number;
  wbgt: number | null;
  level: HeatLevel | null;
}

export interface PlaceHit {
  kind: 'station' | 'bus' | 'poi' | 'address';
  name: Names;
  sub?: Names;
  lat: number;
  lon: number;
  /** For stations and bus stops: line colours to show. */
  lines?: { color: string; name: Names; mode: 'rail' | 'bus' }[];
}

export interface LineStatus {
  railway: number;
  text: Names;
  disrupted: boolean;
  asOf: string;
}

export interface LiveTrain {
  delay?: number;
  fromStation?: Names;
  toStation?: Names;
  asOf: string;
}

export interface StatusResponse {
  fetchedAt: string | null;
  lines: (LineStatus & { line: LineRef })[];
  silentOperators: Names[];
}
