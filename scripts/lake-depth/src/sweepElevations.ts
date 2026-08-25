/**
 * Take back the elevations that are not water surfaces — **the sweep the door guard never did.**
 *
 *   pnpm --filter @skating/lake-depth sweep-elevations              # dry; reports and writes nothing
 *   pnpm --filter @skating/lake-depth sweep-elevations --apply
 *   pnpm --filter @skating/lake-depth sweep-elevations --all        # re-check EVERY body, not just suspects
 *
 * ## What it is for
 *
 * `isPlausibleElevationM` refuses a bad number on the way in. Nothing ever removed one that got in
 * before the rule tightened, because every write path here is additive: a pass proposes a number and
 * the ladder judges it, and a pass concluding *"the stored reading is a river bottom"* has no number
 * to propose. So an unnamed body near Albany still carries **−10.62 m** — the dredged federal channel
 * to Albany, mapped correctly by 3DEP and read by us as a lake surface.
 *
 * ## ⚠ It re-checks live before it retracts, and that is not belt-and-braces
 *
 * The archive holds **one** number per point: whatever EPQS called best. That is exactly the reading
 * under suspicion, so retracting on the strength of it would be taking the suspect's own word for
 * their guilt. `demIdentify` asks the service for *every* raster's value at the point and judges the
 * set — and it can perfectly well come back saying the stored number was fine, which is a result and
 * not a failure. Two of the three verdicts it can return mean *do not retract*.
 *
 * By default only the archive's suspects are re-checked, which is fast and finds the sub-surface
 * cases. `--all` re-checks every stored elevation and is the only way to find *disputed* points,
 * which a single archived value cannot reveal — measured at ~2.9 h for the corpus, and it found none
 * in a 250-point sample, so it is a verification pass rather than a routine one.
 *
 * ## ⚠ The blast radius is capped here, because here is where the total is known
 *
 * `retractElevations` sees a batch of 200 and cannot tell one retraction from twenty-five thousand.
 * A service returning junk — an error page, a maintenance window, a schema change — would refuse
 * every point in the corpus, and the mutation would obediently wipe every elevation we have. So the
 * cap lives at the only level that can see what fraction of the corpus is about to be erased, and it
 * **refuses the whole run** rather than applying a truncated prefix: half a sweep is a corpus in a
 * state no one chose.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, resolveDeployment } from '@skating/run-log';
import { identifyUrl, judgeReadings, MIN_SURFACE_ELEVATION_M, parseIdentify } from './demIdentify';
import { coordinateKey } from './epqs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = resolve(HERE, '../.raw-elevation/readings.ndjson');
const PAGE_SIZE = 500;
const WRITE_BATCH_SIZE = 200;

/**
 * The most a single sweep may retract before it refuses to run at all.
 *
 * **Two limits, because either one alone has a hole.** A percentage cannot protect a small corpus —
 * 2% of 500 bodies is ten, and ten silently-erased elevations in a new region is a bad afternoon
 * nobody notices. An absolute count cannot protect a large one — 200 is a rounding error against
 * 25,000 and a catastrophe against 300. Whichever is *smaller* wins.
 *
 * Sized against what a healthy sweep actually finds: one body, measured. Anything approaching these
 * numbers is not a data-quality finding, it is the service having changed shape under us — which is
 * the failure mode this exists for and the one that will look, in the logs, exactly like success.
 */
const MAX_RETRACT_ABSOLUTE = 200;
const MAX_RETRACT_FRACTION = 0.02;

interface ArchiveEntry {
  key: string;
  elevationM: number;
}

interface Target {
  waterBodyId: string;
  lat: number;
  lng: number;
  surfaceAreaSqM?: number;
  storedElevationM?: number;
  storedSource?: string;
}

/** Every archived point whose stored reading is already under suspicion. */
function suspectKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(ARCHIVE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as ArchiveEntry;
    if (entry.elevationM < MIN_SURFACE_ELEVATION_M) keys.add(entry.key);
  }
  return keys;
}

/** Page the corpus for bodies that HOLD an elevation — `refresh` is what returns stamped rows. */
function* storedElevations(): Generator<{ targets: Target[]; scanned: number }> {
  let cursor: string | undefined;
  for (;;) {
    const page = convexRun<{
      targets: Target[];
      scanned: number;
      cursor: string;
      isDone: boolean;
    }>('waterBodies:listNeedingElevation', {
      ...(cursor ? { cursor } : {}),
      batchSize: PAGE_SIZE,
      refresh: true,
      importFloorOnly: true,
    });
    // `refresh` returns every non-operator body; the ones with a stored value are this pass's
    // subject, and the ones without are simply not its business.
    yield {
      targets: page.targets.filter((t) => t.storedElevationM !== undefined),
      scanned: page.scanned,
    };
    if (page.isDone) return;
    cursor = page.cursor;
  }
}

