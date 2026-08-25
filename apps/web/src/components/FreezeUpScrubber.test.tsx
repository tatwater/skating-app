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
  orbit: null,
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

  it('⚠ says nothing extra when both halves came from the same pass, seconds apart', () => {
    // Two granules from ONE pass are seconds apart, not identical — which is what the first version
    // of this test got wrong by using the same instant for both. Comparing instants called them
    // different and a device rendered "Dec 12, 2025 + Dec 12, 2025" on Quabbin. The question is
    // whether a reader sees two dates, which is a question about the rendered strings.
    render(<Harness timeline={seamed('2025-12-22T15:51:33Z')} />);
    expect(screen.queryByText(/sits across a granule edge/)).toBeNull();
    expect(screen.queryByText(/\+ Dec 22, 2025/)).toBeNull();
  });
});

describe('FreezeUpScrubber — dragging the track', () => {
  const threeStops = timelineOf([
    stop({ frame: frame({ granuleId: 'a' }) }),
    stop({ frame: frame({ granuleId: 'b' }), landable: false, blockedBy: 'cloud' }),
    stop({ frame: frame({ granuleId: 'c' }) }),
  ]);

  /** jsdom reports zero-size boxes, so the track has to be told how wide it is. */
  function withTrackWidth(width: number) {
    return vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width,
      top: 0,
      height: 24,
      right: width,
      bottom: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }

  it('selects the notch under the pointer', () => {
    const rect = withTrackWidth(300);
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={threeStops}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={0}
        onSelect={onSelect}
        loading={false}
      />,
    );

    const track = screen.getByRole('group');
    track.setPointerCapture = vi.fn();
    // 250 of 300 across three notches is the last one.
    fireEvent.pointerDown(track, { clientX: 250, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith(2);
    rect.mockRestore();
  });

  it('⚠ snaps to a blocked notch rather than skipping past it', () => {
    // Jumping ahead to the nearest landable stop would outrun the cursor and hide that a date exists
    // and is unusable — which is the entire reason blocked stops are drawn.
    const rect = withTrackWidth(300);
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={threeStops}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={0}
        onSelect={onSelect}
        loading={false}
      />,
    );

    const track = screen.getByRole('group');
    track.setPointerCapture = vi.fn();
    fireEvent.pointerDown(track, { clientX: 150, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith(1);
    rect.mockRestore();
  });

  it('ignores a move with no button held, so a hover does not scrub', () => {
    const rect = withTrackWidth(300);
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={threeStops}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={0}
        onSelect={onSelect}
        loading={false}
      />,
    );

    fireEvent.pointerMove(screen.getByRole('group'), { clientX: 250, buttons: 0 });
    expect(onSelect).not.toHaveBeenCalled();
    rect.mockRestore();
  });
});

describe('FreezeUpScrubber — settling after a drag', () => {
  it('⚠ slides off a blocked notch on release, rather than parking there', () => {
    // Leaving the thumb on a clouded date would leave the caption and the held image disagreeing at
    // rest — the one state `frameToRender`'s transient mismatch is not allowed to settle into.
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={timelineOf([
          stop({ frame: frame({ granuleId: 'a' }) }),
          stop({ frame: frame({ granuleId: 'b' }), landable: false, blockedBy: 'cloud' }),
          stop({ frame: frame({ granuleId: 'c' }) }),
        ])}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={1}
        onSelect={onSelect}
        loading={false}
      />,
    );

    fireEvent.pointerUp(screen.getByRole('group'));
    expect(onSelect).toHaveBeenCalledWith(expect.any(Number));
    expect(onSelect.mock.calls[0]?.[0]).not.toBe(1);
  });

  it('leaves a landable notch alone', () => {
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={timelineOf([stop(), stop()])}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={0}
        onSelect={onSelect}
        loading={false}
      />,
    );

    fireEvent.pointerUp(screen.getByRole('group'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('⚠ keeps the caveat line present even with nothing to say', () => {
    // Its length varies with the cloud figure, so appearing and vanishing would change the panel's
    // height under a cursor that is mid-drag.
    const { container } = render(<Harness timeline={timelineOf([stop({ stats: undefined })])} />);
    expect(container.querySelector('.min-h-4')).toBeTruthy();
  });
});

describe('FreezeUpScrubber — captioning a held seam half', () => {
  it('⚠ names the half that is on the map, not the one this stop declares', () => {
    // A held companion outlives the stop that supplied it. Reading `current.companion` would leave
    // half the lake showing a date the caption never named — the D84 failure this module is arranged
    // to avoid.
    render(
      <FreezeUpScrubber
        timeline={timelineOf([stop({ frame: frame({ capturedAt: '2025-12-22T15:51:05Z' }) })])}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={0}
        onSelect={vi.fn()}
        loading={false}
        renderedCompanion={frame({ granuleId: 'held', capturedAt: '2025-12-08T15:51:05Z' })}
      />,
    );

    expect(screen.getByText(/\+ Dec 8, 2025/)).toBeTruthy();
    expect(screen.getByText(/sits across a granule edge/)).toBeTruthy();
  });
});

describe('FreezeUpScrubber — the thumb', () => {
  const threeStops = timelineOf([
    stop({ frame: frame({ granuleId: 'a' }) }),
    stop({ frame: frame({ granuleId: 'b' }) }),
    stop({ frame: frame({ granuleId: 'c' }) }),
  ]);

  const thumbOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="scrubber-thumb"]');

  const at = (selected: number | null) =>
    render(
      <FreezeUpScrubber
        timeline={threeStops}
        index={indexOf(['visual'])}
        band="visual"
        onBandChange={vi.fn()}
        selected={selected}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

  it('⚠ sits on the notch it has selected, at the position notchAtOffset reads back', () => {
    // Half-step insets: three notches sit at 1/6, 3/6, 5/6. Pinned as literals rather than recomputed
    // from `notchFraction`, so a change to the placement rule has to be looked at rather than
    // silently agreed with by a test that shares the bug.
    // Compared as numbers: the two ways of writing one sixth differ in the last bit of a double, and
    // a string compare would fail on an arithmetic identity rather than on a placement.
    const leftOf = (selected: number) =>
      Number.parseFloat(thumbOf(at(selected).container)?.style.left ?? '');
    expect(leftOf(0)).toBeCloseTo(100 / 6, 10);
    expect(leftOf(1)).toBeCloseTo(50, 10);
    expect(leftOf(2)).toBeCloseTo(500 / 6, 10);
  });

  it('is not there before a date has been chosen — no thumb, rather than one parked at zero', () => {
    // `selected` is null only until the auto-select effect lands, but a handle that flashes at the
    // left edge first would read as the control jumping.
    const { container } = render(
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
    expect(thumbOf(container)).toBeNull();
  });

  it('⚠ never takes the pointer, so a drag can begin on the handle itself', () => {
    // The most natural gesture on this control is to press the thumb and pull. The track owns the
    // pointer (`setPointerCapture`), so a handle that accepted the `pointerdown` would make exactly
    // that gesture the one that did nothing.
    expect(thumbOf(at(1).container)?.className).toContain('pointer-events-none');
  });

  it('⚠ is a window, not a lozenge — the mark it stands on stays readable through it', () => {
    // The thumb covers the one notch whose state the skater most needs: whether the date under it
    // has a picture (tall, blue) or is clouded out (short, grey). Filling it in would black out that
    // answer exactly where it is being asked, leaving nothing but memory of what was there before.
    const thumb = thumbOf(at(1).container);
    expect(thumb?.className).toContain('border-2');
    expect(thumb?.className).toContain('border-primary');
    expect(thumb?.className).not.toContain('bg-');
  });

  it('does not animate while a finger is on the control', () => {
    // Same 120 ms ease reads as weight when the thumb moves on its own and as lag when it is chasing
    // a pointer that is already ahead of it.
    const { container } = at(1);
    expect(thumbOf(container)?.className).toContain('transition-[left]');

    const track = screen.getAllByRole('group')[0];
    if (track) {
      track.setPointerCapture = vi.fn();
      fireEvent.pointerDown(track, { clientX: 10, pointerId: 1 });
    }
    expect(thumbOf(container)?.className).not.toContain('transition-[left]');
  });

  it('draws every stop as a mark, blocked ones shorter, and colours none of them by selection', () => {
    // The thumb is standing on the selected mark, so colouring it too would draw the same fact twice
    // — and the half the handle covers would read as the handle having a shadow.
    const { container } = at(1);
    const ticks = container.querySelectorAll('[role="group"] button > span');
    expect(ticks).toHaveLength(3);
    for (const tick of ticks) expect(tick.className).toContain('bg-primary/45');
  });
});

describe('FreezeUpScrubber — a stale selection after a band switch', () => {
  const nine = timelineOf(
    Array.from({ length: 9 }, (_, i) => stop({ frame: frame({ granuleId: `S1A_${i}` }) })),
  );

  it('⚠ opens on a date instead of nothing when the index outruns the new band', () => {
    // The founder's report, 2026-08-26: switching to radar showed imagery with no thumb and no date
    // until you dragged. A winter has ~30 optical passes and ~9 radar ones, so the index chosen on
    // true colour is past the end of radar — and `selected !== null` is exactly what made the
    // auto-select effect decline to choose. Read as unselected, it recovers in the same render.
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={nine}
        index={indexOf(['vh'])}
        band="vh"
        onBandChange={vi.fn()}
        selected={29}
        onSelect={onSelect}
        loading={false}
      />,
    );
    expect(onSelect).toHaveBeenCalledWith(8);
  });

  it('draws no thumb on an index the track does not have, rather than one at the end', () => {
    const { container } = render(
      <FreezeUpScrubber
        timeline={nine}
        index={indexOf(['vh'])}
        band="vh"
        onBandChange={vi.fn()}
        selected={29}
        onSelect={vi.fn()}
        loading={false}
      />,
    );
    expect(container.querySelector('[data-testid="scrubber-thumb"]')).toBeNull();
  });
});

describe('FreezeUpScrubber — landing near where the skater was', () => {
  const dated = (iso: string, granuleId = iso) =>
    stop({ frame: frame({ granuleId, capturedAt: iso }) });

  const radar = timelineOf([
    dated('2025-12-05T00:00:00Z'),
    dated('2026-02-11T00:00:00Z'),
    dated('2026-03-25T00:00:00Z'),
  ]);

  it('⚠ opens on the nearest date to the anchor, not the end of the season', () => {
    // Switching bands is the same question asked of a different instrument. Jumping to March because
    // radar happens to have a March pass throws away the part of the winter being read.
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={radar}
        index={indexOf(['vh'])}
        band="vh"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={onSelect}
        loading={false}
        anchorAt="2026-02-14T00:00:00Z"
      />,
    );
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('falls back to the most recent pass with no anchor, which is how a lake opens', () => {
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={radar}
        index={indexOf(['vh'])}
        band="vh"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={onSelect}
        loading={false}
      />,
    );
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('falls back rather than failing when the anchor cannot be honoured', () => {
    const onSelect = vi.fn();
    render(
      <FreezeUpScrubber
        timeline={radar}
        index={indexOf(['vh'])}
        band="vh"
        onBandChange={vi.fn()}
        selected={null}
        onSelect={onSelect}
        loading={false}
        anchorAt="not a date"
      />,
    );
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
