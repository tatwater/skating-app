/**
 * The season watch's preview, in the browser (A06i §6, D213).
 *
 * `/admin/seasons` replays every stored season through the **same** `evaluateSeason` the daily cron
 * runs, under the saved settings and under whatever is being edited, so a change is judged against
 * nine winters before it is saved. Pure, so the arithmetic is tested without a page.
 *
 * ⚠ Every date here is an air-temperature event at a coordinate — a summit's cold night, a share of
 * lakes below a line — never a lake freezing (D3). The labels on the page say so.
 */

import {
  celsiusToFahrenheit,
  type DailyLow,
  daysBetween,
  evaluateSeason,
  expandLows,
  fahrenheitToCelsius,
  firstNightAtOrBelow,
  type SeasonEvaluation,
  type SeasonWatchSettings,
  type SiteSeries,
  seasonFloorDate,
} from '@skating/core';

/** A stored series as `seasonWatch.series` returns it. */
export interface SeriesDoc {
  season: string;
  waterBodyId: string;
  name: string;
  state: string | null;
  source: 'forecast' | 'archive';
  /**
   * Whether a history fill would leave this season be (the server's `holdsSeason`) — false for a
   * past season the live watch kept until the archive has filled its spring. Absent counts as whole.
   */
  whole?: boolean;
  firstDate: string;
  lows: (number | null)[];
}

/** Which bodies are sentinels and which are ordinary sites (pinned plus the sample) for a replay. */
export interface Roster {
  sentinelIds: readonly string[];
  ordinaryIds: readonly string[];
}

/** A site as `seasonWatch.sampleSites` resolves it — roster ids already followed to survivors. */
export interface WatchedSite {
  siteId: string;
  role: 'sentinel' | 'pinned' | 'sample';
  name: string;
  state?: string;
}

/**
 * The roster a replay reads, from the sites the server resolved — never from the ids a settings
 * version stored. A merged sentinel's new lows accrue under its survivor, and the sample is drawn
 * around the roster, so only the resolved sites are the lakes the live watch actually reads.
 */
export function rosterOf(sites: readonly WatchedSite[]): Roster {
  return {
    sentinelIds: sites.filter((s) => s.role === 'sentinel').map((s) => s.siteId),
    ordinaryIds: sites.filter((s) => s.role !== 'sentinel').map((s) => s.siteId),
  };
}

/** A roster lake as the editor lists it. */
export interface RosterEntry {
  waterBodyId: string;
  name: string;
  state?: string;
}

/** A roster lake that no longer resolves — merged into nothing, or delisted. */
export interface MissingSite extends RosterEntry {
  role: 'sentinel' | 'pinned';
}

/** One role's sites as the roster editor lists them. */
export function rosterEntries(
  sites: readonly WatchedSite[],
  role: 'sentinel' | 'pinned',
): RosterEntry[] {
  return sites
    .filter((s) => s.role === role)
    .map((s) => ({ waterBodyId: s.siteId, name: s.name, ...(s.state ? { state: s.state } : {}) }));
}

/**
 * The roster the editor starts from: each lake as the cron reads it (a merged one as its survivor),
 * then any that no longer resolve. ⚠ **A lost lake stays in the draft**, beside the page's warning,
 * so the save refuses it until someone removes it — rather than a save that changed something else
 * quietly deleting it from the roster.
 */
export function draftRoster(
  sites: readonly WatchedSite[],
  missing: readonly MissingSite[],
): { sentinels: RosterEntry[]; pinned: RosterEntry[] } {
  const lost = (role: MissingSite['role']) =>
    missing
      .filter((m) => m.role === role)
      .map(({ waterBodyId, name, state }) => ({ waterBodyId, name, ...(state ? { state } : {}) }));
  return {
    sentinels: [...rosterEntries(sites, 'sentinel'), ...lost('sentinel')],
    pinned: [...rosterEntries(sites, 'pinned'), ...lost('pinned')],
  };
}

/**
 * The sites an edit is previewed over: the saved ones when the edit leaves the sample alone, else
 * the server's re-drawn sample — `undefined` while it loads, `null` when the edit is one the save
 * would refuse (the editor names why).
 */
