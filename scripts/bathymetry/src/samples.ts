import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { SCRATCH_ROOT } from './cache';
import { type Drawn, interpolate, lakeId, publishedContours, setUngated } from './contour';
import { BASE_INTERVAL_FT } from './interval';
import { type JoinCandidate, joinInBatches } from './joinQuery';
import { runJoinQuery } from './joinRunner';
import { readAllLakes } from './lakeSources';
import {
  type ArchivedLake,
  type LakeMetrics,
  measure,
  representativePoint,
  shapePoints,
  spanSelect,
} from './lakes';
import {
  boundsOfLines,
  boundsOfPoints,
  boundsOfPolygon,
  fitProjection,
  isEmptyBounds,
  unionBounds,
} from './render';
import { ringsOf } from './shoreline';

const WORK_DIR = join(SCRATCH_ROOT, 'samples');
const POLYGON_CACHE = join(WORK_DIR, 'polygons.json');

/**
 * Lakes named by the founder, matched by name within a state. Always included when present, and
 * excluded from the spanning pick below so they don't consume a slot meant to widen the range.
 *
 * **Champlain is pinned rather than left to the span**, for two reasons. It is the founder's ask, and
 * it is a 174 km outlier next to Vermont's next-largest at 5.7 km — a size-spanning pick puts it in
 * the top bucket and can then pass over it in favour of a shape it has not seen yet. It is also the
 * only New York coverage that exists, filed under VT where its source lives.
 *
 * Lake George was asked for and is **not** here: no agency publishes bathymetry for it, or for any
 * other New York lake. See `sources.ts` for the search that established that.
 */
const NAMED: { state: string; pattern: RegExp }[] = [
  { state: 'VT', pattern: /^MOREY$/i },
  { state: 'VT', pattern: /^Lake Champlain$/i },
  { state: 'NH', pattern: /^SUNAPEE LAKE$/i },
  { state: 'NH', pattern: /^MASCOMA LAKE$/i },
  { state: 'NH', pattern: /^NEWFOUND LAKE$/i },
];

/** Big enough that its contours are worth drawing at all — a threshold judged on farm ponds is not
 * the threshold that governs the lakes anyone drives to. */
const MIN_EXTENT_M = 700;
const MIN_DEPTH_FT = 15;
/** A contour lane needs enough published lines to show a basin rather than a single ring. */
const MIN_CONTOUR_LINES = 6;

const DEFAULT_CARD = 340;
let CARD = DEFAULT_CARD;
const CARD_PAD = 10;

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const id = lakeId;

// ---------------------------------------------------------------------------------------------
// Polygons — resolved through the same join the ETL uses, and cached.
// ---------------------------------------------------------------------------------------------

interface SampleBody {
  name: string;
  externalId?: string;
  polygon?: Polygon | MultiPolygon;
  /** Why there is no body, when there isn't one. Cached so a miss isn't re-asked every run. */
  missReason?: string;
}

function loadPolygonCache(): Record<string, SampleBody | null> {
  if (!existsSync(POLYGON_CACHE)) return {};
  return JSON.parse(readFileSync(POLYGON_CACHE, 'utf8')) as Record<string, SampleBody | null>;
}

/**
 * Resolve lakes to our water bodies, in batches, via `waterBodies:matchBathymetryLakes`.
 *
 * The same query the ETL's `join` lane calls, rather than a second notion of "these are the same
 * lake". `null` is cached for a miss as deliberately as a hit is: a lake our corpus does not carry
 * still renders, without a shoreline constraint and captioned as such, and re-asking the deployment
 * about it on every run would be the slowest way to learn nothing.
 */
async function resolvePolygons(
  lakes: readonly ArchivedLake[],
): Promise<Record<string, SampleBody | null>> {
  const cache = loadPolygonCache();
  const wanted = lakes.filter((lake) => !(id(lake) in cache));
  if (wanted.length === 0) return cache;

  const candidates: JoinCandidate[] = [];
  for (const lake of wanted) {
    const point = representativePoint(lake);
    if (point) candidates.push({ key: id(lake), point });
    else cache[id(lake)] = { name: '', missReason: 'no representative point on the water' };
  }

  log(`[bathymetry] resolving ${candidates.length} lake(s) against the corpus…`);
  const { matches, rejects } = await joinInBatches(
    candidates,
    // Optimistic, and split automatically when a lake like Champlain trips the 16 MB read cap.
    8,
    async (batch) => runJoinQuery(batch),
    (done, total) => log(`  ${done}/${total}`),
  );

  for (const lake of wanted) cache[id(lake)] ??= null;
  for (const match of matches) {
    cache[match.key] = {
      name: match.name,
      externalId: match.externalId,
      polygon: match.polygon as Polygon | MultiPolygon | undefined,
    };
  }
  for (const reject of rejects) cache[reject.key] = { name: '', missReason: reject.reason };

  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(POLYGON_CACHE, JSON.stringify(cache));
  return cache;
}

