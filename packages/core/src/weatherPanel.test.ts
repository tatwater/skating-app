import { describe, expect, it } from 'vitest';
import {
  buildPastWeatherPanel,
  CALM_FREEZE_MAX_KPH,
  formatLocalHourLabel,
  monthDayLabel,
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

describe('buildPastWeatherPanel — rows', () => {
  it('converts to imperial and orders ascending', () => {
    const panel = buildPastWeatherPanel([day('2026-01-16'), day('2026-01-15')]);
    expect(panel.rows.map((r) => r.localDate)).toEqual(['2026-01-15', '2026-01-16']);
    expect(panel.rows[0]?.highF).toBe(28); // -2°C
    expect(panel.rows[0]?.lowF).toBe(18); // -8°C
    expect(panel.rows[0]?.nightLowF).toBe(14); // -10°C
    expect(panel.rows[0]?.freezeWindMph).toBe(2); // 4 kph
    expect(panel.rows[0]?.missing).toBe(false);
  });

  it('marks a gap as missing with null measures, never as zero', () => {
    const panel = buildPastWeatherPanel([day('2026-01-15'), gap('2026-01-16')]);
    const hole = panel.rows.find((r) => r.localDate === '2026-01-16');
    expect(hole?.missing).toBe(true);
    expect(hole?.highF).toBeNull();
    expect(hole?.snowfallIn).toBeNull();
    // ⚠ The distinction that matters: 0 would say "no snow fell", null says "we don't know".
    expect(hole?.snowfallIn).not.toBe(0);
    expect(panel.missingDays).toBe(1);
  });

  it('skips nulls in the input without shifting the rest', () => {
    const panel = buildPastWeatherPanel([day('2026-01-15'), null, day('2026-01-17')]);
    expect(panel.rows).toHaveLength(2);
  });

  it('carries the coarse flag through for a borrowed row', () => {
    expect(buildPastWeatherPanel([day('2026-01-15')], { coarse: true }).coarse).toBe(true);
  });
});

describe('buildPastWeatherPanel — headline', () => {
  it('says nothing at all when there is no data', () => {
    expect(buildPastWeatherPanel([]).headline).toEqual([]);
    expect(buildPastWeatherPanel([gap('2026-01-15')]).headline).toEqual([]);
  });

  it('leads with the count of hard-freeze nights', () => {
    const panel = buildPastWeatherPanel([
      day('2026-01-14', { nightMinTempC: -12 }),
      day('2026-01-15', { nightMinTempC: -12 }),
      day('2026-01-16', { nightMinTempC: -1 }),
    ]);
    expect(panel.headline[0]).toBe('2 nights below 20°F');
  });

  it('states the absence of hard freezes rather than staying silent', () => {
    const panel = buildPastWeatherPanel([
      day('2026-01-15', { nightMinTempC: -1 }),
      day('2026-01-16', { nightMinTempC: -2 }),
    ]);
    expect(panel.headline[0]).toContain('No nights below 20°F');
  });

  it('reports calm-while-freezing as an observation, not a conclusion', () => {
    const panel = buildPastWeatherPanel([
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
    const panel = buildPastWeatherPanel([day('2026-01-15', { freezingHoursMeanWindKph: windy })]);
    expect(panel.headline.find((l) => l.includes('freezing'))).toContain('Windy while freezing');
  });

  it('omits the freeze-wind line entirely when nothing froze', () => {
    const panel = buildPastWeatherPanel([
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
    const panel = buildPastWeatherPanel([
      day('2026-02-02', { snowfallCm: 7.6 }),
      day('2026-02-03'),
      day('2026-02-04'),
    ]);
    const line = panel.headline.find((l) => l.includes('snow'));
    expect(line).toContain('Feb 2');
    expect(line).toContain('3'); // 7.6 cm ≈ 3″
  });

  it('says there has been no snow when there has been none', () => {
    const panel = buildPastWeatherPanel([day('2026-01-15'), day('2026-01-16')]);
    expect(panel.headline.some((l) => l === 'No snow in the last 2 days')).toBe(true);
  });

  it('ignores a dusting below the snow threshold', () => {
    const panel = buildPastWeatherPanel([day('2026-01-15', { snowfallCm: 0.1 })]);
    expect(panel.headline.some((l) => l.startsWith('No snow'))).toBe(true);
  });

  it('names a rain day — the resurfacing input', () => {
    const panel = buildPastWeatherPanel([
      day('2026-01-15', { rainMm: 6, maxTempC: 4, hoursAboveFreezing: 8, hoursBelowFreezing: 16 }),
      day('2026-01-16'),
    ]);
    expect(panel.headline.some((l) => l === 'Rain on Jan 15')).toBe(true);
  });

  it('counts days that crossed freezing', () => {
    const panel = buildPastWeatherPanel([
      day('2026-01-15', { hoursBelowFreezing: 14, hoursAboveFreezing: 10 }),
      day('2026-01-16', { hoursBelowFreezing: 20, hoursAboveFreezing: 4 }),
      day('2026-01-17', { hoursBelowFreezing: 24, hoursAboveFreezing: 0 }),
    ]);
    expect(panel.headline.some((l) => l === '2 days crossing freezing')).toBe(true);
  });

  it('states missing days plainly rather than under-reporting a span', () => {
    const panel = buildPastWeatherPanel([day('2026-01-15'), gap('2026-01-16'), gap('2026-01-17')]);
    // Five of seven days is not less snow, it is less knowledge — and the panel has to say so.
    expect(panel.headline.at(-1)).toBe('2 days of weather unavailable');
  });

  it('never publishes a degree-hour integral or a thickness', () => {
    // The integrals are model-internal by founder call, and one division from an ice-thickness
    // estimate that D160 confines to an operator surface.
    const panel = buildPastWeatherPanel([
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
    const panel = buildPastWeatherPanel([day('2026-01-15', { nightMinTempC: -12 })]);
    expect(panel.headline[0]).toBe('1 night below 20°F');
  });

  it('does not count a night it could not observe', () => {
    const panel = buildPastWeatherPanel([
      day('2026-01-15', { nightMinTempC: null }),
      day('2026-01-16', { nightMinTempC: -12 }),
    ]);
    // One known night, one unknown: the count is over what is known, and the denominator says so.
    expect(panel.headline[0]).toBe('1 night below 20°F');
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
    const panel = buildPastWeatherPanel(week);

    expect(panel.rows).toHaveLength(5);
    expect(panel.rows[0]?.dayMs).toBe(base);
    expect(panel.headline[0]).toBe('4 nights below 20°F');
    expect(panel.headline).toContain('Rain on Feb 1');
    expect(panel.headline.some((l) => l.includes('snow since Feb 4'))).toBe(true);
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
