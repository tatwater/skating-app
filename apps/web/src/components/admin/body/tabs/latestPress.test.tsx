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
  /** Beside each answer, its refusal: the server's words thrown back instead. */
  refusals: [] as (() => void)[],
  server: null as ((name: string, args: Record<string, unknown>) => void) | null,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const { ConvexError } = await import('convex/values');
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
      await new Promise<void>((resolve, reject) => {
        mocks.answers.push(resolve);
        mocks.refusals.push(() => reject(new ConvexError('Not allowed')));
      });
      mocks.server?.(name, args as Record<string, unknown>);
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: () => true, isLoading: false }),
}));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: async () => {} }) }));
const toasts = vi.hoisted(() => [] as { title: string; description?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => toasts.push(t),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { useBoostCommit } from '../frame/BodyConsoleRoute';
import { BodyConsoleView } from '../frame/BodyConsoleView';
import {
  BODY_NOW,
  MASCOMA_ASKS,
  MASCOMA_COMPLETENESS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_TOWNS,
  MASCOMA_TRUST,
} from '../frame/bodyFixtures';
import { attentionTabs } from '../frame/bodyModel';
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
  /** The control on `body`'s page (default wb1). */
  render: (body?: string) => ReactNode;
  pressA: (user: User) => Promise<void>;
  pressB: (user: User) => Promise<void>;
  /** What the control shows with A, or B, the latest press. */
  showsA: () => void;
  showsB: () => void;
  /** What the control shows with nothing pressed: the record as it was. */
  showsServer: () => void;
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
    render: (body = 'wb1') => <NamesTab bodyId={body} />,
    pressA: (user) => user.click(screen.getByRole('button', { name: 'Display this' })),
    pressB: (user) => user.click(screen.getByRole('button', { name: 'Display this' })),
    showsA: () => rungNow(0),
    showsB: () => rungNow(1),
    showsServer: () => rungNow(1),
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
    render: (body = 'wb1') => <NamesTab bodyId={body} />,
    pressA: (user) => anotherClass(user, /Reservoir/),
    pressB: (user) => anotherClass(user, /Wetland/),
    showsA: () => checked('Class', /Reservoir/),
    showsB: () => checked('Class', /Wetland/),
    showsServer: () => checked('Class', /Lake or pond/),
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
    render: (body = 'wb1') => <AccessTab bodyId={body} />,
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
    showsServer: () => {
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
    render: (body = 'wb1') => <WaterTab bodyId={body} />,
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
    showsServer: () => checked('Mean depth', /state survey/),
    sent: () => mocks.calls.map(([, a]) => a.source),
    a: 'hydrolakes_modeled',
    b: 'state_agency',
  },
  {
    name: 'the frame: the map boost',
    setup: () => {
      mocks.results.set(GET, { available: true, body: { _id: 'wb1', curatedBoost: 0.3 } });
      mocks.server = (_name, args) => setRecord({ curatedBoost: args.curatedBoost });
    },
    render: (body = 'wb1') => <BoostHost body={body} />,
    pressA: async (user) => {
      act(() => slider().focus());
      await user.keyboard('{ArrowRight}');
    },
    pressB: async (user) => {
      act(() => slider().focus());
      await user.keyboard('{ArrowRight}');
    },
    showsA: () => expect(slider()).toHaveAttribute('aria-valuenow', '0.4'),
    showsB: () => expect(slider()).toHaveAttribute('aria-valuenow', '0.5'),
    showsServer: () => expect(slider()).toHaveAttribute('aria-valuenow', '0.3'),
    sent: () => mocks.calls.map(([, a]) => a.curatedBoost),
    a: 0.4,
    b: 0.5,
  },
];

const slider = () => screen.getByRole('slider', { name: 'Map boost' });

/** The console's left column as the route mounts it, its boost written by the route's own commit. */
function BoostHost({ body }: { body: string }) {
  const commit = useBoostCommit(body);
  return (
    <KeysProvider>
      <BodyConsoleView
        identity={{
          ...MASCOMA_IDENTITY,
          id: body,
          boost: { value: record().curatedBoost as number, note: null },
        }}
        completeness={MASCOMA_COMPLETENESS}
        towns={MASCOMA_TOWNS}
        trust={MASCOMA_TRUST}
        asks={MASCOMA_ASKS}
        history={MASCOMA_HISTORY_ENTRIES}
        lit={null}
        now={BODY_NOW}
        tab="shape"
        onTabChange={() => {}}
        onOpenAsk={() => {}}
        attention={attentionTabs(MASCOMA_COMPLETENESS.missing)}
        tabPanel={<p>Shape</p>}
        map={<div>map</div>}
        onBoostCommit={commit}
      />
    </KeysProvider>
  );
}

/** The oldest write out lands. */
const land = () => {
  mocks.refusals.shift();
  mocks.answers.shift()?.();
};
/** The oldest write out is refused, in the server's words. */
const refuse = () => {
  mocks.answers.shift();
  mocks.refusals.shift()?.();
};

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
  mocks.refusals.length = 0;
  mocks.server = null;
  toasts.length = 0;
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
      await act(async () => land());
      await settle();
      rerender(<Elsewhere>{c.render()}</Elsewhere>);
      c.showsB();
      expect(c.sent()).toEqual([c.a, c.b]);
      await act(async () => land());
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
    await act(async () => land());
    await settle();
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    expect(elsewhere).toHaveFocus();
    c.showsA();
    expect(c.sent()).toEqual([c.a]);
  });
});

