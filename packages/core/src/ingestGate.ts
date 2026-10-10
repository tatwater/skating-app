/**
 * When to start looking, and when to stop (A06e §3.3 / **D149**).
 *
 * > **D149 — Ingest is weather-gated, and the archive turns over on the first frame of the new
 * > season, never on a date.**
 *
 * ## The asymmetry that licenses everything here
 *
 * **The gate and the turnover are different things.** Weather decides *when we start looking*; the
 * first frame showing ice decides when the app turns over. So an over-eager gate costs a few dollars
 * of granule reads, while a late one misses freeze-up entirely — the single most valuable frame of
 * the season, gone, with nothing to say it was ever there.
 *
 * That is a license to be generous, and every default below takes it.
 *
 * ## The sentinel, and why it is a one-acre pond
 *
 * > **Founder, 2026-08-21c:** *"I'd actually be totally happy to start a season once Lake of the
 * > Clouds registers freezing temps. That lake is an early-season favorite in the community, which
 * > signals the new season has arrived!"*
 *
 * `Upper Lake of the Clouds`, NH — 1.0 acre at 1,531 m, clearing the corpus floor by 60 m². It freezes
 * weeks before anything in the valleys, and the community already treats it as the season opener, so
 * the signal carries meaning a percentile never would.
 *
 * **It is a weather trigger, not an imagery one, and that distinction is what saves it.** At one acre
 * the pond is ~41 Sentinel pixels, nearly all shoreline-mixed — imagery could not tell us when it
 * froze. Sampling *temperature* at a coordinate does not care how small the pond is.
 *
 * ⚠ **OR, never AND.** The season opens when the sentinel freezes **or** the across-corpus signal
 * fires. One 1-acre pond must not be a single point of failure for a whole region's ingest: a gap in
 * one weather series should not stall a season.
 */

import { approximateUtcOffsetSeconds, COMPLETE_DAY_MIN_HOURS, localStampAt } from './weatherDay';

/** A day's low at one sample site. */
export interface DailyLow {
  /** `YYYY-MM-DD`. */
  date: string;
  minTempC: number;
}

/** One sampled site's recent observed lows. Observed — D140's `.past`, never the forecast. */
export interface SiteSeries {
  siteId: string;
  /** True for the sentinel pond, which can open a season on its own. */
  sentinel?: boolean;
  days: readonly DailyLow[];
}

export interface GateOptions {
  /** At or below this, a site counts as frozen. */
  freezeC?: number;
  /**
   * The fraction of non-sentinel sites that must freeze on a day for the corpus-wide signal to fire.
   *
   * Low on purpose. This is a *start looking* trigger, not a claim that the region has frozen.
   */
  corpusFraction?: number;
  /**
   * The fraction that must freeze for **winter to count as established**, which is what closing is
   * measured from. Deliberately a majority, where opening takes almost anything.
   */
  winterFraction?: number;
  /**
   * A day whose low stays above this counts as thaw at a site.
   *
   * **Zero, and it is measuring "no overnight freeze at all" rather than "warm".** An earlier draft
   * used 4 °C and closed the 2025-26 season on 9 June — clear spring nights in New England dip below
   * 4 °C well into June on lakes that have been wide open for weeks, so the threshold was measuring
   * air temperature where we wanted ice. A run of nights that never reach freezing is the honest
   * cheap proxy for ice-out.
   */
  thawC?: number;
  /** Consecutive all-thawed days before ingest stops. */
  thawRunDays?: number;
  /**
   * Consecutive nights at or below {@link GateOptions.freezeC} **at one sentinel** before that
   * sentinel opens the season (A06i §1). One — a single cold night — is the rule D149 shipped with;
   * a larger number asks a summit to stay cold rather than merely dip. A night with no reading breaks
   * the run, for the same reason a gap never counts as thaw: a missing series must not decide.
   */
  sentinelNights?: number;
}

/** One site's low on the night a rule fired, so a reader can see what was measured, not only that. */
export interface SiteLow {
  siteId: string;
  lowC: number;
}

