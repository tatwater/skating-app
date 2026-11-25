import { LANDMARK_KINDS } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { hazardsMapScene } from '../tabs/hazards/hazardsMap';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyMapStillView } from './BodyMap';
import { BodyMapKey } from './BodyMapMarks';
import { BodyMapPane, RACK_UNDER_TOOL } from './BodyMapPane';
import { drawScene, layerSwitches, mergeScenes } from './bodyScene';
import type { MapPointMark } from './mapDescriptors';

/**
 * The map pane's chrome over a still: the hover plate follows the pointer (and forgets a mark that
 * leaves the scene under it), and the graticule's labels keep clear of the chrome — measured again
 * when the chrome changes size, and never kept out by a box with no area (the foot's empty live
 * region).
 */

const W = 656;
const H = 830;
/** The key's bar, which the foot sits on. */
const KEY = 30;

beforeAll(stubJsdomAnimations);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rect = (left: number, top: number, right: number, bottom: number) =>
  ({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  }) as DOMRect;

/** Lays the pane out as a browser would: the pane at the origin, the foot `foot()` px tall on the key. */
function layout(foot: () => number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const slot = this.getAttribute('data-slot');
    if (slot === 'body-map') return rect(0, 0, W, H);
    if (slot === 'body-map-foot') return rect(0, H - KEY - foot(), W, H - KEY);
    return rect(0, 0, 0, 0);
  });
}

const longitudes = () =>
  [...document.querySelectorAll('[data-slot="map-graticule-label"]')]
    .map((l) => l.textContent ?? '')
    .filter((t) => t.endsWith('°W'));

function Still({ foot }: { foot?: ReactNode }) {
  return (
    <BodyMapStillView
      bbox={MASCOMA_BOUNDS}
      scene={MASCOMA_SCENE}
      resetKey="shape"
      width={W}
      height={H}
      foot={foot}
    />
  );
}