/**
 * **Left and returned while a write waits** (Greptile on #136): the control's queue lives outside
 * it, so the control that comes back joins it — showing the press on its way, never the record's
 * older value — and a press made then waits behind it. A landed write needs nothing more; a refused
 * one is said (a toast, the console's words for a write refused while its page is gone or here) and
 * the control shows the record again.
 */
describe('left and returned while a write waits', () => {
  it.each(CASES)('$name: A lands, and B pressed on return is stored after it', async (c) => {
    const user = userEvent.setup();
    c.setup();
    const { rerender } = render(<Elsewhere>{c.render()}</Elsewhere>);
    await c.pressA(user);
    rerender(<Elsewhere>{null}</Elsewhere>);
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    c.showsA();
    await c.pressB(user);
    c.showsB();
    expect(c.sent()).toEqual([c.a]);
    await act(async () => land());
    await settle();
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    c.showsB();
    expect(c.sent()).toEqual([c.a, c.b]);
    await act(async () => land());
    await settle();
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    c.showsB();
    expect(toasts).toEqual([]);
  });

  it.each(CASES)('$name: A is refused while away — said, and the record shows again', async (c) => {
    const user = userEvent.setup();
    c.setup();
    const { rerender } = render(<Elsewhere>{c.render()}</Elsewhere>);
    await c.pressA(user);
    rerender(<Elsewhere>{null}</Elsewhere>);
    await act(async () => refuse());
    await settle();
    // Said once, naming what wasn't saved.
    expect(toasts).toEqual([
      expect.objectContaining({ description: expect.stringMatching(/^The .*: Not allowed$/) }),
    ]);
    rerender(<Elsewhere>{c.render()}</Elsewhere>);
    c.showsServer();
    expect(c.sent()).toEqual([c.a]);
  });
});

/**
 * **Who hears an answer** (Greptile on #136, again): a write answered while the control that asked
 * is still there, gone with its tab, back on a new mount, or gone with another body shown. A
 * refusal is said exactly once — in a toast naming what wasn't saved — never inside something gone;
 * a landed write says nothing; a control on screen shows the record once its queue has drained.
 */
const WHERE = ['still there', 'tab away', 'tab returned', 'another body shown'] as const;
const ASKED = CASES.flatMap((c) =>
  WHERE.flatMap((where) =>
    (['landed', 'refused'] as const).map((outcome) => ({ ...c, where, outcome })),
  ),
);

describe('who hears a pick’s answer', () => {
  it.each(ASKED)('$name: $where, $outcome', async (c) => {
    const user = userEvent.setup();
    c.setup();
    const page = (node: ReactNode) => <Elsewhere>{node}</Elsewhere>;
    const { rerender } = render(page(c.render()));
    await c.pressA(user);
    const shownAfter = {
      'still there': () => c.render(),
      'tab away': () => null,
      'tab returned': () => c.render(),
      'another body shown': () => c.render('wb2'),
    }[c.where];
    if (c.where !== 'still there') rerender(page(null));
    rerender(page(shownAfter()));
    await act(async () => (c.outcome === 'landed' ? land() : refuse()));
    await settle();
    rerender(page(shownAfter()));
    expect(c.sent()).toEqual([c.a]);
    if (c.outcome === 'landed') {
      expect(toasts).toEqual([]);
      if (c.where === 'still there' || c.where === 'tab returned') c.showsA();
    } else {
      expect(toasts).toEqual([
        expect.objectContaining({ description: expect.stringMatching(/^The .*: Not allowed$/) }),
      ]);
      if (c.where !== 'tab away') c.showsServer();
    }
  });
});

