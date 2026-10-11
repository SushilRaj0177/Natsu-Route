/**
 * The network file the data build writes and the server loads.
 * Indices refer to positions in the arrays of the same file.
 */

export interface Names {
  en: string;
  ja: string;
}

export type Licence = 'public' | 'challenge';

/** Where a railway's trips come from. */
export type TimetableSource =
  /** Operator publishes every train (odpt:TrainTimetable). */
  | 'published'
  /** Rebuilt from per-station departure lists (odpt:StationTimetable). */
  | 'rebuilt'
  /** No timetable in open data; the railway has no service in the planner. */
  | 'none';

export interface OperatorInfo {
  id: string;
  name: Names;
  licence: Licence;
  /** Station-to-station fares are published for this operator. */
  fares: boolean;
  /** Bus operator rather than railway. */
  bus?: boolean;
  /** Tokyo Silver Pass (for residents aged 70+) is valid on this operator's services in Tokyo. */
  silver?: boolean;
}

export interface RailwayInfo {
  id: string;
  operator: number;
  name: Names;
  color: string;
  /** Line letter(s) used in station numbers, e.g. "G", "JY". */
  code?: string;
  timetable: TimetableSource;
  /** A bus route rather than a railway; `name` is the route name as signed ("渋66"). */
  mode?: 'bus';
}

export type CoordSource = 'odpt' | 'mlit' | 'interpolated';

export interface StationInfo {
  /** ODPT id without prefix, e.g. "JR-East.Yamanote.Shibuya". */
  id: string;
  railway: number;
  name: Names;
  /** Station number as signed, e.g. "JY20", "G01". */
  code?: string;
  lat: number;
  lon: number;
  coord: CoordSource;
  place: number;
  /** A bus stop pole rather than a railway station. */
  pole?: true;
  /** Reading in kana, for search. */
  kana?: string;
  /** Pole number at a stop with several poles. */
  number?: string;
  /** Inside the 23 wards. */
  wards?: true;
}

/** A named location grouping the stations a rider thinks of as one ("Shibuya"). */
export interface PlaceInfo {
  name: Names;
  lat: number;
  lon: number;
  stations: number[];
}

export interface TrainTypeInfo {
  id: string;
  name: Names;
  /** Needs a reserved-seat or limited-express ticket on top of the fare. */
  surcharge: boolean;
}

/** Calendar bit flags. A trip runs on day type d when (cal & d) !== 0. */
export const DAY_WEEKDAY = 1;
export const DAY_SATURDAY = 2;
export const DAY_HOLIDAY = 4;

export interface TripRecord {
  /** Train number(s) as published (absent for rebuilt trips); for buses, the ODPT bus timetable id. */
  n?: string;
  /** Train type index at the first stop. */
  ty: number;
  /** Type changes along the trip: [stop index, type index] from that stop on (through trains change type). */
  tc?: [number, number][];
  cal: number;
  /** 0 = every stop from a published train timetable, 1 = some stops rebuilt from station timetables. */
  src: 0 | 1;
  /** Stop indexes that come from rebuilt station timetables (when src = 1). */
  rb?: number[];
  /** Index into NetworkData.destinations: where the train is announced as going. */
  dest: number;
  /** Station index of each stop. */
  s: number[];
  /** Flat [arrival, departure] minutes per stop, minutes since service-day start (may exceed 1440). */
  t: number[];
  /** Stop indexes (into s) whose arrival time is estimated rather than published. */
  est?: number[];
  /** Platform per stop, where published. */
  pl?: (string | null)[];
  /** Bus trips: the route (index into railways) the trip runs as. */
  r?: number;
  /** Bus trips: index into NetworkData.calendars, the exact dates it runs. */
  dc?: number;
  /** Bus trips: a step-free (non-step, low-floor) bus is scheduled. */
  ns?: 1;
  /** Bus trips: index into GeometryData.patterns, the line it follows. */
  pt?: number;
}

/** Date-specific calendar (bus timetables). */
export interface CalendarInfo {
  id: string;
  /** Dates (YYYY-MM-DD) the service runs, authoritative between `from` and `to`. */
  dates: string[];
  from: string;
  to: string;
  /** Day types to use outside that range; 0 when it only runs on the listed dates. */
  dayBits: number;
}

export interface Footpath {
  from: number;
  to: number;
  seconds: number;
}

export interface NetworkData {
  version: 2;
  builtAt: string;
  /** Newest dct:issued among the timetables used. */
  timetableIssued: string;
  operators: OperatorInfo[];
  railways: RailwayInfo[];
  stations: StationInfo[];
  places: PlaceInfo[];
  trainTypes: TrainTypeInfo[];
  /** Announced destinations ("for Odawara"); may lie outside the network. */
  destinations: Names[];
  trips: TripRecord[];
  /** [from, to, seconds], directed. */
  footpaths: [number, number, number][];
  /** [operator, fromStation, toStation, icYen, ticketYen] */
  fares: [number, number, number, number, number][];
  /** ISO dates (Asia/Tokyo) of Japanese public holidays. */
  holidays: string[];
  coverage: Coverage;
  calendars: CalendarInfo[];
  busFares: {
    /** operator index -> [icYen, ticketYen] for flat-fare operators */
    flat: Record<string, [number, number]>;
    /** [fromStation, toStation, icYen, ticketYen] for the rest */
    pairs: [number, number, number, number][];
  };
}

export interface Coverage {
  tripsPublished: number;
  tripsRebuilt: number;
  throughLinks: { published: number; inferred: number };
  stations: { total: number; served: number; coord: Record<CoordSource, number> };
}

/** Geometry file: encoded polylines (precision 5) between consecutive stops. */
export interface GeometryData {
  /** key `${fromStation}>${toStation}` (station indices) -> encoded polyline */
  hops: Record<string, string>;
  /** railway index -> encoded polylines covering the line, for the overview map */
  railways: Record<string, string[]>;
  /** Bus route patterns' lines (encoded polylines), indexed by TripRecord.pt; "" when unknown. */
  patterns: string[];
}
