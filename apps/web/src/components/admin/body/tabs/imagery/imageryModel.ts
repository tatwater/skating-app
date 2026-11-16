import {
  frameSourceLabel,
  MIN_BODY_CLEAR_FRACTION,
  MIN_BODY_COVERAGE,
  SATELLITE_MIN_AREA_SQM,
  type SatelliteImageryMode,
  stopCaveat,
  type TimelineStop,
} from '@skating/core';

/**
 * Body › Imagery's arithmetic: one row per satellite pass over the body this winter, how it fared
 * at the two gates that decide whether skaters land on it, and who sees it. Pure.
 *
 * **A pass is what a satellite saw, never what the ice will hold.** Nothing here reads the
 * picture; the gates are cloud and coverage, and a pass that clears both is *shown*, not *good*.
 */

/** The gates, as percentages (core's `MIN_BODY_CLEAR_FRACTION` and `MIN_BODY_COVERAGE`). */
export const CLEAR_GATE_PCT = Math.round(MIN_BODY_CLEAR_FRACTION * 100);
export const COVERAGE_GATE_PCT = Math.round(MIN_BODY_COVERAGE * 100);

/** A staff call on one pass (the clouded-pass override): show a hidden pass, or hide a shown one. */
export type PassOverride = { verdict: 'show' | 'hide'; by: string; at: number };

/**
 * Who sees a pass. `shown-anyway` and `hidden-by-staff` are a person's call over the gates;
 * `hidden` is the gates' own.
 */
export type PassSeen = 'shown' | 'shown-anyway' | 'hidden' | 'hidden-by-staff';

/**
 * A pass as the tab keeps it, from the imagery archive's season index and each frame's manifest.
 * Every measured figure is kept (cloud, clear, coverage, the gate that hid it, the caveat); a
 * frame's `bodies` count is the season's (how many bodies a granule crossed), not this body's, and
 * is deliberately not shown.
 */
export type PassRow = {
  /** The granule: the pass's id. */
  id: string;
  capturedAt: string;
  /** The picture's object key in the imagery archive. */
  key: string;
  /** "13 Oct". */
  day: string;
  /** "Tue". */
  weekday: string;
  /** "13 Oct 2026" — the dock's caption date. */
  date: string;
  band: string;
  /** "Sentinel-2 true color". */
  source: string;
  /** Percent of the lake under cloud; `null` when no manifest measured it. */
  cloudPct: number | null;
  /** Percent of the lake clear of cloud — the gate's own figure. */
  clearPct: number | null;
  /** Percent of the lake the pass reached. */
  coveragePct: number | null;
  /** Which gate hid it, when one did. */
  blockedBy: 'cloud' | 'coverage' | null;
  seen: PassSeen;
  override: PassOverride | null;
  /** What was in the way, as core captions it, or `null`. */
  caveat: string | null;
};

const pct = (fraction: number) => Math.round(fraction * 100);

/*
 * A pass's day is its UTC day, as the archive files it (a pass over New England is mid-morning,
 * the same day locally). Written day-first, the console's way ("13 Oct 2026") — core's
 * `frameDateLabel` documents that form but its en-US format writes "Oct 13, 2026".
 */
const PASS_DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `{ day: '13 Oct', weekday: 'Tue', date: '13 Oct 2026' }`; an unreadable instant says so. */
export function passDay(capturedAt: string): { day: string; weekday: string; date: string } {
  const at = Date.parse(capturedAt);
  if (Number.isNaN(at)) return { day: 'Unknown date', weekday: '', date: 'Unknown date' };
  const parts = PASS_DAY.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = `${get('day')} ${get('month')}`;
  return { day, weekday: get('weekday'), date: `${day} ${get('year')}` };
}

/** Who sees a pass: the gates, then a person's call over them. */
export function passSeen(landable: boolean, override: PassOverride | null): PassSeen {
  if (landable) return override?.verdict === 'hide' ? 'hidden-by-staff' : 'shown';
  return override?.verdict === 'show' ? 'shown-anyway' : 'hidden';
}

/** Is the pass in front of skaters? */
export const isShown = (seen: PassSeen) => seen === 'shown' || seen === 'shown-anyway';

