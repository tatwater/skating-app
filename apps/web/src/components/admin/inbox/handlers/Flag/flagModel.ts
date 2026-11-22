import {
  cToF,
  DEFAULT_REMOVAL_THRESHOLD,
  describeLocatedChip,
  describeSighting,
  describeSnow,
  formatThicknessReading,
  HAZARD_VERDICTS,
  type HazardVerdict,
  roundTo,
  SKATE_QUALITY_LABELS,
  SUITABILITY_LABELS,
  verdictLabel,
} from '@skating/core';

import { ageInWords, shortAge } from '@/lib/ages';
import { TRUST_WORDS } from '../../../people/person/personModel';
import { VANTAGE_WORDS } from '../../around/aroundModel';
import { countWords, dayMonth, ordinal, skateSpan, utcDayMonth } from './flagFormat';
import type {
  ClaimWeatherData,
  FlagItem,
  FlagMember,
  FlagTarget,
  HazardSubjectData,
  InboxCanData,
  LiveTarget,
  PersonLockupData,
  ReportClaimsData,
  ReportSubjectData,
} from './flagTypes';
import { REASON_HEAD, TARGET_WORDS, FLAG_WORDS as W } from './flagWords';

/**
 * **The flag handler, as data** — pure: the pane head, the claims as the report states them, the
 * weather cells, the flag lines, and which levers the bar draws. **`can` is the law** (D217): a verb
 * is drawn only when the item's `can` answers `null` for it; a sentence is the server's refusal and
 * the button is not drawn, and a verb the server didn't answer is not drawn either.
 */

// ── The verbs ──────────────────────────────────────────────────────────────────────────────────

/** The verbs a flag handler can draw. */
export type FlagVerb = 'dismiss' | 'hide' | 'remove' | 'restore' | 'pin' | 'unpin' | 'retract';

/** Whether `can` allows `verb`: only an explicit `null`. */
export const allows = (can: InboxCanData, verb: FlagVerb): boolean =>
  Object.hasOwn(can, verb) && can[verb] === null;

/** The content is already down (a flag filed before a takedown made elsewhere). */
export function isDown(target: FlagTarget): 'hidden' | 'removed' | null {
  if (!target.exists) return null;
  const s = target.moderationStatus;
  return s === 'hidden' || s === 'removed' ? s : null;
}

/** One group of the bar, before it meets the kit: its label and its verbs, in order. */
export type VerbGroup = { id: 'content' | 'flag'; label: string; verbs: FlagVerb[] };

/**
 * The bar's groups, from `can` and the target — the board's order: 2.1 *Flag* (Dismiss) then
 * *Report* (Hide, Remove); 2.6 *Alert* (Unpin, Retract) then *Flag* (Dismiss). Content already down
 * offers *Restore* in place of Hide and Remove; a person, a body or a gone target offers none. A
 * group with nothing drawn is left out, and so is the whole bar when nothing is.
 */
export function verbGroups(item: Pick<FlagItem, 'can' | 'target'>): VerbGroup[] {
  const { can, target } = item;
  const pick = (verbs: FlagVerb[]) => verbs.filter((v) => allows(can, v));
  const flag: VerbGroup = { id: 'flag', label: W.groupFlag, verbs: pick(['dismiss']) };
  let content: VerbGroup | null = null;
  if (target.exists) {
    const label = TARGET_WORDS[target.targetType];
    if (target.targetType === 'accessAlert') {
      content = { id: 'content', label, verbs: pick(['pin', 'unpin', 'retract']) };
    } else if (target.targetType !== 'user' && target.targetType !== 'waterbody') {
      content = {
        id: 'content',
        label,
        verbs: isDown(target) !== null ? pick(['restore']) : pick(['hide', 'remove']),
      };
    }
  }
  const alertFirst = target.exists && target.targetType === 'accessAlert';
  const groups = alertFirst ? [content, flag] : [flag, content];
  return groups.filter((g): g is VerbGroup => g !== null && g.verbs.length > 0);
}

/** Whether the viewer is shown any lever at all (no bar is drawn when not). */
export const hasAnyVerb = (item: Pick<FlagItem, 'can' | 'target'>): boolean =>
  verbGroups(item).length > 0;

// ── The pane head ──────────────────────────────────────────────────────────────────────────────

/** Where an item's history lives (D226): a report's in Reports (not built), a person's in People. */
export type HistoryLink =
  | { kind: 'reports' }
  | { kind: 'people'; userId: string }
  | { kind: 'body'; waterBodyId: string };

