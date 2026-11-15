import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { UNAVAILABLE } from '@/components/kit/unavailable-button';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ImageryDockView } from './ImageryDockView';
import { ImageryTabView, type ImageryTabViewProps, NOT_MEASURED } from './ImageryTabView';
import {
  granuleOf,
  INFERRED_STOP,
  MASCOMA_PASSES,
  MASCOMA_SATELLITE,
  MASCOMA_STOPS,
  SEASON,
} from './imageryFixtures';
import { CLEAR_GATE_PCT, passRows } from './imageryModel';

beforeAll(stubJsdomAnimations);

const base: ImageryTabViewProps = {
  season: SEASON,
  rows: MASCOMA_PASSES,
  lit: null,
  onLitChange: vi.fn(),
  onOverride: vi.fn(async () => {}),
  satellite: MASCOMA_SATELLITE,
  onSatelliteChange: vi.fn(async () => {}),
};

function Controlled(props: Partial<ImageryTabViewProps>) {
  const [lit, setLit] = useState<string | null>(props.lit ?? null);
  return <ImageryTabView {...base} {...props} lit={lit} onLitChange={setLit} />;
}

const card = () => document.querySelector<HTMLElement>('[data-slot="pass-card"]') as HTMLElement;

describe('ImageryTabView', () => {
  it('opens on the newest pass shown to skaters, with its two gates', () => {
    render(<ImageryTabView {...base} />);
    const c = within(card());
    expect(c.getByText('13 Oct')).toBeVisible();
    expect(c.getByText('Tue')).toBeVisible();
    expect(c.getByText('Shown to skaters')).toBeVisible();
    const meters = c.getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-valuetext'))).toEqual([
      '98%, needs 60%',
      '100%, needs 50%',
    ]);
    expect(c.getByRole('button', { name: /Hide from skaters/ })).toBeVisible();
    expect(c.getByText('7 of 7')).toBeVisible();
    expect(c.getByRole('button', { name: /Next/ })).toHaveAttribute('data-disabled');
  });

  it('a hidden pass: the failing gate is the bright one, and the call flips to Show anyway', async () => {
    const onOverride = vi.fn(async () => {});
    render(<ImageryTabView {...base} lit={granuleOf(10)} onOverride={onOverride} />);
    const c = within(card());
    expect(c.getByText('Hidden from skaters')).toBeVisible();
    const [cloud] = card().querySelectorAll('[data-slot="gate-row"]');
    expect(cloud).toHaveAttribute('data-fails');
    await userEvent.click(c.getByRole('button', { name: /Show to skaters anyway/ }));
    expect(onOverride).toHaveBeenCalledWith(granuleOf(10), 'show', undefined);
  });

  it('the gate that hid a pass fails on the card, even where its rounded figure reaches the gate', () => {
    // 59.6 % clear rounds to "60 %" under a 60 % gate, yet core hid the pass on cloud; and a pass
    // with no manifest is hidden on the scene's own cloud, with no figure for the lake at all.
    const [measured] = MASCOMA_STOPS;
    const rows = passRows([
      {
        ...(measured as (typeof MASCOMA_STOPS)[number]),
        landable: false,
        blockedBy: 'cloud',
        stats: { waterBodyId: 'mascoma', clearPct: 0.596, coveragePct: 1, pixels: 46_200 },
      },
      { ...INFERRED_STOP, landable: false, blockedBy: 'cloud' },
    ]);
    for (const row of rows) {
      const { unmount } = render(<ImageryTabView {...base} rows={rows} lit={row.id} />);
      expect(within(card()).getByText('Hidden from skaters')).toBeVisible();
      const [cloud, coverage] = card().querySelectorAll('[data-slot="gate-row"]');
      expect(cloud).toHaveAttribute('data-fails');
      expect(coverage).not.toHaveAttribute('data-fails');
      unmount();
    }
    expect(rows[0]?.clearPct).toBe(60);
  });

  it('hiding asks a reason first, and waits until there is one', async () => {
    const onOverride = vi.fn(async () => {});
    render(<ImageryTabView {...base} onOverride={onOverride} />);
    await userEvent.click(within(card()).getByRole('button', { name: /Hide from skaters/ }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /Hide from skaters/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Smoke over the north basin');
    await userEvent.click(confirm);
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(onOverride).toHaveBeenCalledWith(granuleOf(13), 'hide', 'Smoke over the north basin');
  });

  it('a hide on its way can’t be dismissed, so its late answer never closes an ask opened since', async () => {
    let land: () => void = () => {};
    const onOverride = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    render(<ImageryTabView {...base} onOverride={onOverride} />);
    await userEvent.click(within(card()).getByRole('button', { name: /Hide from skaters/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Smoke over the north basin');
    await userEvent.click(within(dialog).getByRole('button', { name: /Hide from skaters/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(within(dialog).getByRole('textbox')).toHaveValue('Smoke over the north basin');
    land();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onOverride).toHaveBeenCalledTimes(1);
  });

  it('draws no call without a writer', () => {
    const { onOverride: _, ...rest } = base;
    render(<ImageryTabView {...rest} />);
    expect(within(card()).queryByRole('button', { name: /skaters/ })).toBeNull();
  });

  it('pages through every pass, hidden ones too, and a row lights its pass', async () => {
    render(<Controlled />);
    await userEvent.click(within(card()).getByRole('button', { name: /Previous/ }));
    expect(within(card()).getByText('11 Oct')).toBeVisible();
    expect(within(card()).getByText('6 of 7')).toBeVisible();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '13 Oct2%100%Shown',
      '11 Oct72%100%Shown anywayTTeagan12 Oct',
      '10 Oct64%100%Hidden',
      '8 Oct3%100%Shown',
      '6 Oct0%40%Hidden',
      '5 Oct91%100%Hidden',
      '3 Oct8%100%Shown',
    ]);
    expect(rows[1]).toHaveAttribute('data-selected');
    await userEvent.click(rows[4] as HTMLElement);
    expect(within(card()).getByText('6 Oct')).toBeVisible();
    expect(within(card()).getByRole('button', { name: /Next/ })).not.toHaveAttribute(
      'data-disabled',
    );
  });

  it('a pass with nothing measured says so in words — never a blank, an empty track or a zero', () => {
    render(<ImageryTabView {...base} rows={passRows([INFERRED_STOP])} />);
    // No meter claims a value it doesn't have, and no empty track stands in for one (it reads as
    // zero); each gate keeps its threshold in words.
    expect(within(card()).queryAllByRole('meter')).toEqual([]);
    expect(card().querySelectorAll('[data-slot="meter-track"], [data-slot="meter"]')).toHaveLength(
      0,
    );
    expect(card().textContent).toContain(`Needs ${CLEAR_GATE_PCT}%`);
    // Twice in the card, twice in the table — each one on screen, not only for a reader.
    const said = screen.getAllByText(NOT_MEASURED);
    expect(said).toHaveLength(4);
    for (const el of said) expect(el).not.toHaveClass('sr-only');
    expect(document.querySelector('[data-slot="passes-loading"]')).toBeNull();
    expect(screen.queryByText(/^0$|null/)).toBeNull();
  });

  it('holds the card’s place before the passes land, and says when none reached the body', () => {
    const { rerender } = render(<ImageryTabView {...base} rows={undefined} />);
    expect(document.querySelector('[data-slot="passes-loading"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/No satellite pass/)).toBeNull();
    rerender(<ImageryTabView {...base} rows={[]} />);
    expect(screen.getByText('No satellite pass reached this body this winter')).toBeVisible();
    expect(screen.queryByText('Passes')).toBeNull();
  });

  it('holds the archive’s note as Trying again… while it is tried again', () => {
    render(
      <ImageryTabView {...base} rows={undefined} archiveError onRetry={vi.fn()} retryPending />,
    );
    expect(screen.getByRole('button', { name: 'Trying again…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('an archive that couldn’t be read, or has no address, says so — never a word about the lake', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ImageryTabView {...base} rows={undefined} archiveError onRetry={onRetry} />,
    );
    expect(
      screen.getByText(/couldn’t be read\. That is about the archive, not the lake\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<ImageryTabView {...base} rows={undefined} archiveUnconfigured />);
    expect(screen.getByText(/No imagery archive is set up for this deployment/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a call with no writer is drawn as the board draws it and does nothing else', async () => {
    render(<ImageryTabView {...base} lit={granuleOf(10)} onOverride={UNAVAILABLE} />);
    const call = screen.getByRole('button', { name: /Show to skaters anyway/ });
    expect(call).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(call);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Its key says so too, and opens nothing.
    const pane = document.querySelector<HTMLElement>('[data-slot="imagery-tab"]');
    pane?.focus();
    fireEvent.keyDown(pane as HTMLElement, { key: 'S' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('sets the satellite link; without a writer the choice is read-only', async () => {
    const onSatelliteChange = vi.fn(async () => {});
    const { rerender } = render(<ImageryTabView {...base} onSatelliteChange={onSatelliteChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never' }));
    expect(onSatelliteChange).toHaveBeenCalledWith('off');
    expect(screen.getByText('Auto offers it at 10 ha and up; Mascoma is 462 ha.')).toBeVisible();
    expect(screen.getByRole('link', { name: /Copernicus Browser/ })).toHaveAttribute(
      'target',
      '_blank',
    );
    const { onSatelliteChange: _, ...rest } = base;
    rerender(<ImageryTabView {...rest} />);
    expect(screen.getByRole('button', { name: 'Never' })).toHaveAttribute('data-disabled');
  });

  it('an earlier satellite choice refused late never shows under a choice made since', async () => {
    const answers: ((refusal?: Error) => void)[] = [];
    const onSatelliteChange = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          answers.push((refusal) => (refusal === undefined ? resolve() : reject(refusal)));
        }),
    );
    render(<ImageryTabView {...base} onSatelliteChange={onSatelliteChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never' }));
    await userEvent.click(screen.getByRole('button', { name: 'Always offer' }));
    expect(onSatelliteChange).toHaveBeenCalledTimes(2);
    await act(async () => answers[0]?.(new Error('Not saved: the first choice')));
    await act(async () => answers[1]?.());
    expect(screen.queryByText('Not saved: the first choice')).toBeNull();
  });

  it('a refused call says why', async () => {
    const onOverride = vi.fn(async () => {
      throw new Error('That pass is no longer in the archive');
    });
    render(<ImageryTabView {...base} lit={granuleOf(5)} onOverride={onOverride} />);
    await userEvent.click(within(card()).getByRole('button', { name: /Show to skaters anyway/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer in the archive');
  });
});

describe('ImageryDockView', () => {
  const dock = (selected: number, onSelect = vi.fn(), onBandChange = vi.fn()) => {
    render(
      <ImageryDockView
        rows={MASCOMA_PASSES}
        selected={selected}
        onSelect={onSelect}
        bands={['visual', 'scl', 'vh']}
        band="visual"
        onBandChange={onBandChange}
      />,
    );
    return { onSelect, onBandChange };
  };

  it('captions the lit pass: its date and source, then what was in the way and who sees it', () => {
    dock(4);
    expect(screen.getByText('10 Oct 2026')).toBeVisible();
    const caption = document.querySelector('[data-slot="dock-caption"]');
    expect(caption?.textContent).toBe(
      '10 Oct 2026 · Sentinel-2 true color64% of the lake under cloud · hidden from skaters',
    );
    const notches = [...document.querySelectorAll('[data-slot="pass-notch"]')];
    expect(notches.map((n) => n.getAttribute('data-seen'))).toEqual([
      'shown',
      'hidden',
      'hidden',
      'shown',
      'hidden',
      'shown-anyway',
      'shown',
    ]);
  });

  it('steps through every pass with the arrows, Home and End', () => {
    const { onSelect } = dock(4);
    const slider = screen.getByRole('slider', { name: 'Pass' });
    expect(slider).toHaveAttribute('aria-valuetext', '10 Oct 2026, hidden from skaters');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.keyDown(slider, { key: 'x' });
    expect(onSelect.mock.calls).toEqual([[3], [5], [0], [6]]);
  });

  it('a press picks the nearest notch; the ends hold', () => {
    const { onSelect } = dock(6);
    const slider = screen.getByRole('slider', { name: 'Pass' });
    slider.getBoundingClientRect = () => ({ left: 0, width: 600 }) as DOMRect;
    fireEvent.pointerDown(slider, { clientX: 95 });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSelect.mock.calls).toEqual([[1]]);
  });

  it('switches the band', async () => {
    const { onBandChange } = dock(6);
    await userEvent.click(screen.getByRole('button', { name: 'Radar' }));
    expect(onBandChange).toHaveBeenCalledWith('vh');
  });

  it('with no passes, says so', () => {
    render(
      <ImageryDockView
        rows={[]}
        selected={-1}
        onSelect={vi.fn()}
        bands={['visual']}
        band="visual"
        onBandChange={vi.fn()}
      />,
    );
    expect(screen.getByText('No satellite passes over this body this winter')).toBeVisible();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
