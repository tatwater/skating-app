import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapMarksLayer, type ProjectingMap } from './MapMarksLayer';
import type { HazardMarkModel, LakeLabelModel } from './mapDerive';

/** A map 1000 × 800 whose projection is a plain scale: lng/lat × 100. */
function fakeMap(width = 1000, height = 800) {
  const handlers = new Map<string, Set<() => void>>();
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: width });
  Object.defineProperty(container, 'clientHeight', { value: height });
  let offset = 0;
  const map: ProjectingMap & { pan(dx: number): void } = {
    project: ([lng, lat]) => ({ x: lng * 100 + offset, y: lat * 100 }),
    getContainer: () => container,
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off: (event, handler) => {
      handlers.get(event)?.delete(handler);
    },
    pan(dx) {
      offset += dx;
      for (const h of handlers.get('move') ?? []) h();
    },
  };
  return { map, handlers };
}

const label = (over: Partial<LakeLabelModel> & { id: string }): LakeLabelModel => ({
  name: over.id,
  anchor: { lng: 3, lat: 4 },
  slug: null,
  favorite: false,
  openBounties: 0,
  inactive: false,
  dim: false,
  priority: 1,
  ...over,
});

const hazard = (over: Partial<HazardMarkModel> & { id: string }): HazardMarkModel => ({
  hazardType: 'open_water',
  lng: 5,
  lat: 5,
  tone: 'danger',
  provisional: false,
  ...over,
});

const node = (name: string) =>
  screen.getByText(name).closest('[data-slot="lake-label"]') as HTMLElement;

