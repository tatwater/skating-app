import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { EMBED_HEIGHT, InboxMap, InboxMapStill, legendItem } from './InboxMap';
import { ADMIT, ALERT, DRAWN, LOOKALIKE, REPORT_POINT } from './inboxMapFixtures';
import {
  admitScene,
  alertScene,
  drawnScene,
  lookalikeScene,
  reportPointScene,
} from './inboxMapScene';

/**
 * The embed over a still: no rack, no key, the zoom pair reached and pressed from the keyboard and
 * held to the console map's floor and ceiling, the legend drawn from the map's own style table, and
 * a phone's view-only embed with no zoom pair at all.
 */

beforeAll(stubJsdomAnimations);

const scale = () => screen.getByRole('img', { name: /^Scale:/ }).getAttribute('aria-label');

describe('the embed', () => {
  it('has no rack and no key — only the item, and the zoom pair in its corner', () => {
    const { container } = render(<InboxMapStill view={alertScene(ALERT)} width={300} />);
    expect(container.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
    expect(container.querySelector('[data-slot="map-key"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    const embed = container.querySelector<HTMLElement>('[data-slot="inbox-map"]');
    expect(embed?.style.height).toBe(`${EMBED_HEIGHT}px`);
    // The lit put-in is named in the corner, and no standing plate runs off the embed.
    expect(container.querySelector('[data-slot="inbox-map-caption"]')).toHaveTextContent(
      'Fairlee town launch',
    );
    expect(container.querySelector('[data-slot="map-hover-plate"]')).toBeNull();
  });

  it('zooms from the keyboard, in to the street and out a step and a half past the framing', async () => {
    const user = userEvent.setup();
    render(<InboxMapStill view={reportPointScene(REPORT_POINT)} width={280} height={360} />);
    const framed = scale();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(scale()).not.toBe(framed);
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    await user.click(zoomOut);
    expect(scale()).toBe(framed);
    // At the framing, out is open: one step out is within the floor; a second would pass it.
    expect(zoomOut).toBeEnabled();
    await user.click(zoomOut);
    expect(zoomOut).toBeDisabled();
  });

  it('stops zooming in at the street', async () => {
    const user = userEvent.setup();
    render(<InboxMapStill view={reportPointScene(REPORT_POINT)} width={280} />);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 12 && !(zoomIn as HTMLButtonElement).disabled; i++)
      await user.click(zoomIn);
    expect(zoomIn).toBeDisabled();
  });

  it('goes closer than the street when its caller raises the ceiling', async () => {
    const user = userEvent.setup();
    const presses = async (maxZoom?: number) => {
      const { unmount } = render(
        <InboxMapStill view={reportPointScene(REPORT_POINT)} width={280} maxZoom={maxZoom} />,
      );
      const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
      let n = 0;
      for (; n < 12 && !(zoomIn as HTMLButtonElement).disabled; n++) await user.click(zoomIn);
      unmount();
      return n;
    };
    expect(await presses(19)).toBe((await presses()) + 2);
  });

  it('draws the summer aerial’s stand-in and its credit only when asked', () => {
    const { container, rerender } = render(<InboxMapStill view={alertScene(ALERT)} width={300} />);
    expect(container.querySelector('[data-slot="body-map-aerial-still"]')).toBeNull();
    expect(container.querySelector('[data-slot="body-map-aerial-credit"]')).toBeNull();
    rerender(
      <InboxMapStill
        view={alertScene(ALERT)}
        width={300}
        aerial
        aerialCapturedAt={Date.UTC(2023, 5, 22)}
      />,
    );
    expect(container.querySelector('[data-slot="body-map-aerial-still"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="body-map-aerial-credit"]')).toHaveTextContent(
      'Aerial · NAIP Jun 2023',
    );
    // An embed has no rack: no switch of its own for it.
    expect(screen.queryByRole('switch', { name: 'Summer aerial' })).toBeNull();
  });

  it('view only, on a phone: no zoom pair, and the map takes no pointer', () => {
    const { container } = render(
      <InboxMapStill view={reportPointScene(REPORT_POINT)} width={328} viewOnly />,
    );
    expect(container.querySelector('[data-slot="inbox-map"]')).toHaveAttribute('data-view-only');
    expect(container.querySelector('[data-slot="body-map"]')?.className).toContain(
      '[&_[data-map-zoom]]:hidden',
    );
  });

  it('puts the caption in the rack’s corner when there is no legend', () => {
    const { container } = render(
      <InboxMapStill view={reportPointScene(REPORT_POINT)} width={280} />,
    );
    expect(container.querySelector('[data-slot="inbox-map-caption"]')).toHaveTextContent(
      'Report point · town beach',
    );
    const bare = render(
      <InboxMapStill view={{ ...reportPointScene(REPORT_POINT), caption: null }} width={280} />,
    );
    expect(bare.container.querySelector('[data-slot="body-map-plate"]')).toBeNull();
  });

  it('draws the legend from the map’s own strokes, the caption under it', () => {
    const { container } = render(
      <InboxMapStill
        view={{ ...admitScene(ADMIT), caption: 'Matched 38 m from the ask' }}
        width={796}
      />,
    );
    const items = [...container.querySelectorAll('[data-slot="map-legend-item"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      'Catalog outline · not ours yet',
      'Kate Donovan’s skate',
      'Ours',
    ]);
    expect(container.querySelector('[data-slot="inbox-map-caption"]')).toHaveTextContent(
      'Matched 38 m from the ask',
    );
    // No pass, no switch: the embed keeps its rackless corner.
    expect(container.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
  });

  it('draws the body’s pass under a drawing, with one Aerial switch, on until turned off', async () => {
    const user = userEvent.setup();
    const { container } = render(<InboxMapStill view={drawnScene(DRAWN)} width={788} />);
    // No rack: the one switch sits in the foot, and the legend keeps the top left.
    expect(container.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
    const foot = container.querySelector('[data-slot="body-map-foot"]');
    expect(foot?.querySelectorAll('[data-layer="aerial"]')).toHaveLength(1);
    const aerial = screen.getByRole('switch', { name: /Aerial/ });
    expect(aerial).toBeChecked();
    expect(container.querySelector('[data-slot="body-map-plate"]')?.className).toContain(
      'left-(--space-3)',
    );
    await user.click(aerial);
    expect(screen.getByRole('switch', { name: /Aerial/ })).not.toBeChecked();
  });

  it('lets 2.4 zoom out past its tight frame to see the whole body', async () => {
    const user = userEvent.setup();
    // Newfound Lake as it is, ~10 km long — far bigger than the two points' frame.
    const [lng, lat] = LOOKALIKE.asked.at;
    const ring = [
      [lng - 0.05, lat - 0.05],
      [lng + 0.05, lat - 0.05],
      [lng + 0.05, lat + 0.05],
      [lng - 0.05, lat + 0.05],
      [lng - 0.05, lat - 0.05],
    ];
    const body = {
      id: 'nf',
      name: 'Newfound Lake',
      outline: { type: 'Polygon' as const, coordinates: [ring] },
    };
    render(
      <InboxMapStill view={lookalikeScene({ ...LOOKALIKE, body })} width={380} height={290} />,
    );
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    // A step and a half would stop after one; the body's reach takes it further.
    await user.click(zoomOut);
    expect(zoomOut).toBeEnabled();
    for (let i = 0; i < 8 && !(zoomOut as HTMLButtonElement).disabled; i++)
      await user.click(zoomOut);
    expect(zoomOut).toBeDisabled();
  });
});

describe('legendItem', () => {
  it('is the map’s stroke: its token, its width, its dash in pixels', () => {
    const rows = drawnScene(DRAWN).legend;
    expect(rows.map(legendItem)).toEqual([
      { label: 'Caspian Lake · ours · 789 ac', ink: 'var(--fg1)', width: 1, dash: null },
      {
        label: 'Drawn 12 Oct · Kate Donovan',
        ink: 'var(--fg)',
        width: 1.5,
        dash: [4.5, 3],
      },
      { label: 'The recorded skate · 11 Oct', ink: 'var(--fg2)', width: 1.5, dash: null },
    ]);
  });
});

describe('the live embed', () => {
  it('mounts the console map’s canvas under the same chrome', async () => {
    // The live canvas needs WebGL; the shell is mocked to a box, so this proves the composition.
    vi.resetModules();
    const seen: { padding?: unknown; reach?: unknown; bbox?: unknown }[] = [];
    vi.doMock('../../body/map/useBodyMapCanvas', () => ({
      useBodyMapCanvas: (args: { padding?: unknown; reach?: unknown; bbox?: unknown }) => {
        seen.push(args);
        return {
          ground: <div data-slot="body-map-canvas" />,
          surface: null,
          zoomIn: () => {},
          zoomOut: () => {},
          atMinZoom: false,
          atMaxZoom: true,
          liveMap: () => null,
        };
      },
    }));
    const { InboxMap: Live, EMBED_PADDING } = await import('./InboxMap');
    const { container } = render(
      <Live view={admitScene(ADMIT)} mode="dark" height={318} viewOnly />,
    );
    expect(container.querySelector('[data-slot="body-map-canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="map-layer-rack"]')).toBeNull();
    expect(container.querySelector('[data-slot="map-legend-item"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(container.querySelector<HTMLElement>('[data-slot="inbox-map"]')?.style.height).toBe(
      '318px',
    );
    // The canvas frames inside the embed's own room, on the item's frame.
    expect(seen.at(-1)).toMatchObject({ padding: EMBED_PADDING, reach: null });
    const tight = lookalikeScene(LOOKALIKE);
    render(<Live view={tight} mode="light" />);
    expect(seen.at(-1)).toMatchObject({ bbox: tight.frame, reach: tight.reach });
    vi.doUnmock('../../body/map/useBodyMapCanvas');
    expect(InboxMap).toBeTypeOf('function');
  });
});
