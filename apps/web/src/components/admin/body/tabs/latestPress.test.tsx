import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **A late answer to a pick never acts on moved UI, and the last press wins** — over the wired tabs
 * whose controls write on press (`useLatestPick`): Names' *Display this* and class, Access's ruling,
 * Water's depth source. (The map boost, the frame's, holds the same rule in `BodyConsoleView.test`.)
 * Each case presses A and holds its write, then: presses B before A is answered (A landing shows
 * B still, and B is stored), or moves to a control outside the tab (A landing takes no focus and
 * still shows A). The server is a model of each mutation's effect on the reads, applied as each
 * write lands; the record is read again after every answer.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as Array<[string, Record<string, unknown>]>,
  answers: [] as (() => void)[],
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
      const name = getFunctionName(ref);
      mocks.calls.push([name, args as Record<string, unknown>]);
      await new Promise<void>((r) => mocks.answers.push(r));
      mocks.server?.(name, args as Record<string, unknown>);
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: async () => {} }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { AccessTab } from './access/AccessTab';
import { stubJsdomAnimations } from './jsdomStubs';
import { NamesTab } from './names/NamesTab';
import { WaterTab } from './water/WaterTab';

beforeAll(stubJsdomAnimations);

const fn = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);
const GET = fn(api.waterBodies.get);
type User = ReturnType<typeof userEvent.setup>;
const record = () => (mocks.results.get(GET) as { body: Record<string, unknown> }).body;
const setRecord = (patch: Record<string, unknown>) =>
  mocks.results.set(GET, { available: true, body: { ...record(), ...patch } });

const NAMES_BODY = {
  _id: 'wb1',
  name: 'Lake Auburn',
  type: 'lakePond',
  states: ['ME'],
  nameClaims: [
    { source: 'nhd', value: 'The Basin' },
    { source: 'osm', value: 'Lake Auburn' },
  ],
};
const identityOf = (cls: string, moderatorClass: string | null) => ({
  bodyClass: cls,
  classClaims: null,
  moderatorClass,
  baseClass: 'lakePond',
  moderatorAliases: [],
});
const depthChoices = (meanFrom: string) => ({
  mean: {
    choices: [
      { source: 'state_agency', valueM: 9.4, inUse: meanFrom === 'state_agency' },
      { source: 'hydrolakes_modeled', valueM: 8.1, inUse: meanFrom === 'hydrolakes_modeled' },
    ],
  },
  max: { choices: [{ source: 'state_agency', valueM: 24, inUse: true }] },
  recorded: true,
});

const rungNow = (i: number) =>
  expect(document.querySelectorAll('[data-slot="name-rung"]')[i]).toHaveTextContent(/Now/);
const checked = (group: string | null, name: RegExp) =>
  expect(
    (group === null
      ? screen.getAllByRole('radio', { checked: true })[0]
      : within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', {
          checked: true,
        })) as HTMLElement,
  ).toHaveAccessibleName(name);
const anotherClass = async (user: User, label: RegExp) => {
  await user.click(screen.getByRole('button', { name: /Another class/ }));
  await user.click(await screen.findByRole('menuitem', { name: label }));
  await user.click(screen.getByRole('button', { name: /^Set as/ }));
};

type Case = {
  name: string;
  setup: () => void;
  render: () => ReactNode;
  pressA: (user: User) => Promise<void>;
  pressB: (user: User) => Promise<void>;
  /** What the control shows with A, or B, the latest press. */
  showsA: () => void;
  showsB: () => void;
  /** Each write's value, as sent. */
  sent: () => unknown[];
  a: unknown;
  b: unknown;
};

