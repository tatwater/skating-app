import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectorProvider } from '../../inspector/inspectorContext';
import { CorpusHeadMap, HEAD_MAP_MAX_ZOOM } from './CorpusHeadMap';
import { TAYLOR_POND, THE_BASIN } from './corpusMapFixtures';

/**
 * **The head map, wired**: `CorpusHeadMap` asks `waterBodies.get` for the body and each neighbor,
 * draws the Inbox's embed in the theme's mode — view-only on a narrow page — and says a failed body
 * read with *Try again*. The embed, the theme and the read layer are stood in; the states from props
 * are `headMapScene.test.ts`.
 */

const stub = vi.hoisted(() => ({
  /** `waterBodies.get`'s answer by the body id asked. */
  answers: {} as Record<string, unknown>,
  theme: 'dark' as 'dark' | 'light',
  retry: () => {},
}));

vi.mock('../../inbox/map/InboxMap', () => ({
  InboxMap: ({
    view,
    mode,
    height,
    viewOnly,
    aerial,
    maxZoom,
  }: {
    view: { scene: { items: { id: string }[] } };
    mode: string;
    height: number;
    viewOnly?: boolean;
    aerial?: boolean;
    maxZoom?: number;
  }) => (
    <div
      data-slot="stub-map"
      data-mode={mode}
      data-height={height}
      data-view-only={viewOnly ? '' : undefined}
      data-aerial={aerial ? '' : undefined}
      data-max-zoom={maxZoom}
      data-items={view.scene.items.map((i) => i.id).join(' ')}
    />
  ),
}));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: stub.theme }),
}));
vi.mock('../../reads/consoleReads', async (orig) => ({
  ...(await orig<typeof import('../../reads/consoleReads')>()),
  useConsoleReadSet: (specs: Record<string, { args: { waterBodyId: string } } | null>) => {
    const reads: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(specs)) {
      if (spec !== null) reads[k] = stub.answers[spec.args.waterBodyId];
    }
    return { reads, retry: () => stub.retry(), live: true, failed: false, pending: false };
  },
}));

const doc = (id: string, name: string, polygon: unknown) => ({
  available: true,
  body: { _id: id, name, polygon },
});

beforeEach(() => {
  stub.answers = {};
  stub.theme = 'dark';
  stub.retry = () => {};
});

const narrowly = (children: ReactNode) => (
  <InspectorProvider
    value={{ pane: { current: null }, decidedOnOpen: false, now: 0, narrow: true }}
  >
    {children}
  </InspectorProvider>
);

const basinMap = (
  <CorpusHeadMap
    bodyId={'wbbasin' as never}
    neighbors={[{ id: 'wbtaylor' as never, name: 'Taylor Pond' }]}
    height={200}
    square
  />
);

describe('the head map, wired', () => {
  it('draws the embed with the body and its neighbor, in the theme’s mode, movable when wide', () => {
    stub.answers = {
      wbbasin: doc('wbbasin', 'The Basin', THE_BASIN),
      wbtaylor: doc('wbtaylor', 'Taylor Pond', TAYLOR_POND),
    };
    stub.theme = 'light';
    render(basinMap);
    const drawn = document.querySelector<HTMLElement>('[data-slot="stub-map"]');
    expect(drawn?.dataset.mode).toBe('light');
    expect(drawn?.dataset.height).toBe('200');
    expect(drawn).not.toHaveAttribute('data-view-only');
    expect(drawn?.dataset.items).toContain('body:wbbasin');
    expect(drawn?.dataset.items).toContain('neighbor:wbtaylor');
    // Square beside the pane head: its width is its height.
    const box = document.querySelector<HTMLElement>('[data-slot="head-map"]');
    expect(box?.style.width).toBe('200px');
  });

  it('is view-only on a narrow page, and dark under any theme but light', () => {
    stub.answers = { wbbasin: doc('wbbasin', 'The Basin', THE_BASIN) };
    render(narrowly(basinMap));
    const drawn = document.querySelector<HTMLElement>('[data-slot="stub-map"]');
    expect(drawn).toHaveAttribute('data-view-only');
    expect(drawn?.dataset.mode).toBe('dark');
  });

  it('draws the summer aerial when its handler asks (4.3), none otherwise (4.2), and frames closer', () => {
    stub.answers = { wbbasin: doc('wbbasin', 'The Basin', THE_BASIN) };
    const { unmount } = render(basinMap);
    let drawn = document.querySelector<HTMLElement>('[data-slot="stub-map"]');
    expect(drawn).not.toHaveAttribute('data-aerial');
    expect(drawn?.dataset.maxZoom).toBe(String(HEAD_MAP_MAX_ZOOM));
    unmount();
    render(<CorpusHeadMap bodyId={'wbbasin' as never} neighbors={[]} height={250} aerial />);
    drawn = document.querySelector<HTMLElement>('[data-slot="stub-map"]');
    expect(drawn).toHaveAttribute('data-aerial');
    expect(HEAD_MAP_MAX_ZOOM).toBeGreaterThan(17);
  });

  it('says a failed body read with Try again, which asks the reads again', async () => {
    const retry = vi.fn();
    stub.retry = retry;
    stub.answers = { wbbasin: { failed: true, pending: false, retry: () => {} } };
    render(basinMap);
    expect(document.querySelector('[data-slot="stub-map"]')).toBeNull();
    const failed = document.querySelector<HTMLElement>('[data-slot="head-map-failed"]');
    expect(failed?.textContent).toContain('The map didn’t load');
    expect(failed?.style.height).toBe('200px');
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(retry).toHaveBeenCalled();
  });
});
