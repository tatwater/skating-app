import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Names as the console mounts it: the record from `waterBodies.get` and the boundaries from
 * `bodyConsole.places` (mocked at the Convex hooks), the name write gated on `body.identity` with
 * its receipt through undo — and a write the server lacks drawn *Not available yet*, never hidden.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as Array<[string, unknown]>,
  can: new Set<string>(['body.identity']),
  announce: vi.fn(async () => {}),
  fail: false,
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
      if (mocks.fail) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError('Water body not found');
      }
    },
  };
});
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => mocks.can.has(c) }) }));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';

import { stubJsdomAnimations } from '../jsdomStubs';
import { NamesTab } from './NamesTab';

beforeAll(stubJsdomAnimations);

const BODY = {
  _id: 'wb1',
  name: 'Lake Auburn',
  type: 'lakePond',
  states: ['ME'],
  nameClaims: [
    { source: 'user', value: 'Lake Auburn' },
    { source: 'nhd', value: 'The Basin' },
    { source: 'osm', value: 'Lake Auburn' },
  ],
};

beforeEach(() => {
  // The read layer's registry (paused reads, retries, reports) is module state: start each test clean.
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(['body.identity']);
  mocks.announce.mockClear();
  mocks.fail = false;
  toasts.length = 0;
  mocks.results.set(getFunctionName(api.waterBodies.get), { available: true, body: BODY });
  mocks.results.set(getFunctionName(api.bodyConsole.places), {
    towns: ['Auburn', 'Lewiston'],
    counties: ['Androscoggin County'],
    states: ['ME'],
    computedAt: 1,
  });
});

const location = () => screen.getByRole('region', { name: /Location/ });

describe('NamesTab', () => {
  it('displays another spelling through setWaterBodyName and announces it for undo', async () => {
    render(<NamesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
    expect(mocks.calls).toEqual([
      ['waterBodies:setWaterBodyName', { waterBodyId: 'wb1', name: 'The Basin' }],
    ]);
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'Displaying “The Basin”',
      target: { targetType: 'waterbody', targetId: 'wb1' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Back to the catalogs’ ranking' }));
    expect(mocks.calls[1]).toEqual([
      'waterBodies:setWaterBodyName',
      { waterBodyId: 'wb1', name: null },
    ]);
  });

  it('says the server’s refusal in a red toast, and announces nothing', async () => {
    mocks.fail = true;
    render(<NamesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(toasts).toEqual([
      { title: 'Not saved', description: 'Water body not found', tone: 'bad' },
    ]);
  });

  it('draws no control for a viewer without body.identity', () => {
    mocks.can = new Set();
    render(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Aliases' })).toBeNull();
    expect(screen.getAllByText('Lake Auburn').length).toBeGreaterThan(0);
  });

  it('draws the alias editor and the class change Not available yet: the server has neither write', async () => {
    render(<NamesTab bodyId="wb1" />);
    const aliases = screen.getByRole('group', { name: 'Aliases' });
    expect(aliases).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(aliases);
    expect(toasts).toEqual([
      expect.objectContaining({
        title: 'Not available yet',
        description: expect.stringContaining('aliases editor'),
      }),
    ]);
    const another = screen.getByRole('button', { name: /Another class/ });
    expect(another).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(another);
    expect(toasts).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Set as/ })).toBeNull();
  });

  it('says what no read records: each catalog’s class, and the catalogs that agree', () => {
    render(<NamesTab bodyId="wb1" />);
    expect(screen.getByText(/Each catalog’s class: Not recorded yet/)).toBeTruthy();
    expect(
      screen.getByText(/Other catalogs that gave the same spelling: Not recorded yet/),
    ).toBeTruthy();
  });

  it('places the body in its towns and county, from the boundaries', () => {
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('Auburn');
    expect(location()).toHaveTextContent('Lewiston');
    expect(location()).toHaveTextContent('Androscoggin County');
    expect(location()).toHaveTextContent('US Census BureauTIGER');
  });

  it('says the towns aren’t computed yet before the geometry is, never a blank', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.places), null);
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('TownsNot computed yet');
    expect(location()).not.toHaveTextContent('TIGER');
  });

  it('says a body no boundary holds is in no town and no county', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.places), {
      towns: [],
      counties: [],
      states: [],
      computedAt: 1,
    });
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('TownsIn no town');
    expect(location()).toHaveTextContent('CountyIn no county');
  });

  it('never says a body in a town is in no county: a town without its county is not recorded', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.places), {
      towns: ['Enfield'],
      counties: [],
      states: ['NH'],
      computedAt: 1,
    });
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('TownsEnfield');
    expect(location()).toHaveTextContent('CountyNot recorded yet');
    expect(location()).not.toHaveTextContent('In no county');
  });

  it('says the boundaries couldn’t be read, in place and in the note, and offers Try again', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.places), new Error('down'));
    render(<NamesTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t read the towns and county.');
    expect(location()).toHaveTextContent('TownsCouldn’t be read');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The rest of the tab stands.
    expect(screen.getByRole('button', { name: 'Display this' })).toBeTruthy();
  });

  it('says the record couldn’t be read, with Try again, when it failed', () => {
    mocks.results.set(getFunctionName(api.waterBodies.get), new Error('down'));
    render(<NamesTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t read this body’s record.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('names a community body and clears it in the community’s words, not the catalogs’', async () => {
    mocks.results.set(getFunctionName(api.waterBodies.get), {
      available: true,
      body: { ...BODY, name: 'Low Plains', nameClaims: [{ source: 'user', value: 'Low Plains' }] },
    });
    render(<NamesTab bodyId="wb1" />);
    const field = screen.getByRole('textbox', { name: 'Community name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Low Plains Pond{Enter}');
    expect(mocks.announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Named “Low Plains Pond”' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear the name' }));
    expect(mocks.calls.at(-1)).toEqual([
      'waterBodies:setWaterBodyName',
      { waterBodyId: 'wb1', name: null },
    ]);
    expect(mocks.announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Cleared the name' }),
    );
  });

  it('offers no typed name for a body a skater drew: the server keeps its author’s name', () => {
    mocks.results.set(getFunctionName(api.waterBodies.get), {
      available: true,
      body: { ...BODY, name: 'Back Cove Rink', source: 'user', nameClaims: undefined },
    });
    render(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('textbox', { name: 'Community name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear the name' })).toBeNull();
    expect(screen.getByRole('region', { name: /^Name/ })).toHaveTextContent('Back Cove Rink');
  });

  it('keeps the checked class on the record’s class as it moves', () => {
    const { rerender } = render(<NamesTab bodyId="wb1" />);
    const checked = () => screen.getByRole('radio', { checked: true });
    expect(checked()).toHaveAccessibleName(/Lake or pond/i);
    mocks.results.set(getFunctionName(api.waterBodies.get), {
      available: true,
      body: { ...BODY, type: 'reservoir' },
    });
    rerender(<NamesTab bodyId="wb1" />);
    expect(checked()).toHaveAccessibleName(/Reservoir/i);
  });

  it('holds its place while the record loads, and for a body that is not listed', () => {
    mocks.results.delete(getFunctionName(api.waterBodies.get));
    const { container, rerender } = render(<NamesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    mocks.results.set(getFunctionName(api.waterBodies.get), { available: false });
    rerender(<NamesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
