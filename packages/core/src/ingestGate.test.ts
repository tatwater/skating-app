import { describe, expect, it } from 'vitest';
import { DEFAULT_THAW_RUN_DAYS, ingestWindow, type SiteSeries } from './ingestGate';

/** `count` days from `start`, each with the given low. */
function series(siteId: string, start: string, lows: number[], sentinel?: boolean): SiteSeries {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  return {
    siteId,
    ...(sentinel ? { sentinel: true } : {}),
    days: lows.map((minTempC, i) => ({
      date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      minTempC,
    })),
  };
}

describe('ingestWindow — opening', () => {
  it('opens the season on the sentinel alone', () => {
    // Lake of the Clouds freezes weeks before the valleys. That is the point of using it.
    const sites = [
      series('clouds', '2026-09-20', [5, 3, -1, -2], true),
      series('valley-a', '2026-09-20', [14, 13, 12, 11]),
      series('valley-b', '2026-09-20', [15, 14, 13, 12]),
    ];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-09-22');
    expect(window.openedBy).toEqual(['sentinel']);
  });

  it('opens on the corpus signal even if the sentinel never reports', () => {
    // ⚠ OR, never AND. A gap in one 1-acre pond's weather series must not stall a whole region.
    const sites = [
      series('valley-a', '2026-11-01', [5, -1, -2]),
      series('valley-b', '2026-11-01', [6, 2, 1]),
      series('valley-c', '2026-11-01', [7, 3, 2]),
    ];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-11-02');
    expect(window.openedBy).toEqual(['corpus']);
  });

  it('records both when the sentinel and the corpus fire on the same day', () => {
    const sites = [
      series('clouds', '2026-11-01', [-1], true),
      series('valley-a', '2026-11-01', [-1]),
      series('valley-b', '2026-11-01', [8]),
    ];
    expect(ingestWindow(sites).openedBy).toEqual(['sentinel', 'corpus']);
  });

  it('does not open on a mild autumn', () => {
    const sites = [
      series('clouds', '2026-09-01', [8, 9, 10], true),
      series('valley-a', '2026-09-01', [15, 16, 17]),
    ];
    expect(ingestWindow(sites)).toEqual({
      opensOn: null,
      winterFrom: null,
      closesOn: null,
      openedBy: [],
    });
  });

  it('measures the corpus fraction against sites that reported, not the roster', () => {
    // A day where only one valley site reported, and it froze. Dividing by the roster would read as
    // 1-of-3 and stay shut; dividing by respondents correctly reads as everything we heard from.
    const sites: SiteSeries[] = [
      { siteId: 'valley-a', days: [{ date: '2026-11-02', minTempC: -3 }] },
      { siteId: 'valley-b', days: [] },
      { siteId: 'valley-c', days: [] },
    ];
    expect(ingestWindow(sites).opensOn).toBe('2026-11-02');
  });
});

describe('ingestWindow — winter has to establish before it can end', () => {
  it('⚠ does not close a season that has only been opened by the summit', () => {
    // **The bug this exists to stop, found by calibrating against real 2025-26 weather.** Closing used
    // to be "first sustained thaw after opening", and with a September sentinel freeze followed by a
    // warm valley week that closed the 2025-26 season on 27 SEPTEMBER — before a single lake had
    // frozen. A whole winter skipped, with the logs reporting a tidy closed window.
    const warm = Array<number>(DEFAULT_THAW_RUN_DAYS + 4).fill(14);
    const sites = [
      series('clouds', '2026-09-20', [-1, ...warm], true),
      series('valley-a', '2026-09-20', [12, ...warm]),
    ];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-09-20');
    // Winter never established, so there is no ice-out to find and the window stays open.
    expect(window.winterFrom).toBeNull();
    expect(window.closesOn).toBeNull();
  });

  it('records the date the region itself froze, not the summit', () => {
    const sites = [
      series('clouds', '2026-09-20', [-1, -2, -3, -4], true),
      series('valley-a', '2026-09-20', [12, 11, -1, -2]),
      series('valley-b', '2026-09-20', [13, 12, -1, -3]),
    ];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-09-20');
    // Both valleys froze on the third day — a majority, so winter is established there.
    expect(window.winterFrom).toBe('2026-09-22');
  });
});

