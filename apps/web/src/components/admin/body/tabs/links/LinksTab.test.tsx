import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([k, q]) => [k, convex.results.get(getFunctionName(q.query))]),
      ),
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

import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { LINKS_TAB, LinksTab } from './LinksTab';
import { MASCOMA } from './linksFixtures';

const BODY = 'k1' as Id<'waterBodies'>;

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  resetConsoleReads();
  convex.results.clear();
  convex.mutations.clear();
  undo.announce.mockClear();
  role.caps = new Set(['body.identity']);
});

describe('LinksTab', () => {
  it('holds its place until the body lands, says so when it fails, and draws nothing unlisted', async () => {
    const { container, rerender } = render(<LinksTab bodyId={BODY} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<LinksTab bodyId={BODY} />);
    expect(screen.getByText('This body couldn’t be read')).toBeVisible();
    convex.results.set('waterBodies:get', { available: true, body: { _id: BODY, ...MASCOMA } });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Built from the lake')).toBeVisible();
    convex.results.set('waterBodies:get', { available: false });
    rerender(<LinksTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('builds every outbound link from the body’s own facts, each opening in a new tab', () => {
    const body = {
      _id: BODY,
      name: 'Sunapee Lake',
      states: ['NH'],
      interiorPoint: { lat: 43.4, lng: -72.05 },
      surfaceAreaSqM: 16_700_000,
    };
    convex.results.set('waterBodies:get', { available: true, body });
    render(<LinksTab bodyId={BODY} />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    }
    const hrefs = links.map((a) => a.getAttribute('href') ?? '');
    // Windy and Copernicus open on this body's interior point, not the fixture lake's.
    expect(hrefs.some((h) => h.includes('windy.com') && h.includes('43.4'))).toBe(true);
    expect(hrefs.some((h) => h.includes('copernicus') && h.includes('43.4'))).toBe(true);
    expect(hrefs.some((h) => h.includes('43.6174'))).toBe(false);
    expect(hrefs).toContain('/water/k1');
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
    expect(undo.announce).toHaveBeenCalledWith(
      {
        title: 'Links saved',
        target: { targetType: 'waterbody', targetId: BODY },
      },
      expect.any(Function),
    );
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
    // A change to send (Done on an unchanged link sends nothing).
    await userEvent.type(screen.getByPlaceholderText('What the link is, as skaters read it'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 8');
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('an editor open on one body never opens on the next body’s link', async () => {
    convex.results.set('waterBodies:get', { available: true, body: { _id: BODY, ...MASCOMA } });
    const { rerender } = render(<LinksTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    expect(screen.getByRole('textbox', { name: /Label/ })).toBeVisible();
    // The next body's read is already in hand (no loading state between them).
    const other = 'k2' as Id<'waterBodies'>;
    convex.results.set('waterBodies:get', {
      available: true,
      body: {
        _id: other,
        ...MASCOMA,
        referenceLinks: [{ label: 'Pond association', url: 'https://pond.org' }],
      },
    });
    rerender(<LinksTab bodyId={other} />);
    expect(screen.queryByRole('textbox', { name: /Label/ })).toBeNull();
    expect(screen.getByText('Pond association')).toBeVisible();
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
      data = LINKS_TAB.map?.useData(BODY, null);
      return null;
    }
    const { rerender } = render(<Probe />);
    const first = data;
    rerender(<Probe />);
    // Kept while Convex's result holds: the identity the frame keys its redraw on.
    expect(data).toBe(first);
    expect(LINKS_TAB.map?.describe(data as never, null).lit).toBe('interior:point');
    expect(LINKS_TAB.map?.describe({ body: null }, null)).toEqual({ items: [] });
    convex.results.set('waterBodies:get', { available: false });
    rerender(<Probe />);
    expect(data).toEqual({ body: null });
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<Probe />);
    expect(data).toBeUndefined();
  });

  describe('a switch to another body that is already read', () => {
    const OTHER = 'k2' as Id<'waterBodies'>;
    const open = (id: Id<'waterBodies'>) =>
      convex.results.set('waterBodies:get', { available: true, body: { _id: id, ...MASCOMA } });

    it('drops the open editor and its draft; nothing typed for one body is sent for the other', async () => {
      open(BODY);
      const { rerender } = render(<BodyTabHost Wiring={LinksTab} bodyId={BODY} />);
      await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
      await userEvent.type(screen.getByRole('textbox', { name: /Label/ }), ' (Mascoma only)');
      open(OTHER);
      rerender(<BodyTabHost Wiring={LinksTab} bodyId={OTHER} />);
      expect(screen.queryByRole('textbox', { name: /Label/ })).toBeNull();
      expect(screen.queryByDisplayValue(/Mascoma only/)).toBeNull();
      expect(convex.mutations.get('waterBodies:setReferenceLinks')).not.toHaveBeenCalled();
    });

    it('a save started on one body that lands after the switch changes nothing on the next, and puts up no receipt', async () => {
      open(BODY);
      let land: () => void = () => {};
      convex.mutations.set(
        'waterBodies:setReferenceLinks',
        vi.fn(
          () =>
            new Promise((resolve) => {
              land = () => resolve(null);
            }),
        ),
      );
      const { rerender } = render(<BodyTabHost Wiring={LinksTab} bodyId={BODY} />);
      await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
      await userEvent.type(screen.getByRole('textbox', { name: /Label/ }), '!{Enter}');
      expect(convex.mutations.get('waterBodies:setReferenceLinks')).toHaveBeenCalledTimes(1);
      open(OTHER);
      rerender(<BodyTabHost Wiring={LinksTab} bodyId={OTHER} />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      expect(undo.announce).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(convex.mutations.get('waterBodies:setReferenceLinks')).toHaveBeenCalledTimes(1);
    });
  });
});
