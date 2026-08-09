/**
 * The answer to a certificate that did not validate — **D130's corroboration** (2026-08-08).
 *
 *   pnpm --filter @skating/lake-depth corroborate-alsc
 *
 * Committed because it is the evidence the ALSC payload is genuine, and that claim has to be
 * re-checkable — especially if the archive is ever re-fetched over the same unverified transport.
 * Measured 2026-08-08: 81.3% of areas agree within 35%, median ratio 88.9%; 74.8% of names identical.
 *
 * Joins each ALSC pond to the corpus body its published coordinate falls inside, then compares
 * ALSC's surface area against the polygon we drew from OSM/NHD and its name against ours. Agreement
 * between three publishers who have never met is stronger evidence that the bytes are the survey
 * they claim to be than a TLS certificate would have been.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { pointInPolygon } from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';
import type { AlscPond } from '../src/alsc';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODIES = resolve(HERE, '../../etl/.scratch/merge/bodies.ndjson');
const SQ_M_PER_HA = 10_000;
const CELL = 0.05;
const cell = (lat: number, lng: number) => `${Math.floor(lng / CELL)}:${Math.floor(lat / CELL)}`;

const ponds = readFileSync(resolve(HERE, '../.raw/alsc/ponds.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as AlscPond)
  .filter((p) => p.lat !== undefined && p.lng !== undefined);

interface Body {
  name: string;
  surfaceAreaSqM: number;
  polygon: Polygon | MultiPolygon;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  states?: string[];
}
const grid = new Map<string, Body[]>();
const rl = createInterface({ input: createReadStream(BODIES), crlfDelay: Infinity });
let bodies = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const b = JSON.parse(line) as Body;
  if (!b.states?.includes('NY')) continue;
  bodies++;
  for (let x = Math.floor(b.bbox.minLng / CELL); x <= Math.floor(b.bbox.maxLng / CELL); x++) {
    for (let y = Math.floor(b.bbox.minLat / CELL); y <= Math.floor(b.bbox.maxLat / CELL); y++) {
      const k = `${x}:${y}`;
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }
  }
}
console.log(`${bodies.toLocaleString()} NY corpus bodies indexed · ${ponds.length} ALSC ponds\n`);

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let inside = 0;
let areaComparable = 0;
let areaAgree = 0;
let nameComparable = 0;
let nameAgree = 0;
const ratios: number[] = [];
const disagreements: string[] = [];

for (const p of ponds) {
  const lat = p.lat as number;
  const lng = p.lng as number;
  let hit: Body | undefined;
  for (const b of grid.get(cell(lat, lng)) ?? []) {
    if (lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;
    if (lng < b.bbox.minLng || lng > b.bbox.maxLng) continue;
    if (!pointInPolygon({ lat, lng }, b.polygon)) continue;
    // The smallest containing body: an ALSC point inside a pond inside a bay belongs to the pond.
    if (hit === undefined || b.surfaceAreaSqM < hit.surfaceAreaSqM) hit = b;
  }
  if (hit === undefined) continue;
  inside++;

  if (p.surfaceAreaHa !== undefined && p.surfaceAreaHa > 0 && hit.surfaceAreaSqM > 0) {
    areaComparable++;
    const theirs = p.surfaceAreaHa * SQ_M_PER_HA;
    const ratio = Math.min(theirs, hit.surfaceAreaSqM) / Math.max(theirs, hit.surfaceAreaSqM);
    ratios.push(ratio);
    if (ratio >= 0.65) areaAgree++;
    else if (disagreements.length < 12) {
      disagreements.push(
        `${p.name} — ALSC ${Math.round(p.surfaceAreaHa)} ha vs ours ${Math.round(
          hit.surfaceAreaSqM / SQ_M_PER_HA,
        )} ha (${(ratio * 100).toFixed(0)}%) [${hit.name || '(unnamed)'}]`,
      );
    }
  }
  if (hit.name.length > 0) {
    nameComparable++;
    if (norm(hit.name) === norm(p.name)) nameAgree++;
  }
}

ratios.sort((a, b) => a - b);
const median = ratios[Math.floor(ratios.length / 2)] ?? 0;
console.log(`${inside} of ${ponds.length} ALSC coordinates fall inside a corpus body`);
console.log(
  `AREA  ${areaAgree}/${areaComparable} agree within 35% (${((areaAgree / Math.max(1, areaComparable)) * 100).toFixed(1)}%) · median ratio ${(median * 100).toFixed(1)}%`,
);
console.log(
  `NAME  ${nameAgree}/${nameComparable} identical after folding (${((nameAgree / Math.max(1, nameComparable)) * 100).toFixed(1)}%)`,
);
console.log(`\nlargest area disagreements:\n  ${disagreements.join('\n  ')}`);
