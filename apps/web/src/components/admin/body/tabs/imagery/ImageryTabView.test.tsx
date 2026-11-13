import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ImageryDockView } from './ImageryDockView';
import { ImageryTabView, type ImageryTabViewProps } from './ImageryTabView';
import {
  granuleOf,
  INFERRED_STOP,
  MASCOMA_PASSES,
  MASCOMA_SATELLITE,
  SEASON,
} from './imageryFixtures';
import { passRows } from './imageryModel';

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

  it('a pass with nothing measured shows no figure, and says so to a reader', () => {
    render(<ImageryTabView {...base} rows={passRows([INFERRED_STOP])} />);
    // No meter claims a value it doesn't have; the gates still stand on their tracks.
    expect(within(card()).queryAllByRole('meter')).toEqual([]);
    expect(card().querySelectorAll('[data-slot="meter-mark"]')).toHaveLength(2);
    expect(card().querySelectorAll('[data-slot="meter-fill"]')).toHaveLength(0);
    // Twice in the card, twice in the table.
    expect(screen.getAllByText('Not measured')).toHaveLength(4);
  });

  it('says what it can before the passes land, and when none reached the body', () => {
    const { rerender } = render(<ImageryTabView {...base} rows={undefined} />);
    expect(screen.getByText('Loading the passes')).toBeVisible();
    rerender(<ImageryTabView {...base} rows={[]} />);
    expect(screen.getByText('No satellite pass reached this body this winter')).toBeVisible();
    expect(screen.queryByText('Passes')).toBeNull();
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
