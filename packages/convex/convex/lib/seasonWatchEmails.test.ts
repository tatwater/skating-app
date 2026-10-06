import { DEFAULT_SEASON_WATCH_SETTINGS, fahrenheitToCelsius } from '@skating/core';
import { describe, expect, it } from 'vitest';

import {
  inlineHtml,
  inlineText,
  renderBlocksHtml,
  renderBlocksText,
  renderTableText,
} from './emailBlocks';
import {
  composeImageryAlert,
  composeSeasonEmail,
  countWord,
  degreesF,
  longDate,
  newYorkDate,
  seasonTitle,
  shareWord,
} from './seasonWatchEmails';

/**
 * The four emails as the founder settled them (2026-10-06), rendered to the plain-text part a mail
 * client shows — so a copy change is a visible diff here, not a surprise in an inbox.
 */

const ctx = {
  season: 'winter-2026-27',
  settings: DEFAULT_SEASON_WATCH_SETTINGS,
  sentinelNames: ['Upper Lake of the Clouds', 'Eagle Lake', 'Kinsman Pond'],
};

const text = (email: Parameters<typeof composeSeasonEmail>[0], c = ctx) => {
  const composed = composeSeasonEmail(email, c);
  return { ...composed, body: renderBlocksText(composed.blocks) };
};

describe('the season emails (D212)', () => {
  it('1 — the ice watch has begun, with the sentinels that fired as a table', () => {
    const email = text({
      kind: 'opened',
      date: '2026-10-03',
      sentinels: [
        { name: 'Upper Lake of the Clouds', state: 'NH', lowC: -0.4 },
        { name: 'Eagle Lake', state: 'NH', lowC: 0 },
      ],
      corpus: { frozen: 0, reporting: 25 },
    });
    expect(email.subject).toBe('Winter 2026-27: Ice Watch Has Begun');
    expect(email.heading).toBe('Ice watch began on Saturday, October 3');
    expect(email.body).toBe(
      [
        'Daily monitoring has begun across the corpus because at least one sentinel had one night at or below freezing.',
        'What set it off',
        [
          'Sentinel                      Low on October 3',
          'Upper Lake of the Clouds, NH  31.3°F (−0.4°C)',
          'Eagle Lake, NH                32.0°F (0.0°C)',
        ].join('\n'),
        'The rule: one night at or below 32°F at any of the three sentinel ponds (Upper Lake of the Clouds, Eagle Lake, Kinsman Pond), or at 10% of the 25 ordinary lakes we sample. That night, 0 of 25 ordinary lakes saw freezing temperatures.',
        'What changes now',
        [
          '- The region-wide weather sweep runs daily',
          "- Satellite imagery doesn't start until you start it. Press Start imagery on the Seasons page in /admin to start it now, or wait until the first 20°F night (you'll get a reminder email when that happens)",
        ].join('\n'),
        'What to expect next',
        [
          '- That reminder email when a sentinel sees a 20°F night',
          '- An email when winter sets in region-wide: half the ordinary lakes freezing on the same night',
          '- An email when the watch ends: ten nights in a row with no freeze at any ordinary lake',
        ].join('\n'),
      ].join('\n\n'),
    );
  });

  it('1 — opened by the ordinary lakes, under edited settings, after a reset', () => {
    const email = text(
      {
        kind: 'opened',
        date: '2026-11-04',
        sentinels: [],
        corpus: { frozen: 4, reporting: 25 },
        replaces: { opensOn: '2026-10-03', detectedAt: Date.parse('2026-10-04T20:46:00Z') },
      },
      {
        ...ctx,
        sentinelNames: [],
        settings: {
          ...DEFAULT_SEASON_WATCH_SETTINGS,
          sentinelNights: 3,
          winterFraction: 0.6,
          thawRunDays: 14,
        },
      },
    );
    expect(email.body).toContain('This replaces the notice from Sunday, October 4');
    expect(email.body).toContain(
      'because 4 of 25 ordinary lakes had a night at or below freezing.',
    );
    expect(email.body).not.toContain('What set it off');
    expect(email.body).toContain(
      'The rule: three nights in a row at or below 32°F at a sentinel pond',
    );
    expect(email.body).toContain('60% of the ordinary lakes freezing on the same night');
    expect(email.body).toContain('14 nights in a row');
  });

  it('2 — time to start satellite imagery', () => {
    const email = text({
      kind: 'imagery',
      date: '2026-10-06',
      sites: [{ name: 'Upper Lake of the Clouds', state: 'NH', lowC: -7.1 }],
    });
    expect(email.subject).toBe('Winter 2026-27: Time to Start Satellite Imagery');
    expect(email.heading).toBe('First 20°F night: Tuesday, October 6');
    expect(email.body).toBe(
      [
        [
          'Sentinel                      Low on October 6',
          'Upper Lake of the Clouds, NH  19.2°F (−7.1°C)',
        ].join('\n'),
        "It's time to start this season's satellite imagery. Running it late loses nothing, since the archive keeps every image, but the app won't show this season's imagery until it's run.",
        'Press Start imagery on the Seasons page in /admin. From then on, Skating checks the satellite catalog every 6 hours and cuts each new image of our lakes, until the watch ends.',
      ].join('\n\n'),
    );
  });

  it('3 — winter has set in region-wide, and says it measures air, not ice', () => {
    const email = text({
      kind: 'winter',
      date: '2026-10-19',
      frozen: [
        { name: 'Umbagog Lake', state: 'ME', lowC: -3.1 },
        { name: 'Flagstaff Lake', state: 'ME', lowC: -2.7 },
      ],
      reporting: 3,
    });
    expect(email.subject).toBe('Winter 2026-27: Winter Has Set In Region-Wide');
    expect(email.heading).toBe('Winter set in region-wide on Monday, October 19');
    expect(email.body).toContain(
      '2 of 3 ordinary lakes had a night at or below 32°F on October 19. This is above the threshold of half, and is a measure of the air temperature at those lakes, not actual ice formation.',
    );
    expect(email.body).toContain(
      'Lake                Low on October 19\nUmbagog Lake, ME    26.4°F (−3.1°C)',
    );
    expect(email.body).toContain(
      'The watch keeps running until spring; its end is measured from this date.',
    );
    // Exactly at the threshold says "at", not "above".
    const at = text({
      kind: 'winter',
      date: '2026-10-19',
      frozen: [{ name: 'A', lowC: -1 }],
      reporting: 2,
    });
    expect(at.body).toContain('This is at the threshold of half');
    const none = text({ kind: 'winter', date: '2026-10-19', frozen: [], reporting: 0 });
    expect(none.body).toContain('0 of 0');
  });

  it('4 — the ice watch has ended', () => {
    const email = text({ kind: 'closed', date: '2027-05-05', sitesSampled: 25 });
    expect(email.subject).toBe('Winter 2026-27: Ice Watch Has Ended');
    expect(email.heading).toBe('The ice watch ended on Wednesday, May 5');
    expect(email.body).toContain(
      'Ten consecutive nights with no overnight freeze at any of the 25 sampled lakes',
    );
    expect(email.body).toContain('not a claim that any particular lake is unskateable');
  });

  it('an admin alert from the imagery job', () => {
    const alert = composeImageryAlert(
      'winter-2026-27',
      'Satellite imagery is not configured',
      'Missing FLY_IMAGE.',
    );
    expect(alert.subject).toBe('Winter 2026-27: Satellite Imagery Needs a Look');
    expect(renderBlocksText(alert.blocks)).toContain('Missing FLY_IMAGE.');
  });

  it('never says skateable, safe or ice in a way that claims any (D3)', () => {
    const all = [
      text({
        kind: 'opened',
        date: '2026-10-03',
        sentinels: [{ name: 'A', lowC: -1 }],
        corpus: { frozen: 0, reporting: 1 },
      }),
      text({ kind: 'imagery', date: '2026-10-06', sites: [] }),
      text({ kind: 'winter', date: '2026-10-19', frozen: [], reporting: 1 }),
      text({ kind: 'closed', date: '2027-05-05', sitesSampled: 1 }),
    ]
      .map((e) => `${e.subject} ${e.heading} ${e.body}`)
      .join(' ');
    expect(all).not.toMatch(/\bsafe\b|good to go|skating season has begun/i);
    expect(all).not.toMatch(/\bskateable\b/i);
  });
});

