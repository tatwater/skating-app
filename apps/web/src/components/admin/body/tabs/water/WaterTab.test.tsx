import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Water as the console mounts it: the record and the bathymetry state (mocked at the Convex
 * hooks), read-only until its writes exist — drawn *Not available yet* for a viewer who could make
 * them, and every read's state said in its place.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  can: new Set<string>(),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [
          key,
          mocks.results.get(getFunctionName(query)),
        ]),
      ),
  };
});
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => mocks.can.has(c) }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../jsdomStubs';
import { WaterTab } from './WaterTab';

beforeAll(stubJsdomAnimations);

const fn = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);
const bathymetry = () => screen.getByRole('region', { name: /Bathymetry/ });

beforeEach(() => {
  mocks.results.clear();
  mocks.can = new Set();
  toasts.length = 0;
  mocks.results.set(fn(api.waterBodies.get), {
    available: true,
    body: {
      _id: 'wb1',
      name: 'Mascoma Lake',
      states: ['NH'],
      meanDepthM: 9.4,
      maxDepthM: 24,
      meanDepthSource: 'state_agency',
      maxDepthSource: 'state_agency',
      interiorPoint: { lat: 43.617368, lng: -72.136006 },
      bbox: { maxLat: 43.6497901, maxLng: -72.1206902, minLat: 43.6061979, minLng: -72.1819521 },
    },
  });
  mocks.results.set(fn(api.bodyConsole.consoleExtras), {
    towns: ['Enfield'],
    hasBathymetry: false,
    outlineTrustedSince: null,
    outlineTrustedVia: null,
    touchingBodyIds: [],
    touchingCapped: false,
  });
});

describe('WaterTab', () => {
  it('draws the record’s depth and point, and what no read records, with no control', () => {
    render(<WaterTab bodyId="wb1" />);
    expect(screen.getByText('NH state survey')).toBeTruthy();
    expect(screen.getByText('43.6174°N 72.1360°W')).toBeTruthy();
    expect(screen.getByText(/Other sources’ depths: Not recorded yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says whether contour lines were drawn, the gap amber, and that the search isn’t recorded', () => {
    const { container, rerender } = render(<WaterTab bodyId="wb1" />);
    expect(bathymetry()).toHaveTextContent('FoundNo contour lines');
    expect(bathymetry()).toHaveTextContent('SearchedNot recorded yet');
    expect(container.querySelector('[data-slot="bathymetry"]')).toHaveAttribute('data-gap');
    mocks.results.set(fn(api.bodyConsole.consoleExtras), { hasBathymetry: true });
    rerender(<WaterTab bodyId="wb1" />);
    expect(bathymetry()).toHaveTextContent('FoundContour lines drawn');
    expect(container.querySelector('[data-slot="bathymetry"]')).not.toHaveAttribute('data-gap');
  });

  it('draws the survey field Not available yet for a viewer who could file one', async () => {
    mocks.can = new Set(['body.water']);
    render(<WaterTab bodyId="wb1" />);
    const survey = screen.getByRole('group', { name: 'A survey the next build should load' });
    expect(survey).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('textbox')).toBeDisabled();
    await userEvent.click(survey);
    expect(toasts).toEqual([expect.objectContaining({ title: 'Not available yet' })]);
  });

  it('holds the bathymetry’s place while its read loads', () => {
    mocks.results.delete(fn(api.bodyConsole.consoleExtras));
    render(<WaterTab bodyId="wb1" />);
    expect(bathymetry()).toHaveAttribute('aria-busy', 'true');
  });

  it('says the bathymetry couldn’t be read, in place and in the note, with Try again', () => {
    mocks.results.set(fn(api.bodyConsole.consoleExtras), new Error('down'));
    render(<WaterTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t read the bathymetry state.');
    expect(bathymetry()).toHaveTextContent('Couldn’t be read');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The depth still stands.
    expect(screen.getByText('NH state survey')).toBeTruthy();
  });

  it('says the record couldn’t be read when it failed', () => {
    mocks.results.set(fn(api.waterBodies.get), new Error('down'));
    render(<WaterTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t read this body’s record.');
  });

  it('holds its place while the record loads', () => {
    mocks.results.delete(fn(api.waterBodies.get));
    const { container } = render(<WaterTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