// ---------------------------------------------------------------------------------------------
// The interpolation chain — sounding lanes only.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------------------------

function svg(
  lake: ArchivedLake,
  drawn: Drawn,
  polygon: Polygon | MultiPolygon | undefined,
): { html: string; stretched: boolean } | undefined {
  const dataBounds = lake.soundings
    ? boundsOfPoints(lake.soundings)
    : boundsOfLines(shapePoints(lake).map((p) => [[p.lng, p.lat]]));
  const bounds = unionBounds(
    polygon ? boundsOfPolygon(polygon) : dataBounds,
    dataBounds,
    boundsOfLines(drawn.lines),
  );
  if (isEmptyBounds(bounds)) return undefined;
  const p = fitProjection(bounds, CARD, CARD_PAD);

  const path = (coords: readonly Position[], close: boolean): string =>
    `${coords
      .map(
        (c, i) =>
          `${i === 0 ? 'M' : 'L'}${p.x(c[0] as number).toFixed(1)},${p.y(c[1] as number).toFixed(1)}`,
      )
      .join('')}${close ? 'Z' : ''}`;

  const shore = polygon
    ? ringsOf(polygon)
        .map(
          (ring) =>
            `<path d="${path(ring, true)}" fill="#f4f9fd" stroke="#93a8b7" stroke-width="1"/>`,
        )
        .join('')
    : '';

  const maxDepth = Math.max(1, ...drawn.depths);
  const contours = drawn.lines
    .map((line, i) => {
      // A blue ramp, deliberately nothing like the hazard palette (D82): a depth ramp a skater could
      // mistake for a severity scale would reintroduce through colour the claim we declined in words.
      const t = Math.min(1, (drawn.depths[i] ?? 0) / maxDepth);
      return `<path d="${path(line, false)}" fill="none" stroke="hsl(205 70% ${72 - t * 45}%)" stroke-width="1.05"/>`;
    })
    .join('');

  // Soundings, thinned. Champlain has 20,345 and a card is 340 px wide.
  const soundings = lake.soundings ?? [];
  const step = Math.max(1, Math.ceil(soundings.length / 1200));
  const dots = soundings
    .filter((_, i) => i % step === 0)
    .map(
      (s) =>
        `<circle cx="${p.x(s.lng).toFixed(1)}" cy="${p.y(s.lat).toFixed(1)}" r="0.8" fill="#d1495b" opacity="0.5"/>`,
    )
    .join('');

  return {
    stretched: p.stretched,
    html:
      `<svg viewBox="0 0 ${p.width.toFixed(0)} ${p.height.toFixed(0)}" width="${p.width.toFixed(0)}" height="${p.height.toFixed(0)}" ` +
      `style="background:#fbfdff;border:1px solid #dde5ec;border-radius:6px">${shore}${contours}${dots}</svg>`,
  };
}

/**
 * The name to put on the card.
 *
 * Maine keys its lakes by MIDAS number and carries no name at all, so the source name is often just
 * `4894` — meaningless to anyone reading the grid. Our corpus knows the name, so prefer it whenever
 * the source's own is empty or purely numeric, and keep the id alongside rather than losing it.
 */
function title(lake: ArchivedLake, body: SampleBody | null): string {
  const own = lake.lakeName.trim();
  const named = own && !/^\d+$/.test(own);
  if (named) return own;
  return body?.name ? `${body.name} <span class="key">${own}</span>` : own;
}

