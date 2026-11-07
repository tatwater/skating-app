/**
 * The folded credits, driven through MapLibre's **real** `AttributionControl` — not a fake.
 *
 * The bug this replaces lived entirely in the gap between a fake and the library: the old test
 * handed the shell a control already in MapLibre's expanded state, so removing the show class at
 * mount passed, while in a browser the control was not compact yet at mount (no source had loaded)
 * and expanded itself later. The only honest check is the library's own lifecycle, so the map here
 * is the smallest stand-in the control actually touches: `on`/`off`, a style whose tile managers
 * carry sources, the UI-string lookup, and a canvas container to measure.
 */

import maplibregl from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { FoldedAttributionControl } from './mapAttribution';

const OSM = '© OpenStreetMap contributors';
const COPERNICUS = 'Copernicus Sentinel data 2025–2026';
const AERIAL = 'USDA, USGS The National Map: Orthoimagery';

/** A source as the control sees it: used, with or without an attribution. */
const source = (attribution?: string) => ({
  used: true,
  usedForTerrain: false,
  getSource: () => ({ attribution }),
});

class StubMap {
  handlers = new Map<string, Set<(e?: unknown) => void>>();
  style = { stylesheet: {}, tileManagers: {} as Record<string, ReturnType<typeof source>> };
  canvasContainer = document.createElement('div');
  on(event: string, fn: (e?: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)?.add(fn);
    return this;
  }
  off(event: string, fn: (e?: unknown) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  fire(event: string, e: unknown = { type: event }) {
    for (const fn of this.handlers.get(event) ?? []) fn(e);
  }
  getCanvasContainer() {
    return this.canvasContainer;
  }
  _getUIString(key: string) {
    return key === 'AttributionControl.ToggleAttribution' ? 'Toggle attribution' : key;
  }
  /** A source finishes loading its metadata — what makes the control re-read the credits. */
  addSource(id: string, attribution?: string) {
    this.style.tileManagers[id] = source(attribution);
    this.fire('sourcedata', { type: 'sourcedata', sourceDataType: 'metadata' });
  }
  removeSource(id: string) {
    delete this.style.tileManagers[id];
    this.fire('sourcedata', { type: 'sourcedata', sourceDataType: 'metadata' });
  }
}

/** Mount the control the way `map.addControl` does: `onAdd`, then into the document. */
function mount(control: maplibregl.AttributionControl = new FoldedAttributionControl()) {
  const map = new StubMap();
  const container = control.onAdd(map as unknown as maplibregl.Map) as HTMLDetailsElement;
  document.body.append(container);
  const summary = container.querySelector('summary') as HTMLElement;
  const inner = container.querySelector('.maplibregl-ctrl-attrib-inner') as HTMLElement;
  return { map, control, container, summary, inner };
}

const shown = (el: Element) => el.classList.contains('maplibregl-compact-show');

/**
 * A press on the ⓘ as a browser runs it: MapLibre's click handler, then the `<summary>`'s own
 * activation behavior flipping `open` (jsdom implements that part, so a click is the whole press).
 */
function press(summary: HTMLElement) {
  summary.click();
}

describe('FoldedAttributionControl', () => {
  it('is MapLibre’s compact attribution control', () => {
    const control = new FoldedAttributionControl();
    expect(control).toBeInstanceOf(maplibregl.AttributionControl);
    expect(control.options.compact).toBe(true);
  });

  /**
   * ⚠ The case the earlier fix missed: at mount no source has loaded, so MapLibre marks the control
   * empty and does not compact it; the first source's metadata compacts it **expanded**. This pins
   * MapLibre's half of that, so an upgrade that changes it shows up here first.
   */
  it('MapLibre alone mounts empty and then expands on the first source (the bug)', () => {
    const { map, container } = mount(new maplibregl.AttributionControl({ compact: true }));
    expect(container.classList.contains('maplibregl-attrib-empty')).toBe(true);
    expect(container.classList.contains('maplibregl-compact')).toBe(false);
    map.addSource('water', OSM);
    expect(container.classList.contains('maplibregl-compact')).toBe(true);
    expect(shown(container)).toBe(true);
  });

  it('folds the credits behind the ⓘ when the first source brings them', () => {
    const { map, container, inner } = mount();
    map.addSource('water', OSM);
    expect(container.classList.contains('maplibregl-compact')).toBe(true);
    expect(shown(container)).toBe(false);
    expect(container.open).toBe(false);
    // Folded, not dropped: the exact credit is in the control, one press away.
    expect(inner.textContent).toBe(OSM);
  });

  it('folds a control that already has credits at mount', () => {
    const map = new StubMap();
    map.style.tileManagers.water = source(OSM);
    const container = new FoldedAttributionControl().onAdd(map as unknown as maplibregl.Map);
    expect(container.classList.contains('maplibregl-compact')).toBe(true);
    expect(shown(container)).toBe(false);
  });

  it('stays folded through resizes and later sources', () => {
    const { map, container, inner } = mount();
    map.addSource('water', OSM);
    map.fire('resize');
    map.addSource('freeze-up', COPERNICUS);
    map.addSource('aerial', AERIAL);
    expect(shown(container)).toBe(false);
    // Every active source's credit rides in the control, in MapLibre's order (shortest first).
    expect(inner.textContent).toBe(`${OSM} | ${COPERNICUS} | ${AERIAL}`);
    map.removeSource('aerial');
    expect(inner.textContent).toBe(`${OSM} | ${COPERNICUS}`);
  });

  it('opens on the ⓘ and folds again on a second press', () => {
    const { map, container, summary } = mount();
    map.addSource('water', OSM);
    press(summary);
    expect(shown(container)).toBe(true);
    expect(container.open).toBe(true);
    press(summary);
    expect(shown(container)).toBe(false);
    expect(container.open).toBe(false);
  });

  it('never re-folds credits the skater opened when a source arrives later', () => {
    const { map, container, summary, inner } = mount();
    map.addSource('water', OSM);
    press(summary);
    map.addSource('freeze-up', COPERNICUS);
    map.fire('resize');
    expect(shown(container)).toBe(true);
    expect(inner.textContent).toBe(`${OSM} | ${COPERNICUS}`);
  });

  it('closes the <details> too when a drag folds the open credits', () => {
    const { map, container, summary } = mount();
    map.addSource('water', OSM);
    press(summary);
    map.fire('drag');
    expect(shown(container)).toBe(false);
    expect(container.open).toBe(false);
  });

  it('leaves a folded control alone on a drag', () => {
    const { map, container } = mount();
    map.addSource('water', OSM);
    container.setAttribute('open', ''); // not ours to touch unless the drag folded it
    map.fire('drag');
    expect(container.open).toBe(true);
  });

  /**
   * The toggle's accessible shape: a native `<summary>` — focusable, so a Tab reaches it, and
   * Enter/Space activate it as a click — inside a `<details>` whose `open` carries the expanded
   * state, labeled by MapLibre's UI string.
   */
  it('is a labeled, keyboard-reachable disclosure', () => {
    const { map, container, summary } = mount();
    map.addSource('water', OSM);
    expect(container.tagName).toBe('DETAILS');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.getAttribute('aria-label')).toBe('Toggle attribution');
    expect(summary.title).toBe('Toggle attribution');
    summary.focus();
    expect(document.activeElement).toBe(summary);
  });

  it('unsubscribes on removal', () => {
    const { map, control } = mount();
    control.onRemove();
    for (const set of map.handlers.values()) expect(set.size).toBe(0);
  });
});
