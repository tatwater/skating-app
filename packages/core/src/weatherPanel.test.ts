import { describe, expect, it } from 'vitest';
import { dayMsToLocalDate, monthDayLabel } from './weatherDay';
import {
  buildPastWeatherPanel,
  CALM_FREEZE_MAX_KPH,
  formatLocalHourLabel,
  type PanelDay,
  shortDayLabel,
} from './weatherPanel';

function dayMsOf(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** A complete stored day. Only the fields a test cares about need overriding. */
function day(localDate: string, over: Partial<NonNullable<PanelDay>> = {}): PanelDay {
  return {
    dayMs: dayMsOf(localDate),
    localDate,
    hours: 24,
    minTempC: -8,
    maxTempC: -2,
    meanTempC: -5,
    nightMinTempC: -10,
    hoursBelowFreezing: 24,
    hoursAboveFreezing: 0,
    freezingDegreeHours: 120,
    thawDegreeHours: 0,
    precipitationMm: 0,
    rainMm: 0,
    snowfallCm: 0,
    maxSnowDepthM: 0,
    hoursOfSun: 4,
    insolationWhM2: 500,
    maxWindKph: 10,
    maxWindGustKph: 18,
    windRunKm: 100,
    windSectorHours: [],
    freezingHoursMeanWindKph: 4,
    freezingHoursMaxWindKph: 9,
    ...over,
  };
}

/** A recorded gap — present in the window, carrying no measures. */
function gap(localDate: string): PanelDay {
  return { dayMs: dayMsOf(localDate), localDate };
}

describe('label formatting', () => {
  it('formats a weekday without letting a timezone shift it', () => {
    // 2026-01-15 is a Thursday in UTC. A local `new Date('2026-01-15')` west of Greenwich would
    // read Wednesday, on a date that is already the lake's own local date.
    expect(shortDayLabel('2026-01-15')).toBe('Thu 15');
    expect(monthDayLabel('2026-02-02')).toBe('Feb 2');
  });

  it('passes malformed dates through rather than inventing one', () => {
    expect(shortDayLabel('nope')).toBe('nope');
    expect(monthDayLabel('')).toBe('');
  });
});

/**
 * Every fixture here is January/February 2026, so a "today" in 2030 makes them all settled days.
 *
 * ⚠ The helper exists so the *interesting* argument stays visible. `todayLocalDayMs` is required on
 * the real function precisely because omitting it was the bug — but repeating a far-future constant
 * in forty call sites would bury the handful of tests where the value is the point.
 */
const ALL_SETTLED = Date.UTC(2030, 0, 1);
function panelOf(
  days: readonly PanelDay[],
  options: { todayLocalDayMs?: number; coarse?: boolean } = {},
) {
  return buildPastWeatherPanel(days, { todayLocalDayMs: ALL_SETTLED, ...options });
}

describe('buildPastWeatherPanel — rows', () => {
  it('converts to imperial and orders ascending', () => {
    const panel = panelOf([day('2026-01-16'), day('2026-01-15')]);
    expect(panel.rows.map((r) => r.localDate)).toEqual(['2026-01-15', '2026-01-16']);
    expect(panel.rows[0]?.highF).toBe(28); // -2°C
    expect(panel.rows[0]?.lowF).toBe(18); // -8°C
    expect(panel.rows[0]?.nightLowF).toBe(14); // -10°C
    expect(panel.rows[0]?.freezeWindMph).toBe(2); // 4 kph
    expect(panel.rows[0]?.missing).toBe(false);
  });

  it('marks a gap as missing with null measures, never as zero', () => {
    const panel = panelOf([day('2026-01-15'), gap('2026-01-16')]);
    const hole = panel.rows.find((r) => r.localDate === '2026-01-16');
    expect(hole?.missing).toBe(true);
    expect(hole?.highF).toBeNull();
    expect(hole?.snowfallIn).toBeNull();
    // ⚠ The distinction that matters: 0 would say "no snow fell", null says "we don't know".
    expect(hole?.snowfallIn).not.toBe(0);
    expect(panel.missingDays).toBe(1);
  });

  it('skips nulls in the input without shifting the rest', () => {
    const panel = panelOf([day('2026-01-15'), null, day('2026-01-17')]);
    expect(panel.rows).toHaveLength(2);
  });

  it('carries the coarse flag through for a borrowed row', () => {
    expect(panelOf([day('2026-01-15')], { coarse: true }).coarse).toBe(true);
  });
});

describe('buildPastWeatherPanel — headline', () => {
  it('says nothing at all when there is no data', () => {
    expect(panelOf([]).headline).toEqual([]);
    expect(panelOf([gap('2026-01-15')]).headline).toEqual([]);
  });

  it('leads with the cold chain, and names its anchor (D164)', () => {
    const panel = panelOf([
      day('2026-01-14', { nightMinTempC: -12 }),
      day('2026-01-15', { nightMinTempC: -12 }),
      day('2026-01-16', { nightMinTempC: -1 }),
    ]);
    // The chain's first night is the window's oldest day, so it may extend further back — the "+".
    // The mild 16th is inside the 48 h tolerance, so the chain is still alive. The action serves a
    // chain over a wider window than the panel draws; here the panel computes its own.
    expect(panel.headline[0]).toBe('2+ nights below 20°F, no snow since the first');
  });

  it('prints a chain that is bounded on both sides without the plus', () => {
    const panel = panelOf([
      day('2026-01-13', { nightMinTempC: -1 }),
      day('2026-01-14', { nightMinTempC: -12 }),
      day('2026-01-15', { nightMinTempC: -12 }),
      day('2026-01-16', { nightMinTempC: -12 }),
    ]);
    expect(panel.headline[0]).toBe('3 nights below 20°F, no snow since the first');
  });

  it('dates the end of a chain that has broken', () => {
    const panel = panelOf([
      day('2026-01-13', { nightMinTempC: -12 }),
      day('2026-01-14', { nightMinTempC: -12 }),
      day('2026-01-15', { nightMinTempC: -1 }),
      day('2026-01-16', { nightMinTempC: -1 }),
    ]);
    expect(panel.headline[0]).toBe('Run of 2+ nights below 20°F ended Jan 14');
  });

  it('states the absence of hard freezes rather than staying silent', () => {
    const panel = panelOf([
      day('2026-01-15', { nightMinTempC: -1 }),
      day('2026-01-16', { nightMinTempC: -2 }),
    ]);
    expect(panel.headline[0]).toContain('No nights below 20°F');
  });

  it('reports calm-while-freezing as an observation, not a conclusion', () => {
    const panel = panelOf([
      day('2026-01-15', { freezingHoursMeanWindKph: 3 }),
      day('2026-01-16', { freezingHoursMeanWindKph: 3 }),
    ]);
    const line = panel.headline.find((l) => l.includes('freezing'));
    expect(line).toContain('Calm while freezing');
    // ⚠ It must never say what the ice therefore is (D3 / D150).
    for (const l of panel.headline) {
      expect(l.toLowerCase()).not.toContain('black ice');
      expect(l.toLowerCase()).not.toContain('safe');
      expect(l.toLowerCase()).not.toContain('should');
    }
  });

  it('reports windy-while-freezing above the calm threshold', () => {
    const windy = CALM_FREEZE_MAX_KPH + 10;
    const panel = panelOf([day('2026-01-15', { freezingHoursMeanWindKph: windy })]);
    expect(panel.headline.find((l) => l.includes('freezing'))).toContain('Windy while freezing');
  });

  it('omits the freeze-wind line entirely when nothing froze', () => {
    const panel = panelOf([
      day('2026-01-15', {
        minTempC: 3,
        maxTempC: 8,
        hoursBelowFreezing: 0,
        hoursAboveFreezing: 24,
        nightMinTempC: 2,
        freezingHoursMeanWindKph: null,
      }),
    ]);
    expect(panel.headline.some((l) => l.includes('while freezing'))).toBe(false);
  });

  it('names the day snow last fell and totals it', () => {
    const panel = panelOf([
      day('2026-02-02', { snowfallCm: 7.6 }),
      day('2026-02-03'),
      day('2026-02-04'),
    ]);
    const line = panel.headline.find((l) => l.includes('last on'));
    expect(line).toContain('Feb 2');
    expect(line).toContain('3'); // 7.6 cm ≈ 3″
  });

  it('says there has been no snow when there has been none', () => {
    const panel = panelOf([day('2026-01-15'), day('2026-01-16')]);
    expect(panel.headline.some((l) => l === 'No snow in the last 2 days')).toBe(true);
  });

  it('ignores a dusting below the snow threshold', () => {
    const panel = panelOf([day('2026-01-15', { snowfallCm: 0.1 })]);
    expect(panel.headline.some((l) => l.startsWith('No snow'))).toBe(true);
  });

  it('names a rain day — the resurfacing input', () => {
    const panel = panelOf([
      day('2026-01-15', { rainMm: 6, maxTempC: 4, hoursAboveFreezing: 8, hoursBelowFreezing: 16 }),
      day('2026-01-16'),
    ]);
    expect(panel.headline.some((l) => l === 'Rain on Jan 15')).toBe(true);
  });

  it('counts days that crossed freezing', () => {
    const panel = panelOf([
      day('2026-01-15', { hoursBelowFreezing: 14, hoursAboveFreezing: 10 }),
      day('2026-01-16', { hoursBelowFreezing: 20, hoursAboveFreezing: 4 }),
      day('2026-01-17', { hoursBelowFreezing: 24, hoursAboveFreezing: 0 }),
    ]);
    expect(panel.headline.some((l) => l === '2 days crossing freezing')).toBe(true);
  });

  it('states missing days plainly rather than under-reporting a span', () => {
    const panel = panelOf([day('2026-01-15'), gap('2026-01-16'), gap('2026-01-17')]);
    // Five of seven days is not less snow, it is less knowledge — and the panel has to say so.
    expect(panel.headline.at(-1)).toBe('2 days of weather unavailable');
  });

  it('never publishes a degree-hour integral or a thickness', () => {
    // The integrals are model-internal by founder call, and one division from an ice-thickness
    // estimate that D160 confines to an operator surface.
    const panel = panelOf([
      day('2026-01-15', { freezingDegreeHours: 999 }),
      day('2026-01-16', { freezingDegreeHours: 999 }),
    ]);
    for (const line of panel.headline) {
      expect(line).not.toContain('999');
      expect(line.toLowerCase()).not.toContain('degree');
      expect(line).not.toMatch(/["″]/);
      expect(line.toLowerCase()).not.toContain('thick');
    }
  });

  it('handles a single day without pluralising wrongly', () => {
    const panel = panelOf([
      day('2026-01-14', { nightMinTempC: -1 }),
      day('2026-01-15', { nightMinTempC: -12 }),
    ]);
    expect(panel.headline[0]).toBe('1 night below 20°F, no snow since the first');
  });

  it('does not count a night it could not observe, and does not let it break the chain', () => {
    const panel = panelOf([
      day('2026-01-14', { nightMinTempC: -12 }),
      day('2026-01-15', { nightMinTempC: null }),
      day('2026-01-16', { nightMinTempC: -12 }),
    ]);
    // The unknown night consumes the 48 h tolerance rather than counting either way.
    expect(panel.headline[0]).toBe('2+ nights below 20°F, no snow since the first');
  });
});

describe('buildPastWeatherPanel — the two order traps', () => {
  it('does not claim the window total fell since the last snow day', () => {
    // 10 cm on the 1st and 1 cm on the 6th. "4.3″ of snow since Feb 6" would be a false sentence
    // built from two true numbers — 0.4″ fell after the 6th.
    const panel = panelOf([
      day('2026-02-01', { snowfallCm: 10 }),
      day('2026-02-06', { snowfallCm: 1 }),
    ]);
    const snowLine = panel.headline.find((l) => l.includes('last on'));
    expect(snowLine).toContain('last on Feb 6');
    expect(snowLine).not.toContain('since Feb 6');
  });

  it('names the latest rainy day even when the input arrives out of order', () => {
    const panel = panelOf([day('2026-02-05', { rainMm: 6 }), day('2026-02-02', { rainMm: 6 })]);
    expect(panel.headline).toContain('Rain on Feb 5');
  });
});

describe('buildPastWeatherPanel — a realistic week', () => {
  it('reads as a sequence of facts a skater can act on', () => {
    const base = dayMsOf('2026-02-01');
    const week: PanelDay[] = [
      // Rain, then a hard calm freeze, then a dump of snow, then quiet cold.
      day('2026-02-01', {
        rainMm: 8,
        maxTempC: 5,
        minTempC: 1,
        hoursAboveFreezing: 24,
        hoursBelowFreezing: 0,
        nightMinTempC: 1,
        freezingHoursMeanWindKph: null,
      }),
      day('2026-02-02', { nightMinTempC: -14, freezingHoursMeanWindKph: 2 }),
      day('2026-02-03', { nightMinTempC: -15, freezingHoursMeanWindKph: 3 }),
      day('2026-02-04', { nightMinTempC: -9, snowfallCm: 6, freezingHoursMeanWindKph: 4 }),
      day('2026-02-05', { nightMinTempC: -11, freezingHoursMeanWindKph: 3 }),
    ];
    const panel = panelOf(week);

    expect(panel.rows).toHaveLength(5);
    expect(panel.rows[0]?.dayMs).toBe(base);
    // Four in a row from the 2nd; the 4th's snow fell inside the chain, and the line says so.
    expect(panel.headline[0]).toBe('4 nights below 20°F, 2.4 in of snow since the first');
    expect(panel.headline).toContain('Rain on Feb 1');
    // "last on", never "since": the inches are the window total and Feb 4 is only the most recent
    // snow day, so "since Feb 4" would assert all of it fell after that date.
    expect(panel.headline.some((l) => l.includes('snow, last on Feb 4'))).toBe(true);
    expect(panel.headline.some((l) => l.startsWith('Calm while freezing'))).toBe(true);
  });
});

describe('formatLocalHourLabel — the local-shift trap (N6h hole 1)', () => {
  it('reads a local-shifted timestamp back with UTC getters', () => {
    // `HourlyWeather.startMs` is unix + utc_offset_seconds. This value encodes 8 PM local.
    const eightPmLocal = Date.UTC(2026, 0, 15, 20, 0);
    expect(formatLocalHourLabel(eightPmLocal)).toBe('8 PM');
  });

  it('does NOT double-apply the offset the way a local formatter would', () => {
    // The bug this exists to prevent: in US Eastern, `toLocaleTimeString` on an already-shifted value
    // slides 5 hours and still reads plausibly ("1 AM" for a storm that starts at 8 PM). The label
    // must depend only on the encoded wall clock, never on the machine running the test.
    const eightPmLocal = Date.UTC(2026, 0, 15, 20, 0);
    const label = formatLocalHourLabel(eightPmLocal);
    expect(label).toBe('8 PM');
    expect(label).not.toBe('1 AM');
    expect(label).not.toBe('3 PM');
  });

  it('formats midnight and noon without a zero or a 24', () => {
    expect(formatLocalHourLabel(Date.UTC(2026, 0, 15, 0, 0))).toBe('12 AM');
    expect(formatLocalHourLabel(Date.UTC(2026, 0, 15, 12, 0))).toBe('12 PM');
  });

  it('includes minutes only when they are not on the hour', () => {
    expect(formatLocalHourLabel(Date.UTC(2026, 0, 15, 9, 0))).toBe('9 AM');
    expect(formatLocalHourLabel(Date.UTC(2026, 0, 15, 9, 30))).toBe('9:30 AM');
    expect(formatLocalHourLabel(Date.UTC(2026, 0, 15, 13, 5))).toBe('1:05 PM');
  });

  it('returns an empty label rather than "Invalid Date" for a non-finite input', () => {
    expect(formatLocalHourLabel(Number.NaN)).toBe('');
    expect(formatLocalHourLabel(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('buildPastWeatherPanel — today has not finished happening', () => {
  /** Six settled days, then a three-hour "today" — the shape the archive actually stores. */
  function windowWithPartialToday(): PanelDay[] {
    const days: PanelDay[] = [];
    for (let i = 6; i >= 1; i--) {
      const dayMs = Date.UTC(2026, 1, 10 - i);
      days.push({
        dayMs,
        localDate: dayMsToLocalDate(dayMs),
        hours: 24,
        minTempC: -12,
        maxTempC: -6,
        snowfallCm: 0,
        rainMm: 0,
        hoursBelowFreezing: 24,
        hoursAboveFreezing: 0,
      });
    }
    days.push({
      dayMs: Date.UTC(2026, 1, 10),
      localDate: '2026-02-10',
      hours: 3, // 3 AM. Nothing has happened yet today.
      minTempC: -3,
      maxTempC: -2,
      snowfallCm: 0,
      rainMm: 0,
      hoursBelowFreezing: 3,
      hoursAboveFreezing: 0,
    });
    return days;
  }

  /** The fixture's last row is 2026-02-10, so that is the day still happening. */
  const TODAY = Date.UTC(2026, 1, 10);

  it('does not count an unfinished day as a settled one', () => {
    const panel = panelOf(windowWithPartialToday(), { todayLocalDayMs: TODAY });
    expect(panel.partialDays).toBe(1);
    expect(panel.rows).toHaveLength(7); // still drawn — what is happening now is what people want
    expect(panel.rows.at(-1)?.partial).toBe(true);
    expect(panel.rows.at(-1)?.missing).toBe(false); // a partial day is not a gap
    expect(panel.rows[0]?.partial).toBe(false);
  });

  it('says the last N days about N *finished* days, not N rows', () => {
    // ⚠ The bug: today's un-elapsed hours read as "it did not snow today", so a seven-day no-snow
    // claim covered six settled days and three hours. The count now matches what was actually
    // observed end to end.
    const panel = panelOf(windowWithPartialToday(), { todayLocalDayMs: TODAY });
    expect(panel.headline.some((l) => l.includes('No snow in the last 6 days'))).toBe(true);
    expect(panel.headline.some((l) => l.includes('last 7 days'))).toBe(false);
  });

  it('tells the reader that today was left out, rather than quietly shortening the window', () => {
    const panel = panelOf(windowWithPartialToday(), { todayLocalDayMs: TODAY });
    expect(panel.headline.some((l) => l.includes('still in progress'))).toBe(true);
  });

  it("does not let a partial day's snow or thaw enter an integral", () => {
    const days = windowWithPartialToday();
    // It is snowing hard right now, three hours in.
    days[6] = { ...(days[6] as NonNullable<PanelDay>), snowfallCm: 8, hoursAboveFreezing: 0 };
    const panel = panelOf(days, { todayLocalDayMs: TODAY });
    // The snow is visible on the strip...
    expect(panel.rows.at(-1)?.snowfallIn).toBeGreaterThan(0);
    // ...but the headline does not report a partial total as the window's settled total.
    expect(panel.headline.some((l) => l.includes('No snow in the last 6 days'))).toBe(true);
  });

  it('keeps a 23-hour DST day as a complete day', () => {
    // Spring-forward, and *yesterday* — so the hour count is the only thing that could call it
    // partial, and it must not.
    const days = windowWithPartialToday();
    days[6] = { ...(days[6] as NonNullable<PanelDay>), hours: 23 };
    const panel = panelOf(days, { todayLocalDayMs: Date.UTC(2026, 1, 11) });
    expect(panel.partialDays).toBe(0);
    expect(panel.headline.some((l) => l.includes('No snow in the last 7 days'))).toBe(true);
  });

  it('treats today as unfinished even holding a full 24 hours', () => {
    // ⚠ **The bug this whole argument exists for.** Open-Meteo returns whole calendar days and the
    // ingest trims nothing, so today's row carries 24 hours — the un-elapsed ones *forecast* — from
    // the morning's first fetch. Under the old hour-count test today was settled all day, and the
    // headline stated tonight's predicted low as an observed one.
    const days = windowWithPartialToday();
    days[6] = { ...(days[6] as NonNullable<PanelDay>), hours: 24, snowfallCm: 9 };
    const panel = panelOf(days, { todayLocalDayMs: TODAY });
    expect(panel.partialDays).toBe(1);
    expect(panel.rows.at(-1)?.partial).toBe(true);
    // Nine centimetres of *forecast* snow stays out of the settled total.
    expect(panel.headline.some((l) => l.includes('No snow in the last 6 days'))).toBe(true);
  });

  it('a future-dated row is never settled either', () => {
    // Tomorrow's forecast can reach the archive the same way today's does.
    const days = windowWithPartialToday();
    days[6] = {
      ...(days[6] as NonNullable<PanelDay>),
      dayMs: Date.UTC(2026, 1, 11),
      localDate: '2026-02-11',
      hours: 24,
    };
    expect(panelOf(days, { todayLocalDayMs: TODAY }).partialDays).toBe(1);
  });
});