export function editedSitesFor(
  resample: boolean,
  savedSites: readonly WatchedSite[],
  preview: { sites: readonly WatchedSite[] } | null | undefined,
): readonly WatchedSite[] | null | undefined {
  if (!resample) return savedSites;
  return preview === undefined ? undefined : (preview?.sites ?? null);
}

export interface FieldDate {
  season: string;
  kind: 'first_skated' | 'last_skated';
  date: string;
}

/** Every season with stored lows, newest first. */
export function seasonsIn(docs: readonly SeriesDoc[]): string[] {
  return [...new Set(docs.map((d) => d.season))].sort().reverse();
}

/** One season's series under a roster: sentinels flagged, sites in neither list left out. */
export function siteSeriesFor(
  season: string,
  docs: readonly SeriesDoc[],
  roster: Roster,
): SiteSeries[] {
  const sentinels = new Set(roster.sentinelIds);
  const ordinary = new Set(roster.ordinaryIds);
  return docs
    .filter(
      (d) => d.season === season && (sentinels.has(d.waterBodyId) || ordinary.has(d.waterBodyId)),
    )
    .map((d) => ({
      siteId: d.waterBodyId,
      ...(sentinels.has(d.waterBodyId) ? { sentinel: true } : {}),
      days: expandLows(d),
    }));
}

/** How many watched sites hold a season whole — the rest are what a fill would ask for. */
function wholeIn(season: string, docs: readonly SeriesDoc[], watched: ReadonlySet<string>): number {
  return docs.filter((d) => d.season === season && d.whole !== false && watched.has(d.waterBodyId))
    .length;
}

export interface PreviewRow {
  season: string;
  /** Where the lows came from: the live endpoint, the ERA5 archive, or both. */
  source: 'forecast' | 'archive' | 'mixed';
  evaluation: SeasonEvaluation;
  firstSkated: string | null;
  lastSkated: string | null;
  /** Days from the watch opening to the first recorded skate; positive means the watch was early. */
  leadDays: number | null;
  /**
   * Sites the roster watches, and how many lack lows for this season: none stored, or — for a past
   * season — only what the live watch kept, without the archive's spring (the server's rule).
   */
  watched: number;
  missingLows: number;
}

export function previewSeasons(
  docs: readonly SeriesDoc[],
  roster: Roster,
  settings: SeasonWatchSettings,
  fieldDates: readonly FieldDate[],
): PreviewRow[] {
  return seasonsIn(docs).map((season) => {
    const sources = new Set(docs.filter((d) => d.season === season).map((d) => d.source));
    const series = siteSeriesFor(season, docs, roster);
    const evaluation = evaluateSeason(series, settings, season);
    const watched = new Set([...roster.sentinelIds, ...roster.ordinaryIds]);
    const dates = fieldDates.filter((f) => f.season === season);
    const earliest = (kind: FieldDate['kind']) =>
      dates
        .filter((f) => f.kind === kind)
        .map((f) => f.date)
        .sort()[0] ?? null;
    const latest = dates
      .filter((f) => f.kind === 'last_skated')
      .map((f) => f.date)
      .sort()
      .at(-1);
    const firstSkated = earliest('first_skated');
    return {
      season,
      source: sources.size > 1 ? 'mixed' : ([...sources][0] as 'forecast' | 'archive'),
      evaluation,
      firstSkated,
      lastSkated: latest ?? null,
      leadDays:
        firstSkated && evaluation.opensOn ? daysBetween(evaluation.opensOn, firstSkated) : null,
      watched: watched.size,
      missingLows: watched.size - wholeIn(season, docs, watched),
    };
  });
}

export interface SentinelCrossing {
  waterBodyId: string;
  name: string;
  state: string | null;
  firstFreeze: DailyLow | null;
  firstImageryNight: DailyLow | null;
  coldest: DailyLow | null;
}

/** For each sentinel in a season: its first night at the freezing line, at the imagery line, and its coldest. */
export function sentinelCrossings(
  season: string,
  docs: readonly SeriesDoc[],
  sentinelIds: readonly string[],
  settings: SeasonWatchSettings,
): SentinelCrossing[] {
  const floor = seasonFloorDate(season, settings.startMonthDay);
  return sentinelIds.flatMap((id) => {
    const doc = docs.find((d) => d.season === season && d.waterBodyId === id);
    if (!doc) return [];
    const site: SiteSeries = { siteId: id, days: expandLows(doc).filter((d) => d.date >= floor) };
    const coldest = site.days.reduce<DailyLow | null>(
      (min, d) => (!min || d.minTempC < min.minTempC ? d : min),
      null,
    );
    return [
      {
        waterBodyId: id,
        name: doc.name,
        state: doc.state,
        firstFreeze: firstNightAtOrBelow(site, settings.freezeC),
        firstImageryNight: firstNightAtOrBelow(site, settings.imageryNudgeC),
        coldest,
      },
    ];
  });
}

