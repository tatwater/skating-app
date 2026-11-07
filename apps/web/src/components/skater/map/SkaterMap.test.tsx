import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const theme = { resolvedTheme: 'light' as 'dark' | 'light' };
vi.mock('@/components/theme-provider', () => ({ useTheme: () => theme }));

let canvasMounts = 0;
vi.mock('./SkaterMapCanvas', async () => {
  const { useEffect } = await import('react');
  return {
    default: function FakeCanvas() {
      useEffect(() => {
        canvasMounts++;
      }, []);
      return <div data-testid="canvas" />;
    },
  };
});

const { useSkaterMapStore } = await import('@/stores/skaterMapStore');
const { exploreMapSpec, HIDDEN_MAP_SPEC } = await import('./mapSpec');
const { SkaterMap } = await import('./SkaterMap');

beforeEach(() => {
  canvasMounts = 0;
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

const pane = () => document.querySelector('[data-slot="skater-map"]') as HTMLElement;

describe('SkaterMap', () => {
  it('is a hidden, inert pane with no canvas until a view shows the map', () => {
    render(<SkaterMap />);
    expect(pane()).toHaveAttribute('data-map-spec', HIDDEN_MAP_SPEC.id);
    expect(pane().className).toContain('invisible');
    expect(pane()).toHaveAttribute('inert');
    expect(screen.queryByTestId('canvas')).toBeNull();
  });

  it('starts the canvas the first time a view shows the map, and never unmounts it', async () => {
    render(<SkaterMap />);
    await act(async () => {
      useSkaterMapStore.getState().declareMapSpec('view', exploreMapSpec());
    });
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(pane()).toHaveAttribute('data-visible');
    expect(pane()).not.toHaveAttribute('inert');
    await act(async () => {
      useSkaterMapStore.getState().declareMapSpec('view', null);
    });
    // Hidden, but the instance lives on: a page with no map doesn't cost the next one a GL context.
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    expect(pane().className).toContain('invisible');
    await act(async () => {
      useSkaterMapStore.getState().declareMapSpec('view', exploreMapSpec());
    });
    expect(canvasMounts).toBe(1);
  });

  it('keeps clicks and labels out of autocapture (D240), and sets the marks’ ground', () => {
    render(<SkaterMap className="col-span-2" />);
    expect(pane().className).toContain('ph-no-capture');
    expect(pane().className).toContain('col-span-2');
    expect(pane().style.getPropertyValue('--map-ground')).toBe('#ffffff');
    theme.resolvedTheme = 'dark';
    render(<SkaterMap />);
    const panes = document.querySelectorAll<HTMLElement>('[data-slot="skater-map"]');
    expect(panes[1]?.style.getPropertyValue('--map-ground')).toBe('#1f1f1f');
  });
});
