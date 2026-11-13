import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      convex.results.get(getFunctionName(ref)),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      const made = convex.mutations.get(name) ?? vi.fn(async () => null);
      convex.mutations.set(name, made);
      return made;
    },
  };
});
const role = vi.hoisted(() => ({ caps: new Set<string>() }));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => role.caps.has(c) }) }));
const undo = vi.hoisted(() => ({ announce: vi.fn(async () => {}) }));
vi.mock('@/components/admin/shell/undo', () => ({ useUndo: () => undo }));

import type { Id } from '@skating/convex/dataModel';
import { ConvexError } from 'convex/values';

import { LINKS_TAB, LinksTab } from './LinksTab';
import { MASCOMA } from './linksFixtures';

const BODY = 'k1' as Id<'waterBodies'>;

beforeEach(() => {
  convex.results.clear();
  convex.mutations.clear();
  undo.announce.mockClear();
  role.caps = new Set(['body.identity']);
});

describe('LinksTab', () => {
  it('draws nothing until the body lands, or when it is unavailable', () => {
    const { container, rerender } = render(<LinksTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
    convex.results.set('waterBodies:get', { available: false });
    rerender(<LinksTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('writes the whole list and announces it to Undo', async () => {
    convex.results.set('waterBodies:get', { available: true, body: { _id: BODY, ...MASCOMA } });
    render(<LinksTab bodyId={BODY} />);
    expect(screen.getByRole('link', { name: /Lake sheet/ })).toHaveAttribute('href', '/water/k1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(convex.mutations.get('waterBodies:setReferenceLinks')).toHaveBeenCalledWith({
      waterBodyId: BODY,
      links: [MASCOMA.referenceLinks?.[0]],
    });
    expect(undo.announce).toHaveBeenCalledWith({
      title: 'Links saved',
      target: { targetType: 'waterbody', targetId: BODY },
    });
  });

  it('a refusal reads in the server’s words', async () => {
    convex.results.set('waterBodies:get', { available: true, body: { _id: BODY, ...MASCOMA } });
    convex.mutations.set(
      'waterBodies:setReferenceLinks',
      vi.fn(async () => {
        throw new ConvexError('A body carries at most 8 reference links');
      }),
    );
    render(<LinksTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 8');
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('a viewer without body.identity reads the links and edits none', () => {
    role.caps = new Set();
    convex.results.set('waterBodies:get', { available: true, body: { _id: BODY, ...MASCOMA } });
    render(<LinksTab bodyId={BODY} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('registers its wiring and a map that plates the interior point', () => {
    expect(LINKS_TAB.Wiring).toBe(LinksTab);
    const result = { available: true, body: { _id: BODY, ...MASCOMA } };
    convex.results.set('waterBodies:get', result);
    let data: unknown;
    function Probe() {
      data = LINKS_TAB.map?.useData(BODY);
      return null;
    }
    render(<Probe />);
    // Convex's own result: the identity the frame keys its redraw on.
    expect(data).toBe(result);
    expect(LINKS_TAB.map?.describe(data, null).lit).toBe('interior:point');
    expect(LINKS_TAB.map?.describe({ available: false }, null)).toEqual({ items: [] });
    expect(LINKS_TAB.map?.describe(undefined, null)).toEqual({ items: [] });
  });
});
