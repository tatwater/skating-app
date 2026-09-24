/**
 * The corpus's destination bays → `name_bay` requests (D201), in two commands:
 *
 *   pnpm --filter @skating/seed-destinations build-bay-requests \
 *     --mentions=<mentions.csv> --points=<classification.csv> --out=<bays.json> [--campaign=<id>]
 *   pnpm --filter @skating/seed-destinations seed-bay-requests <bays.json> --requester=<profileId> [--apply]
 *
 * The first is the tested transform (`bayRequests.ts`) with file I/O around it; review the JSON —
 * fill in any empty `parentName` by hand. The second files the rows through
 * `corpusRequests.seedBayRequests`, **dry by default**: without `--apply` the mutation reports what
 * each row would do (parent found, already asked, already drawn) and writes nothing. Excluded from
 * coverage like the other CLIs, for the same reason: what can be wrong is in the pure function.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun } from '@skating/run-log';
import { type BayRequestSeedRow, buildBayRequests, parseBayPointsCsv } from './bayRequests';
import { parseMentionsCsv } from './buildFromMentions';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function build(args: string[]) {
  const mentionsPath = flag(args, 'mentions');
  const pointsPath = flag(args, 'points');
  const outPath = flag(args, 'out');
  const campaign = flag(args, 'campaign') ?? 'a10-corpus-seed-20260919';
  if (!mentionsPath || !pointsPath || !outPath) {
    process.stderr.write(
      'Usage: build-bay-requests --mentions=<path> --points=<path> --out=<path> [--campaign=<id>]\n',
    );
    process.exit(1);
  }
  const mentions = parseMentionsCsv(readFileSync(mentionsPath, 'utf8'));
  const points = parseBayPointsCsv(readFileSync(pointsPath, 'utf8'));
  const { rows, stats } = buildBayRequests(mentions, points, campaign);
  writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`);
  process.stderr.write(
    `[bay-requests] ${stats.pointBays} point bays · ${stats.destinations} destinations ` +
      `(skated ≥ 2) · ${stats.referencePoints} reference points · ${stats.parentless} without a parent ` +
      `(fill by hand)\n[bay-requests] wrote ${rows.length} rows to ${outPath}\n`,
  );
}

function seed(args: string[]) {
  const file = args.find((a) => !a.startsWith('--'));
  const requesterId = flag(args, 'requester');
  const apply = args.includes('--apply');
  if (!file || !requesterId) {
    process.stderr.write(
      'Usage: seed-bay-requests <bays.json> --requester=<profileId> [--apply]\n',
    );
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, 'utf8')) as BayRequestSeedRow[];
  const parentless = rows.filter((r) => !r.parentName.trim());
  if (parentless.length > 0) {
    process.stderr.write(
      `[bay-requests] ${parentless.length} row(s) have no parentName — fill them in first: ${parentless
        .map((r) => r.name)
        .join(', ')}\n`,
    );
    process.exit(1);
  }
  const report = convexRun<{ name: string; parent?: string; status: string }[]>(
    'corpusRequests:seedBayRequests',
    { requesterId, rows, ...(apply ? { apply: true } : {}) },
  );
  for (const r of report) {
    process.stderr.write(
      `[bay-requests] ${r.status.padEnd(16)} ${r.name}${r.parent ? ` → ${r.parent}` : ''}\n`,
    );
  }
  const counts = report.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  process.stderr.write(
    `[bay-requests] ${apply ? 'applied' : 'dry run'}: ${JSON.stringify(counts)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'build') build(rest);
    else if (command === 'seed') seed(rest);
    else {
      process.stderr.write('Usage: bayRequestsCli <build|seed> …\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(
      `[bay-requests] failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
