import type { BodyTimeline, IndexedFrame, SeasonIndex, TimelineStop } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FreezeUpScrubber } from './FreezeUpScrubber';

const frame = (over: Partial<IndexedFrame> = {}): IndexedFrame => ({
  granuleId: 'S2C_A',
  capturedAt: '2025-12-22T15:51:05Z',
  cloudCoverPct: 7.6,
  bodies: 9,
  band: 'visual',
  key: 'frames/winter-2025-26/S2C_A-visual.pmtiles',
  ...over,
});

const stop = (over: Partial<TimelineStop> = {}): TimelineStop => ({
  frame: frame(),
  landable: true,
  basis: 'measured',
  ...over,
});

const timelineOf = (stops: TimelineStop[]): BodyTimeline => ({
  season: 'winter-2025-26',
  stops,
  landableCount: stops.filter((s) => s.landable).length,
  notCovered: 0,
  coverageInferred: 0,
  coverageUnknown: 0,
});

const indexOf = (bands: string[]): SeasonIndex => ({
  season: 'winter-2025-26',
  frames: bands.map((band, i) => frame({ band, granuleId: `G${i}` })),
  firstCapturedAt: null,
  lastCapturedAt: null,
});

/** Drives `selected` the way the drawer will, so the auto-select effect can settle. */
function Harness({ timeline, index }: { timeline: BodyTimeline; index?: SeasonIndex }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [band, setBand] = useState('visual');
  return (
    <FreezeUpScrubber
      timeline={timeline}
      index={index ?? indexOf(['visual'])}
      band={band}
      onBandChange={setBand}
      selected={selected}
      onSelect={setSelected}
      loading={false}
    />
  );
}

