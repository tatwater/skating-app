import type { Doc } from '@skating/convex/dataModel';

/**
 * **How the run pages write a time, a duration and a count** — pure, with the zone passed in, so a
 * story or a test pins them. The tallies' and the path's grouping is ported from the old run detail
 * (`ImportRunDetail`, which stays standing for `/admin/imports` until that page retires); nothing is
 * shared with it, so the old file can be deleted whole.
 */

type ImportRun = Doc<'importRuns'>;
export type Stage = ImportRun['stages'][number];
export type Count = ImportRun['counts'][number];

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A whole number as the console writes it: "9,412". */
export const count = (n: number) => n.toLocaleString('en-US');

/** A wall-clock time in `timeZone`: "12:58". */
export function clock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
}

/** A log line's time in `timeZone`, to the second: "13:26:04". */
export function clockSeconds(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
}

/** A calendar date in `timeZone`, as a source's build date is written: "2026-10-11". */
export function isoDay(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(at);
}

/** A value with its unit, for a stat (the unit set in the gray slot). */
export type Part = { value: string; unit: string };

const clean = (ms: number) => (Number.isFinite(ms) ? Math.max(0, ms) : 0);

/**
 * An elapsed time as the board's stat writes it, in parts: "42 s", "14 m", "1 h 14 m". Never
 * negative; rounded down, so a run is "1 h" old until it is an hour old.
 */
export function elapsedParts(ms: number): Part[] {
  const t = clean(ms);
  if (t < MINUTE) return [{ value: String(Math.floor(t / SECOND)), unit: 's' }];
  if (t < HOUR) return [{ value: String(Math.floor(t / MINUTE)), unit: 'm' }];
  return [
    { value: String(Math.floor(t / HOUR)), unit: 'h' },
    { value: String(Math.floor((t % HOUR) / MINUTE)), unit: 'm' },
  ];
}

/** How long a pass took, as the passes table writes it: "42 s", "4 m 10", "1 h 03". */
export function tookWords(ms: number): string {
  const t = clean(ms);
  if (t < MINUTE) return `${Math.floor(t / SECOND)} s`;
  if (t < HOUR) {
    return `${Math.floor(t / MINUTE)} m ${String(Math.floor((t % MINUTE) / SECOND)).padStart(2, '0')}`;
  }
  return `${Math.floor(t / HOUR)} h ${String(Math.floor((t % HOUR) / MINUTE)).padStart(2, '0')}`;
}

/**
 * A quiet stretch as the heartbeat writes it: seconds under a minute ("18 s"), minutes under 100
 * ("41 min"), hours past that ("2 h"). Rounded down, never negative.
 */
export function quietPart(ms: number): Part {
  const t = clean(ms);
  if (t < MINUTE) return { value: String(Math.floor(t / SECOND)), unit: 's' };
  if (t < 100 * MINUTE) return { value: String(Math.floor(t / MINUTE)), unit: 'min' };
  return { value: String(Math.floor(t / HOUR)), unit: 'h' };
}

/** A quiet stretch in one string: "41 min". */
export const quietWords = (ms: number) => {
  const p = quietPart(ms);
  return `${p.value} ${p.unit}`;
};

/** An expected gap: "3 min", "90 s", "1.5 h". */
export function everyWords(ms: number): string {
  const t = clean(ms);
  if (t < 2 * MINUTE && t % MINUTE !== 0) return `${Math.round(t / SECOND)} s`;
  if (t < HOUR) return `${Math.round((t / MINUTE) * 10) / 10} min`;
  return `${Math.round((t / HOUR) * 10) / 10} h`;
}