describe('formatting helpers', () => {
  it.each([
    [0, '32°F'],
    [fahrenheitToCelsius(20), '20°F'],
    [-20, '−4°F'],
    [-0.5, '31.1°F'],
  ])('%d °C as a line reads %s', (c, f) => {
    expect(degreesF(c)).toBe(f);
  });

  it('words, shares, titles and dates', () => {
    expect(countWord(3)).toBe('three');
    expect(countWord(14)).toBe('14');
    expect(shareWord(0.5)).toBe('half');
    expect(shareWord(0.1)).toBe('10%');
    expect(seasonTitle('winter-2026-27')).toBe('Winter 2026-27');
    expect(longDate('2027-01-01')).toBe('Friday, January 1');
    // 1am UTC on 5 October is still the 4th in New York.
    expect(newYorkDate(Date.parse('2026-10-05T01:00:00Z'))).toBe('2026-10-04');
  });
});

describe('emailBlocks', () => {
  it('escapes before marking up, so a mark cannot inject', () => {
    expect(inlineHtml('**<b>** and `a<b`')).toBe(
      '<strong>&lt;b&gt;</strong> and <code style="font-family:ui-monospace,monospace">a&lt;b</code>',
    );
    expect(inlineText('Press **Start**')).toBe('Press Start');
  });

  it('renders every block kind to HTML', () => {
    const html = renderBlocksHtml([
      { kind: 'heading', text: 'H' },
      { kind: 'paragraph', text: 'P' },
      { kind: 'list', items: ['a', 'b'] },
      { kind: 'table', columns: ['Name', 'Low'], rows: [['Clouds', '31°F']] },
    ]);
    expect(html).toContain('<h3');
    expect(html).toContain('<p style="margin:0 0 8px">P</p>');
    expect(html).toContain('<li style="margin:0 0 4px">b</li>');
    expect(html).toContain('<th style=');
    expect(html).toContain('>Clouds</td>');
  });

  it('pads text columns to the widest cell, and never pads the last', () => {
    expect(
      renderTableText(
        ['A', 'B'],
        [
          ['long name', 'x'],
          ['s', 'yy'],
        ],
      ),
    ).toBe('A          B\nlong name  x\ns          yy');
    expect(renderTableText(['A', 'B'], [['x']])).toBe('A  B\nx');
  });
});