describe('FreezeUpScrubber — blocked stops stay drawn', () => {
  it('renders one mark per pass, blocked ones included', () => {
    render(
      <Harness
        timeline={timelineOf([
          stop({ frame: frame({ granuleId: 'a' }) }),
          stop({
            frame: frame({ granuleId: 'b' }),
            landable: false,
            blockedBy: 'cloud',
            stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 0.06, pixels: 4107 },
          }),
          stop({ frame: frame({ granuleId: 'c' }) }),
        ])}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('⚠ gives a blocked mark its reason as an accessible name', () => {
    // The whole point of drawing blocked stops is that they explain themselves. A screen-reader user
    // must get the same explanation a sighted one gets from a greyed mark, or it is decoration.
    render(
      <Harness
        timeline={timelineOf([
          stop({
            landable: false,
            blockedBy: 'cloud',
            stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 0.06, pixels: 4107 },
          }),
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: /94% of the lake under cloud/ })).toBeTruthy();
  });

  it('marks a blocked stop as disabled without removing it from the tree', () => {
    render(<Harness timeline={timelineOf([stop({ landable: false, blockedBy: 'coverage' })])} />);
    expect(screen.getByRole('button').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('FreezeUpScrubber — where the thumb lands', () => {
  it('opens on the most recent usable pass, because a skater is asking about now', () => {
    render(
      <Harness
        timeline={timelineOf([
          stop({ frame: frame({ granuleId: 'a', capturedAt: '2025-12-01T00:00:00Z' }) }),
          stop({ frame: frame({ granuleId: 'b', capturedAt: '2026-01-15T00:00:00Z' }) }),
        ])}
      />,
    );

    const marks = screen.getAllByRole('button');
    expect(marks[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('⚠ skips past a trailing blocked stop rather than landing on nothing', () => {
    render(
      <Harness
        timeline={timelineOf([
          stop({ frame: frame({ granuleId: 'a' }) }),
          stop({ frame: frame({ granuleId: 'b' }), landable: false, blockedBy: 'cloud' }),
        ])}
      />,
    );

    const marks = screen.getAllByRole('button');
    expect(marks[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('does not select anything when nothing is landable', () => {
    render(<Harness timeline={timelineOf([stop({ landable: false, blockedBy: 'cloud' })])} />);
    expect(screen.getByRole('button').getAttribute('aria-current')).toBeNull();
  });

  it('arrow keys move between landable stops, stepping over a blocked one', () => {
    render(
      <Harness
        timeline={timelineOf([
          stop({ frame: frame({ granuleId: 'a' }) }),
          stop({ frame: frame({ granuleId: 'b' }), landable: false, blockedBy: 'cloud' }),
          stop({ frame: frame({ granuleId: 'c' }) }),
        ])}
      />,
    );

    const marks = screen.getAllByRole('button');
    // Auto-selected the last landable (index 2); walking left must reach 0, not the blocked 1.
    expect(marks[2]?.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(marks[2] as HTMLElement, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('button')[0]?.getAttribute('aria-current')).toBe('true');
  });
});

describe('FreezeUpScrubber — the date is content', () => {
  it('renders the selected pass’s date, source and caveat as text', () => {
    render(
      <Harness
        timeline={timelineOf([
          stop({ stats: { waterBodyId: 'x', coveragePct: 1, clearPct: 0.62, pixels: 4107 } }),
        ])}
      />,
    );

    expect(screen.getByText(/Dec 22, 2025/)).toBeTruthy();
    expect(screen.getByText(/Sentinel-2 true colour/)).toBeTruthy();
    expect(screen.getByText(/38% of the lake under cloud/)).toBeTruthy();
  });

  it('says how much of the timeline is still a guess, and only when some of it is', () => {
    const { rerender } = render(<Harness timeline={timelineOf([stop()])} />);
    expect(screen.queryByText(/not yet confirmed/)).toBeNull();

    rerender(
      <Harness timeline={{ ...timelineOf([stop({ basis: 'inferred' })]), coverageInferred: 1 }} />,
    );
    expect(screen.getByText(/1 of 1 passes not yet confirmed/)).toBeTruthy();
  });
});

describe('FreezeUpScrubber — the band selector', () => {
  it('⚠ offers only the bands this season actually published', () => {
    // The archive's bands changed twice; a hardcoded list would show a tab leading to an empty
    // scrubber for any season cut under an older policy.
    render(<Harness timeline={timelineOf([stop()])} index={indexOf(['visual', 'vh'])} />);

    expect(screen.getByRole('button', { name: 'Sentinel-2 true colour' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sentinel-1 radar (VH)' })).toBeTruthy();
  });

  it('hides itself when there is only one band, since a control that governs nothing is noise', () => {
    render(<Harness timeline={timelineOf([stop()])} index={indexOf(['visual'])} />);
    // Exact name, not a regex: a stop mark's own label *contains* the source ("Dec 22, 2025 —
    // Sentinel-2 true colour"), so a loose match finds the track and reports a toggle that is not
    // there.
    expect(screen.queryByRole('button', { name: 'Sentinel-2 true colour' })).toBeNull();
  });
});

describe('FreezeUpScrubber — the empty states are not errors', () => {
  it('⚠ says NOTHING when the index has not arrived, because that is not a fact about the lake', () => {
    // `timeline` is null for an unconfigured archive, a failed fetch, or a read in flight — none of
    // which is knowledge about this water. Claiming "no passes recorded" there tells a skater
    // something false on the strength of a missing environment variable. Observed live 2026-08-25.
    const { container } = render(
      <FreezeUpScrubber
        timeline={null}
        index={null}
        band="visual"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('⚠ blames the archive, never the lake, when a configured archive is unreadable', () => {
    // Observed live 2026-08-25: the bucket was public but sent no CORS headers, so every fetch failed
    // and the panel rendered an empty box. A bad URL, a missing CORS rule and a dropped network all
    // land here, and none of them is news about this water.
    render(
      <FreezeUpScrubber
        timeline={null}
        index={null}
        band="visual"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={vi.fn()}
        loading={false}
        error
      />,
    );
    const text = screen.getByText(/could not be reached/).textContent ?? '';
    expect(text).not.toMatch(/lake|pass|recorded/i);
  });

  it('says a lake simply had no passes, without sounding broken', () => {
    render(
      <FreezeUpScrubber
        timeline={timelineOf([])}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByText(/No satellite passes recorded/)).toBeTruthy();
  });

  it('shows a loading state while the archive is still being read', () => {
    render(
      <FreezeUpScrubber
        timeline={null}
        index={null}
        band="visual"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={vi.fn()}
        loading
      />,
    );
    expect(screen.getByText(/Loading the freeze-up timeline/)).toBeTruthy();
  });
});

describe('FreezeUpScrubber — the split-body seam', () => {
  const seamed = (companionAt: string) =>
    timelineOf([
      stop({
        frame: frame({ granuleId: 'west', capturedAt: '2025-12-22T15:51:05Z' }),
        companion: {
          frame: frame({ granuleId: 'east', capturedAt: companionAt }),
          stats: { waterBodyId: 'x', coveragePct: 0.45, clearPct: 0.9, pixels: 900 },
        },
        stats: { waterBodyId: 'x', coveragePct: 0.55, clearPct: 0.9, pixels: 900 },
      }),
    ]);

  it('⚠ names the second date at the same weight as the first', () => {
    // Both halves are on screen. Presenting one date would put a single day's label over ground
    // observed twice, which is the inference the seam exists to prevent.
    render(<Harness timeline={seamed('2025-12-24T15:51:05Z')} />);
    expect(screen.getByText(/Dec 22, 2025/)).toBeTruthy();
    expect(screen.getByText(/\+ Dec 24, 2025/)).toBeTruthy();
  });

  it('explains why there are two, rather than leaving a bare "+"', () => {
    render(<Harness timeline={seamed('2025-12-24T15:51:05Z')} />);
    expect(screen.getByText(/sits across a granule edge/)).toBeTruthy();
  });

  it('says nothing extra when both halves came from the same pass', () => {
    // The common case: one pass, two adjacent granules, same day. There is no second date to name and
    // a "+ Dec 22" beside "Dec 22" would read as a bug.
    render(<Harness timeline={seamed('2025-12-22T15:51:05Z')} />);
    expect(screen.queryByText(/sits across a granule edge/)).toBeNull();
  });
});