export type FlagHead = {
  /** The head's lit kicker: "Flagged as unsafe" (2.1), "Flag on an access alert" (2.6). */
  title: string;
  /** The Safety lane's red badge. */
  safety: boolean;
  /** The micro line: the age written out, a content flag's reason first ("Other · 6 hours ago"). */
  sub: string;
  link: HistoryLink | null;
};

/** The distinct reasons on the item, the oldest flag's first. */
export function reasonsOf(flags: readonly FlagMember[]): FlagMember['reason'][] {
  const sorted = flags.slice().sort((a, b) => a.filedAt - b.filedAt);
  return [...new Set(sorted.map((f) => f.reason))];
}

/** The page that holds the item's history, as its head links it. */
export function historyLinkOf(target: FlagTarget, author: FlagItem['author']): HistoryLink | null {
  if (!target.exists) {
    // Gone: a report's, Post's, comment's or hazard's history still lives in Reports; a person's in
    // People; a gone alert or body names no page the read can link.
    if (target.targetType === 'user')
      return author === null ? null : { kind: 'people', userId: author.person.userId };
    if (target.targetType === 'accessAlert' || target.targetType === 'waterbody') return null;
    return { kind: 'reports' };
  }
  switch (target.targetType) {
    case 'user':
      return { kind: 'people', userId: target.person.person.userId };
    case 'accessAlert':
      return { kind: 'body', waterBodyId: target.alert.body.waterBodyId };
    case 'waterbody':
      return { kind: 'body', waterBodyId: target.body.waterBodyId };
    default:
      return { kind: 'reports' };
  }
}

export function flagHead(
  item: Pick<FlagItem, 'lane' | 'target' | 'flags' | 'filedAt' | 'author'>,
  now: number,
): FlagHead {
  const safety = item.lane === 'safety';
  const age = ageInWords(item.filedAt, now);
  const reasons = reasonsOf(liveFlags(item.flags));
  const what = item.target.targetType;
  const title = safety && what !== 'user' ? W.flaggedAs : W.flagOn(W.flagOnWhat[what]);
  const reasonWords = reasons.map((r) => REASON_HEAD[r]).join(' · ');
  const sub = safety || reasonWords === '' ? age : `${reasonWords} · ${age}`;
  return { title, safety, sub, link: historyLinkOf(item.target, item.author) };
}

// ── The report's claims ────────────────────────────────────────────────────────────────────────

export type ClaimChip = { key: string; label: string; flagged: boolean };

/**
 * The claims as the report states them, in the board's order: thickness readings (its method
 * named), ice types, surface, sightings (the reader's words, with the place), how it skated and who
 * it is for, snow. Each in the skater's own vocabulary — nothing here grades a claim. In the Safety
 * lane a measured reading is the claim under question and is marked `flagged` (2.1's red chip).
 */
export function claimChips(claims: ReportClaimsData, safety: boolean): ClaimChip[] {
  const chips: ClaimChip[] = [];
  for (const [i, r] of (claims.iceThickness?.readings ?? []).entries()) {
    const words = formatThicknessReading(r);
    if (words === null) continue;
    chips.push({
      key: `t${i}`,
      label: words.replace(/ \(([^)]+)\)/, ' $1'),
      flagged: safety && r.method === 'measured',
    });
  }
  for (const [i, c] of claims.iceTypes.entries()) {
    chips.push({ key: `i${i}`, label: lower(describeLocatedChip(chipOf(c))), flagged: false });
  }
  for (const [i, c] of claims.surfaceTags.entries()) {
    chips.push({ key: `s${i}`, label: lower(describeLocatedChip(chipOf(c))), flagged: false });
  }
  for (const [i, c] of claims.sightings.entries()) {
    chips.push({ key: `w${i}`, label: lower(describeSighting(chipOf(c))), flagged: false });
  }
  const verdict = [
    claims.skateQuality === null ? null : SKATE_QUALITY_LABELS[claims.skateQuality],
    claims.suitability === null ? null : SUITABILITY_LABELS[claims.suitability],
  ].filter((x): x is string => x !== null);
  if (verdict.length > 0)
    chips.push({ key: 'q', label: verdict.map(lower).join(' · '), flagged: false });
  const snow = claims.snow === null ? null : describeSnow(claims.snow);
  if (snow !== null) chips.push({ key: 'n', label: lower(snow), flagged: false });
  return chips;
}

function chipOf<T extends string>(
  c: T | { type: T; where?: unknown },
): {
  type: T;
  where?: never;
} {
  // The stored chip, located or bare; its `where` passes through to core's words untouched.
  return (typeof c === 'string' ? { type: c } : c) as { type: T; where?: never };
}

