/**
 * How much of the corpus sits at or below sea-level tolerance — **D126's blast-radius check**.
 *
 *   pnpm --filter @skating/etl tidal-band
 *
 * Committed because it is the measurement that decided the tidal referee must stay SCOPED, and that
 * decision needs to be re-checkable against a corpus that has moved. Read-only.
 *
 * The tidal referee is only safe if it stays scoped to bodies already under suspicion. Cape Cod's
 * freshwater kettle ponds sit at 1–8 m, so a corpus-wide "below 5 m is salt" rule would delete real
 * lakes. This measures exactly how many, so the scoping is a measurement rather than a worry.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = resolve(HERE, '../../lake-depth/.raw-elevation/readings.ndjson');
const BODIES = resolve(HERE, '../.scratch/merge/bodies.ndjson');
const PLACES = 5;
const key = (lat: number, lng: number) => `${lat.toFixed(PLACES)},${lng.toFixed(PLACES)}`;

const elevation = new Map<string, number>();
for (const line of readFileSync(ARCHIVE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as { key: string; elevationM: number };
  elevation.set(e.key, e.elevationM);
}
console.log(`${elevation.size.toLocaleString()} archived readings\n`);

const TIDAL_WORDS = /\b(bay|cove|harbor|harbour|sound|inlet|pool|basin|estuary|narrows|creek)\b/i;
const bands = [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const all = new Map<number, number>();
const suspicious = new Map<number, number>();
const lowFresh: string[] = [];
let matched = 0;
let bayClass = 0;
let bayLow = 0;

const rl = createInterface({ input: createReadStream(BODIES), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const b = JSON.parse(line) as {
    name: string;
    type: string;
    states: string[];
    surfaceAreaSqM: number;
    interiorPoint?: { lat: number; lng: number };
    centroid?: { lat: number; lng: number };
  };
  const pt = b.interiorPoint ?? b.centroid;
  if (!pt) continue;
  const m = elevation.get(key(pt.lat, pt.lng));
  if (m === undefined) continue;
  matched++;
  const suspect = b.type === 'bay' || TIDAL_WORDS.test(b.name);
  if (b.type === 'bay') bayClass++;
  for (const band of bands) {
    if (m <= band) {
      all.set(band, (all.get(band) ?? 0) + 1);
      if (suspect) suspicious.set(band, (suspicious.get(band) ?? 0) + 1);
      break;
    }
  }
  if (m <= 5) {
    if (b.type === 'bay') bayLow++;
    if (!suspect && lowFresh.length < 25) {
      lowFresh.push(
        `${`${m.toFixed(1)}m`.padStart(7)}  ${String(Math.round(b.surfaceAreaSqM / 4046.86)).padStart(5)}ac  ` +
          `${b.states.join(',').padEnd(5)} ${b.type.padEnd(11)} ${b.name || '(unnamed)'}`,
      );
    }
  }
}

console.log(
  `${matched.toLocaleString()} bodies have an archived elevation · ${bayClass} are bay-class\n`,
);
console.log('elev ≤   all bodies   of which "suspicious" (bay-class or tidally named)');
let cumAll = 0;
let cumSus = 0;
for (const band of bands) {
  cumAll += all.get(band) ?? 0;
  cumSus += suspicious.get(band) ?? 0;
  console.log(
    `${String(band).padStart(5)}m  ${String(cumAll).padStart(10)}   ${String(cumSus).padStart(10)}`,
  );
}
console.log(`\nbay-class bodies at or under 5 m: ${bayLow}`);
console.log(`\nNOT suspicious, yet under 5 m — what a corpus-wide rule would delete:`);
for (const l of lowFresh) console.log(`  ${l}`);