/**
 * Each local day's low from an hourly `unixtime` series, oldest first.
 *
 * ⚠ **Not Open-Meteo's `daily=temperature_2m_min`.** Its day boundaries use the offset in force when
 * the request is made, for every day in the response (see {@link localStampAt}), so a 92-day window
 * fetched after a DST change cuts every day on the far side of it at the wrong midnight. The Convex
 * watcher and the CLI both go through here so the two cannot disagree about what a day is.
 *
 * Two kinds of partial day are dropped rather than reported, so the site abstains instead of voting
 * on part of one. The window's first day, unless the series starts at its local midnight: across a
 * DST change Open-Meteo's cut is an hour off, the same edge `weatherArchive.fetchLocalHourly` drops.
 * And any day with fewer than {@link COMPLETE_DAY_MIN_HOURS} readings, because a null reading is a
 * gap in the record, not a warm hour.
 */
export function dailyLowsFromHourly(
  timesSec: readonly unknown[],
  temps: readonly unknown[],
  timeZone: string | null,
  fallbackOffsetSeconds: number,
): DailyLow[] {
  const instants = timesSec.filter((t): t is number => typeof t === 'number');
  const first =
    instants.length === 0
      ? null
      : localStampAt(Math.min(...instants) * 1000, timeZone, fallbackOffsetSeconds);
  const truncatedDate = first !== null && first.localHour !== 0 ? first.localDate : null;

  const byDate = new Map<string, { min: number; hours: number }>();
  for (const [i, t] of timesSec.entries()) {
    const temp = temps[i];
    if (typeof t !== 'number' || typeof temp !== 'number') continue;
    const stamp = localStampAt(t * 1000, timeZone, fallbackOffsetSeconds);
    if (stamp === null || stamp.localDate === truncatedDate) continue;
    const day = byDate.get(stamp.localDate);
    if (day === undefined) byDate.set(stamp.localDate, { min: temp, hours: 1 });
    else {
      day.min = Math.min(day.min, temp);
      day.hours++;
    }
  }
  return [...byDate]
    .filter(([, d]) => d.hours >= COMPLETE_DAY_MIN_HOURS)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, d]) => ({ date, minTempC: d.min }));
}

/** One site's object in an Open-Meteo `hourly=temperature_2m&timeformat=unixtime&timezone=auto` answer. */
export interface OpenMeteoHourlyRow {
  /** The zone Open-Meteo resolved under `timezone=auto` — what makes a local day knowable. */
  timezone?: string;
  /** The offset at request time, not at any hour in the response; a fallback only. */
  utc_offset_seconds?: number;
  hourly?: { time?: (number | null)[]; temperature_2m?: (number | null)[] };
}

/**
 * A site's local-day lows from its Open-Meteo hourly row ({@link dailyLowsFromHourly}), cut by the
 * zone Open-Meteo resolved — or, without one, its request-time offset, or one from the longitude.
 * The daily tick and the history fill (forecast and archive alike) both read through here, so the
 * lows they store agree on where a day begins.
 */
export function dailyLowsFromOpenMeteo(
  row: OpenMeteoHourlyRow | undefined,
  lng: number,
): DailyLow[] {
  return dailyLowsFromHourly(
    row?.hourly?.time ?? [],
    row?.hourly?.temperature_2m ?? [],
    typeof row?.timezone === 'string' && row.timezone.length > 0 ? row.timezone : null,
    row?.utc_offset_seconds ?? approximateUtcOffsetSeconds(lng),
  );
}

export const DEFAULT_FREEZE_C = 0;
export const DEFAULT_CORPUS_FRACTION = 0.1;
export const DEFAULT_WINTER_FRACTION = 0.5;
export const DEFAULT_THAW_C = 0;
export const DEFAULT_THAW_RUN_DAYS = 10;
export const DEFAULT_SENTINEL_NIGHTS = 1;

