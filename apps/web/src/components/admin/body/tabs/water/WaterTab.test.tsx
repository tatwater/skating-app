import { act, render, screen, within } from '@testing-library/react';
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
  calls: [] as Array<[string, unknown]>,
  announce: vi.fn(async () => {}),
  server: null as ((name: string, args: Record<string, unknown>) => void) | null,
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
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => async (args: unknown) => {
      mocks.calls.push([getFunctionName(ref), args]);
      await mocks.server?.(getFunctionName(ref), args as Record<string, unknown>);
    },
  };
});
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => mocks.can.has(c) }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { statusDate } from '../../frame/bodyModel';
import { stubJsdomAnimations } from '../jsdomStubs';
import { WaterTab } from './WaterTab';

beforeAll(stubJsdomAnimations);

const fn = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);
const bathymetry = () => screen.getByRole('region', { name: /Bathymetry/ });

beforeEach(() => {
  // The read layer's registry (paused reads, retries, reports) is module state: start each test clean.
  resetConsoleReads();
  mocks.results.clear();
  mocks.can = new Set();
  mocks.calls.length = 0;
  mocks.announce.mockClear();
  mocks.server = null;
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
  // A body whose other sources' depths were never stored: settled, not recorded.
  mocks.results.set(fn(api.bodyConsole.depthChoices), {
    mean: { choices: [] },
    max: { choices: [] },
    recorded: false,
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

  it('keeps each depth’s pick on the source in use as the record moves — never a choice nobody made', () => {
    mocks.can = new Set(['body.water']);
    const { rerender } = render(<WaterTab bodyId="wb1" />);
    const meanPick = () =>
      within(screen.getByRole('radiogroup', { name: 'Mean depth' })).getByRole('radio', {
        checked: true,
      });
    expect(meanPick()).toHaveAccessibleName('NH state survey, 9.4 m');
    const got = mocks.results.get(fn(api.waterBodies.get)) as { body: object };
    mocks.results.set(fn(api.waterBodies.get), {
      available: true,
      body: { ...got.body, meanDepthM: 10, meanDepthSource: 'operator' },
    });
    rerender(<WaterTab bodyId="wb1" />);
    expect(meanPick()).toHaveAccessibleName('A moderator, 10 m');
    expect(screen.queryByRole('button', { name: /for the mean/ })).toBeNull();
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

  it('says the other sources’ depths couldn’t be read when their read failed — never “not recorded”', () => {
    mocks.results.set(fn(api.bodyConsole.depthChoices), new Error('nope'));
    render(<WaterTab bodyId="wb1" />);
    expect(screen.queryByText(/Other sources’ depths: Not recorded yet/)).toBeNull();
    expect(document.querySelector('[data-slot="depth-others"]')).toHaveTextContent(
      'Couldn’t be read',
    );
    const note = document.querySelector('[data-slot="read-failures"]') as HTMLElement;
    expect(note).toHaveTextContent('the other sources’ depths');
    expect(within(note).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('holds the other sources’ place while their read loads — never “not recorded”', () => {
    mocks.results.set(fn(api.bodyConsole.depthChoices), undefined);
    render(<WaterTab bodyId="wb1" />);
    expect(screen.queryByText(/Other sources’ depths: Not recorded yet/)).toBeNull();
    expect(
      document.querySelector('[data-slot="depth-others"] [data-slot="skeleton"]'),
    ).not.toBeNull();
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

  it('a switch to another body already read shows only that body — Water holds no draft to carry', () => {
    // Water's writes aren't built (the depth editor, the survey), so it has no draft; its picks
    // follow the record. The frame keys it by body all the same.
    const { container, rerender } = render(<BodyTabHost Wiring={WaterTab} bodyId="wb1" />);
    const first = container.firstElementChild;
    expect(screen.getAllByText(/9\.4/).length).toBeGreaterThan(0);
    mocks.results.set(fn(api.waterBodies.get), {
      available: true,
      body: {
        _id: 'wb2',
        name: 'Crystal Lake',
        states: ['NH'],
        maxDepthM: 6,
        maxDepthSource: 'state_agency',
      },
    });
    rerender(<BodyTabHost Wiring={WaterTab} bodyId="wb2" />);
    // Remounted, not re-rendered: the read's own answer would change the words either way.
    expect(container.firstElementChild).not.toBe(first);
    expect(screen.queryByText(/9\.4/)).toBeNull();
    expect(screen.queryByText(/Mascoma/)).toBeNull();
  });

  /** `bodyConsole.depthChoices`, as the server answers it for a body whose offers are kept. */
  const choices = (meanFrom: string) => ({
    mean: {
      choices: [
        { source: 'state_agency', valueM: 9.4, inUse: meanFrom === 'state_agency' },
        { source: 'hydrolakes_modeled', valueM: 8.1, inUse: meanFrom === 'hydrolakes_modeled' },
      ],
    },
    max: { choices: [{ source: 'state_agency', valueM: 24, inUse: true }] },
    recorded: true,
  });

  it('chooses where the mean comes from (`chooseDepthSource`), and once the record holds it asks nothing more', async () => {
    mocks.can = new Set(['body.water']);
    const get = fn(api.waterBodies.get);
    mocks.results.set(fn(api.bodyConsole.depthChoices), choices('state_agency'));
    mocks.server = (name, args) => {
      if (name !== 'waterBodies:chooseDepthSource') return;
      const prior = mocks.results.get(get) as { body: Record<string, unknown> };
      mocks.results.set(get, {
        available: true,
        body: { ...prior.body, meanDepthM: 8.1, meanDepthSource: args.source },
      });
      mocks.results.set(fn(api.bodyConsole.depthChoices), choices(args.source as string));
    };
    const { rerender } = render(<WaterTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('radio', { name: 'HydroLAKES, 8.1 m' }));
    await userEvent.click(screen.getByRole('button', { name: /Use HydroLAKES for the mean/ }));
    expect(mocks.calls).toEqual([
      [
        'waterBodies:chooseDepthSource',
        { waterBodyId: 'wb1', measure: 'mean', source: 'hydrolakes_modeled' },
      ],
    ]);
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Mean depth from HydroLAKES' }),
    );
    rerender(<WaterTab bodyId="wb1" />);
    expect(screen.queryByRole('button', { name: /Use HydroLAKES for the mean/ })).toBeNull();
    expect(mocks.calls).toHaveLength(1);
  });

  it('the latest press wins: HydroLAKES, then back to the state survey before the first answer, ends on the survey', async () => {
    mocks.can = new Set(['body.water']);
    const get = fn(api.waterBodies.get);
    mocks.results.set(fn(api.bodyConsole.depthChoices), choices('state_agency'));
    const answers: (() => void)[] = [];
    mocks.server = (name, args) => {
      if (name !== 'waterBodies:chooseDepthSource') return;
      return new Promise<void>((resolve) =>
        answers.push(() => {
          const prior = mocks.results.get(get) as { body: Record<string, unknown> };
          mocks.results.set(get, {
            available: true,
            body: { ...prior.body, meanDepthSource: args.source },
          });
          mocks.results.set(fn(api.bodyConsole.depthChoices), choices(args.source as string));
          resolve();
        }),
      );
    };
    const { rerender } = render(<WaterTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('radio', { name: 'HydroLAKES, 8.1 m' }));
    await userEvent.click(screen.getByRole('button', { name: /Use HydroLAKES for the mean/ }));
    // Shown at once, though the server hasn't answered: the survey can be chosen back.
    await userEvent.click(screen.getByRole('radio', { name: /state survey, 9\.4 m/ }));
    await userEvent.click(screen.getByRole('button', { name: /Use NH state survey for the mean/ }));
    await act(async () => answers.shift()?.());
    rerender(<WaterTab bodyId="wb1" />);
    await act(async () => answers.shift()?.());
    rerender(<WaterTab bodyId="wb1" />);
    expect(mocks.calls.map((c) => (c[1] as { source: string }).source)).toEqual([
      'hydrolakes_modeled',
      'state_agency',
    ]);
    expect(
      (mocks.results.get(get) as { body: { meanDepthSource: string } }).body.meanDepthSource,
    ).toBe('state_agency');
  });

  it('says what was searched for contours, and when, once a search is recorded', () => {
    mocks.results.set(fn(api.bodyConsole.consoleExtras), {
      towns: ['Enfield'],
      hasBathymetry: false,
      outlineTrustedSince: null,
      outlineTrustedVia: null,
      touchingBodyIds: [],
      touchingCapped: false,
      bathymetrySearched: { label: 'NH GRANIT lake contours', at: Date.UTC(2026, 8, 12, 12) },
    });
    render(<WaterTab bodyId="wb1" />);
    expect(bathymetry()).toHaveTextContent('NH GRANIT lake contours');
    // With its year: a search may be seasons old.
    expect(bathymetry()).toHaveTextContent(statusDate(Date.UTC(2026, 8, 12, 12)));
    expect(statusDate(Date.UTC(2026, 8, 12, 12))).toMatch(/ 2026$/);
  });
});