/** Oldest first, as the timeline's stops are (the dock's left to right). */
export function passRows(
  stops: readonly TimelineStop[],
  overrides: Readonly<Record<string, PassOverride>> = {},
): PassRow[] {
  return stops.map((stop) => {
    const id = stop.frame.granuleId;
    const override = overrides[id] ?? null;
    const clear = stop.stats?.clearPct ?? null;
    const coverage = stop.stats?.coveragePct ?? null;
    return {
      id,
      capturedAt: stop.frame.capturedAt,
      key: stop.frame.key,
      ...passDay(stop.frame.capturedAt),
      band: stop.frame.band,
      source: frameSourceLabel(stop.frame.band),
      cloudPct: clear === null ? null : 100 - pct(clear),
      clearPct: clear === null ? null : pct(clear),
      coveragePct: coverage === null ? null : pct(coverage),
      blockedBy: stop.blockedBy ?? null,
      seen: passSeen(stop.landable, override),
      override,
      caveat: stopCaveat(stop),
    };
  });
}

/**
 * The pass the tab opens on when nothing is lit: the newest one shown to skaters — the one the
 * app's own stepper opens on — or, when none is, the newest pass.
 */
export function defaultPass(rows: readonly PassRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isShown((rows[i] as PassRow).seen)) return i;
  }
  return rows.length - 1;
}

/** The lit pass's index, or the default when the lit id is absent or unknown. */
export function selectedPass(rows: readonly PassRow[], lit: string | null): number {
  const i = lit === null ? -1 : rows.findIndex((r) => r.id === lit);
  return i >= 0 ? i : defaultPass(rows);
}

/** "shown to skaters" — the dock's second line, after the caveat. */
export function seenWords(seen: PassSeen): string {
  switch (seen) {
    case 'shown':
      return 'shown to skaters';
    case 'shown-anyway':
      return 'shown anyway';
    case 'hidden':
      return 'hidden from skaters';
    case 'hidden-by-staff':
      return 'hidden by staff';
  }
}

/** "7 · 3 hidden" — the passes section's count. */
export function passCount(rows: readonly PassRow[]): { total: number; hidden: number } {
  return { total: rows.length, hidden: rows.filter((r) => !isShown(r.seen)).length };
}

/** "Winter 2026–27" from the archive's `winter-2026-27`; anything else as it came. */
export function winterWord(season: string): string {
  const m = /^winter-(\d{4})-(\d{2})$/.exec(season);
  return m ? `Winter ${m[1]}–${m[2]}` : season;
}

/** The dock's band switch: what each band is called on the button. */
export const BAND_WORD: Readonly<Record<string, string>> = {
  visual: 'True color',
  scl: 'Classified',
  vh: 'Radar',
};

/** The satellite link's assist line: the rule, and where this body falls under it. */
export function satelliteAssist(
  name: string | undefined,
  areaSqM: number | undefined,
  mode: SatelliteImageryMode,
): string {
  const floor = `Auto offers it at ${SATELLITE_MIN_AREA_SQM / 10_000} ha and up`;
  const who = name?.replace(/ (Lake|Pond|Reservoir)$/, '') ?? 'this body';
  const area =
    areaSqM === undefined
      ? `${who} has no stored area, so auto offers it`
      : `${who} is ${formatHa(areaSqM / 10_000)} ha`;
  const override =
    mode === 'on' ? ' Always offered, whatever the area.' : mode === 'off' ? ' Never offered.' : '';
  return `${floor}; ${area}.${override}`;
}

function formatHa(ha: number): string {
  return ha >= 10 ? Math.round(ha).toLocaleString('en-US') : ha.toFixed(1);
}

// ── The lit address ─────────────────────────────────────────────────────────────────────────────

/** The bands a lit address may name (the archive's). */
const BAND_ID = /^[a-z0-9]{1,16}$/;
/** What `?lit=` may carry after its colon (the frame's rule). */
const LIT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The lit pass as `?lit=` carries it: `pass:<band>` (that band's default pass) or
 * `pass:<band>.<granuleId>` — the band rides with the pass, so the dock's band switch and the
 * inspector's rows can't disagree. `null` for a granule id the URL can't hold.
 */
export function passAddress(band: string, granuleId?: string | null): string | null {
  const id = granuleId == null ? band : `${band}.${granuleId}`;
  return BAND_ID.test(band) && LIT_ID.test(id) ? `pass:${id}` : null;
}

/** The band and pass a lit address names; anything not a pass address is the default band. */
export function parsePassAddress(lit: string | null | undefined): {
  band: string;
  granuleId: string | null;
} {
  const m = lit == null ? null : /^pass:([a-z0-9]{1,16})(?:\.(.+))?$/.exec(lit);
  if (m === null) return { band: 'visual', granuleId: null };
  return { band: m[1] as string, granuleId: m[2] ?? null };
}
