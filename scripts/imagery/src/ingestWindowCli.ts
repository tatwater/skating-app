/**
 * What the season watch has decided, read from the deployment (A06e §3.3 / D149; A06i §7).
 *
 *   pnpm --filter @skating/imagery ingest-window [--season=winter-2026-27]
 *
 * Prints the recorded watch — when it opened and which sentinels fired, the first imagery-line
 * night, winter, the end — the settings version that decided it, whether live imagery is running,
 * and the manual `select-granules` / `backfill.sh` invocation for a gap or a past season.
 *
 * ## It no longer decides anything itself
 *
 * This used to re-run the gate locally, against its own spatially even sample of the mask file and
 * its own one-sentinel regex (`/lake of the clouds/`), while the daily cron in Convex watched three
 * sentinels and a boost-ordered sample. Two instruments, two rosters, two answers to "when did the
 * season open" — the founder caught the mismatch from the first staff email (2026-10-05). The cron's
 * recorded verdict is now the one answer, the settings it was decided under are on `/admin/seasons`,
 * and this CLI reads both through `convex run` against whichever deployment `packages/convex` is
 * configured for.
 *
 * Thin glue; excluded from coverage, like the sibling CLIs.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { archiveSeasonAt, celsiusToFahrenheit } from '@skating/core';

import { flag } from './cli';

const CONVEX_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'convex',
);

interface NamedLow {
  name: string;
  state?: string;
  lowC: number;
}

interface Status {
  config: {
    version: number;
    settings: {
      startMonthDay: string;
      freezeC: number;
      sentinelNights: number;
      imageryNudgeC: number;
    };
    sentinels: { name: string; state?: string }[];
  };
  record: {
    opensOn: string;
    openedBy: string[];
    winterFrom: string | null;
    closesOn?: string;
    settingsVersion?: number;
    opening?: { sentinels: NamedLow[]; corpus: { frozen: number; reporting: number } };
    imageryNudgeOn?: string;
    imageryStartedAt?: number;
    imageryPausedAt?: number;
  } | null;
}

const f = (c: number) => `${(Math.round(celsiusToFahrenheit(c) * 10) / 10).toFixed(1)}°F`;
const named = (s: { name: string; state?: string }) => (s.state ? `${s.name}, ${s.state}` : s.name);

function main(): void {
  const season = flag('season') ?? archiveSeasonAt(Date.now());
  const raw = execFileSync(
    'pnpm',
    ['exec', 'convex', 'run', 'seasonWatch:cliStatus', JSON.stringify({ season })],
    { cwd: CONVEX_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { config, record } = JSON.parse(raw) as Status;
  const s = config.settings;

  console.error(`[ingest-window] ${season} — settings v${config.version}`);
  console.error(
    `[ingest-window] rule: ${s.sentinelNights} night(s) at or below ${f(s.freezeC)} at a sentinel, from ${s.startMonthDay}`,
  );
  console.error(`[ingest-window] sentinels: ${config.sentinels.map(named).join(' · ') || 'none'}`);
  console.error('');

  if (!record) {
    console.error(`[ingest-window] the ice watch has NOT opened for ${season} — nothing to ingest`);
    return;
  }

  console.error(
    `[ingest-window] opened   ${record.opensOn}  (by ${record.openedBy.join(' + ')}, settings v${record.settingsVersion ?? '?'})`,
  );
  for (const site of record.opening?.sentinels ?? []) {
    console.error(`[ingest-window]          ${named(site).padEnd(30)} ${f(site.lowC)}`);
  }
  if (record.opening) {
    console.error(
      `[ingest-window]          ${record.opening.corpus.frozen} of ${record.opening.corpus.reporting} ordinary lakes at or below the line`,
    );
  }
  console.error(
    `[ingest-window] imagery  ${record.imageryNudgeOn ?? `no ${f(s.imageryNudgeC)} sentinel night yet`}`,
  );
  // Printed because the two dates answer different questions: `opened` is when we start looking,
  // `winter` is when the region actually froze, and only the second can be followed by an ice-out.
  console.error(
    `[ingest-window] winter   ${record.winterFrom ?? 'not established — only a summit has frozen'}`,
  );
  console.error(`[ingest-window] closes   ${record.closesOn ?? 'still open'}`);
  console.error(
    `[ingest-window] live     ${
      record.imageryStartedAt === undefined
        ? 'not started — press Start imagery on /admin/seasons'
        : record.imageryPausedAt !== undefined
          ? 'paused on /admin/seasons'
          : 'running from Convex every 6 hours'
    }`,
  );
  console.error('');
  const to = record.closesOn ?? new Date().toISOString().slice(0, 10);
  console.error('[ingest-window] manual, for a gap or a recut (live imagery needs none of this):');
  console.error(
    `  pnpm --filter @skating/imagery select-granules --from=${record.opensOn} --to=${to}`,
  );
  console.error(
    `  scripts/imagery/backfill.sh .scratch/granules-${record.opensOn}-to-${to}.txt ${season}`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error('[ingest-window] FATAL:', error instanceof Error ? error.message : error);
  process.exit(1);
}
