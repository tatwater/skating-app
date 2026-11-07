import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_LAYERS, useSkaterMapStore } from '@/stores/skaterMapStore';

const capture = vi.fn();
vi.mock('@/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture }),
}));

const { MapDockControls } = await import('./MapDockControls');
type Props = React.ComponentProps<typeof MapDockControls>;

const ALL = { zoom: true, layers: true, locate: true, imagery: true, legend: true };

function dock(over: Partial<Props> = {}) {
  const props: Props = {
    controls: ALL,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onLocate: vi.fn(),
    onOpenImagery: vi.fn(),
    depthShown: true,
    onReturnToRegion: vi.fn(),
    lakeName: 'Mascoma Lake',
    // The store's shape: `formatContourCredit` always closes with its own period.
    contourCredit: '5 ft contours, surveyed by NH GRANIT.',
    ...over,
  };
  render(<MapDockControls {...props} />);
  return props;
}

beforeEach(() => {
  capture.mockReset();
  localStorage.clear();
  useSkaterMapStore.setState({ layers: { ...DEFAULT_MAP_LAYERS }, awayFromRegion: false });
});

describe('MapDockControls', () => {
  it('shows only the controls the view asks for', () => {
    dock({ controls: { zoom: true, layers: false, locate: false, imagery: false, legend: false } });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Map layers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Your location' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Latest imagery/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /Depth bands/ })).toBeNull();
  });

  it('zooms, locates and opens the imagery, counting the imagery open', async () => {
    const user = userEvent.setup();
    const props = dock();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Your location' }));
    await user.click(screen.getByRole('button', { name: /Latest imagery/ }));
    expect(props.onZoomIn).toHaveBeenCalledOnce();
    expect(props.onZoomOut).toHaveBeenCalledOnce();
    expect(props.onLocate).toHaveBeenCalledOnce();
    expect(props.onOpenImagery).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith('imagery_opened', { band: 'tc' });
  });

  it('rests a zoom button at the end of its range', () => {
    dock({ atMaxZoom: true });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });

  it('shows no imagery entry without a flow to open, and no legend without contours', () => {
    dock({ onOpenImagery: undefined, depthShown: false });
    expect(screen.queryByRole('button', { name: /Latest imagery/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /Depth bands/ })).toBeNull();
  });

  it('marks the locate button busy while it looks', () => {
    dock({ locating: true });
    expect(screen.getByRole('button', { name: 'Your location' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('offers the way back only once the region has left the screen, and counts its use', async () => {
    const user = userEvent.setup();
    const props = dock();
    expect(screen.queryByRole('button', { name: /Back to the Northeast/ })).toBeNull();
    useSkaterMapStore.setState({ awayFromRegion: true });
    const back = await screen.findByRole('button', { name: /Back to the Northeast/ });
    // Announced as it appears: it lives in a polite live region.
    expect(back.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    await user.click(back);
    expect(props.onReturnToRegion).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith('return_to_region_used');
  });
});

describe('the layers menu (board 3.16)', () => {
  it('opens from the keyboard, toggles a switch, persists it and counts it', async () => {
    const user = userEvent.setup();
    dock();
    const trigger = screen.getByRole('button', { name: 'Map layers' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Map layers', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('On Mascoma Lake')).toBeInTheDocument();
    const depth = screen.getByRole('switch', { name: /Depth/ });
    expect(depth).toBeChecked();
    depth.focus();
    await user.keyboard(' ');
    expect(useSkaterMapStore.getState().layers.depth).toBe(false);
    expect(JSON.parse(localStorage.getItem('gli-map-layers') ?? '{}').depth).toBe(false);
    expect(capture).toHaveBeenCalledWith('map_layer_toggled', { layer: 'depth', on: false });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('On Mascoma Lake')).toBeNull());
  });

  it('keeps hazards locked on: the row is on and pressing it changes nothing (D3)', async () => {
    const user = userEvent.setup();
    dock();
    await user.click(screen.getByRole('button', { name: 'Map layers' }));
    const hazards = await screen.findByRole('switch', { name: /Hazards/ });
    expect(hazards).toBeChecked();
    expect(hazards).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByText('Always shown')).toBeInTheDocument();
    await user.click(hazards);
    expect(hazards).toBeChecked();
    expect(capture).not.toHaveBeenCalled();
  });

  it('counts every switch under its taxonomy name', async () => {
    const user = userEvent.setup();
    dock();
    await user.click(screen.getByRole('button', { name: 'Map layers' }));
    await user.click(await screen.findByRole('switch', { name: /Tracks/ }));
    expect(useSkaterMapStore.getState().layers.tracks).toBe(true);
    expect(capture).toHaveBeenCalledWith('map_layer_toggled', { layer: 'tracks', on: true });
  });

  it('names the open lake, or speaks of one in general, and credits the contours from the tile', async () => {
    const user = userEvent.setup();
    dock({ lakeName: null, contourCredit: null });
    await user.click(screen.getByRole('button', { name: 'Map layers' }));
    expect(await screen.findByText('On an open lake')).toBeInTheDocument();
    expect(screen.getByText('Basemap and water © OpenStreetMap contributors.')).toBeInTheDocument();
  });

  it('adds the contour credit when contours are drawn, with one period, not two', async () => {
    const user = userEvent.setup();
    dock();
    await user.click(screen.getByRole('button', { name: 'Map layers' }));
    expect(
      await screen.findByText(
        'Basemap and water © OpenStreetMap contributors. Contours: 5 ft contours, surveyed by NH GRANIT.',
      ),
    ).toBeInTheDocument();
  });
});
