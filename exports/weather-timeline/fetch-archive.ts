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
 */
import { writeFileSync } from 'node:fs';

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

async function main() {
  const params = new URLSearchParams({
    latitude: String(LAKE.lat),
    longitude: String(LAKE.lng),
    start_date: START,
    end_date: END,
    hourly: VARS.join(','),
    timezone: 'auto',
    timeformat: 'iso8601',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
    elevation: String(LAKE.elevationM),
  });
  const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { hourly?: Record<string, unknown[]> };
  const hours = json.hourly?.time?.length ?? 0;
  if (hours === 0) throw new Error('archive returned no hours');

  writeFileSync(
    new URL('./src/mascoma-weather-2025.json', import.meta.url),
    `${JSON.stringify({ lake: LAKE, start: START, end: END, fetchedAt: new Date().toISOString(), ...json }, null, 1)}\n`,
  );
  console.log(`wrote ${hours} hours for ${LAKE.name}, ${START} → ${END}`);
}

void main();
