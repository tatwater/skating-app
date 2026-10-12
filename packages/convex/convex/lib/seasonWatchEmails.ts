/**
 * The season watch's four staff emails (A06i §4, D212), as settled with the founder on 2026-10-06.
 *
 * ⚠ **"Ice watch", never "season".** The first version announced *"Skating season winter-2026-27
 * has begun"* on a night two summits touched 32 °F and nobody was skating. Every subject here says
 * *Ice Watch*, and the opening email says in so many words that daily monitoring has begun — not
 * skating, and not ice (D3). The winter email says plainly that it measures air, not ice.
 *
 * Pure: everything a message reports arrives in its queued entry, so the copy is a function of what
 * was measured that night and of the settings that measured it.
 */

import { celsiusToFahrenheit, formatLow, type SeasonWatchSettings } from '@skating/core';
import type { Infer } from 'convex/values';

import type { EmailBlock } from './emailBlocks';
import type { namedSiteLow, seasonEmail } from './seasonWatchValidators';

export type SeasonEmail = Infer<typeof seasonEmail>;
type NamedSiteLow = Infer<typeof namedSiteLow>;

export interface ComposedEmail {
  subject: string;
  heading: string;
  blocks: EmailBlock[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The calendar day in New York — the day "one email a day" counts in (D212). */
export function newYorkDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** `2026-10-03` → `Saturday, October 3`. A label, so read in UTC — it names a night, not an instant. */
export function longDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `2026-10-03` → `October 3`. */
export function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `winter-2026-27` → `Winter 2026-27`. */
export function seasonTitle(season: string): string {
  return season.replace(/^winter-/, 'Winter ');
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** Words up to ten, digits after — the way the copy reads aloud. */
export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** `0.5` → `half`, otherwise a whole percent. */
export function shareWord(fraction: number): string {
  return fraction === 0.5 ? 'half' : `${Math.round(fraction * 100)}%`;
}

/** A temperature line as the founder reads it: `32°F`, one decimal only when it needs one. */
export function degreesF(c: number): string {
  const f = Math.round(celsiusToFahrenheit(c) * 10) / 10;
  return `${Number.isInteger(f) ? f.toFixed(0) : f.toFixed(1)}°F`.replace('-', '−');
}

function siteName(site: { name: string; state?: string | undefined }): string {
  return site.state ? `${site.name}, ${site.state}` : site.name;
}

function lowsTable(label: string, date: string, sites: readonly NamedSiteLow[]): EmailBlock {
  return {
    kind: 'table',
    columns: [label, `Low on ${shortDate(date)}`],
    rows: sites.map((s) => [siteName(s), formatLow(s.lowC)]),
  };
}

function nightsPhrase(nights: number): string {
  return nights === 1 ? 'one night' : `${countWord(nights)} nights in a row`;
}

export interface EmailContext {
  season: string;
  settings: SeasonWatchSettings;
  /** The sentinel names the watch reads, in roster order, for the rule sentence. */
  sentinelNames: readonly string[];
}

const SEASONS_PAGE = 'the **Seasons** page in /admin';

export function composeSeasonEmail(email: SeasonEmail, ctx: EmailContext): ComposedEmail {
  const title = seasonTitle(ctx.season);
  const { settings } = ctx;
  const freezing = degreesF(settings.freezeC);
  const nudge = degreesF(settings.imageryNudgeC);

  switch (email.kind) {
    case 'opened': {
      const blocks: EmailBlock[] = [];
      if (email.replaces) {
        blocks.push({
          kind: 'paragraph',
          // The notice went out on its New York day, so it is named by that day (D212's clock).
          text: `This replaces the notice from ${longDate(newYorkDate(email.replaces.detectedAt))}: the watch was reset, and has begun again under the current settings.`,
        });
      }
      const bySentinel = email.sentinels.length > 0;
      blocks.push({
        kind: 'paragraph',
        text: bySentinel
          ? `Daily monitoring has begun across the corpus because at least one sentinel had ${nightsPhrase(settings.sentinelNights)} at or below freezing.`
          : `Daily monitoring has begun across the corpus because ${email.corpus.frozen} of ${email.corpus.reporting} ordinary lakes had a night at or below freezing.`,
      });
      if (bySentinel) {
        blocks.push({ kind: 'heading', text: 'What set it off' });
        blocks.push(lowsTable('Sentinel', email.date, email.sentinels));
      }
      const roster = ctx.sentinelNames.length
        ? `any of the ${countWord(ctx.sentinelNames.length)} sentinel ponds (${ctx.sentinelNames.join(', ')})`
        : 'a sentinel pond';
      blocks.push({
        kind: 'paragraph',
        text:
          `The rule: ${nightsPhrase(settings.sentinelNights)} at or below ${freezing} at ${roster}, ` +
          `or at ${shareWord(settings.corpusFraction)} of the ${email.corpus.reporting} ordinary lakes we sample. ` +
          `That night, ${email.corpus.frozen} of ${email.corpus.reporting} ordinary lakes saw freezing temperatures.`,
      });
      blocks.push({ kind: 'heading', text: 'What changes now' });
      blocks.push({
        kind: 'list',
        items: [
          'The region-wide weather sweep runs daily',
          `Satellite imagery doesn't start until you start it. Press **Start imagery** on ${SEASONS_PAGE} to start it now, or wait until the first ${nudge} night (you'll get a reminder email when that happens)`,
        ],
      });
      blocks.push({ kind: 'heading', text: 'What to expect next' });
      blocks.push({
        kind: 'list',
        items: [
          `That reminder email when a sentinel sees a ${nudge} night`,
          `An email when winter sets in region-wide: ${settings.winterFraction === 0.5 ? 'half the' : `${shareWord(settings.winterFraction)} of the`} ordinary lakes freezing on the same night`,
          `An email when the watch ends: ${countWord(settings.thawRunDays)} nights in a row with no freeze at any ordinary lake`,
        ],
      });
      return {
        subject: `${title}: Ice Watch Has Begun`,
        heading: `Ice watch began on ${longDate(email.date)}`,
        blocks,
      };
    }

    case 'imagery':
      return {
        subject: `${title}: Time to Start Satellite Imagery`,
        heading: `First ${nudge} night: ${longDate(email.date)}`,
        blocks: [
          lowsTable('Sentinel', email.date, email.sites),
          {
            kind: 'paragraph',
            text: "It's time to start this season's satellite imagery. Running it late loses nothing, since the archive keeps every image, but the app won't show this season's imagery until it's run.",
          },
          {
            kind: 'paragraph',
            text: `Press **Start imagery** on ${SEASONS_PAGE}. From then on, Skating checks the satellite catalog every 6 hours and cuts each new image of our lakes, until the watch ends.`,
          },
        ],
      };

    case 'winter': {
      const share = email.reporting > 0 ? email.frozen.length / email.reporting : 0;
      const relation = share > settings.winterFraction ? 'above' : 'at';
      return {
        subject: `${title}: Winter Has Set In Region-Wide`,
        heading: `Winter set in region-wide on ${longDate(email.date)}`,
        blocks: [
          {
            kind: 'paragraph',
            text:
              `${email.frozen.length} of ${email.reporting} ordinary lakes had a night at or below ${freezing} on ${shortDate(email.date)}. ` +
              `This is ${relation} the threshold of ${shareWord(settings.winterFraction)}, and is a measure of the air temperature at those lakes, not actual ice formation.`,
          },
          lowsTable('Lake', email.date, email.frozen),
          {
            kind: 'paragraph',
            text: 'The watch keeps running until spring; its end is measured from this date.',
          },
        ],
      };
    }

    case 'closed': {
      const nights = countWord(settings.thawRunDays);
      return {
        subject: `${title}: Ice Watch Has Ended`,
        heading: `The ice watch ended on ${longDate(email.date)}`,
        blocks: [
          {
            kind: 'paragraph',
            text: `${nights[0]?.toUpperCase()}${nights.slice(1)} consecutive nights with no overnight freeze at any of the ${email.sitesSampled} sampled lakes — the reluctant ice-out proxy, which typically lands a couple of weeks after a real Vermont ice-out.`,
          },
          {
            kind: 'paragraph',
            text: "Satellite imagery and the corpus-wide weather sweep stand down until next season's watch begins.",
          },
          {
            kind: 'paragraph',
            text: 'This is a region-wide signal about monitoring, not a claim that any particular lake is unskateable.',
          },
        ],
      };
    }
  }
}

/** An admin-only alert from the live imagery job (founder, 2026-10-06: admins, not all staff). */
export function composeImageryAlert(
  season: string,
  problem: string,
  detail: string,
): ComposedEmail {
  return {
    subject: `${seasonTitle(season)}: Satellite Imagery Needs a Look`,
    heading: problem,
    blocks: [
      { kind: 'paragraph', text: detail },
      {
        kind: 'paragraph',
        text: `The run history is on ${SEASONS_PAGE}. Nothing else is retried until the next scheduled check, six hours from now.`,
      },
    ],
  };
}
