/**
 * Pull real Open-Meteo **archive** hours for one lake and one window, and cache them.
 *
 * ⚠ **A different endpoint from anything the app uses, and only for this demo.** Production reads the
 * *forecast* endpoint with `past_days`, which reaches back 92 days — so it cannot see January 2025 at
 * all. The ERA5-backed archive can, and `weatherArchive.ts` already reserves a `source: 'archive'`
 * literal for the day someone wires it in properly (D153, step 3 of the recovery ladder). This script
 * is not that: it writes a JSON file next to itself, never touches Convex, and exists so the design
 * mock is built on weather that actually happened.
 *
 * The variable list and every unit match `HOURLY_VARS` exactly, so what lands here is byte-for-byte
 * the shape the real ingest would have stored.
 *
 * ⚠ **The local stamps are made here, not by Open-Meteo.** Its `iso8601` times use the offset in
 * force when the request is made, so a summer fetch of this January window labeled every hour an hour
 * late. The request asks for `unixtime` a day either side of the window, stamps each hour against the
 * zone with `localStampAt`, and keeps the hours whose local date falls inside it.
 */
import { writeFileSync } from 'node:fs';
import { dayMsToLocalDate, localDateToDayMs, localStampAt } from '../../packages/core/src/index';

const LAKE = {
  name: 'Mascoma Lake',
  town: 'Enfield, NH',
  // From the dev corpus: `interiorPoint`, which is what the weather cell is snapped from.
  lat: 43.617368,
  lng: -72.136006,
  elevationM: 228,
  /** The real 16-sector profile on the body document. Max 2,901 m NW — above `MIN_FETCH_CLAUSE_M`. */
  fetchProfileM: [
    758, 540, 512, 459, 638, 673, 1547, 968, 758, 479, 386, 412, 464, 513, 2901, 1484,
  ],
};

const START = '2025-01-13';
const END = '2025-02-11'; // 30 days, so the scrubber has something to scroll

const VARS = [
  'temperature_2m',
  'precipitation',
  'rain',
  'snowfall',
  'snow_depth',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cloud_cover',
  'sunshine_duration',
  'shortwave_radiation',
  'weather_code',
];

/** `YYYY-MM-DD` shifted by whole days. */
function shiftDate(date: string, days: number): string {
  return dayMsToLocalDate((localDateToDayMs(date) ?? 0) + days * 86_400_000);
}

async function main() {
  const params = new URLSearchParams({
    latitude: String(LAKE.lat),
    longitude: String(LAKE.lng),
    start_date: shiftDate(START, -1),
    end_date: shiftDate(END, 1),
    hourly: VARS.join(','),
    timezone: 'auto',
    timeformat: 'unixtime',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
    elevation: String(LAKE.elevationM),
  });
  const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as {
    timezone?: string;
    utc_offset_seconds?: number;
    hourly?: Record<string, unknown[]>;
  };
  const zone = raw.timezone || null;
  if (zone === null) throw new Error('archive returned no timezone');
  const unix = raw.hourly?.time ?? [];

  // Re-stamp as local wall clock and keep [START, END] — the shape `build-svg.ts` reads.
  const keep: number[] = [];
  const time: string[] = [];
  for (const [i, ts] of unix.entries()) {
    const stamp = typeof ts === 'number' ? localStampAt(ts * 1000, zone, 0) : null;
    if (stamp === null || stamp.localDate < START || stamp.localDate > END) continue;
    keep.push(i);
    time.push(`${stamp.localDate}T${String(stamp.localHour).padStart(2, '0')}:00`);
  }
  const hourly: Record<string, unknown[]> = { time };
  for (const [key, values] of Object.entries(raw.hourly ?? {})) {
    if (key !== 'time') hourly[key] = keep.map((i) => values[i]);
  }
  const json = { timezone: zone, hourly };
  const hours = time.length;
  if (hours === 0) throw new Error('archive returned no hours');

  writeFileSync(
    new URL('./src/mascoma-weather-2025.json', import.meta.url),
    `${JSON.stringify({ lake: LAKE, start: START, end: END, fetchedAt: new Date().toISOString(), ...json }, null, 1)}\n`,
  );
  console.log(`wrote ${hours} hours for ${LAKE.name}, ${START} → ${END}`);
}

void main();