function caption(
  lake: ArchivedLake,
  metrics: LakeMetrics,
  drawn: Drawn,
  body: SampleBody | null,
  stretched: boolean,
): string {
  const lane =
    lake.lane === 'contours'
      ? '<span class="lane surveyed">state-surveyed</span>'
      : '<span class="lane fitted">interpolated from soundings</span>';
  const bits: string[] = [];
  bits.push(
    `${metrics.recordCount.toLocaleString()} ${lake.lane === 'contours' ? 'lines' : 'soundings'}`,
  );
  bits.push(`${Math.round(metrics.extentM).toLocaleString()} m across`);
  bits.push(`max ${Math.round(metrics.maxDepthFt)} ft`);
  if (metrics.density) bits.push(`gap ${(metrics.density.gapRatio * 100).toFixed(1)}%`);
  if (drawn.interval) {
    bits.push(
      `${drawn.interval} ft interval${drawn.coarsenedBy ? ` (coarsened: ${drawn.coarsenedBy})` : ''}`,
    );
  }
  if (drawn.shoreShare !== undefined) {
    bits.push(`${(drawn.shoreShare * 100).toFixed(0)}% shoreline-constrained`);
  }
  if (drawn.fragmentsPerLevel !== undefined) {
    bits.push(`${drawn.fragmentsPerLevel.toFixed(1)} frag/level`);
  }
  if (drawn.ratio !== undefined) {
    bits.push(`elong ${metrics.elongation.toFixed(2)} → aniso ${drawn.ratio.toFixed(2)}`);
  }
  bits.push(`${drawn.lines.length} lines drawn`);

  const warnings: string[] = [];
  if (!body?.polygon) {
    warnings.push(
      `no shoreline constraint — ${body?.missReason ?? 'no body in our corpus at this point'}`,
    );
  }
  if (drawn.clippedAway && drawn.clippedAway > 0) {
    warnings.push(`${drawn.clippedAway} feature(s) removed by the clip against our shoreline`);
  }
  if (drawn.thinnedAway) {
    warnings.push(
      `${drawn.thinnedAway} published line(s) thinned toward the ${BASE_INTERVAL_FT} ft ladder`,
    );
  }
  if (drawn.note) warnings.push(drawn.note);
  if (stretched) {
    // Said out loud rather than absorbed: a 174 km lake a few km wide would otherwise be a sliver a
    // handful of pixels tall, and a reader has no way to tell a clamped card from a true shape.
    warnings.push('card aspect clamped — this lake is longer and thinner than it looks here');
  }

  return (
    `<figcaption><b>${title(lake, body)}</b> <span class="state">${lake.state}</span><br>${lane}` +
    `<br><span class="agency">${lake.agency}</span>` +
    `<br>${bits.join(' · ')}` +
    (body?.name &&
    /^\D/.test(lake.lakeName) &&
    body.name.toUpperCase() !== lake.lakeName.toUpperCase()
      ? `<br><span class="matched">matched to “${body.name}”</span>`
      : '') +
    warnings.map((w) => `<br><span class="warn">⚠ ${w}</span>`).join('') +
    '</figcaption>'
  );
}

// ---------------------------------------------------------------------------------------------