/** One row per date: each sentinel's low in °F, keyed by its id — what the chart draws. */
export function chartRows(
  season: string,
  docs: readonly SeriesDoc[],
  sentinelIds: readonly string[],
  from: string,
): Array<Record<string, number | string | null>> {
  const byDate = new Map<string, Record<string, number | string | null>>();
  for (const id of sentinelIds) {
    const doc = docs.find((d) => d.season === season && d.waterBodyId === id);
    if (!doc) continue;
    for (const day of expandLows(doc)) {
      if (day.date < from) continue;
      const row = byDate.get(day.date) ?? { date: day.date };
      row[id] = Math.round(celsiusToFahrenheit(day.minTempC) * 10) / 10;
      byDate.set(day.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** The settings as the form edits them: °F, percentages, whole numbers — all strings while typed. */
export interface SettingsForm {
  startMonthDay: string;
  freezeF: string;
  sentinelNights: string;
  corpusPct: string;
  winterPct: string;
  imageryNudgeF: string;
  thawF: string;
  thawRunDays: string;
  sampleSize: string;
}

const f1 = (c: number) => String(Math.round(celsiusToFahrenheit(c) * 10) / 10);
const pct = (fraction: number) => String(Math.round(fraction * 1000) / 10);

export function toForm(s: SeasonWatchSettings): SettingsForm {
  return {
    startMonthDay: s.startMonthDay,
    freezeF: f1(s.freezeC),
    sentinelNights: String(s.sentinelNights),
    corpusPct: pct(s.corpusFraction),
    winterPct: pct(s.winterFraction),
    imageryNudgeF: f1(s.imageryNudgeC),
    thawF: f1(s.thawC),
    thawRunDays: String(s.thawRunDays),
    sampleSize: String(s.sampleSize),
  };
}

/**
 * The form back to settings. A blank or non-numeric field becomes `NaN`, which
 * `validateSeasonWatchSettings` names — the form never guesses a value someone did not type.
 *
 * ⚠ A field left as it was keeps the saved value exactly, rather than round-tripping through °F:
 * 20 °F is −6.666…°C, and re-deriving it from a rounded string would make an untouched form look
 * edited and save a new version that changes nothing.
 */
export function fromForm(form: SettingsForm, saved: SeasonWatchSettings): SeasonWatchSettings {
  const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
  const temp = (text: string, savedC: number) =>
    text === f1(savedC) ? savedC : fahrenheitToCelsius(num(text));
  const share = (text: string, savedFraction: number) =>
    text === pct(savedFraction) ? savedFraction : num(text) / 100;
  return {
    startMonthDay: form.startMonthDay.trim(),
    freezeC: temp(form.freezeF, saved.freezeC),
    sentinelNights: num(form.sentinelNights),
    corpusFraction: share(form.corpusPct, saved.corpusFraction),
    winterFraction: share(form.winterPct, saved.winterFraction),
    imageryNudgeC: temp(form.imageryNudgeF, saved.imageryNudgeC),
    thawC: temp(form.thawF, saved.thawC),
    thawRunDays: num(form.thawRunDays),
    sampleSize: num(form.sampleSize),
  };
}

/** Whether two settings objects decide the same thing. */
export function sameSettings(a: SeasonWatchSettings, b: SeasonWatchSettings): boolean {
  return (Object.keys(a) as (keyof SeasonWatchSettings)[]).every((k) => a[k] === b[k]);
}

/** `2026-10-03` → `Oct 3`; `null` → an em dash. */
export function shortDay(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** `−0.4 °C` → `31.3°F`. */
export function lowF(c: number): string {
  const f = Math.round(celsiusToFahrenheit(c) * 10) / 10;
  return `${f.toFixed(1)}°F`.replace('-', '−');
}
