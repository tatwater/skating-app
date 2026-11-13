import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Names as the console mounts it: the record from `waterBodies.get`, the name write gated
 * on `body.identity`, its receipt through undo — and nothing drawn for a write the server lacks.
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
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      mocks.results.get(getFunctionName(ref)),
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
vi.mock('@/components/kit/toast', () => ({ toast: (t: unknown) => toasts.push(t) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

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
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(['body.identity']);
  mocks.announce.mockClear();
  mocks.fail = false;
  toasts.length = 0;
  mocks.results.set(getFunctionName(api.waterBodies.get), { available: true, body: BODY });
});

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
    expect(screen.getAllByText('Lake Auburn').length).toBeGreaterThan(0);
  });

  it('draws no alias editor and no class change: the server has neither write yet', () => {
    render(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Another class|Set as/ })).toBeNull();
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