export interface GateWindow {
  /** First date ingest should look, or `null` if the season has not opened in this data. */
  opensOn: string | null;
  /**
   * First date the region itself froze — a majority of ordinary sites, not one alpine pond.
   *
   * This is what closing is measured from, and it exists because **ice-out can only follow ice-in**.
   * `null` means winter never established in this data, which is also the honest answer to "when did
   * it thaw".
   */
  winterFrom: string | null;
  /** First date after winter established where ingest may stop, or `null` while ice is still likely. */
  closesOn: string | null;
  /** Why it opened — a sentinel freeze, a corpus-wide signal, or both on the same day. */
  openedBy: ('sentinel' | 'corpus')[];
  /**
   * What the opening night measured: every sentinel that fired, with its low on `opensOn`, and how
   * many ordinary sites froze out of how many reported. `null` while the season has not opened.
   *
   * Carried so the staff email can say *which* sentinel and *how cold* (A06i) rather than the bare
   * word `sentinel` — the first season-open email said only that, and nobody could tell what to tune.
   */
  opening: { sentinels: SiteLow[]; corpus: { frozen: number; reporting: number } } | null;
  /**
   * What the night winter established measured: the ordinary sites that froze, coldest first, out of
   * how many reported. `null` while winter has not established.
   */
  winter: { frozen: SiteLow[]; reporting: number } | null;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` shifted by whole days, in UTC — dates here are labels, not instants. */
export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Coldest first, then by id, so a table of them reads the same on every render. */
function byLow(a: SiteLow, b: SiteLow): number {
  return a.lowC === b.lowC ? a.siteId.localeCompare(b.siteId) : a.lowC - b.lowC;
}

/** Every distinct date across the sites, ascending. */
function allDates(sites: readonly SiteSeries[]): string[] {
  const seen = new Set<string>();
  for (const site of sites) for (const day of site.days) seen.add(day.date);
  return [...seen].sort();
}

/**
 * `siteId → date → low`, built once.
 *
 * The obvious shape is a `find` over `site.days` per date, which is a linear scan of a whole season
 * for every one of that season's days at every site — quadratic in the length of the window, three
 * times over, for a lookup that is a hash.
 */
type LowIndex = Map<string, Map<string, number>>;

function indexLows(sites: readonly SiteSeries[]): LowIndex {
  const out: LowIndex = new Map();
  for (const site of sites) {
    const byDate = out.get(site.siteId) ?? new Map<string, number>();
    for (const day of site.days) byDate.set(day.date, day.minTempC);
    out.set(site.siteId, byDate);
  }
  return out;
}

function lowsOn(sites: readonly SiteSeries[], date: string, index: LowIndex): Map<string, number> {
  const out = new Map<string, number>();
  for (const site of sites) {
    const low = index.get(site.siteId)?.get(date);
    if (low !== undefined) out.set(site.siteId, low);
  }
  return out;
}

/**
 * The window ingest should run over.
 *
 * ## Closing is deliberately reluctant
 *
 * Ten consecutive days where **every** ordinary site went without an overnight freeze. That is a much
 * stronger claim than "it thawed," and it is meant to be: closing early truncates the melt-out record,
 * which is half of what §3.5's window metrics are computed from. Closing a fortnight late costs a
 * handful of granule reads the cloud gate has probably already refused.
 *
 * Calibrated against real 2025-26 weather at five sites — the defaults put ice-out at **5 May 2026**,
 * against a typical Vermont ice-out of mid-April to early May. Reluctant by about two weeks, which is
 * the intended direction.
 *
 * A site with no reading on a day is **not** counted as thawed — the day does not count toward the
 * run at all, and the run resets. A missing series must not be able to end a season, which is the
 * same reasoning that makes the opening rule an OR, pointed the other way.
 *
 * ## ⚠ The sentinel opens a season but does not hold it open, and that asymmetry is load-bearing
 *
 * Measured against real 2025-26 weather: Lake of the Clouds first froze **2025-09-20**, five weeks
 * before Burlington — the sentinel doing exactly its job. But feeding it into the *closing* rule too
 * produced a window of **20 Sep → 26 Jun**: nine months, against §3.3's estimate of skipping roughly
 * half the year. At 1,531 m the tarn has sub-4 °C nights into late June, so "every site thawed" was
 * never true until the tarn said so.
 *
 * That is the Mt Washington problem arriving through the back door. Using one 1-acre alpine pond in
 * both directions makes it the single point of stall the OR rule exists to prevent — it would hold a
 * whole region's ingest open through a Vermont summer. So **closing consults the ordinary sites
 * only**, and the sentinel is what it was always meant to be: an early warning, not a veto.
 *
 * The asymmetry is not a fudge; it follows from §3.3. Weather decides when we *start looking*, and
 * being early there is cheap. Nothing about that argument says a summit should decide when to stop.
 */
export function ingestWindow(sites: readonly SiteSeries[], options: GateOptions = {}): GateWindow {
  const freezeC = options.freezeC ?? DEFAULT_FREEZE_C;
  const corpusFraction = options.corpusFraction ?? DEFAULT_CORPUS_FRACTION;
  const sentinelNights = Math.max(1, Math.floor(options.sentinelNights ?? DEFAULT_SENTINEL_NIGHTS));
  // `winterFraction` is read by `winterOnOrAfter`, `thawC` / `thawRunDays` by `thawClose`.

  const sentinels = sites.filter((s) => s.sentinel);
  const others = sites.filter((s) => !s.sentinel);
  const dates = allDates(sites);
  const index = indexLows(sites);

  /** Whether `siteId` was at or below freezing on `date` and each of the `nights − 1` nights before. */
  const coldRun = (siteId: string, date: string): boolean => {
    const byDate = index.get(siteId);
    for (let back = 0; back < sentinelNights; back++) {
      const low = byDate?.get(addDaysIso(date, -back));
      if (low === undefined || low > freezeC) return false;
    }
    return true;
  };

  let opensOn: string | null = null;
  const openedBy: GateWindow['openedBy'] = [];
  let opening: GateWindow['opening'] = null;

  for (const date of dates) {
    const lows = lowsOn(sites, date, index);

    const fired: SiteLow[] = sentinels
      .filter((s) => coldRun(s.siteId, date))
      .map((s) => ({ siteId: s.siteId, lowC: lows.get(s.siteId) as number }));

    // The corpus signal needs sites that actually reported. Dividing by the roster rather than by the
    // respondents would let a day of missing data read as "hardly anything froze".
    const reporting = others.filter((s) => lows.get(s.siteId) !== undefined);
    const frozen = reporting.filter((s) => (lows.get(s.siteId) as number) <= freezeC);
    const corpusFired = reporting.length > 0 && frozen.length / reporting.length >= corpusFraction;

    if (fired.length > 0 || corpusFired) {
      opensOn = date;
      if (fired.length > 0) openedBy.push('sentinel');
      if (corpusFired) openedBy.push('corpus');
      opening = {
        sentinels: fired.sort(byLow),
        corpus: { frozen: frozen.length, reporting: reporting.length },
      };
      break;
    }
  }

  if (opensOn === null) {
    return {
      opensOn: null,
      winterFrom: null,
      closesOn: null,
      openedBy: [],
      opening: null,
      winter: null,
    };
  }

  // ⚠ **Ice-out can only follow ice-in, and skipping this step loses whole winters.**
  //
  // Closing used to be "the first sustained thaw after opening", which is wrong the moment opening is
  // driven by a summit. Measured against real 2025-26 weather: the sentinel froze 20 September, the
  // valleys then had a warm week, and the gate closed the season on **27 September** — before a
  // single lake had frozen. A whole winter, skipped, with the logs reporting a tidy closed window.
  //
  // So closing is measured from the date the *region* froze: a majority of ordinary sites on one day.
  // Opening takes almost anything (10%) because being early is cheap; this takes a majority because
  // being wrong here throws away the season.
  const established = winterOnOrAfter(sites, opensOn, options);
  const winterFrom = established?.date ?? null;
  const winter: GateWindow['winter'] = established
    ? { frozen: established.frozen, reporting: established.reporting }
    : null;
  if (winterFrom === null) {
    return { opensOn, winterFrom: null, closesOn: null, openedBy, opening, winter: null };
  }

  return {
    opensOn,
    winterFrom,
    closesOn: thawClose(sites, winterFrom, options),
    openedBy,
    opening,
    winter,
  };
}

/**
 * The first night on or after `from` on which at least `winterFraction` of the **ordinary** sites
 * that reported were at or below freezing — winter established region-wide — with the sites that
 * froze, coldest first.
 *
 * Split out of {@link ingestWindow} for the live watch (A06i): a season already open under one set
 * of settings looks for winter from its *recorded* opening date, not from wherever a re-run of the
 * opening rule would land under today's settings — which, after a stricter edit, could be later or
 * nowhere, and winter would then never be found for a season that is plainly in it.
 */
export function winterOnOrAfter(
  sites: readonly SiteSeries[],
  from: string,
  options: GateOptions = {},
): { date: string; frozen: SiteLow[]; reporting: number } | null {
  const freezeC = options.freezeC ?? DEFAULT_FREEZE_C;
  const winterFraction = options.winterFraction ?? DEFAULT_WINTER_FRACTION;
  const others = sites.filter((s) => !s.sentinel);
  const index = indexLows(sites);
  for (const date of allDates(sites)) {
    if (date < from) continue;
    const lows = lowsOn(others, date, index);
    const frozen = [...lows]
      .filter(([, low]) => low <= freezeC)
      .map(([siteId, lowC]) => ({ siteId, lowC }));
    if (lows.size > 0 && frozen.length / lows.size >= winterFraction) {
      return { date, frozen: frozen.sort(byLow), reporting: lows.size };
    }
  }
  return null;
}

/**
 * The closing half on its own: the first date ending a run of {@link DEFAULT_THAW_RUN_DAYS}
 * consecutive days on which **every** ordinary site went without an overnight freeze.
 *
 * ⚠ **Split out of {@link ingestWindow} because a live gate cannot re-derive `winterFrom`.** The
 * daily checker fetches `past_days=92`, so by the April or May tick that would actually close a
 * season the December date the region froze is months outside the window — `ingestWindow` would
 * find no `winterFrom`, return `closesOn: null`, and the season would never close. The recorded
 * `winterFrom` is passed in instead, which is both correct and cheaper: it is already on the row.
 *
 * The date filter is a lower bound only, so a `winterFrom` that predates the series is a harmless
 * no-op rather than an error — which is exactly the live-checker case.
 */
export function thawClose(
  sites: readonly SiteSeries[],
  winterFrom: string,
  options: GateOptions = {},
): string | null {
  const thawC = options.thawC ?? DEFAULT_THAW_C;
  const thawRunDays = options.thawRunDays ?? DEFAULT_THAW_RUN_DAYS;
  const others = sites.filter((s) => !s.sentinel);
  const dates = allDates(sites);
  const index = indexLows(sites);

  // Ordinary sites only — see the asymmetry note above. Falls back to the full roster when the
  // corpus is all sentinel, so a single-site run still terminates rather than never closing.
  const closingSites = others.length > 0 ? others : sites;
  // ⚠ **Counted as distinct ids, because `lowsOn` returns a Map and a Map cannot hold a duplicate.**
  //
  // The completeness test below compares "how many sites reported" against "how many closing sites
  // there are", and those two are counted differently the moment two sites share a `siteId`: the Map
  // collapses them, the array does not. The comparison is then unsatisfiable on every single day and
  // the season **never closes** — silently, with ingest running through the summer.
  //
  // Not hypothetical: `ingestWindowCli` uses the body *name* as its `siteId`, and the corpus is full
  // of duplicate names (there are many "Mud Pond"s in Vermont alone), so any stride sample that
  // happens to draw two of them disables closing entirely. Convex's `gateSites` keys on `_id` and is
  // safe, which is exactly why this would only ever break on the operator's side.
  const closingSiteIds = new Set(closingSites.map((s) => s.siteId));

  let run = 0;
  for (const date of dates) {
    if (date <= winterFrom) continue;
    const lows = lowsOn(closingSites, date, index);
    const reporting = [...lows.values()];
    // ⚠ **Every closing site has to have reported, not just every site that happened to.**
    //
    // `reporting` holds only the sites with a reading that day, so testing `.every()` against it
    // alone silently treats a site that went dark as thawed — and `fetchLows` drops null readings
    // per site, which is precisely how a series goes dark. Four sites out of five dropping out for a
    // fortnight would then let the one warm survivor close the season, truncating the melt-out
    // record that §3.5's window metrics are computed from. A missing series must not be able to end a
    // season; the same reasoning that makes the opening rule an OR makes this an all-or-reset.
    const allThawed =
      reporting.length === closingSiteIds.size && reporting.every((low) => low > thawC);
    run = allThawed ? run + 1 : 0;
    if (run >= thawRunDays) return date;
  }
  return null;
}
