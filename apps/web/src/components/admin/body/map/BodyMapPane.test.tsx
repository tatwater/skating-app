import { LANDMARK_KINDS } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MASCOMA_BOUNDS, MASCOMA_SCENE } from '../frame/bodyFixtures';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyMapStillView } from './BodyMap';
import { BodyMapKey } from './BodyMapMarks';
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
