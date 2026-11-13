import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as { name: string; args: unknown }[],
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      const name = getFunctionName(ref);
      convex.calls.push({ name, args });
      if (args === 'skip') return undefined;
      const r = convex.results.get(name);
      return typeof r === 'function' ? r(args) : r;
    },
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
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => nav.navigate }));

import { ConvexError } from 'convex/values';
import { HAZARDS_TAB, HazardsTab } from './HazardsTab';
import { FEB_ARCHIVED, FEB_HAZARDS, MASCOMA_FEATURES } from './hazardsFixtures';

const BODY = 'k1';

beforeEach(() => {
  convex.results.clear();
  convex.mutations.clear();
  convex.calls = [];
  undo.announce.mockClear();
  nav.navigate.mockClear();
  role.caps = new Set(['body.read', 'corpus.preIce']);
  convex.results.set('waterBodies:get', {
    available: true,
    body: { _id: BODY, name: 'Mascoma Lake' },
  });
  convex.results.set('bodyFeatures:listForBody', MASCOMA_FEATURES);
  convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
    args.includeArchived ? [...FEB_HAZARDS, ...FEB_ARCHIVED] : [],
  );
  convex.results.set('recurrence:listForBodyAdmin', [
    { _id: 'r1' },
    { _id: 'r2' },
    { _id: 'r3', suppressedAt: 1 },
    { _id: 'r4', promotedToFeatureId: 'f' },
  ]);
});

describe('HazardsTab', () => {
  it('draws nothing until the body lands', () => {
    convex.results.delete('waterBodies:get');
    const { container } = render(<HazardsTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads this season’s hazards, the archived, the features and the waiting patterns', () => {
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('Nothing marked yet')).toBeVisible();
    expect(screen.getByText(/No one has marked a hazard on Mascoma this winter\./)).toBeVisible();
    expect(screen.getByText('2 patterns on Mascoma wait in the pre-ice pass')).toBeVisible();
    const seasons = convex.calls
      .filter((c) => c.name === 'hazards:listForBody')
      .map((c) => (c.args as { season: number }).season);
    expect(new Set(seasons).size).toBe(1);
    // No writer for these yet: not drawn.
    expect(
      screen.queryByRole('button', { name: /Mark a hazard|Add a feature|Edit shape/ }),
    ).toBeNull();
  });

  it('demotes with the reason and announces it to Undo; a refusal reads in the server’s words', async () => {
    render(<HazardsTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Not a spring');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(convex.mutations.get('bodyFeatures:demote')).toHaveBeenCalledWith({
      bodyFeatureId: 'f-spring',
      reason: 'Not a spring',
    });
    expect(undo.announce).toHaveBeenCalledWith({
      title: 'Known feature demoted',
      target: { targetType: 'bodyFeature', targetId: 'f-spring' },
    });
  });

  it('a refused demotion says why and announces nothing', async () => {
    convex.mutations.set(
      'bodyFeatures:demote',
      vi.fn(async () => {
        throw new ConvexError('Body feature not found');
      }),
    );
    render(<HazardsTab bodyId={BODY} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Demote' })[0] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: /Demote/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /again/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Body feature not found');
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('a past winter reads that season, and Recurrence opens the pre-ice pass', async () => {
    render(<HazardsTab bodyId={BODY} />);
    const current = (
      convex.calls.find((c) => c.name === 'hazards:listForBody')?.args as { season: number }
    ).season;
    await userEvent.click(
      screen.getByRole('button', {
        name: `${current - 1}–${String(current % 100).padStart(2, '0')}`,
      }),
    );
    const last = convex.calls.filter((c) => c.name === 'hazards:listForBody').at(-1);
    expect(last?.args).toMatchObject({ season: current - 1 });
    expect(screen.getByText('Read-only')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Recurrence/ }));
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/admin/recurrence' });
  });

  it('without the capabilities: no Demote, and the queue isn’t read', () => {
    role.caps = new Set();
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.queryByRole('button', { name: 'Demote' })).toBeNull();
    expect(screen.queryByText('Promotion')).toBeNull();
    expect(convex.calls.find((c) => c.name === 'recurrence:listForBodyAdmin')?.args).toBe('skip');
  });

  it('registers its wiring and a map whose data keeps its identity', () => {
    expect(HAZARDS_TAB.Wiring).toBe(HazardsTab);
    const hazards = [] as unknown[];
    convex.results.set('hazards:listForBody', hazards);
    const seen: unknown[] = [];
    function Probe() {
      seen.push(HAZARDS_TAB.map?.useData(BODY, null));
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    const scene = HAZARDS_TAB.map?.describe(seen[0] as never, 'feature:f-spring');
    expect(scene?.lit).toBe('feature:f-spring');
    expect(scene?.items.map((i: { id: string }) => i.id)).toEqual([
      'feature:f-spring',
      'feature:f-narrows',
    ]);
    convex.results.delete('bodyFeatures:listForBody');
    rerender(<Probe />);
    expect(seen.at(-1)).toBeUndefined();
  });
});