describe('ingestWindow — closing', () => {
  it('stays open while the season is still cold', () => {
    const sites = [series('valley-a', '2026-12-01', [-5, -6, -4, -3])];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-12-01');
    expect(window.winterFrom).toBe('2026-12-01');
    expect(window.closesOn).toBeNull();
  });

  it('closes only after a sustained run of thaw', () => {
    const warm = Array<number>(DEFAULT_THAW_RUN_DAYS).fill(12);
    const sites = [series('valley-a', '2026-12-01', [-5, ...warm])];
    const window = ingestWindow(sites);
    expect(window.opensOn).toBe('2026-12-01');
    // The tenth consecutive warm day, not the first.
    expect(window.closesOn).toBe('2026-12-11');
  });

  it('a frosty spring night resets the run — thaw means no overnight freeze at all', () => {
    // 4 °C was the earlier threshold and it closed 2025-26 on 9 June, because clear New England
    // spring nights dip below it on lakes that have been open for weeks. Zero measures the ice.
    const sites = [series('valley-a', '2026-12-01', [-5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3])];
    expect(ingestWindow(sites).closesOn).toBe('2026-12-11');
    const frosty = [series('valley-b', '2026-12-01', [-5, 3, 3, 3, -1, 3, 3, 3, 3, 3, 3])];
    expect(ingestWindow(frosty).closesOn).toBeNull();
  });

  it('a single warm week does not end a winter', () => {
    // January thaws happen. Closing on one would truncate the season mid-freeze and lose every frame
    // after it, which is exactly the expensive direction.
    const sites = [series('valley-a', '2026-12-01', [-5, 12, 12, 12, 12, 12, -3, -4])];
    expect(ingestWindow(sites).closesOn).toBeNull();
  });

  it('a cold day resets the thaw run', () => {
    const sites = [
      series('valley-a', '2026-12-01', [-5, 12, 12, 12, 12, 12, 12, 12, 12, 12, -1, 12]),
    ];
    expect(ingestWindow(sites).closesOn).toBeNull();
  });

  it('one cold ORDINARY site keeps the season open for everyone', () => {
    // `every`, not `most`: while anywhere we sample is still freezing, there is still ice to record.
    const warm = Array<number>(DEFAULT_THAW_RUN_DAYS).fill(12);
    const cold = Array<number>(DEFAULT_THAW_RUN_DAYS).fill(-2);
    const sites = [
      series('valley-a', '2026-12-01', [-5, ...warm]),
      series('valley-b', '2026-12-01', [-5, ...cold]),
    ];
    expect(ingestWindow(sites).closesOn).toBeNull();
  });

  it('⚠ the sentinel opens a season but cannot hold it open', () => {
    // Measured: feeding the tarn into closing too produced a 20 Sep → 26 Jun window, because at
    // 1,531 m it has freezing nights into late June. One 1-acre alpine pond must not keep a whole
    // region's ingest running through a Vermont summer — the same single-point-of-failure argument
    // that makes opening an OR, pointed the other way.
    const warm = Array<number>(DEFAULT_THAW_RUN_DAYS).fill(12);
    const cold = Array<number>(DEFAULT_THAW_RUN_DAYS).fill(-2);
    const sites = [
      series('valley-a', '2026-12-01', [-5, ...warm]),
      series('clouds', '2026-12-01', [-5, ...cold], true),
    ];
    expect(ingestWindow(sites).closesOn).toBe('2026-12-11');
  });

  it('⚠ a site that goes dark cannot close the season on the survivors', () => {
    // `fetchLows` drops null readings per site, so a series going dark is what a real Open-Meteo gap
    // looks like. Testing `.every()` against only the sites that reported treats the missing one as
    // thawed — four of five dropping out for a fortnight would then let the one warm survivor end the
    // season and truncate the melt-out record §C5's metrics are computed from.
    const warm = Array<number>(DEFAULT_THAW_RUN_DAYS + 2).fill(12);
    const sites = [
      series('valley-a', '2026-12-01', [-5, ...warm]),
      // Froze on day one alongside valley-a, establishing winter, and then stopped reporting.
      series('valley-b', '2026-12-01', [-5]),
    ];
    const window = ingestWindow(sites);
    expect(window.winterFrom).toBe('2026-12-01');
    expect(window.closesOn).toBeNull();
  });

  it('a day nobody reported does not count toward the thaw run', () => {
    // A missing series must not be able to end a season — the same reasoning that makes opening an OR.
    const days = [{ date: '2026-12-01', minTempC: -5 }];
    for (let i = 1; i <= DEFAULT_THAW_RUN_DAYS + 2; i++) {
      // Deliberately sparse: only every other day reports, all of them warm.
      if (i % 2 === 0) {
        days.push({
          date: new Date(Date.parse('2026-12-01T00:00:00Z') + i * 86_400_000)
            .toISOString()
            .slice(0, 10),
          minTempC: 12,
        });
      }
    }
    const window = ingestWindow([{ siteId: 'valley-a', days }]);
    // Only ~6 warm days actually reported across that span, short of the 10-day run.
    expect(window.closesOn).toBeNull();
  });
});