async function verdictFor(target: Target): Promise<{ retract: boolean; note: string }> {
  let readings: ReturnType<typeof parseIdentify> = [];
  try {
    const response = await fetch(identifyUrl(target.lat, target.lng));
    readings = parseIdentify(await response.json());
  } catch (err) {
    return {
      retract: false,
      note: `unreachable (${err instanceof Error ? err.message : 'error'})`,
    };
  }
  // ⚠ **An unreadable answer is never a retraction.** A proxy error page parses to zero rasters, and
  // "the service did not answer" must not be spelled the same way as "the service says this is a
  // river bottom" — that equivalence is how a maintenance window erases a corpus.
  if (readings.length === 0) return { retract: false, note: 'no readable rasters — left alone' };

  const verdict = judgeReadings(readings);
  const values = readings
    .filter((r) => r.elevationM !== null)
    .map((r) => `${r.elevationM?.toFixed(2)}@${r.name.slice(0, 24)}`)
    .join(' · ');
  if (verdict.ok) {
    return { retract: false, note: `confirmed ${verdict.elevationM.toFixed(2)} m (${values})` };
  }
  if (verdict.reason === 'no-data')
    return { retract: false, note: 'all rasters NoData — left alone' };
  return { retract: true, note: `${verdict.reason} — ${values}` };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const all = args.includes('--all');
  const allowNonDev = args.includes('--prod');
  /**
   * `--min-area=<sqm>` — only re-check bodies at least this big.
   *
   * **The population that matters is not the corpus.** A wrong elevation only reaches a skater
   * through the radar geocode, whose offset is `(h − h_ref) / tan θ` — and the geocode only ever
   * touches bodies big enough to image, `SATELLITE_MIN_AREA_SQM` = 100,000 m² (24.7 acres). That is
   * **9,004 of 24,838**, so scoping here turns a 2.9 h corpus sweep into about an hour.
   *
   * ⚠ **And the thing being looked for is a *large* error, not a better number.** At IW incidence
   * half a metre of elevation buys 0.7 m of ground shift — 0.04 px against a calibrated residual of
   * 42.1 m RMS whose floor is our own shoreline polygons. Thirty metres buys 37 m, which is 1.9 px
   * and comparable to the entire per-pass error. Refining is pointless; finding an outlier is not.
   */
  const minAreaSqM = Number(
    args.find((a) => a.startsWith('--min-area='))?.slice('--min-area='.length),
  );

  const target = resolveDeployment();
  process.stderr.write(`[sweep] target deployment: ${target.label}\n`);
  if (!target.isDev && !allowNonDev) {
    process.stderr.write(
      '[sweep] refusing: target is not a dev deployment. Confirm, then re-run with --prod.\n',
    );
    process.exit(1);
  }

  const suspects = all ? null : suspectKeys();
  process.stderr.write(
    all
      ? '[sweep] --all: re-checking every stored elevation against the full raster set\n'
      : `[sweep] ${suspects?.size ?? 0} archived reading(s) under ${MIN_SURFACE_ELEVATION_M} m — ` +
          're-checking those live\n',
  );
  if (Number.isFinite(minAreaSqM) && minAreaSqM > 0) {
    process.stderr.write(
      `[sweep] --min-area=${minAreaSqM}: only bodies at or above that, which is the population the ` +
        'radar geocode can reach\n',
    );
  }

  const candidates: Target[] = [];
  let scanned = 0;
  let stored = 0;
  for (const page of storedElevations()) {
    scanned += page.scanned;
    stored += page.targets.length;
    for (const t of page.targets) {
      if (Number.isFinite(minAreaSqM) && minAreaSqM > 0 && (t.surfaceAreaSqM ?? 0) < minAreaSqM) {
        continue;
      }
      if (suspects === null || suspects.has(coordinateKey(t.lat, t.lng))) candidates.push(t);
    }
  }
  process.stderr.write(
    `[sweep] scanned ${scanned.toLocaleString()} · ${stored.toLocaleString()} hold an elevation · ` +
      `${candidates.length.toLocaleString()} to re-check\n`,
  );

  const retract: Target[] = [];
  const notes: string[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const { retract: shouldRetract, note } = await verdictFor(candidate);
    notes.push(
      `${coordinateKey(candidate.lat, candidate.lng)}  stored ` +
        `${candidate.storedElevationM?.toFixed(2)} → ${shouldRetract ? 'RETRACT' : 'keep'} · ${note}`,
    );
    if (shouldRetract) retract.push(candidate);
    if ((i + 1) % 100 === 0) process.stderr.write(`[sweep] ${i + 1}/${candidates.length}\n`);
  }

  process.stderr.write(`\n[sweep] verdicts:\n  ${notes.slice(0, 40).join('\n  ')}\n`);
  process.stderr.write(
    `\n[sweep] ${retract.length} of ${candidates.length} re-checked would be retracted ` +
      `(${stored.toLocaleString()} stored)\n`,
  );

  const cap = Math.min(MAX_RETRACT_ABSOLUTE, Math.floor(stored * MAX_RETRACT_FRACTION));
  if (retract.length > cap) {
    process.stderr.write(
      `\n[sweep] ⚠ REFUSING: ${retract.length} retractions exceeds the cap of ${cap} ` +
        `(min of ${MAX_RETRACT_ABSOLUTE} and ${MAX_RETRACT_FRACTION * 100}% of ${stored}).\n` +
        '[sweep] A healthy sweep finds a handful. This many means the service changed shape, not\n' +
        '[sweep] that the corpus did — check the verdicts above before overriding anything.\n',
    );
    process.exit(1);
  }

  if (!apply) {
    process.stderr.write('\n[sweep] dry run — nothing written. Re-run with --apply.\n');
    return;
  }
  if (retract.length === 0) {
    process.stderr.write('\n[sweep] nothing to retract.\n');
    return;
  }

  let retracted = 0;
  let operatorHeld = 0;
  for (let i = 0; i < retract.length; i += WRITE_BATCH_SIZE) {
    const result = convexRun<{ retracted: number; operatorHeld: number }>(
      'waterBodies:retractElevations',
      {
        waterBodyIds: retract.slice(i, i + WRITE_BATCH_SIZE).map((t) => t.waterBodyId),
        reason: 'not-a-water-surface',
      },
    );
    retracted += result.retracted;
    operatorHeld += result.operatorHeld;
  }
  process.stderr.write(
    `\n[sweep] retracted ${retracted}` +
      (operatorHeld > 0 ? ` · ${operatorHeld} left alone as a moderator's value` : '') +
      '\n[sweep] those bodies are now offered to the next elevation pass.\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[sweep] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
