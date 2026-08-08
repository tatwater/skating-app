/**
 * Archive the Adirondack Lakes Survey into `.raw/alsc/` — **once, ever** (N7-2).
 *
 *   pnpm --filter @skating/lake-depth snapshot-alsc [--limit=N] [--delay-ms=N] [--refresh]
 *
 * ## Why it lives under `.raw/` rather than getting its own archive
 *
 * `scripts/lake-depth/.raw/` is already mirrored to `skating-raw-lake-depth`, and ALSC is a depth
 * source like the other three. A new bucket per source would make the *registry* (`depthSources.ts`)
 * and the *storage* disagree about what a source is.
 *
 * ## Politeness is the design constraint, not throughput
 *
 * This is a scrape of a small public-benefit organisation's site, run on the founder's call (see
 * `alsc.ts` for the reasoning and the robots.txt finding). So it is **serial, paced, and one-time**:
 * no concurrency at all, a full second between requests, and an archive so nobody ever runs it
 * again. ~1,470 requests at 1/s is about 25 minutes and is indistinguishable from one person reading
 * the site attentively for an afternoon.
 *
 * Contrast `snapshotElevation.ts`, which runs twelve at a time against a federal API built for
 * machine access. The difference is deliberate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { convexRun, RunLogger, resolveDeployment } from '@skating/run-log';
import {
  ALSC_BASE,
  ALSC_COUNTIES,
  type AlscPond,
  type AlscPondRef,
  type AlscRefusal,
  alscCountyUrl,
  alscPondUrl,
  parseAlscReport,
  parsePondList,
} from './alsc';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = resolve(HERE, '../.raw/alsc');
const PONDS = `${ARCHIVE_DIR}/ponds.ndjson`;
const MANIFEST = `${ARCHIVE_DIR}/manifest.json`;

/** A full second between requests. See the header — this is a courtesy budget, not a rate limit. */
const DEFAULT_DELAY_MS = 1_000;
/** Attempts per pond before it is counted as a failure. A pond is one pond, never the run. */
const MAX_ATTEMPTS = 3;
const CHECKPOINT_EVERY = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The certificate does not validate — a Let's Encrypt cert for the shared host `www.server266.com`.
 *
 * ⚠ `NODE_TLS_REJECT_UNAUTHORIZED` is **process-wide**, not per-host — Node offers no per-host
 * escape. What makes it acceptable is that this CLI talks to exactly one origin and does nothing
 * else, so the blast radius is this file. **Do not import anything from here**, and do not add a
 * second fetch target to this command; either would silently extend an unverified transport to it.
 *
 * Recorded in the manifest so the archive states its own transport honestly. The answer to "was
 * this really the survey?" is `corroborate()` against GNIS names and our own polygon areas — three
 * publishers that have never met — which is stronger evidence than a certificate anyway.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function get(url: string, body?: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(2_000 * attempt);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(45_000),
        // A scrape should say what it is. An honest UA is the minimum courtesy owed to a site we
        // are reading at volume, and it gives the operator something to contact if we are a problem.
        headers: {
          'User-Agent':
            'skating-corpus/1.0 (open-source outdoor-recreation project; contact desk@teaganatwater.com)',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { method: 'POST', body } : {}),
      });
      if (!res.ok) continue;
      return await res.text();
    } catch {
      // network / TLS / timeout — worth another go
    }
  }
  return undefined;
}

function readArchive(): AlscPond[] {
  if (!existsSync(PONDS)) return [];
  return readFileSync(PONDS, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AlscPond);
}