const CASES: Case[] = [
  {
    name: 'Names: Display this',
    setup: () => {
      mocks.results.set(GET, { available: true, body: NAMES_BODY });
      mocks.server = (_name, args) => {
        const catalog = NAMES_BODY.nameClaims;
        const chosen = args.name as string;
        setRecord({ name: chosen, nameClaims: [{ source: 'user', value: chosen }, ...catalog] });
      };
    },
    render: () => <NamesTab bodyId="wb1" />,
    pressA: (user) => user.click(screen.getByRole('button', { name: 'Display this' })),
    pressB: (user) => user.click(screen.getByRole('button', { name: 'Display this' })),
    showsA: () => rungNow(0),
    showsB: () => rungNow(1),
    sent: () => mocks.calls.map(([, a]) => a.name),
    a: 'The Basin',
    b: 'Lake Auburn',
  },
  {
    name: 'Names: the class',
    setup: () => {
      mocks.results.set(GET, { available: true, body: NAMES_BODY });
      mocks.results.set(fn(api.bodyConsole.identity), identityOf('lakePond', null));
      mocks.server = (_name, args) => {
        const cls = (args.bodyClass as string | null) ?? 'lakePond';
        setRecord({ type: cls });
        mocks.results.set(
          fn(api.bodyConsole.identity),
          identityOf(cls, args.bodyClass as string | null),
        );
      };
    },
    render: () => <NamesTab bodyId="wb1" />,
    pressA: (user) => anotherClass(user, /Reservoir/),
    pressB: (user) => anotherClass(user, /Wetland/),
    showsA: () => checked('Class', /Reservoir/),
    showsB: () => checked('Class', /Wetland/),
    sent: () => mocks.calls.map(([, a]) => a.bodyClass),
    a: 'reservoir',
    b: 'wetland',
  },
  {
    name: 'Access: the ruling',
    setup: () => {
      mocks.results.set(GET, {
        available: true,
        body: { _id: 'wb1', name: 'Mascoma Lake', publicAccess: { verdict: 'open', decidedAt: 1 } },
      });
      mocks.results.set(fn(api.accessPoints.accessForBody), {
        putIns: [],
        parking: [],
        blockedIds: [],
        alerts: [],
      });
      mocks.results.set(fn(api.landmarks.listForBody), []);
      mocks.results.set(fn(api.bodyConsole.history), { entries: [], capped: false });
      mocks.server = (_name, args) =>
        setRecord({
          publicAccess:
            args.verdict === null ? undefined : { verdict: args.verdict, decidedAt: Date.now() },
        });
    },
    render: () => <AccessTab bodyId="wb1" />,
    pressA: (user) => user.click(screen.getByRole('button', { name: 'Clear the ruling' })),
    pressB: (user) => user.click(screen.getByRole('button', { name: 'Rule accessible' })),
    showsA: () => {
      expect(screen.queryByRole('button', { name: 'Clear the ruling' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Rule accessible' })).toBeTruthy();
    },
    showsB: () => {
      expect(screen.queryByRole('button', { name: 'Rule accessible' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Clear the ruling' })).toBeTruthy();
    },
    sent: () => mocks.calls.map(([, a]) => a.verdict),
    a: null,
    b: 'open',
  },
  {
    name: 'Water: the mean’s source',
    setup: () => {
      mocks.results.set(GET, {
        available: true,
        body: {
          _id: 'wb1',
          name: 'Mascoma Lake',
          states: ['NH'],
          meanDepthM: 9.4,
          maxDepthM: 24,
          meanDepthSource: 'state_agency',
          maxDepthSource: 'state_agency',
        },
      });
      mocks.results.set(fn(api.bodyConsole.depthChoices), depthChoices('state_agency'));
      mocks.results.set(fn(api.bodyConsole.consoleExtras), { towns: [], hasBathymetry: false });
      mocks.server = (_name, args) => {
        setRecord({ meanDepthSource: args.source });
        mocks.results.set(fn(api.bodyConsole.depthChoices), depthChoices(args.source as string));
      };
    },
    render: () => <WaterTab bodyId="wb1" />,
    pressA: async (user) => {
      await user.click(screen.getByRole('radio', { name: 'HydroLAKES, 8.1 m' }));
      await user.click(screen.getByRole('button', { name: /Use HydroLAKES for the mean/ }));
    },
    pressB: async (user) => {
      await user.click(screen.getByRole('radio', { name: /state survey, 9\.4 m/ }));
      await user.click(screen.getByRole('button', { name: /Use NH state survey for the mean/ }));
    },
    showsA: () => checked('Mean depth', /HydroLAKES/),
    showsB: () => checked('Mean depth', /state survey/),
    sent: () => mocks.calls.map(([, a]) => a.source),
    a: 'hydrolakes_modeled',
    b: 'state_agency',
  },
];

function Elsewhere({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <input aria-label="Somewhere else" />
    </>
  );
}

/** A frame and a tick: long enough for a focus move deferred to the next frame to have happened. */
const settle = () =>
  act(async () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));

beforeEach(() => {
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.length = 0;
  mocks.answers.length = 0;
  mocks.server = null;
});

describe('a late answer to a pick', () => {
  it.each(CASES)(
    '$name: after a newer press, A landing still shows B, and B is stored',
    async (c) => {
      const user = userEvent.setup();
      c.setup();
      const { rerender } = render(<Elsewhere>{c.render()}</Elsewhere>);
      await c.pressA(user);
      c.showsA();
      await c.pressB(user);
      c.showsB();
      // One write at a time: B waits for A's answer.
      expect(c.sent()).toEqual([c.a]);
      await act(async () => mocks.answers.shift()?.());
      await settle();
      rerender(<Elsewhere>{c.render()}</Elsewhere>);
      c.showsB();
      expect(c.sent()).toEqual([c.a, c.b]);
      await act(async () => mocks.answers.shift()?.());
      await settle();
      rerender(<Elsewhere>{c.render()}</Elsewhere>);
      c.showsB();
      expect(mocks.answers).toHaveLength(0);
    },
  );

  it.each(CASES)('$name: after the moderator moved on, A lands taking no focus', async (c) => {
    const user = userEvent.setup();
    c.setup();
    const { rerender } = render(<Elsewhere>{c.render()}</Elsewhere>);
    await c.pressA(user);
    const elsewhere = screen.getByRole('textbox', { name: 'Somewhere else' });
    await user.click(elsewhere);
    await act(async () => mocks.answers.shift()?.());
    await settle();
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    expect(elsewhere).toHaveFocus();
    c.showsA();
    expect(c.sent()).toEqual([c.a]);
  });
});

describe('Access: a reason’s dialog', () => {
  it('canceled, is no press: nothing is sent and the ruling stands', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.calls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Clear the ruling' })).toBeTruthy();
  });

  it('confirmed behind a press on its way, it is sent after it, and the last press stands', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const { rerender } = render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Clear the ruling' }));
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    await user.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
    await act(async () => mocks.answers.shift()?.());
    await settle();
    rerender(<AccessTab bodyId="wb1" />);
    // The clear landed; the ruling the dialog confirmed still shows, its dialog still waiting.
    expect(document.querySelector('[data-slot="ruling-statement"]')).toHaveTextContent(
      /found no public access/,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => mocks.answers.shift()?.());
    await settle();
    rerender(<AccessTab bodyId="wb1" />);
    expect(mocks.calls.map(([, a]) => a.verdict)).toEqual([null, 'none']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((record().publicAccess as { verdict: string }).verdict).toBe('none');
  });
});
