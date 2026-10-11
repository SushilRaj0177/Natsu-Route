/** Shapes of the ODPT v4 records the pipeline reads. Only fields we use. */

export type Multilingual = Partial<Record<'en' | 'ja' | 'ja-Hrkt' | 'ko' | 'zh-Hans' | 'zh-Hant', string>>;

export interface OdptStation {
  'owl:sameAs': string;
  'odpt:railway': string;
  'odpt:operator': string;
  'dc:title'?: string;
  'odpt:stationTitle'?: Multilingual;
  'geo:lat'?: number;
  'geo:long'?: number;
  'odpt:stationCode'?: string;
  'odpt:connectingStation'?: string[];
  'odpt:connectingRailway'?: string[];
}

export interface OdptStationOrder {
  'odpt:index': number;
  'odpt:station': string;
  'odpt:stationTitle'?: Multilingual;
}

export interface OdptRailway {
  'owl:sameAs': string;
  'odpt:operator': string;
  'dc:title'?: string;
  'odpt:railwayTitle'?: Multilingual;
  'odpt:stationOrder'?: OdptStationOrder[];
  'odpt:color'?: string;
  'odpt:lineCode'?: string;
  'odpt:ascendingRailDirection'?: string;
  'odpt:descendingRailDirection'?: string;
}

export interface OdptTimetableStop {
  'odpt:departureTime'?: string;
  'odpt:departureStation'?: string;
  'odpt:arrivalTime'?: string;
  'odpt:arrivalStation'?: string;
  'odpt:platformNumber'?: string;
}

export interface OdptTrainTimetable {
  'owl:sameAs': string;
  'odpt:railway': string;
  'odpt:operator': string;
  'odpt:calendar': string;
  'odpt:trainType'?: string;
  'odpt:trainNumber': string;
  'odpt:railDirection'?: string;
  'odpt:originStation'?: string[];
  'odpt:destinationStation'?: string[];
  'odpt:trainTimetableObject': OdptTimetableStop[];
  'odpt:nextTrainTimetable'?: string[];
  'odpt:previousTrainTimetable'?: string[];
  'dct:issued'?: string;
}

export interface OdptStationTimetableEntry {
  'odpt:departureTime'?: string;
  'odpt:trainType'?: string;
  'odpt:trainNumber'?: string;
  'odpt:train'?: string;
  'odpt:destinationStation'?: string[];
  'odpt:isOrigin'?: boolean;
  'odpt:isLast'?: boolean;
  'odpt:platformNumber'?: string;
  'odpt:trainName'?: Multilingual[];
  'odpt:note'?: Multilingual;
}

export interface OdptStationTimetable {
  'owl:sameAs': string;
  'odpt:station': string;
  'odpt:railway': string;
  'odpt:operator': string;
  'odpt:calendar': string;
  'odpt:railDirection'?: string;
  'odpt:stationTimetableObject': OdptStationTimetableEntry[];
  'dct:issued'?: string;
}

export interface OdptFare {
  'odpt:operator': string;
  'odpt:fromStation': string;
  'odpt:toStation': string;
  'odpt:icCardFare': number;
  'odpt:ticketFare': number;
}

export interface OdptTrainType {
  'owl:sameAs': string;
  'odpt:operator'?: string;
  'dc:title'?: string;
  'odpt:trainTypeTitle'?: Multilingual;
}

export interface OdptOperator {
  'owl:sameAs': string;
  'dc:title'?: string;
  'odpt:operatorTitle'?: Multilingual;
}

/** "odpt.Station:JR-East.Yamanote.Shibuya" -> "JR-East.Yamanote.Shibuya" */
export function local(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

/** "HH:MM" -> minutes past midnight, or NaN. */
export function hhmm(value: string | undefined): number {
  if (!value) return NaN;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * Calendars we route on. ODPT also publishes event-day calendars such as
 * `Specific.Keio.SaturdayHolidayOnRaceDay`; those only apply on named days,
 * so they are dropped rather than mixed into ordinary weekends.
 */
export const CALENDARS = ['Weekday', 'SaturdayHoliday', 'Saturday', 'Holiday'] as const;
export type Calendar = (typeof CALENDARS)[number];

export function calendarOf(id: string): Calendar | null {
  const c = local(id) as Calendar;
  return (CALENDARS as readonly string[]).includes(c) ? c : null;
}