describe('BodyMapPane', () => {
  it('labels the longitudes over an empty foot — a box with no area keeps nothing out', () => {
    layout(() => 0);
    render(<Still foot={<div data-slot="empty-notice" />} />);
    expect(longitudes().length).toBeGreaterThan(0);
  });

  it('measures the foot again when it grows, and keeps the longitudes off it', () => {
    const resized: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    let foot = 0;
    layout(() => foot);
    render(<Still foot={<div data-slot="notice" />} />);
    expect(longitudes().length).toBeGreaterThan(0);
    // The map's notice arrives in the foot: it grows, and the row it now covers loses its labels.
    foot = 40;
    act(() => {
      for (const cb of resized) cb();
    });
    expect(longitudes()).toEqual([]);
  });

  it('forgets a hovered mark that leaves the scene, so it never comes back hovered', async () => {
    const user = userEvent.setup();
    render(<Still />);
    const putIn = () =>
      document.querySelector<HTMLElement>('[data-slot="body-map-point"][data-mark="putIn"]');
    fireEvent.pointerEnter(putIn() as HTMLElement);
    expect(document.querySelector('[data-slot="map-hover-plate"]')).not.toBeNull();
    const putIns = screen.getByRole('switch', { name: /Put-ins/ });
    await user.click(putIns);
    expect(putIn()).toBeNull();
    await user.click(putIns);
    expect(putIn()).not.toBeNull();
    expect(document.querySelector('[data-slot="map-hover-plate"]')).toBeNull();
  });

  it('a pin at its field’s fade never steps back for another mark’s plate — no fainter than its field', () => {
    const { minLng, maxLng, minLat, maxLat } = MASCOMA_BOUNDS;
    const pins = hazardsMapScene(
      {
        season: 2025,
        current: 2025,
        hazards: [
          {
            _id: 'stale-pin',
            type: 'thin_ice',
            geometryKind: 'point_radius',
            geometry: {
              type: 'Point',
              coordinates: [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
            },
            radiusMeters: Number.NaN,
            freshness: 'stale',
            provisional: true,
          },
        ],
        features: [],
      },
      null,
    );
    render(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={mergeScenes(MASCOMA_SCENE, pins)}
        resetKey="pins"
        width={W}
        height={H}
      />,
    );
    const pin = () =>
      document.querySelector('[data-slot="body-map-point"][data-id="hazard:stale-pin"] svg');
    expect(pin()).not.toBeNull();
    fireEvent.pointerEnter(
      document.querySelector('[data-slot="body-map-point"][data-mark="putIn"]') as HTMLElement,
    );
    // The other marks step back; the pin stays at exactly its field's fade.
    expect(
      document.querySelectorAll('[data-slot="body-map-point"] svg[data-fade]').length,
    ).toBeGreaterThan(0);
    expect(pin()?.hasAttribute('data-fade')).toBe(false);
  });
});

describe('the map pane and the keyboard', () => {
  it('answers the keyboard wherever it answers a click: the rack, the zoom, the marks', () => {
    const { container } = render(<Still />);
    expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
  });
});

describe('the rack’s switches', () => {
  it('a tab change restores the tab’s defaults: switches made on Shape don’t come back after Names', async () => {
    const user = userEvent.setup();
    const at = (key: string) => (
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey={key}
        width={W}
        height={H}
      />
    );
    const { rerender } = render(at('k1:shape'));
    const putIns = () => screen.getByRole('switch', { name: /Put-ins/ });
    expect(putIns()).toBeChecked();
    await user.click(putIns());
    expect(putIns()).not.toBeChecked();
    rerender(at('k1:names'));
    expect(putIns()).toBeChecked();
    rerender(at('k1:shape'));
    // Cleared when the key changed, not parked for the next visit.
    expect(putIns()).toBeChecked();
  });
});

describe('the summer aerial on the console map', () => {
  it('is the rack’s last row, never disabled, and draws its stand-in and credit while on', async () => {
    const user = userEvent.setup();
    render(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
        aerialCapturedAt={Date.UTC(2023, 5, 22)}
      />,
    );
    const rack = screen.getAllByRole('switch');
    const aerial = screen.getByRole('switch', { name: 'Summer aerial' });
    expect(rack.at(-1)).toBe(aerial);
    expect(aerial).not.toBeChecked();
    expect(aerial).not.toHaveAttribute('data-disabled');
    // The winter pass's own row stays what it was: disabled with no pass in the scene.
    expect(screen.getByRole('switch', { name: 'Aerial' })).toHaveAttribute('data-disabled');
    expect(document.querySelector('[data-slot="body-map-aerial-still"]')).toBeNull();
    expect(document.querySelector('[data-slot="body-map-aerial-credit"]')).toBeNull();

    await user.click(aerial);
    expect(aerial).toBeChecked();
    expect(document.querySelector('[data-slot="body-map-aerial-still"]')).not.toBeNull();
    const credit = document.querySelector('[data-slot="body-map-aerial-credit"]');
    expect(credit).toHaveTextContent('Aerial · NAIP Jun 2023');
    // In the dock, before the scale and the zoom pair: board 4.3's corner.
    const group = credit?.parentElement;
    expect(group?.parentElement).toHaveAttribute('data-slot', 'map-dock');
    expect(group?.parentElement?.firstElementChild).toBe(group);
    expect(group?.firstElementChild).toBe(credit);
    // In: nothing owed, nothing to press.
    expect(credit).toHaveAttribute('data-state', 'loaded');
    expect(document.querySelector('[data-slot="body-map-aerial-retry"]')).toBeNull();
  });

  it('draws over the fills and under every line: the shore stays on top', () => {
    render(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
        aerial
      />,
    );
    const svg = document.querySelector('[data-slot="body-map-still"]') as SVGElement;
    const children = [...svg.children];
    const stand = children.findIndex(
      (c) => c.getAttribute('data-slot') === 'body-map-aerial-still',
    );
    const shore = children.findIndex((c) => c.getAttribute('data-id')?.startsWith('body'));
    expect(stand).toBeGreaterThan(0);
    expect(shore).toBeGreaterThan(stand);
  });

  it('a switch a tab change resets (Put-ins) is not the aerial’s: it stays as the viewer left it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
      />,
    );
    await user.click(screen.getByRole('switch', { name: 'Summer aerial' }));
    await user.click(screen.getByRole('switch', { name: 'Put-ins' }));
    rerender(
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="names"
        width={W}
        height={H}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Put-ins' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Summer aerial' })).toBeChecked();
  });
});

describe('BodyMapKey', () => {
  const words = () => screen.getAllByRole('listitem').map((i) => i.textContent);

  it('lists access, then places, once per word — a known feature is a hazard', () => {
    render(<BodyMapKey kinds={['island', 'lot', 'putIn', 'hazard', 'feature']} />);
    expect(words()).toEqual(['Put-in', 'Lot', 'Island', 'Hazard']);
  });

  it('has a word for every face the map draws, and none says anything about the ice', () => {
    const faces: MapPointMark[] = [
      ...LANDMARK_KINDS,
      'putIn',
      'lot',
      'sample',
      'hazard',
      'healing',
      'passage',
      'feature',
      'photo',
      'proposal',
    ];
    render(<BodyMapKey kinds={faces} />);
    // Every face but the known feature (listed as a hazard) has its own entry.
    expect(words()).toHaveLength(faces.length - 1);
    for (const word of words()) expect(word).not.toMatch(/safe|skateable|good|ok\b/i);
  });
});

