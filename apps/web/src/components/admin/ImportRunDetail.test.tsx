import type { Doc } from '@skating/convex/dataModel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  groupCounts,
  groupStages,
  humanize,
  ImportRunDetail,
} from './ImportRunDetail';

/**
 * The run detail exists so an operator can answer "how did the last import go" without re-running
 * it, and every test here is about the page not *overstating* the answer — a bounded failure sample
 * that reads as complete, or a killed loader that reads as still working, would make this page a
 * better-looking version of the problem it replaces.
 */

function run(overrides: Partial<Doc<'importRuns'>> = {}): Doc<'importRuns'> {
  return {
    _id: 'run_1' as Doc<'importRuns'>['_id'],
    _creationTime: 0,
    kind: 'canonical_water',
    label: 'VT canonical water',
    deployment: 'dev:agile-bee-397',
    isProd: false,
    status: 'succeeded',
    startedAt: Date.UTC(2026, 7, 2, 12, 0, 0),
    finishedAt: Date.UTC(2026, 7, 2, 12, 3, 24),
    counts: [{ name: 'inserted', value: 14 }],
    stages: [],
    failures: [],
    failuresTotal: 0,
    ...overrides,
  } as Doc<'importRuns'>;
}

describe('ImportRunDetail', () => {
  it('renders the path in order, with the source URL and checksum verdict', () => {
    render(
      <ImportRunDetail
        run={run({
          stages: [
            {
              name: 'extract',
              sourceUrl: 'https://download.geofabrik.de/vermont-260731.osm.pbf',
              checksumVerified: true,
              sourceAt: Date.UTC(2026, 6, 31),
              bytes: 45_679_023,
            },
            { name: 'filter', command: 'osmium tags-filter -t …' },
            { name: 'load', counts: [{ name: 'inserted', value: 14 }] },
          ],
        })}
      />,
    );

    const stages = screen.getAllByText(/^(extract|filter|load)$/);
    expect(stages.map((el) => el.textContent)).toEqual(['extract', 'filter', 'load']);
    expect(screen.getByText(/geofabrik\.de/)).toBeInTheDocument();
    expect(screen.getByText('checksum verified')).toBeInTheDocument();
    expect(screen.getByText('2026-07-31')).toBeInTheDocument();
  });

  it('says a failure list is a sample, and how much it is hiding', () => {
    render(
      <ImportRunDetail
        run={run({
          failures: [{ stage: 'transform', key: 'way/1', reason: 'unclosed ring' }],
          failuresTotal: 4_000,
        })}
      />,
    );

    expect(screen.getByText(/3,999 more not stored/)).toBeInTheDocument();
  });

  it('does not claim a run is still going when the loader simply never finished', () => {
    render(<ImportRunDetail run={run({ status: 'running', finishedAt: undefined })} />);
    // "no finish recorded", never "in progress" — the row cannot tell the difference between a
    // live loader and one that was killed, so it must not assert either.
    expect(screen.getByText(/no finish recorded/i)).toBeInTheDocument();
  });

  it('marks a production run unmistakably', () => {
    render(
      <ImportRunDetail run={run({ isProd: true, deployment: 'prod:diligent-guanaco-965' })} />,
    );
    expect(screen.getByText('production')).toBeInTheDocument();
  });

  it('distinguishes an unverified checksum from an absent one', () => {
    const { rerender } = render(
      <ImportRunDetail run={run({ stages: [{ name: 'extract', checksumVerified: false }] })} />,
    );
    expect(screen.getByText('checksum unverified')).toBeInTheDocument();

    rerender(<ImportRunDetail run={run({ stages: [{ name: 'extract' }] })} />);
    expect(screen.queryByText(/checksum/)).not.toBeInTheDocument();
  });
});

