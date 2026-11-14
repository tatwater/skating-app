import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as { name: string; args: unknown }[],
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          convex.calls.push({ name, args });
          const r = convex.results.get(name);
          return [key, typeof r === 'function' ? r(args) : r];
        }),
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
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => nav.navigate }));

import { seasonOf } from '@skating/core';
import { ConvexError } from 'convex/values';
import { HAZARDS_TAB, HazardsTab } from './HazardsTab';
import { dailyFrom, FEB_ARCHIVED, FEB_HAZARDS, MASCOMA_FEATURES } from './hazardsFixtures';
import { dailyClock, winterWindow } from './hazardsModel';
import { resetReadPauses } from './tabReads';

const BODY = 'k1';

beforeAll(stubJsdomAnimations);

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
  convex.results.set('hazards:listForBody', () => []);
  resetReadPauses();
  // Whatever winter the clock is in: this one bare, the last with one archived hazard in it.
  convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
    args.season === seasonOf(Date.now())
      ? dailyFrom(args.season, [], args.now)
      : dailyFrom(
          args.season,
          [{ first: winterWindow(args.season).start + 60 * 86_400_000, active: false }],
          args.now,
        ),
  );
  convex.results.set('recurrence:listForBodyAdmin', [
    { _id: 'r1' },
    { _id: 'r2' },
    { _id: 'r3', suppressedAt: 1 },
    { _id: 'r4', promotedToFeatureId: 'f' },
  ]);
});

describe('HazardsTab', () => {
  it('holds its place until the body lands, and says so when it can’t be read', () => {
    convex.results.delete('waterBodies:get');
    const { container, rerender } = render(<HazardsTab bodyId={BODY} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(/No hazard reports/)).toBeNull();
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('This body couldn’t be read')).toBeVisible();
  });

  it('reads this season’s hazards, the archived, the features and the waiting patterns', () => {
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('No hazard reports yet')).toBeVisible();
    expect(
      screen.getByText(/There are no hazard reports on record for Mascoma this winter\./),
    ).toBeVisible();
    expect(screen.getByText('2 patterns on Mascoma wait in the pre-ice pass')).toBeVisible();
    const seasons = convex.calls
      .filter((c) => c.name === 'hazards:listForBody')
      .map((c) => (c.args as { season: number }).season);
    expect(new Set(seasons).size).toBe(1);
    // No writer for these yet: drawn, and not available yet.
    expect(screen.getByRole('button', { name: /Mark a hazard/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: /Add a feature/ })).toHaveAttribute(
      'data-unavailable',
    );
  });

  it('reads this winter’s day-by-day count beside last winter’s, against an hour’s clock', () => {
    render(<HazardsTab bodyId={BODY} />);
    const daily = convex.calls
      .filter((c) => c.name === 'bodyConsole:dailyHazards')
      .map((c) => c.args as { season: number; now: number });
    const current = daily[0]?.season ?? Number.NaN;
    expect(new Set(daily.map((d) => d.season))).toEqual(new Set([current, current - 1]));
    expect(daily.every((d) => d.now % 3_600_000 === 0)).toBe(true);
    // This winter's clock is past every instant of this hour; last winter's is its own end.
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const thisWinter = daily.find((d) => d.season === current);
    expect(thisWinter?.now).toBe(dailyClock(current, hour));
    const { start, days } = winterWindow(current - 1);
    expect(daily.find((d) => d.season === current - 1)?.now).toBe(start + days * 86_400_000);
    expect(screen.getByRole('img', { name: /some unknown/ })).toBeVisible();
  });

  it('over a list, last winter’s read neither holds nor fails the strip that is drawn', () => {
    convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
      args.includeArchived ? [...FEB_HAZARDS, ...FEB_ARCHIVED] : FEB_HAZARDS,
    );
    const thisWinter = convex.results.get('bodyConsole:dailyHazards') as (args: {
      season: number;
      now: number;
    }) => unknown;
    convex.results.set('bodyConsole:dailyHazards', (args: { season: number; now: number }) =>
      args.season === seasonOf(Date.now()) ? thisWinter(args) : new Error('boom'),
    );
    render(<HazardsTab bodyId={BODY} />);
    expect(document.querySelector('[data-slot="hazards-winters"]')).not.toBeNull();
    expect(screen.queryByText('The winter’s day-by-day count couldn’t be read')).toBeNull();
  });

  it('a failed read says so in its place; Try again reads every read afresh', async () => {
    convex.results.set('hazards:listForBody', new Error('boom'));
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('The hazards on the lake couldn’t be read')).toBeVisible();
    convex.results.set('hazards:listForBody', () => []);
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement);
    expect(await screen.findByText('No hazard reports yet')).toBeVisible();
  });

  it('a populated winter lists its hazards over its strip, its archived ones in their group', () => {
    convex.results.set('hazards:listForBody', (args: { includeArchived?: boolean }) =>
      args.includeArchived ? [...FEB_HAZARDS, ...FEB_ARCHIVED] : FEB_HAZARDS,
    );
    render(<HazardsTab bodyId={BODY} />);
    expect(screen.getByText('Black Point to Wood Island')).toBeVisible();
    expect(screen.getByRole('button', { name: /Archived this winter/ })).toHaveTextContent('2');
    expect(document.querySelector('[data-slot="hazards-winters"]')).not.toBeNull();
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
    const first = convex.calls.find((c) => c.name === 'hazards:listForBody');
    const current = (first?.args as { season: number } | undefined)?.season ?? Number.NaN;
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

  it('without the capabilities: no tools, and the queue isn’t read', () => {
    role.caps = new Set();
    render(<HazardsTab bodyId={BODY} />);
    expect(
      screen.queryByRole('button', { name: /Demote|Mark a hazard|Add a feature|Edit shape/ }),
    ).toBeNull();
    expect(screen.queryByText('Promotion')).toBeNull();
    expect(convex.calls.find((c) => c.name === 'recurrence:listForBodyAdmin')).toBeUndefined();
  });

  it('a body that isn’t listed draws nothing', () => {
    convex.results.set('waterBodies:get', { available: false });
    const { container } = render(<HazardsTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
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
    // A failed read draws nothing of its own on the map.
    convex.results.set('bodyFeatures:listForBody', new Error('boom'));
    rerender(<Probe />);
    expect(seen.at(-1)).toBeUndefined();
  });
});