describe('Access: a reason’s dialog', () => {
  /**
   * The dialog's answer is its own while it is open: a refusal shows over the kept reason. Once the
   * dialog has gone — its tab away, back on a new mount, another body shown — the refusal is said
   * once in a toast, never into a dialog that has gone. Its write in flight, or waiting behind a
   * clear.
   */
  const DIALOG = (['in flight', 'waiting behind a clear'] as const).flatMap((entry) =>
    (['still open', 'tab away', 'tab returned', 'another body shown'] as const).map((where) => ({
      entry,
      where,
    })),
  );
  it.each(DIALOG)('refused, $entry, its dialog $where', async ({ entry, where }) => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const { rerender } = render(
      <div>
        <AccessTab bodyId="wb1" />
      </div>,
    );
    if (entry === 'waiting behind a clear') {
      await user.click(screen.getByRole('button', { name: 'Clear the ruling' }));
    }
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    await user.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
    const shownAfter = {
      'still open': () => <AccessTab bodyId="wb1" />,
      'tab away': () => null,
      'tab returned': () => <AccessTab bodyId="wb1" />,
      'another body shown': () => <AccessTab bodyId="wb2" />,
    }[where];
    if (where !== 'still open') rerender(<div />);
    rerender(<div>{shownAfter()}</div>);
    if (entry === 'waiting behind a clear') {
      await act(async () => land());
      await settle();
    }
    await act(async () => refuse());
    await settle();
    rerender(<div>{shownAfter()}</div>);
    if (where === 'still open') {
      // Said over the kept reason, in the dialog that asked — and nowhere else.
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('Not allowed');
      expect(toasts).toEqual([]);
    } else {
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(toasts).toEqual([expect.objectContaining({ description: 'The ruling: Not allowed' })]);
    }
  });

  it('confirmed behind a clear, its dialog gone (Back, then Forward), refused: said once, the record shows', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const { rerender } = render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Clear the ruling' }));
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    await user.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
    // Back and Forward before the clear answers: the tab, and its dialog, are mounted afresh.
    rerender(<div />);
    rerender(<AccessTab bodyId="wb1" />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => land());
    await settle();
    await act(async () => refuse());
    await settle();
    rerender(<AccessTab bodyId="wb1" />);
    expect(mocks.calls.map(([, a]) => a.verdict)).toEqual([null, 'none']);
    // Said once, naming what wasn't saved, never inside a dialog that has gone.
    expect(toasts).toEqual([
      expect.objectContaining({ description: expect.stringMatching(/ruling.*Not allowed/) }),
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The record shows: the clear landed, the ruling refused.
    expect(screen.queryByRole('button', { name: 'Clear the ruling' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rule accessible' })).toBeTruthy();
  });

  it('a one-shot reason (Hide) refused after its dialog went with its row, the tab still here: said once', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const access = fn(api.accessPoints.accessForBody);
    const launch = {
      id: 'pi1',
      coord: { lat: 43.6489, lng: -72.1793 },
      name: 'NW launch',
      source: 'osm',
    };
    mocks.results.set(access, { putIns: [launch], parking: [], blockedIds: [], alerts: [] });
    const { rerender } = render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'A private dock');
    await user.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    // Another moderator's change takes the launch, and its dialog, away; the tab stays.
    mocks.results.set(access, { putIns: [], parking: [], blockedIds: [], alerts: [] });
    rerender(<AccessTab bodyId="wb1" />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => refuse());
    await settle();
    expect(toasts).toEqual([
      expect.objectContaining({ description: expect.stringMatching(/NW launch: Not allowed$/) }),
    ]);
  });

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

  it('confirmed after another moderator already ruled the same, its reason is still sent', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const { rerender } = render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    // Another moderator's ruling lands while the dialog is open.
    setRecord({ publicAccess: { verdict: 'none', decidedAt: Date.now() } });
    rerender(<AccessTab bodyId="wb1" />);
    await user.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
    // Never closed as saved with nothing sent: the reason typed is recorded.
    expect(mocks.calls).toEqual([
      [
        'waterBodies:setPublicAccess',
        { waterBodyId: 'wb1', verdict: 'none', reason: 'Posted all round' },
      ],
    ]);
    await act(async () => land());
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('confirmed after another moderator already ruled the same, its dialog gone with the tab still here, refused: said once', async () => {
    const user = userEvent.setup();
    CASES[2]?.setup();
    const { rerender } = render(<AccessTab bodyId="wb1" />);
    await user.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted all round');
    setRecord({ publicAccess: { verdict: 'none', decidedAt: Date.now() } });
    rerender(<AccessTab bodyId="wb1" />);
    await user.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
    expect(mocks.calls).toHaveLength(1);
    // The body's record goes away while the write is out: the tab stays, its ruling — and the
    // dialog that asked — go.
    mocks.results.set(GET, { available: false });
    rerender(<AccessTab bodyId="wb1" />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => refuse());
    await settle();
    expect(toasts).toEqual([expect.objectContaining({ description: 'The ruling: Not allowed' })]);
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
    await act(async () => land());
    await settle();
    rerender(<AccessTab bodyId="wb1" />);
    // The clear landed; the ruling the dialog confirmed still shows, its dialog still waiting.
    expect(document.querySelector('[data-slot="ruling-statement"]')).toHaveTextContent(
      /found no public access/,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => land());
    await settle();
    rerender(<AccessTab bodyId="wb1" />);
    expect(mocks.calls.map(([, a]) => a.verdict)).toEqual([null, 'none']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((record().publicAccess as { verdict: string }).verdict).toBe('none');
  });
});