/**
 * `droppedByAreaFloor` / `below-hard-floor` → readable words, capitalized: "Dropped by area
 * floor", "Below hard floor"; a nested name reads as a path ("Dropped · below hard floor").
 */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\./g, ' · ')
    .trim();
  const lower = spaced.replace(/(^|\s)([A-Z])(?=[a-z])/g, (m) => m.toLowerCase());
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** A byte count: "412 B", "1.9 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `refused.no-class` → `no-class`: the family is already the heading above it. */
export function stripPrefix(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/** What each known count prefix is, in an operator's words; any other groups under its own name. */
const COUNT_GROUPS: Record<string, string> = {
  refused: 'Refused',
  floor: 'Below the admission floor',
  queue: 'Sent to the review queue',
  osm: 'OSM lane',
  nhd: 'NHD lane',
  '3dhp': '3DHP lane',
  nhdId: 'NHD identifiers',
};

/** The bucket for counts with no prefix: the run's own totals. */
export const TOTALS = 'Totals';

export interface CountGroup {
  key: string;
  title: string;
  counts: Count[];
}

/**
 * Every count filed under the prefix its loader named it with (`refused.no-class` under
 * *Refused*). Totals first, in the loader's own order (it is the group every other one breaks
 * down); the other groups in first-appearance order, each sorted biggest first.
 */
export function groupCounts(counts: readonly Count[]): CountGroup[] {
  const groups = new Map<string, CountGroup>();
  for (const c of counts) {
    const dot = c.name.indexOf('.');
    const key = dot === -1 ? TOTALS : c.name.slice(0, dot);
    const existing = groups.get(key);
    if (existing) existing.counts.push(c);
    else groups.set(key, { key, title: COUNT_GROUPS[key] ?? humanize(key), counts: [c] });
  }
  const all = [...groups.values()];
  const totals = all.filter((g) => g.key === TOTALS);
  const rest = all.filter((g) => g.key !== TOTALS);
  for (const g of rest) g.counts.sort((a, b) => b.value - a.value);
  return [...totals, ...rest];
}

/** The convention loaders name a multi-file stage with: `osm · vt`. */
const STAGE_SEPARATOR = ' · ';

export interface StageFamily {
  key: string;
  stages: Stage[];
}

/**
 * Consecutive stages that share a family (`osm · vt`, `osm · nh` → `osm`), so the path reads as the
 * steps it is while every file keeps its own evidence. A stage with no separator is its own family.
 */
export function groupStages(stages: readonly Stage[]): StageFamily[] {
  const families: StageFamily[] = [];
  for (const stage of stages) {
    const at = stage.name.indexOf(STAGE_SEPARATOR);
    const key = at === -1 ? stage.name : stage.name.slice(0, at);
    const last = families.at(-1);
    if (last && last.key === key) last.stages.push(stage);
    else families.push({ key, stages: [stage] });
  }
  return families;
}

/**
 * The coverage ledger's arithmetic: the rate, the stated omissions biggest first, and what no
 * reason accounts for (`eligible − covered − stated`) — computed here, never trusted from the
 * loader, because it is the number nobody wrote down.
 */
export function coverageLedger(c: NonNullable<ImportRun['coverage']>) {
  const pct = c.eligible > 0 ? (c.covered / c.eligible) * 100 : 0;
  const stated = c.omissions.reduce((sum, o) => sum + o.count, 0);
  const unexplained = c.eligible - c.covered - stated;
  const omissions = [...c.omissions].sort((a, b) => b.count - a.count);
  const widest = Math.max(1, ...omissions.map((o) => o.count), Math.abs(unexplained));
  return { pct, unexplained, omissions, widest };
}

/**
 * The headline tallies: the run's last stage's counts when it has any (the stage that produced the
 * result), else the known outcome names, else the unprefixed counts — at most four.
 */
const HEADLINE_COUNTS = [
  'inserted',
  'updated',
  'emitted',
  'kept',
  'created',
  'matched',
  'groups',
  'dropped',
  'stamped',
];

export function headlineCounts(run: Pick<ImportRun, 'stages' | 'counts'>): Count[] {
  const fromStage = run.stages.at(-1)?.counts ?? [];
  if (fromStage.length > 0) return fromStage.slice(0, 4);
  const known = HEADLINE_COUNTS.map((name) => run.counts.find((c) => c.name === name)).filter(
    (c): c is Count => c !== undefined,
  );
  return (known.length > 0 ? known : run.counts.filter((c) => !c.name.includes('.'))).slice(0, 4);
}