describe('the tool’s mode bar (B01-6a)', () => {
  const drawn = drawScene(MASCOMA_SCENE, layerSwitches(MASCOMA_SCENE.layers, {}));
  it('says the mode, what to do next and the step, and its Esc cap leaves the tool', async () => {
    const onExit = vi.fn();
    render(
      <BodyMapPane
        surface={null}
        ground={null}
        drawn={drawn}
        rack={false}
        tool={{ mode: 'Bay mode', line: 'Click the shore', step: 'Step 1 of 4', onExit }}
      />,
    );
    const bar = screen.getByRole('status');
    expect(bar.textContent).toContain('Bay mode');
    expect(bar.textContent).toContain('Click the shore');
    expect(bar.textContent).toContain('Step 1 of 4');
    await userEvent.click(screen.getByRole('button', { name: 'Leave bay mode' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('lets the pointer through the marks to a tool that takes it, and forgets their hover', () => {
    const still = (tool: { mode: string; onExit: () => void; takesPointer?: boolean } | null) => (
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
        tool={tool}
      />
    );
    const { rerender } = render(still(null));
    const marks = () => [...document.querySelectorAll('[data-slot="body-map-point"]')];
    const plate = () => document.querySelector('[data-slot="map-hover-plate"]');
    expect(marks().length).toBeGreaterThan(0);
    for (const m of marks()) expect(m).toHaveClass('pointer-events-auto');
    fireEvent.pointerEnter(marks()[0] as HTMLElement);
    expect(plate()).not.toBeNull();
    // Placing: a click on a lot is the tool's, and a landmark's mark never covers its drag handle.
    rerender(still({ mode: 'Place mode', onExit: () => {}, takesPointer: true }));
    for (const m of marks()) {
      expect(m).toHaveClass('pointer-events-none');
      expect(m).not.toHaveClass('pointer-events-auto');
    }
    expect(plate()).toBeNull();
    // A tool with no engine on the map leaves the marks as they were.
    rerender(still({ mode: 'Sample mode', onExit: () => {} }));
    for (const m of marks()) expect(m).toHaveClass('pointer-events-auto');
  });

  it('draws no bar while no tool is held', () => {
    render(<BodyMapPane surface={null} ground={null} drawn={drawn} rack={false} />);
    expect(document.querySelector('[data-slot="map-mode-bar"]')).toBeNull();
  });

  it('drops the rack under the bar while a tool is held, and puts it back when the tool goes', () => {
    const tool = { mode: 'Bay mode', onExit: () => {} };
    const still = (held: typeof tool | null) => (
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
        tool={held}
      />
    );
    const { rerender } = render(still(tool));
    const rack = () => screen.getByRole('group', { name: 'Map layers' });
    // The kit's own rule looks for the bar inside `[data-slot=map-pane]`; this pane is `body-map`,
    // so the rule can't match and the pane says the offset itself.
    expect(rack().closest('[data-slot="map-pane"]')).toBeNull();
    expect(rack()).toHaveClass(RACK_UNDER_TOOL);
    // One rule for the rack's top: the corner's is gone, not merely outvoted.
    expect(rack()).not.toHaveClass('top-(--space-5)');
    // …and the measure it names is the kit rack's own, set on the rack.
    expect(rack().style.getPropertyValue('--rack-under-mode')).not.toBe('');
    rerender(still(null));
    expect(rack()).not.toHaveClass(RACK_UNDER_TOOL);
    expect(rack()).toHaveClass('top-(--space-5)');
  });

  it('measures the chrome again when a tool’s bar goes up: the labels keep clear of it', () => {
    // The pane at the origin, and the bar laid out down the right edge (taller than it is drawn, so
    // every parallel's label meets it): only a new measure can know it is there.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const slot = this.getAttribute('data-slot');
      if (slot === 'body-map') return rect(0, 0, W, H);
      if (slot === 'map-mode-bar') return rect(20, 14, W - 20, H);
      return rect(0, 0, 0, 0);
    });
    const latitudes = () =>
      [...document.querySelectorAll('[data-slot="map-graticule-label"]')]
        .map((l) => l.textContent ?? '')
        .filter((t) => t.endsWith('°N'));
    const still = (held: boolean) => (
      <BodyMapStillView
        bbox={MASCOMA_BOUNDS}
        scene={MASCOMA_SCENE}
        resetKey="shape"
        width={W}
        height={H}
        tool={held ? { mode: 'Bay mode', onExit: () => {} } : null}
      />
    );
    const { rerender } = render(still(false));
    expect(latitudes().length).toBeGreaterThan(0);
    rerender(still(true));
    expect(latitudes()).toEqual([]);
    // …and back when the tool goes.
    rerender(still(false));
    expect(latitudes().length).toBeGreaterThan(0);
  });
});
