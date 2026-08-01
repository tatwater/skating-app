/**
 * Drift check (N6b) — has an agency republished under our archive?
 *
 *   pnpm --filter @skating/bathymetry verify [<key>…]
 *
 * Two cheap requests per source (a descriptor and a count) against a stored manifest. It never pulls
 * a payload, and that is the point: a check that costs as much as a refetch is a check nobody runs.
 *
 * Exit codes are meant for a human and for CI alike — `2` on a breaking change (a field the transform
 * reads has gone, or a column changed type), `0` otherwise. A notable drift is reported loudly and
 * still exits clean, because "New Hampshire surveyed forty more lakes" is good news that should not
 * fail a pipeline.
 */

import process from 'node:process';
import { countUrl, descriptorUrl, parseCount } from './arcgis';
import { getText, readManifest } from './cache';
import { diffManifests, normalizeDescriptor, worstSeverity } from './manifest';
import { SOURCES, sourceByKey } from './sources';
import type { RawManifest } from './types';

const MARK = { breaking: '✗', notable: '!', cosmetic: '·' } as const;

async function probeCurrent(manifest: RawManifest): Promise<Partial<RawManifest>> {
  if (manifest.source.kind === 'file') {
    // A plain download has no descriptor to read, so the validators are the whole signal: a moved
    // etag or content-length is how we learn Vermont re-exported its sonar archive.
    const response = await fetch(manifest.source.url, { method: 'HEAD' });
    const contentLength = Number(response.headers.get('content-length') ?? Number.NaN);
    return {
      http: {
        lastModified: response.headers.get('last-modified') ?? undefined,
        etag: response.headers.get('etag') ?? undefined,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      },
    };
  }

  const descriptor = normalizeDescriptor(
    JSON.parse(await getText(descriptorUrl(manifest.source.url))),
  );
  const recordCount = parseCount(await getText(countUrl(manifest.source.url)));
  return { service: descriptor, recordCount };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const selected =
    requested.length > 0
      ? requested.map((key) => {
          const source = sourceByKey(key);
          if (!source) throw new Error(`unknown source key: ${key}`);
          return source;
        })
      : SOURCES;

  let worst: 'breaking' | 'notable' | 'cosmetic' | undefined;
  let checked = 0;

  for (const source of selected) {
    const manifest = readManifest(source.key);
    if (!manifest) {
      process.stdout.write(`  ? ${source.key}: no snapshot yet — run \`fetch\` first\n`);
      continue;
    }
    checked += 1;

    const report = diffManifests(manifest, await probeCurrent(manifest));
    const severity = worstSeverity(report);
    if (!severity) {
      process.stdout.write(
        `  ✓ ${source.key}: unchanged since ${manifest.fetchedAt.slice(0, 10)}\n`,
      );
      continue;
    }
    process.stdout.write(
      `  ${MARK[severity]} ${source.key}: ${report.findings.length} change(s)\n`,
    );
    for (const finding of report.findings) {
      process.stdout.write(`      ${MARK[finding.severity]} ${finding.message}\n`);
    }

    // Compare the credit we render against the credit the agency currently publishes. These are
    // deliberately two different strings — ours is agreed wording, theirs is today's terms — so a
    // drift is a thing to read, not to auto-resolve.
    if (severity === 'breaking' || worst === 'breaking') worst = 'breaking';
    else if (severity === 'notable') worst = 'notable';
    else worst ??= 'cosmetic';
  }

  if (checked === 0) {
    process.stdout.write('\nNothing archived yet. Run `fetch` before `verify`.\n');
    return;
  }
  if (worst === 'breaking') {
    process.stdout.write(
      '\n✗ A breaking change is live. A transform written against the archive is now wrong for the\n' +
        '  current source — reconcile before re-fetching, or the archive silently becomes the odd one out.\n',
    );
    process.exit(2);
  }
  process.stdout.write(
    worst ? '\n! Drift found; nothing breaking.\n' : '\n✓ All sources unchanged.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] verify failed: ${(error as Error).message}\n`);
  process.exit(1);
});