function eligible(lake: ArchivedLake, metrics: LakeMetrics): boolean {
  if (metrics.extentM < MIN_EXTENT_M) return false;
  if (metrics.maxDepthFt < MIN_DEPTH_FT) return false;
  // A key holding two waters cannot be joined at all — one key resolves to one polygon, so the other
  // pond's geometry is clipped away against a shoreline miles from it. Not a lake to sample.
  if (metrics.bodyCount > 1) return false;
  if (lake.lane === 'contours') return metrics.recordCount >= MIN_CONTOUR_LINES;
  return metrics.density?.verdict === 'ok';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  mkdirSync(WORK_DIR, { recursive: true });
  const outPath = flag(args, 'out') ?? join(WORK_DIR, 'samples.html');
  const perState = Number(flag(args, 'per-state') ?? 5);
  CARD = Number(flag(args, 'card') ?? DEFAULT_CARD);
  setUngated(args.includes('--ungated'));
  const states = (flag(args, 'states') ?? 'VT,NH,MA,ME').split(',').map((s) => s.trim());

  log('[bathymetry] reading every archived source…');
  const all = await readAllLakes();
  log(
    `[bathymetry] ${all.length} lakes across ${new Set(all.map((l) => l.sourceKey)).size} sources`,
  );

  const measured = all.map((lake) => ({ lake, metrics: measure(lake) }));

  // Named, never silently skipped (the register's no-silent-caps rule). These are a defect in the
  // source's own keying and they are fatal to the join, so they are worth reporting on every run
  // rather than discovering again from a blank card.
  const collided = measured.filter((m) => m.metrics.bodyCount > 1);
  if (collided.length > 0) {
    log(
      `\n[bathymetry] ⚠ ${collided.length} source key(s) hold more than one water body — excluded from sampling:`,
    );
    for (const { lake, metrics } of collided) {
      log(
        `    ${lake.state} ${id(lake)} "${lake.lakeName}" — ${metrics.bodyCount} bodies over ${Math.round(metrics.extentM).toLocaleString()} m`,
      );
    }
    log('');
  }

  if (args.includes('--list')) {
    for (const { lake, metrics } of measured) {
      if (!eligible(lake, metrics)) continue;
      process.stdout.write(
        `${lake.state}\t${id(lake)}\t${lake.lakeName}\t${metrics.recordCount}\t${Math.round(metrics.extentM)}\t${metrics.elongation.toFixed(2)}\t${Math.round(metrics.maxDepthFt)}\n`,
      );
    }
    return;
  }

  const only = flag(args, 'only')
    ?.split(',')
    .map((s) => s.trim());
  let picked: typeof measured;
  if (only) {
    picked = only
      .map((key) => measured.find((m) => id(m.lake) === key || m.lake.lakeName === key))
      .filter((m): m is (typeof measured)[number] => m !== undefined);
  } else {
    // Named lakes first, whether or not they clear the eligibility bar — they were asked for by name.
    const named = NAMED.flatMap(({ state, pattern }) =>
      measured.filter((m) => m.lake.state === state && pattern.test(m.lake.lakeName)),
    );
    const takenIds = new Set(named.map((m) => id(m.lake)));

    const spanned = states.flatMap((state) => {
      const candidates = measured.filter(
        (m) => m.lake.state === state && !takenIds.has(id(m.lake)) && eligible(m.lake, m.metrics),
      );
      const chosen = spanSelect(
        candidates,
        perState,
        (m) => m.metrics.extentM,
        (m) => m.metrics.elongation,
      );
      for (const m of chosen) takenIds.add(id(m.lake));
      log(`  ${state}: ${chosen.length} of ${candidates.length} eligible`);
      return chosen;
    });
    picked = [...named, ...spanned];
  }

  log(`[bathymetry] rendering ${picked.length} lakes…`);
  const bodies = await resolvePolygons(picked.map((m) => m.lake));

  const cards: { state: string; html: string }[] = [];
  for (const { lake, metrics } of picked) {
    const body = bodies[id(lake)] ?? null;
    const polygon = body?.polygon;
    const measured = polygon ? measure(lake, polygon) : metrics;
    const drawn =
      lake.lane === 'contours'
        ? publishedContours(lake, polygon)
        : interpolate(lake, polygon, measured.extentM);
    const picture = svg(lake, drawn, polygon);
    if (!picture) {
      log(`  ✗ ${lake.lakeName} (${lake.state}) — nothing to draw`);
      continue;
    }
    cards.push({
      state: lake.state,
      html: `<figure>${picture.html}${caption(lake, metrics, drawn, body, picture.stretched)}</figure>`,
    });
    log(
      `  ✓ ${lake.state} ${lake.lakeName} — ${drawn.lines.length} lines${drawn.note ? ` (${drawn.note})` : ''}`,
    );
  }

  const byState = new Map<string, string[]>();
  for (const card of cards) {
    const list = byState.get(card.state) ?? [];
    list.push(card.html);
    byState.set(card.state, list);
  }
  const sections = [...byState.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([state, html]) =>
        `<h2>${state} <span class="count">${html.length}</span></h2><div class="grid">${html.join('')}</div>`,
    )
    .join('');

  writeFileSync(
    outPath,
    `<!doctype html><meta charset="utf-8"><title>N6b — contour samples across five sources</title>
<style>
 body{font:14px/1.55 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:1400px;color:#16222c;padding:0 1rem}
 h1{font-size:1.5rem;margin-bottom:.3rem} h2{font-size:1.1rem;margin-top:2.5rem;border-bottom:1px solid #e3eaf0;padding-bottom:.3rem}
 .count{color:#8b9aa6;font-weight:400;font-size:.85em}
 figure{margin:0;display:inline-block;vertical-align:top;max-width:${CARD + 20}px}
 figcaption{font-size:12px;color:#5a6b78;margin-top:.5rem;line-height:1.5}
 .grid{display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:1.2rem}
 .state{background:#eef3f7;border-radius:3px;padding:0 5px;font-size:11px;color:#5a6b78}
 .lane{font-size:11px;border-radius:3px;padding:1px 6px}
 .surveyed{background:#e8f2e8;color:#2f6b3a} .fitted{background:#fdf2e3;color:#8a5a1a}
 .agency{color:#8b9aa6} .matched{color:#8b9aa6;font-style:italic} .warn{color:#a33b2b}
 .key{color:#a9b6c0;font-weight:400;font-size:11px}
 .note{background:#f2f7fb;border-left:3px solid #7ba7c7;padding:.9rem 1.1rem;border-radius:4px;margin-top:1rem}
</style>
<h1>N6b — what the chain draws, across all five sources</h1>
<p class="note"><b>Two lanes, and the difference is a provenance claim rather than a file format.</b>
<span class="lane surveyed">state-surveyed</span> lakes are the agency's own isobaths; we reproject and
clip, and invent nothing. <span class="lane fitted">interpolated from soundings</span> lakes are
<b>our</b> surface, fitted through the state's measured depth points with the shoreline pinned at zero.
<br><br>They sit in the same grid on purpose: a surveyed lake beside a fitted one is the only honest
calibration we have for how good the fitted ones look. Red dots are real measurements; blue lines are
contours; the pale shape is our own water-body polygon. Every card is framed to the whole lake.
<br><br>New York publishes no lake bathymetry of any kind — it appears here only as Lake Champlain,
whose soundings span the entire New York shore, filed under Vermont where its source lives.</p>
${sections}`,
  );
  log(`\n[bathymetry] wrote ${outPath} — ${cards.length} lakes`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[bathymetry] samples failed: ${(error as Error).stack}\n`);
  process.exit(1);
});
