/**
 * Does the multi-raster read agree with what we already stamped? — **the measurement before the swap.**
 *
 *   pnpm --filter @skating/lake-depth probe-identify [--limit=300] [--concurrency=6] [--all]
 *
 * Read-only. Writes nothing, to Convex or to the archive.
 *
 * ## Why this exists before the change it is testing
 *
 * The tiler swap set the rule and the SAR geocode is still waiting on it: *prototype on a sample
 * before it touches a season*. `identify` returns ~19 rasters per point where EPQS returns one
 * number, so the two things that decide whether it can replace the EPQS lane are **whether it
 * disagrees** (and where) and **what it costs** — neither of which is answerable by reasoning.
 *
 * So this walks a sample of the archive, asks `identify` for the same points, and reports:
 *
 * - **agreement** — how often the median of the real rasters matches the number we stamped, which
 *   for a hydro-flattened lake should be essentially always;
 * - **refusals** — the points where the rasters dispute each other or agree on a depth, which is
 *   the population this whole change exists to find;
 * - **throughput** — measured, so a corpus-wide pass can be costed rather than hoped about.
 *
 * ⚠ **A disagreement here is not automatically a defect in the new rule.** It is a point where two
 * methods differ, and the run prints enough of each to be looked at by hand. The failure this is
 * guarding against is not "the new rule refuses things" — it is meant to — but "the new rule
 * refuses things that were fine", which only reading the list can tell you.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifyUrl, judgeReadings, parseIdentify } from './demIdentify';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = resolve(HERE, '../.raw-elevation/readings.ndjson');

interface ArchiveEntry {
  key: string;
  lat: number;
  lng: number;
  elevationM: number;
  resolutionM?: number;
}

/** Evenly spread across the file rather than the first N, so one region cannot stand for the corpus. */
function sample<T>(rows: readonly T[], limit: number): T[] {
  if (limit >= rows.length) return [...rows];
  const step = rows.length / limit;
  return Array.from({ length: limit }, (_, i) => rows[Math.floor(i * step)] as T);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = Number(argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length)) || 300;
  const concurrency =
    Number(argv.find((a) => a.startsWith('--concurrency='))?.slice('--concurrency='.length)) || 6;

  const entries: ArchiveEntry[] = [];
  for (const line of readFileSync(ARCHIVE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line) as ArchiveEntry);
  }
  const targets = argv.includes('--all') ? entries : sample(entries, limit);
  process.stderr.write(
    `[probe] ${entries.length.toLocaleString()} archived · probing ${targets.length.toLocaleString()} ` +
      `at concurrency ${concurrency}\n`,
  );

  const tally = { ok: 0, disputed: 0, belowSurface: 0, noData: 0, unreadable: 0 };
  /** Points where the two methods differ by more than the archive's own rounding. */
  const drifted: string[] = [];
  const refused: string[] = [];
  let latencyTotalMs = 0;
  let done = 0;

  const startedAt = Date.now();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const entry = targets[index];
      if (!entry) return;
      const began = Date.now();
      let readings: ReturnType<typeof parseIdentify> = [];
      try {
        const response = await fetch(identifyUrl(entry.lat, entry.lng));
        readings = parseIdentify(await response.json());
      } catch {
        readings = [];
      }
      latencyTotalMs += Date.now() - began;
      done++;
      // ⚠ **Here, before any of the `continue`s below.** At the bottom of the loop this line sat
      // after the early exits for "unreadable" and "agreed", so it only ever printed on a refusal —
      // and a healthy run has none, which is precisely the run where a multi-hour `--all` pass looks
      // hung. Progress has to be reported on progress, not on findings.
      if (done % 50 === 0) process.stderr.write(`[probe] ${done}/${targets.length}\n`);

      if (readings.length === 0) {
        tally.unreadable++;
        continue;
      }
      const verdict = judgeReadings(readings);
      if (verdict.ok) {
        tally.ok++;
        const delta = Math.abs(verdict.elevationM - entry.elevationM);
        // A tenth of a metre: finer than any real difference between two flights, coarse enough
        // that float formatting cannot manufacture a disagreement.
        if (delta > 0.1 && drifted.length < 25) {
          drifted.push(
            `${entry.key}  stamped ${entry.elevationM.toFixed(2)} → median ` +
              `${verdict.elevationM.toFixed(2)} (Δ${delta.toFixed(2)} m, ${verdict.used} rasters, ` +
              `spread ${verdict.spreadM.toFixed(2)} m)`,
          );
        }
        continue;
      }
      if (verdict.reason === 'no-data') tally.noData++;
      else if (verdict.reason === 'disputed') tally.disputed++;
      else tally.belowSurface++;
      if (refused.length < 25) {
        refused.push(
          `${entry.key}  stamped ${entry.elevationM.toFixed(2)} → ${verdict.reason} ` +
            `(${verdict.used} rasters, spread ${verdict.spreadM.toFixed(2)} m) ` +
            readings
              .filter((r) => r.elevationM !== null)
              .map((r) => `${r.elevationM?.toFixed(2)}@${r.name.slice(0, 28)}`)
              .join(' · '),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const wallSeconds = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(wallSeconds, 0.001);
  process.stderr.write(
    `\n[probe] ${done} points in ${wallSeconds.toFixed(1)} s — ${rate.toFixed(2)} /s, ` +
      `median-ish latency ${(latencyTotalMs / Math.max(done, 1)).toFixed(0)} ms\n` +
      `[probe] a ${entries.length.toLocaleString()}-point pass at this rate: ` +
      `${(entries.length / rate / 3600).toFixed(1)} h\n\n` +
      `[probe] agreed ${tally.ok} · disputed ${tally.disputed} · below-surface ${tally.belowSurface} ` +
      `· all-NoData ${tally.noData} · unreadable ${tally.unreadable}\n`,
  );
  if (drifted.length > 0) {
    process.stderr.write(
      `\n[probe] accepted but different from what we stamped (${drifted.length} shown):\n  ` +
        `${drifted.join('\n  ')}\n`,
    );
  }
  if (refused.length > 0) {
    process.stderr.write(
      `\n[probe] would now be refused (${refused.length} shown):\n  ${refused.join('\n  ')}\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[probe] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