describe('MapMarksLayer', () => {
  it('places each label on its projected anchor and keeps it there as the camera moves', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[label({ id: 'Mascoma Lake' })]}
        putIns={[]}
        hazards={[]}
        onOpenHazard={vi.fn()}
      />,
    );
    const el = node('Mascoma Lake');
    expect(el.style.transform).toBe('translate(300px, 400px)');
    expect(el.style.visibility).toBe('');
    act(() => map.pan(50));
    expect(el.style.transform).toBe('translate(350px, 400px)');
  });

  it('mirrors a label near the right edge', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[label({ id: 'Crystal Lake', anchor: { lng: 9.95, lat: 4 } })]}
        putIns={[]}
        hazards={[]}
        onOpenHazard={vi.fn()}
      />,
    );
    const el = node('Crystal Lake');
    expect(el).toHaveAttribute('data-mirrored');
    const lockup = el.querySelector('[data-slot="lake-label-lockup"]') as HTMLElement;
    expect(lockup.style.right).toBe('18px');
    expect(lockup.style.left).toBe('');
    act(() => map.pan(-500));
    expect(el).not.toHaveAttribute('data-mirrored');
    expect(lockup.style.left).toBe('18px');
  });

  it('hides a label that would cover a hazard mark, or that the camera has left behind', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[
          label({ id: 'Covering', anchor: { lng: 5, lat: 5.1 } }),
          label({ id: 'Offscreen', anchor: { lng: -3, lat: 4 } }),
        ]}
        putIns={[]}
        hazards={[hazard({ id: 'h1' })]}
        onOpenHazard={vi.fn()}
      />,
    );
    expect(node('Covering').style.visibility).toBe('hidden');
    expect(node('Offscreen').style.visibility).toBe('hidden');
  });

  it('keeps clear of the reserved boxes (the dock)', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[label({ id: 'Under the dock' })]}
        putIns={[]}
        hazards={[]}
        onOpenHazard={vi.fn()}
        reserved={() => [{ left: 250, top: 300, right: 500, bottom: 450 }]}
      />,
    );
    expect(node('Under the dock').style.visibility).toBe('hidden');
  });

  it('centers marks on their points and opens a hazard from its mark', () => {
    const { map } = fakeMap();
    const onOpenHazard = vi.fn();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[
          { id: 'p1', lng: 2, lat: 2, name: 'Mascoma Lake Boat Launch' },
          { id: 'p2', lng: 1, lat: 1 },
        ]}
        hazards={[hazard({ id: 'h1', provisional: true }), hazard({ id: 'h2', lng: 6, lat: 6 })]}
        selectedHazardId="h2"
        onOpenHazard={onOpenHazard}
      />,
    );
    const put = screen.getByRole('img', { name: 'Put-in: Mascoma Lake Boat Launch' });
    expect(put.style.transform).toBe('translate(183px, 183px)');
    // Each mark names its own id and kind, for what highlights it from elsewhere.
    expect(put).toHaveAttribute('data-pin', 'p1');
    expect(put.querySelector('svg')).toHaveAttribute('data-kind', 'put-in');
    expect(screen.getByRole('img', { name: 'Put-in' })).toBeInTheDocument();
    const h1 = screen.getByRole('button', { name: 'Hazard: Open water / lead, not yet confirmed' });
    const h2 = screen.getByRole('button', { name: /Hazard: Open water \/ lead$/ });
    expect(h2).toHaveAttribute('aria-current', 'true');
    expect(h2).toHaveAttribute('data-pin', 'h2');
    // The other hazard recedes behind the chosen one, never below half.
    expect(h1.querySelector('svg')?.getAttribute('class')).toContain('opacity-55');
    fireEvent.click(h1);
    expect(onOpenHazard).toHaveBeenCalledWith('h1');
  });

  it('names a hazard type it doesn’t know plainly', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[]}
        hazards={[hazard({ id: 'h', hazardType: 'mystery' })]}
        onOpenHazard={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Hazard: Hazard' })).toBeInTheDocument();
  });

  it('shows a put-in’s name on hover, in the one hover plate', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[
          { id: 'p', lng: 2, lat: 2, name: 'Shakoma Beach' },
          { id: 'q', lng: 1, lat: 1 },
        ]}
        hazards={[]}
        onOpenHazard={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole('img', { name: 'Put-in: Shakoma Beach' }));
    expect(screen.getByText('Shakoma Beach')).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByRole('img', { name: 'Put-in: Shakoma Beach' }));
    expect(screen.queryByText('Shakoma Beach')).toBeNull();
    // A nameless marker answers too. It used to answer with nothing at all, which on a lake where
    // most launches are unnamed (Mascoma: five, two named) read as half the pins being broken.
    fireEvent.pointerEnter(screen.getByRole('img', { name: 'Put-in' }));
    expect(screen.getByText('Unnamed')).toBeInTheDocument();
  });

  it('shows a hazard’s own line on hover — the pins that most need a word before a click', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[]}
        hazards={[hazard({ id: 'h', hazardType: 'open_water' })]}
        onOpenHazard={vi.fn()}
      />,
    );
    const mark = screen.getByRole('button', { name: /^Hazard: / });
    fireEvent.pointerEnter(mark);
    expect(screen.getByText('Hazard')).toBeInTheDocument();
    expect(screen.getByText('Open water / lead')).toBeInTheDocument();
    fireEvent.pointerLeave(mark);
    expect(screen.queryByText('Open water / lead')).toBeNull();
  });

  it('an unconfirmed hazard says so, and never that it is probably fine (D3)', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[]}
        hazards={[hazard({ id: 'h', hazardType: 'open_water', provisional: true })]}
        onOpenHazard={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole('button', { name: /^Hazard: / }));
    const plate = document.querySelector('[data-slot="map-hover-plate"]') as HTMLElement;
    expect(plate.textContent).toContain('Not yet confirmed');
    expect(plate.textContent).not.toMatch(/safe|fine|clear|ok\b/i);
  });

  it('the plate opens on keyboard focus too — a hazard mark is a button', () => {
    const { map } = fakeMap();
    render(
      <MapMarksLayer
        map={map}
        labels={[]}
        putIns={[]}
        hazards={[hazard({ id: 'h' })]}
        onOpenHazard={vi.fn()}
      />,
    );
    const mark = screen.getByRole('button', { name: /^Hazard: / });
    fireEvent.focus(mark);
    expect(document.querySelector('[data-slot="map-hover-plate"]')).not.toBeNull();
    fireEvent.blur(mark);
    expect(document.querySelector('[data-slot="map-hover-plate"]')).toBeNull();
  });

  it('over imagery, fades the one hazard the mouse rests on, and only then', () => {
    const { map } = fakeMap();
    const props = {
      map,
      labels: [],
      putIns: [],
      hazards: [hazard({ id: 'a' }), hazard({ id: 'b', lng: 7, hazardType: 'pressure_ridge' })],
      onOpenHazard: vi.fn(),
    };
    const { rerender } = render(<MapMarksLayer {...props} />);
    const [a, b] = screen.getAllByRole('button') as [HTMLElement, HTMLElement];
    const faded = () => screen.getAllByRole('button').filter((el) => el.hasAttribute('data-peek'));

    // No picture up: a hover is only a hover, the mark stays at full strength.
    fireEvent.pointerEnter(a, { pointerType: 'mouse' });
    expect(faded()).toEqual([]);

    // The picture comes up under a resting mouse: that mark fades, and eases while it does.
    rerender(<MapMarksLayer {...props} imagery />);
    expect(faded()).toEqual([a]);
    expect(a.className).toContain('opacity-35');
    expect(a.className).toContain('transition-opacity');
    expect(b.className).not.toContain('opacity-35');

    // Moving to the next mark hands the fade over — never two at once.
    fireEvent.pointerEnter(b, { pointerType: 'mouse' });
    fireEvent.pointerLeave(a, { pointerType: 'mouse' });
    expect(faded()).toEqual([b]);

    fireEvent.pointerLeave(b, { pointerType: 'mouse' });
    expect(faded()).toEqual([]);

    // Focus is inspecting the mark itself, and a tap opens it: neither fades it.
    act(() => a.focus());
    expect(faded()).toEqual([]);
    fireEvent.pointerEnter(a, { pointerType: 'touch' });
    expect(faded()).toEqual([]);
  });

  it('stops following the camera when it unmounts', () => {
    const { map, handlers } = fakeMap();
    const { unmount } = render(
      <MapMarksLayer map={map} labels={[]} putIns={[]} hazards={[]} onOpenHazard={vi.fn()} />,
    );
    expect(handlers.get('move')?.size).toBe(1);
    unmount();
    expect(handlers.get('move')?.size).toBe(0);
  });

  it('re-lays out once the fonts land', async () => {
    const { map } = fakeMap();
    let ready: () => void = () => {};
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise<void>((r) => (ready = r)) },
    });
    render(
      <MapMarksLayer
        map={map}
        labels={[label({ id: 'Late font' })]}
        putIns={[]}
        hazards={[]}
        onOpenHazard={vi.fn()}
      />,
    );
    await act(async () => {
      ready();
      await Promise.resolve();
    });
    expect(node('Late font').style.transform).toBe('translate(300px, 400px)');
    Reflect.deleteProperty(document, 'fonts');
  });
});