function writeArchive(
  ponds: readonly AlscPond[],
  refusals: Record<string, number>,
  listed: number,
) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(PONDS, `${ponds.map((p) => JSON.stringify(p)).join('\n')}\n`);
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        key: 'alsc',
        label: 'Adirondack Lakes Survey 1984–87 — pond morphometry',
        publisher:
          'Adirondack Lakes Survey Corporation (NYSDEC + Empire State Electric Energy Research Corporation)',
        sourceUrl: ALSC_BASE,
        fetchedAt: new Date().toISOString(),
        pondsListed: listed,
        pondsArchived: ponds.length,
        withMaxDepth: ponds.filter((p) => p.maxDepthM !== undefined).length,
        withMeanDepth: ponds.filter((p) => p.meanDepthM !== undefined).length,
        refusals,
        // **The three things a reader of this archive has to know**, recorded rather than left to
        // be rediscovered. See `alsc.ts` for the full reasoning.
        licence:
          'NO PUBLISHED TERMS. Checked every page 2026-08-08: the site carries no licence, no ' +
          'terms-of-use and no data-use statement — only a footer "copyright ©" whose year is ' +
          'generated by JavaScript from the current date, i.e. template boilerplate rather than a ' +
          'claim about this 1984–87 dataset. Retrieved on the founder call of 2026-08-08 on the ' +
          'ALSC\'s own published mission ("for the benefit of … the general public … through an ' +
          'exchange of objective information"). Attribution is carried in DEPTH_SOURCE_TERMS.',
        transport:
          'TLS certificate did NOT validate: a Let\'s Encrypt certificate for "www.server266.com", ' +
          'the shared host, which never issued one for this domain. Verification disabled for this ' +
          'one fetch. The payload is corroborated instead against GNIS names and our own polygon ' +
          'areas — three publishers that have never met — which is stronger evidence than a cert.',
        robots:
          'robots.txt is a blanket "User-agent: * / Disallow: /". Founder call 2026-08-08: treated ' +
          'as aimed at search indexers. Fetched serially at 1 req/s with an identifying User-Agent, ' +
          'once, and archived so it is never repeated.',
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length));
  const delayMs =
    Number(args.find((a) => a.startsWith('--delay-ms='))?.slice('--delay-ms='.length)) ||
    DEFAULT_DELAY_MS;

  const logger = new RunLogger({
    kind: 'lake_depth',
    label: 'ALSC 1984–87 morphometry (archive)',
    campaignId: args.find((a) => a.startsWith('--campaign='))?.slice('--campaign='.length),
    target: resolveDeployment(),
    call: convexRun,
    stages: [
      {
        name: 'alsc · enumerate',
        detail: `${ALSC_COUNTIES.length} county queries → the pond list`,
        sourceUrl: alscCountyUrl(),
      },
      {
        name: 'alsc · reports',
        detail:
          'one per-pond report each, serial at 1 req/s with an identifying User-Agent. No bulk ' +
          'download exists; the site publishes chemistry in bulk and morphometry only per pond.',
        sourceUrl: ALSC_BASE,
      },
      { name: 'archive', detail: '.raw/alsc/ponds.ndjson', output: ARCHIVE_DIR },
    ],
  });
  logger.start();

  try {
    // ── Enumerate, by county ────────────────────────────────────────────────
    const refs = new Map<string, AlscPondRef>();
    for (const county of ALSC_COUNTIES) {
      const html = await get(
        alscCountyUrl(),
        `county=${encodeURIComponent(county)}&Submit=Input+Information`,
      );
      if (html === undefined) {
        process.stderr.write(`[alsc] ! county ${county} did not respond\n`);
        continue;
      }
      const found = parsePondList(html);
      for (const ref of found) if (!refs.has(ref.pondNumber)) refs.set(ref.pondNumber, ref);
      process.stderr.write(`[alsc] ${county}: ${found.length} ponds (${refs.size} distinct)\n`);
      await sleep(delayMs);
    }
    process.stderr.write(`[alsc] ${refs.size} distinct ponds listed\n`);
    logger.count('listed', refs.size);

    // ── Fetch each report, skipping whatever the archive already answers ─────
    const existing = refresh ? [] : readArchive();
    const have = new Set(existing.map((p) => p.pondNumber));
    let todo = [...refs.values()].filter((r) => !have.has(r.pondNumber));
    if (Number.isFinite(limit) && limit > 0) todo = todo.slice(0, limit);
    process.stderr.write(
      `[alsc] ${have.size} already archived · ${todo.length} to fetch ` +
        `(~${((todo.length * delayMs) / 60_000).toFixed(0)} min at ${delayMs}ms apart)\n`,
    );

    const fetched: AlscPond[] = [...existing];
    const refusals: Record<string, number> = {};
    let done = 0;
    for (const ref of todo) {
      const html = await get(alscPondUrl(ref.pondNumber, ref.name));
      if (html === undefined) {
        refusals.unreachable = (refusals.unreachable ?? 0) + 1;
      } else {
        const outcome = parseAlscReport(html, ref.pondNumber);
        if (outcome.ok) fetched.push(outcome.pond);
        else {
          const reason: AlscRefusal = outcome.reason;
          refusals[reason] = (refusals[reason] ?? 0) + 1;
        }
      }
      done++;
      if (done % CHECKPOINT_EVERY === 0) {
        writeArchive(fetched, refusals, refs.size);
        process.stderr.write(
          `[alsc] ${done}/${todo.length} · ${fetched.length} archived · ` +
            `${JSON.stringify(refusals)}\n`,
        );
        logger.count('archived', fetched.length);
        logger.flush();
      }
      await sleep(delayMs);
    }

    writeArchive(fetched, refusals, refs.size);
    const withMax = fetched.filter((p) => p.maxDepthM !== undefined).length;
    const withMean = fetched.filter((p) => p.meanDepthM !== undefined).length;
    process.stderr.write(
      `[alsc] done: ${fetched.length} ponds archived · ${withMax} max depths · ` +
        `${withMean} mean depths · refused ${JSON.stringify(refusals)}\n`,
    );

    logger.count('archived', fetched.length);
    logger.count('withMaxDepth', withMax);
    logger.count('withMeanDepth', withMean);
    for (const [reason, n] of Object.entries(refusals)) logger.count(`refused.${reason}`, n);
    logger.coverage({
      unit: 'ponds',
      eligible: refs.size,
      covered: fetched.length,
      omissions: Object.entries(refusals).map(([reason, count]) => ({ reason, count })),
    });
    logger.succeed([
      `${fetched.length} Adirondack ponds archived at ${ARCHIVE_DIR}`,
      'mirror with scripts/lake-depth/mirror-r2.sh push',
    ]);
  } catch (err) {
    logger.failed(err);
    throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[alsc] FAILED: ${err instanceof Error ? err.message : String(err)}\n` +
      '[alsc] Re-running is safe and resumes: archived ponds are never re-fetched.\n',
  );
  process.exit(1);
});