/** A chip's label in the chip's case: lowercase, its first letter too. */
const lower = (s: string) => (s === '' ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** "Report · Enfield, NH · 10 Oct 15:40–17:05 · on the ice" — the subject's kicker (2.1). */
export function reportKicker(report: ReportSubjectData, timeZone?: string): string {
  return [
    W.reportKicker,
    report.place ?? report.body.place,
    skateSpan(report.skateStartTime, report.skateEndTime, timeZone),
    report.observedFrom === null ? null : VANTAGE_WORDS[report.observedFrom],
  ]
    .filter((x): x is string => x !== null && x !== '')
    .join(' · ');
}

/** *Also on this report*: thumbs up then down; down in amber only when it leads. */
export function thumbsOf(ratings: { up: number; down: number } | null) {
  if (ratings === null) return null;
  const words = W.thumbsLine(ratings.up, ratings.down);
  return { ...words, downLeads: ratings.down > ratings.up };
}

// ── That night, at the body ────────────────────────────────────────────────────────────────────

export type WeatherCell = {
  key: 'low' | 'nights' | 'fdd' | 'stefan';
  label: string;
  /** The figure, or `null` when the input is missing (then `missing` says what). */
  value: string | null;
  unit: string | null;
  missing: string | null;
  /** A line under the figure: how much of the season it covers, when it is short. */
  note?: string;
};

const DAY = 86_400_000;

const fahrenheit = (c: number) => String(roundTo(cToF(c)));

/**
 * The four cells of *That night, at the body* (2.1), in °F: the night's low, the freezing nights in
 * a row ending on the skate day, the freezing degree-days since 1 October, and the Stefan thickness
 * estimate (D288) — a model's figure, worded as one, or why it declined. Context beside the claim:
 * no cell compares itself with the claim, and a missing input says what is missing, never a guess.
 */
export function weatherCells(cw: ClaimWeatherData): WeatherCell[] {
  const nights = cw.freezingNights;
  const fddF = roundTo((cw.freezingDegreeDaysC.value * 9) / 5);
  const stefan = cw.stefan;
  return [
    {
      key: 'low',
      label: W.low(utcDayMonth(cw.dayMs)),
      value: cw.lowC === null ? null : fahrenheit(cw.lowC),
      unit: cw.lowC === null ? null : W.degF,
      missing: cw.lowC === null ? W.notRecorded : null,
    },
    // The skate night itself not recorded is a missing input, never "0 in a row".
    nights.run <= 0 && nights.gapAfter
      ? { key: 'nights', label: W.freezingNights, value: null, unit: null, missing: W.notRecorded }
      : {
          key: 'nights',
          label: W.freezingNights,
          value: String(Math.max(0, nights.run)),
          unit: nights.gapAfter ? W.thenAGap : W.inARow,
          missing: null,
        },
    degreeDaysCell(cw, fddF),
    'declined' in stefan
      ? {
          key: 'stefan',
          label: W.stefan,
          value: null,
          unit: null,
          missing: W.stefanDeclined[stefan.declined],
        }
      : {
          key: 'stefan',
          label: W.stefan,
          value: `${W.approx}${roundTo(stefan.thicknessIn, 1).toFixed(1)}`,
          unit: W.inches,
          missing: null,
        },
  ];
}

/**
 * The freezing degree-days since 1 October, in °F·days: no complete day recorded is a missing input
 * (never "0"); a season with days missing says how many days the sum covers, so a partial sum never
 * reads as the whole.
 */
function degreeDaysCell(cw: ClaimWeatherData, fddF: number): WeatherCell {
  const { days, since } = cw.freezingDegreeDaysC;
  if (days <= 0) {
    return { key: 'fdd', label: W.degreeDays, value: null, unit: null, missing: W.notRecorded };
  }
  const span = Math.max(1, Math.round((cw.dayMs - since) / DAY) + 1);
  const value = String(Math.max(0, fddF));
  return days < span
    ? {
        key: 'fdd',
        label: W.degreeDays,
        value,
        unit: W.degreeDaysUnitShort,
        missing: null,
        note: W.degreeDaysPartial(days, span),
      }
    : { key: 'fdd', label: W.degreeDays, value, unit: W.degreeDaysUnit, missing: null };
}

// ── A hazard's votes ───────────────────────────────────────────────────────────────────────────

/** One verdict as skaters cast it on this hazard: core's words for its type, and how many. */
export type VerdictRow = {
  verdict: HazardVerdict;
  /** Core's `verdictLabel(verdict, type)` — a passage marker relabels every verdict. */
  label: string;
  /** "2", or "2+" when the read stopped counting (every count is then a floor). */
  count: string;
  /** No vote for it (drawn quietly, never left out). */
  none: boolean;
};

/**
 * A hazard's votes, **every verdict in core's own order**, each with core's label for this hazard's
 * type — never folded into sides, never netted, never reordered by count, and a verdict no one cast
 * still drawn: a moderator ruling on "never existed" needs to see that nobody said it is still there
 * as plainly as that somebody did. `null` when no one has voted (then the pane says so in words).
 */
export function verdictRows(
  hazard: Pick<HazardSubjectData, 'type' | 'votes' | 'votesCapped'>,
): VerdictRow[] | null {
  const capped = hazard.votesCapped;
  const total = HAZARD_VERDICTS.reduce((n, v) => n + (hazard.votes[v] ?? 0), 0);
  if (total === 0 && !capped) return null;
  return HAZARD_VERDICTS.map((verdict) => {
    const n = Math.max(0, hazard.votes[verdict] ?? 0);
    return {
      verdict,
      label: verdictLabel(verdict, hazard.type),
      count: countWords({ count: n, capped }),
      none: n === 0 && !capped,
    };
  });
}

// ── The flags ──────────────────────────────────────────────────────────────────────────────────

/** "Trusted · 58 pts" — a flagger's standing; points beside the class (the byline's). */
export function standingMeta(person: PersonLockupData | null): string | null {
  if (person === null) return null;
  const cls = person.trustClass === null ? null : TRUST_WORDS[person.trustClass];
  const pts = `${person.points.toLocaleString('en-US')} pts`;
  return cls === null ? pts : `${cls} · ${pts}`;
}

/** What filed an app's flag: its rule's sentence, by reason and target. */
export function appRuleOf(
  reason: FlagMember['reason'],
  targetType: FlagTarget['targetType'],
  /** For the contradiction check: how many of their reports it counted, when the read says. */
  counted: { count: number; capped: boolean } | null = null,
  /** For the hazard vote's flag: the hazard's type, whose words name the verdict (core's). */
  hazardType?: HazardSubjectData['type'],
): string {
  if (reason === 'unsafe_false_report' && targetType === 'hazard')
    return W.appRule.hazardNeverExisted(
      DEFAULT_REMOVAL_THRESHOLD,
      verdictLabel('never_existed', hazardType ?? 'open_water'),
    );
  if (reason === 'unsafe_false_report' && targetType === 'user')
    return W.appRule.contradiction(counted === null ? null : countWords(counted));
  if (reason === 'auto_low_quality') return W.appRule.lowQuality;
  return W.appRule.other;
}

/** "4th occurrence · last dismissed 6 d ago" — an app flag's count; `null` for a first one. */
export function occurrenceLine(flag: FlagMember, now: number): string | null {
  const parts: string[] = [];
  if (flag.occurrences > 1) parts.push(W.occurrence(ordinal(flag.occurrences)));
  if (flag.prior !== null) {
    const verdict = W.priorVerdict[flag.prior.resolution];
    if (verdict !== undefined)
      parts.push(W.lastResolved(verdict, shortAge(now - flag.prior.resolvedAt)));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The flags an item's pane counts and acts on: its open ones. A closed member (closed by an earlier
 * decision) is no longer this item's question, so it is neither drawn, counted nor dismissed again;
 * a decided item, every member closed, shows them all as its record.
 */
export function liveFlags(flags: readonly FlagMember[]): FlagMember[] {
  const open = flags.filter((f) => f.status === 'open');
  return open.length > 0 ? open : flags.slice();
}

/** The open flags first, then the oldest first: the order the block reads them. */
export function flagsInOrder(flags: readonly FlagMember[]): FlagMember[] {
  return flags.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return a.filedAt - b.filedAt;
  });
}

// ── Small words ────────────────────────────────────────────────────────────────────────────────

/** A target's noun for a dialog title ("Hide this report?"). */
export function targetNoun(target: LiveTarget | FlagTarget): string {
  const noun = TARGET_WORDS[target.targetType];
  return noun === 'Post' ? noun : noun.toLowerCase();
}

/** What a receipt names: the body, or the person. */
export function subjectOf(item: Pick<FlagItem, 'target' | 'author'>): string {
  const t = item.target;
  if (t.exists) {
    switch (t.targetType) {
      case 'report':
        return t.report.body.name;
      case 'post':
        return t.post.reports[0]?.body.name ?? item.author?.person.displayName ?? '';
      case 'hazard':
        return t.hazard.body?.name ?? '';
      case 'accessAlert':
        return t.alert.body.name;
      case 'waterbody':
        return t.body.name;
      case 'user':
        return t.person.person.displayName;
      default:
        break;
    }
  }
  return item.author?.person.displayName ?? '';
}

/** "until 15 Oct" for a suspension's end. */
export const untilWords = (at: number, timeZone?: string) => W.until(dayMonth(at, timeZone));
