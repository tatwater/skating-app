import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { InboxMapStill } from './InboxMap';
import { ItemMapView } from './ItemMap';
import {
  ACCESS_MAP,
  ACCESS_REPORTS,
  EMPTY_MAP,
  SAFETY,
  SAFETY_MAP,
  TICKET,
} from './itemMapFixtures';

/** The item map's states: loading holds the embed's box, a failure says so, nothing collapses. */

beforeAll(stubJsdomAnimations);

const still = (view: Parameters<typeof InboxMapStill>[0]['view']) => (
  <InboxMapStill view={view} width={336} />
);

describe('ItemMapView', () => {
  it('holds the embed’s box while it loads', () => {
    const { container } = render(<ItemMapView item={SAFETY} state={undefined} renderMap={still} />);
    const box = container.querySelector<HTMLElement>('[data-slot="item-map-loading"]');
    expect(box?.style.height).toBe('300px');
  });

  it('says a failed read, with Try again', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const state = (await import('../../reads/consoleReads')).retryAll([]);
    render(<ItemMapView item={SAFETY} state={state} renderMap={still} onRetry={onRetry} />);
    expect(screen.getByText('The map didn’t load')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('collapses with nothing to draw', () => {
    const { container } = render(
      <ItemMapView
        item={SAFETY}
        state={{ map: EMPTY_MAP('flag'), pending: false }}
        renderMap={still}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    const none = render(
      <ItemMapView item={SAFETY} state={{ map: null, pending: true }} renderMap={still} />,
    );
    expect(none.container).toBeEmptyDOMElement();
  });

  it('draws the embed for an answer', () => {
    const { container } = render(
      <ItemMapView item={SAFETY} state={{ map: SAFETY_MAP, pending: false }} renderMap={still} />,
    );
    expect(
      container.querySelector('[data-slot="item-map"] [data-slot="inbox-map"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-mark="reticle"]')).not.toBeNull();
  });
});

describe('the aerial switch', () => {
  it('is never drawn for an item: no answer carries a pass this wave, so there is nothing to switch', async () => {
    const f = await import('./itemMapFixtures');
    const { itemMapScene } = await import('./itemMapAdapters');
    const cases = [
      [f.SAFETY, f.SAFETY_MAP],
      [f.ALERT_FLAG, f.ALERT_MAP],
      [f.ACCESS_REPORTS, f.ACCESS_MAP],
      [f.ADMIT_MATCH, f.ADMIT_MAP],
      [f.ACTIVATE, f.ACTIVATE_MAP],
      [f.PLACE, f.PLACE_MAP],
      [f.DRAWN, f.DRAWN_MAP],
    ] as const;
    for (const [item, map] of cases) {
      const view = itemMapScene(item, map);
      expect(view?.scene.items.some((i) => i.kind === 'raster')).toBe(false);
      const { container, unmount } = render(
        <ItemMapView item={item} state={{ map, pending: false }} renderMap={still} />,
      );
      expect(container.querySelector('[role="switch"]')).toBeNull();
      expect(container.querySelector('[data-layer="aerial"]')).toBeNull();
      unmount();
    }
  });
});

describe('ItemMap', () => {
  it('reads only a kind with a map, and only with the body read’s capability', async () => {
    vi.resetModules();
    const asked: unknown[] = [];
    let can = true;
    vi.doMock('@/lib/useRole', () => ({ useRole: () => ({ can: () => can }) }));
    vi.doMock('@/components/theme-provider', () => ({
      useTheme: () => ({ resolvedTheme: 'light' }),
    }));
    vi.doMock('../../reads/consoleReads', async (orig) => {
      const actual = await orig<typeof import('../../reads/consoleReads')>();
      return {
        ...actual,
        useConsoleReadSet: (specs: { map: unknown }) => {
          asked.push(specs.map);
          return {
            reads: { map: specs.map ? { map: ACCESS_MAP, pending: false } : undefined },
            retry: () => {},
            pending: false,
          };
        },
      };
    });
    vi.doMock('./InboxMap', async (orig) => ({
      ...(await orig<typeof import('./InboxMap')>()),
      InboxMap: () => <div data-slot="live-map" />,
    }));
    const { ItemMap } = await import('./ItemMap');
    const { container, rerender } = render(<ItemMap item={ACCESS_REPORTS} />);
    expect(container.querySelector('[data-slot="live-map"]')).not.toBeNull();
    expect(asked.at(-1)).not.toBeNull();
    rerender(<ItemMap item={TICKET} />);
    expect(asked.at(-1)).toBeNull();
    expect(container).toBeEmptyDOMElement();
    can = false;
    rerender(<ItemMap item={ACCESS_REPORTS} />);
    expect(asked.at(-1)).toBeNull();
    expect(container).toBeEmptyDOMElement();
    vi.doUnmock('@/lib/useRole');
    vi.doUnmock('@/components/theme-provider');
    vi.doUnmock('../../reads/consoleReads');
    vi.doUnmock('./InboxMap');
  });
});

describe('ItemMap’s dates', () => {
  it('reads a date on the map in the inspector’s zone, as every date beside it does', async () => {
    vi.resetModules();
    vi.doMock('@/lib/useRole', () => ({ useRole: () => ({ can: () => true }) }));
    vi.doMock('@/components/theme-provider', () => ({
      useTheme: () => ({ resolvedTheme: 'dark' }),
    }));
    const { DRAWN, DRAWN_MAP } = await import('./itemMapFixtures');
    vi.doMock('../../reads/consoleReads', async (orig) => ({
      ...(await orig<typeof import('../../reads/consoleReads')>()),
      useConsoleReadSet: () => ({
        reads: { map: { map: DRAWN_MAP, pending: false } },
        retry: () => {},
        pending: false,
      }),
    }));
    const legends: string[][] = [];
    vi.doMock('./InboxMap', async (orig) => ({
      ...(await orig<typeof import('./InboxMap')>()),
      InboxMap: ({ view }: { view: { legend: { label: string }[] } }) => {
        legends.push(view.legend.map((r) => r.label));
        return null;
      },
    }));
    const { ItemMap } = await import('./ItemMap');
    const { InspectorProvider } = await import('../inspector/inspectorContext');
    const at = (timeZone: string) =>
      render(
        <InspectorProvider
          value={{ pane: { current: null }, decidedOnOpen: false, now: 0, timeZone }}
        >
          <ItemMap item={DRAWN} />
        </InspectorProvider>,
      ).unmount();
    // Noon on 12 Oct in New York is already the 13th at UTC+14.
    at('America/New_York');
    at('Pacific/Kiritimati');
    expect(legends.map((l) => l[1])).toEqual([
      'Drawn 12 Oct · Kate Donovan',
      'Drawn 13 Oct · Kate Donovan',
    ]);
    vi.doUnmock('@/lib/useRole');
    vi.doUnmock('@/components/theme-provider');
    vi.doUnmock('../../reads/consoleReads');
    vi.doUnmock('./InboxMap');
  });
});