describe('coverage', () => {
  it('reports a rate, not just a count', () => {
    render(
      <ImportRunDetail
        run={run({
          coverage: { unit: 'bodies', eligible: 116_070, covered: 8_100, omissions: [] },
        })}
      />,
    );
    expect(screen.getByText('7.0%')).toBeInTheDocument();
    expect(screen.getByText(/8,100 of 116,070 bodies/)).toBeInTheDocument();
  });

  it('accounts for the gap when the omissions add up', () => {
    render(
      <ImportRunDetail
        run={run({
          coverage: {
            unit: 'bodies',
            eligible: 100,
            covered: 60,
            omissions: [
              { reason: 'below the source area floor', count: 30 },
              { reason: 'matched no body', count: 10 },
            ],
          },
        })}
      />,
    );
    expect(screen.queryByText(/unexplained/)).not.toBeInTheDocument();
  });

  it('flags the remainder nobody wrote down', () => {
    // The whole point: "30 skipped below the area floor" is a documented limit, and "10 more went
    // somewhere" is a bug. A totals-only summary renders those two identically.
    render(
      <ImportRunDetail
        run={run({
          coverage: {
            unit: 'bodies',
            eligible: 100,
            covered: 60,
            omissions: [{ reason: 'below the source area floor', count: 30 }],
          },
        })}
      />,
    );
    expect(screen.getByText(/unexplained/)).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('renders nothing at all when a loader reported no coverage', () => {
    render(<ImportRunDetail run={run()} />);
    expect(screen.queryByText('Coverage')).not.toBeInTheDocument();
  });
});

/**
 * The N7 merge reports forty-five counts and twenty stages. Everything below is about that run
 * being *readable* — the first version rendered all of it as one flat uppercase grid, which made
 * `emitted` and `refused.refused-over-silence` look like the same kind of fact.
 */
describe('grouping the tallies', () => {
  it('files each count under the prefix its loader named it with', () => {
    const groups = groupCounts([
      { name: 'emitted', value: 25_050 },
      { name: 'refused.no-class', value: 11_403 },
      { name: 'refused.vetoed', value: 134 },
      { name: 'floor.unnamed wetland under 50 acres', value: 62_126 },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['Totals', 'refused', 'floor']);
    expect(groups[1]?.title).toBe('Refused');
  });

  it('puts the run totals first — every other group is a breakdown of them', () => {
    const groups = groupCounts([
      { name: 'refused.no-class', value: 1 },
      { name: 'emitted', value: 2 },
    ]);
    expect(groups[0]?.key).toBe('Totals');
  });

  it('sorts a group by size, because within a family the question is which one is big', () => {
    const groups = groupCounts([
      { name: 'floor.a', value: 3 },
      { name: 'floor.b', value: 900 },
      { name: 'floor.c', value: 40 },
    ]);
    expect(groups[0]?.counts.map((c) => c.value)).toEqual([900, 40, 3]);
  });

  it('groups a prefix it has never seen rather than dropping it on the floor', () => {
    const groups = groupCounts([{ name: 'newloader.thing', value: 1 }]);
    expect(groups[0]).toMatchObject({ key: 'newloader', title: 'Newloader' });
  });

  it('renders every count, including the ones behind the disclosure', () => {
    render(
      <ImportRunDetail
        run={run({
          counts: Array.from({ length: 9 }, (_, i) => ({ name: `floor.r${i}`, value: i + 1 })),
        })}
      />,
    );
    // A group past the preview cap hides rows behind a <details>, which still renders them into the
    // DOM — the cap is about attention, never about the page holding something back.
    expect(screen.getByText('3 more in this group')).toBeInTheDocument();
    expect(screen.getByText('R8')).toBeInTheDocument();
  });
});

describe('the outcome row', () => {
  it("takes its headline from the run's last stage, so a new loader needs no page change", () => {
    render(
      <ImportRunDetail
        run={run({
          counts: [{ name: 'refused.no-class', value: 11_403 }],
          stages: [
            { name: 'merge', counts: [{ name: 'emitted', value: 25_050 }] },
          ],
        })}
      />,
    );
    expect(screen.getByText('25,050')).toBeInTheDocument();
    expect(screen.getByText(/as reported by the run's last stage, merge/)).toBeInTheDocument();
  });

  it('falls back to the known headline counts for a row written before stages existed', () => {
    render(
      <ImportRunDetail
        run={run({
          stages: [],
          counts: [
            { name: 'batchesTotal', value: 7 },
            { name: 'inserted', value: 42 },
          ],
        })}
      />,
    );
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

describe('grouping the path', () => {
  it('collapses `source · osm/vt`-style stages into one step per family', () => {
    const families = groupStages([
      { name: 'source · osm/vt' },
      { name: 'source · osm/nh' },
      { name: 'mask · five-state' },
      { name: 'merge' },
    ]);
    expect(families.map((f) => [f.key, f.stages.length])).toEqual([
      ['source', 2],
      ['mask', 1],
      ['merge', 1],
    ]);
  });

  it('rolls the family checksum verdicts up, without merging the two "not verified" cases', () => {
    render(
      <ImportRunDetail
        run={run({
          stages: [
            { name: 'source · osm/vt', checksumVerified: true, bytes: 1_000 },
            { name: 'source · osm/nh', checksumVerified: false, bytes: 2_000 },
            { name: 'source · nhd/VT', detail: 'MISSING — no readable manifest' },
          ],
        })}
      />,
    );
    expect(screen.getByText('2/2 checksum verified')).not.toBeNull();
    expect(screen.getByText('1 checksum unverified')).toBeInTheDocument();
    // The NHD family is its own single-stage step, and a missing archive is never a silent absence.
    expect(screen.getByText(/MISSING/)).toBeInTheDocument();
  });

  it('explains what a missing path means and how to get one', () => {
    // The old copy — "the loader was given no provenance sidecars" — named an internal concept and
    // gave the reader nothing to do about it.
    render(<ImportRunDetail run={run({ stages: [] })} />);
    expect(screen.getByText(/recorded no stages, so its path is unknown/)).toBeInTheDocument();
    expect(screen.getByText('run-corpus.sh')).toBeInTheDocument();
  });
});

describe('humanize', () => {
  it('turns a loader token into words', () => {
    expect(humanize('droppedByAreaFloor')).toBe('Dropped By Area Floor');
    expect(humanize('below-hard-floor')).toBe('Below hard floor');
    expect(humanize('emitted')).toBe('Emitted');
  });
});

describe('formatting helpers', () => {
  it('scales bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(45_679_023)).toBe('43.6 MB');
  });

  it('scales durations', () => {
    expect(formatDuration(204_000)).toBe('3m 24s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4_500_000)).toBe('1h 15m');
  });
});
