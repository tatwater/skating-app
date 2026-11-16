import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  /** The server's own effect of a write on the reads, applied when the write is called. */
  server: null as ((name: string, args: Record<string, unknown>) => void) | null,
  /** A write held on its way until the test lets it land. */
  hold: null as Promise<void> | null,
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
      if (mocks.hold !== null) await mocks.hold;
      if (!mocks.fail) mocks.server?.(getFunctionName(ref), args as Record<string, unknown>);
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
import { CLASS_CLAIMS_NOT_RECORDED } from '../../consoleWords';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
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
  mocks.server = null;
  mocks.hold = null;
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
    // Said once, naming what wasn't saved (no body name outside a console's frame).
    await waitFor(() =>
      expect(toasts).toEqual([
        {
          title: 'Not saved',
          description: 'The displayed name: Water body not found',
          tone: 'bad',
        },
      ]),
    );
  });

  it('draws no control for a viewer without body.identity', () => {
    mocks.can = new Set();
    render(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Aliases' })).toBeNull();
    expect(screen.getAllByText('Lake Auburn').length).toBeGreaterThan(0);
  });

  /** `bodyConsole.identity`, as the server answers it. */
  const identityOf = (over: Record<string, unknown> = {}) => ({
    bodyClass: 'lakePond',
    classClaims: null,
    moderatorClass: null,
    moderatorAliases: [],
    ...over,
  });

  it('saves the aliases as a whole list naming the list it was built on, and says a refusal in place', async () => {
    const identity = getFunctionName(api.bodyConsole.identity);
    mocks.results.set(identity, identityOf({ moderatorAliases: ['The Basin'] }));
    // `setAliases` stores the list; the identity read answers with it.
    mocks.server = (name, args) => {
      if (name === 'waterBodies:setAliases') {
        mocks.results.set(identity, identityOf({ moderatorAliases: args.aliases }));
      }
    };
    const { rerender } = render(<NamesTab bodyId="wb1" />);
    const field = screen.getByRole('combobox', { name: 'Aliases' });
    await userEvent.type(field, 'Big Pond{Enter}');
    await waitFor(() =>
      expect(mocks.calls).toEqual([
        [
          'waterBodies:setAliases',
          { waterBodyId: 'wb1', aliases: ['The Basin', 'Big Pond'], expected: ['The Basin'] },
        ],
      ]),
    );
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Aliases saved' }),
    );
    rerender(<NamesTab bodyId="wb1" />);
    // The server's refusal (past 20, past 120 characters) is said under the field.
    mocks.fail = true;
    await userEvent.type(screen.getByRole('combobox', { name: 'Aliases' }), 'Another{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Water body not found');
  });

  it('an aliases refusal that comes once the field isn’t drawn (its read failed, the tab still mounted) is a toast', async () => {
    const identity = getFunctionName(api.bodyConsole.identity);
    mocks.results.set(identity, identityOf({ moderatorAliases: ['The Basin'] }));
    let land: () => void = () => {};
    mocks.hold = new Promise<void>((r) => {
      land = r;
    });
    mocks.fail = true;
    const { rerender } = render(<NamesTab bodyId="wb1" />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Aliases' }), 'Big Pond{Enter}');
    mocks.results.set(identity, new Error('down'));
    rerender(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('combobox', { name: 'Aliases' })).toBeNull();
    await act(async () => land());
    await waitFor(() =>
      expect(toasts).toEqual([
        expect.objectContaining({ description: 'The aliases: Water body not found' }),
      ]),
    );
  });

  it('a failed read of the moderator’s aliases holds no place for the editor, and says so with Try again', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.identity), new Error('down'));
    render(<NamesTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent('the moderator’s aliases and class');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Never "on its way" for a read that failed, and never the catalogs' count in its place.
    const aliases = document.querySelector('[data-slot=aliases]');
    expect(aliases?.querySelector('[data-slot^=skeleton]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Aliases' })).toBeNull();
  });

  it('sets the class, and puts the catalogs’ class back over a moderator’s', async () => {
    const get = getFunctionName(api.waterBodies.get);
    const identity = getFunctionName(api.bodyConsole.identity);
    mocks.results.set(identity, identityOf());
    mocks.server = (name, args) => {
      if (name !== 'waterBodies:setClass') return;
      const cls = (args.bodyClass as string | null) ?? 'lakePond';
      mocks.results.set(get, { available: true, body: { ...BODY, type: cls } });
      mocks.results.set(identity, identityOf({ bodyClass: cls, moderatorClass: args.bodyClass }));
    };
    const { rerender } = render(<NamesTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: /Another class/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reservoir' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set as Reservoir' }));
    expect(mocks.calls).toEqual([
      ['waterBodies:setClass', { waterBodyId: 'wb1', bodyClass: 'reservoir' }],
    ]);
    rerender(<NamesTab bodyId="wb1" />);
    // Held now: no Set as; the way back to the catalogs' class instead.
    expect(screen.queryByRole('button', { name: /Set as/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the catalogs’ class' }));
    expect(mocks.calls.at(-1)).toEqual([
      'waterBodies:setClass',
      { waterBodyId: 'wb1', bodyClass: null },
    ]);
    rerender(<NamesTab bodyId="wb1" />);
    expect(screen.queryByRole('button', { name: 'Back to the catalogs’ class' })).toBeNull();
    expect(mocks.calls).toHaveLength(2);
  });

  it('says what no read records: each catalog’s class until the body’s next campaign, and the catalogs that agree', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.identity), identityOf());
    render(<NamesTab bodyId="wb1" />);
    expect(screen.getByText(CLASS_CLAIMS_NOT_RECORDED)).toBeTruthy();
    expect(
      screen.getByText(/Other catalogs that gave the same spelling: Not recorded yet/),
    ).toBeTruthy();
  });

  it('draws each catalog’s class once the import has stored them', () => {
    mocks.results.set(
      getFunctionName(api.bodyConsole.identity),
      identityOf({
        classClaims: [
          { source: 'osm', value: 'lakePond' },
          { source: 'nhd', value: 'reservoir' },
        ],
      }),
    );
    render(<NamesTab bodyId="wb1" />);
    expect(screen.queryByText(CLASS_CLAIMS_NOT_RECORDED)).toBeNull();
    expect(screen.getByRole('radio', { name: /Reservoir/ })).toBeTruthy();
  });

  it('places the body in its towns and county, from the boundaries', () => {
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('Auburn');
    expect(location()).toHaveTextContent('Lewiston');
    expect(location()).toHaveTextContent('Androscoggin County');
    expect(location()).toHaveTextContent('US Census BureauTIGER');
  });

  it('names every county a border body’s towns lie in', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.places), {
      towns: ['Alburgh', 'Champlain'],
      counties: ['Grand Isle', 'Clinton'],
      states: ['NY', 'VT'],
      computedAt: 1,
    });
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('CountiesGrand IsleClinton');
  });

  it('reads the town lines and says the towns whose line isn’t stored yet', () => {
    mocks.results.set(getFunctionName(api.bodyConsole.townLines), {
      towns: [
        { name: 'Auburn', state: 'ME', ring: null },
        { name: 'Lewiston', state: 'ME', ring: null },
      ],
      capped: false,
      computedAt: 1,
    });
    render(<NamesTab bodyId="wb1" />);
    expect(location()).toHaveTextContent('On the map, 2 towns’ lines aren’t stored yet');
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

  /**
   * **The latest press wins** (`useLatestPick`): a pick shows at once, each press is sent in press
   * order, and the server's answer is drawn again once every press has been answered — a second
   * press is never weighed against a record that hasn't moved yet and dropped.
   */
  describe('the latest press wins', () => {
    const get = getFunctionName(api.waterBodies.get);
    const identity = getFunctionName(api.bodyConsole.identity);
    const record = () => (mocks.results.get(get) as { body: { type: string } }).body;
    let land: () => void = () => {};
    beforeEach(() => {
      mocks.hold = new Promise<void>((r) => {
        land = r;
      });
    });

    it('Display The Basin, then Lake Auburn before the first answer: ends on Lake Auburn', async () => {
      // `setWaterBodyName`: the chosen name with a `user` claim over the catalogs'.
      mocks.server = (_name, args) => {
        const prior = (mocks.results.get(get) as { body: typeof BODY }).body;
        const catalog = prior.nameClaims.filter((c) => c.source !== 'user');
        const chosen = args.name as string;
        mocks.results.set(get, {
          available: true,
          body: {
            ...prior,
            name: chosen,
            nameClaims: [{ source: 'user', value: chosen }, ...catalog],
          },
        });
      };
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
      // Shown at once, though the server hasn't answered: The Basin is Now, Lake Auburn offered.
      const now = document.querySelectorAll('[data-slot="name-rung"]');
      expect(now[0]).toHaveTextContent(/The Basin.*Now/);
      await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
      await act(async () => land());
      rerender(<NamesTab bodyId="wb1" />);
      await waitFor(() =>
        expect(mocks.calls.map((c) => (c[1] as { name: string }).name)).toEqual([
          'The Basin',
          'Lake Auburn',
        ]),
      );
      rerender(<NamesTab bodyId="wb1" />);
      expect((mocks.results.get(get) as { body: typeof BODY }).body.name).toBe('Lake Auburn');
      expect(document.querySelectorAll('[data-slot="name-rung"]')[1]).toHaveTextContent(
        /Lake Auburn.*Now/,
      );
    });

    it('Set as Reservoir, then back to Lake or pond before the first answer: ends on Lake or pond', async () => {
      mocks.results.set(identity, identityOf());
      mocks.server = (name, args) => {
        if (name !== 'waterBodies:setClass') return;
        const cls = (args.bodyClass as string | null) ?? 'lakePond';
        mocks.results.set(get, { available: true, body: { ...BODY, type: cls } });
        mocks.results.set(identity, identityOf({ bodyClass: cls, moderatorClass: args.bodyClass }));
      };
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: /Another class/ }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reservoir' }));
      await userEvent.click(screen.getByRole('button', { name: 'Set as Reservoir' }));
      // Shown at once: Reservoir is checked and Now; Lake or pond can be set again.
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Reservoir/);
      await userEvent.click(screen.getByRole('button', { name: /Another class/ }));
      await userEvent.click(await screen.findByRole('menuitem', { name: /Lake or pond/i }));
      await userEvent.click(screen.getByRole('button', { name: /Set as Lake or pond/i }));
      await act(async () => land());
      await waitFor(() =>
        expect(mocks.calls.map((c) => (c[1] as { bodyClass: string }).bodyClass)).toEqual([
          'reservoir',
          'lakePond',
        ]),
      );
      rerender(<NamesTab bodyId="wb1" />);
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Lake or pond/i);
    });

    it('Reservoir, then Wetland while it waits; away and back, then Slow river reach: one queue, the last press stored', async () => {
      mocks.results.set(identity, identityOf());
      mocks.server = (name, args) => {
        if (name !== 'waterBodies:setClass') return;
        const cls = (args.bodyClass as string | null) ?? 'lakePond';
        mocks.results.set(get, { available: true, body: { ...BODY, type: cls } });
        mocks.results.set(identity, identityOf({ bodyClass: cls, moderatorClass: args.bodyClass }));
      };
      const pick = async (label: string | RegExp) => {
        await userEvent.click(screen.getByRole('button', { name: /Another class/ }));
        await userEvent.click(await screen.findByRole('menuitem', { name: label }));
        await userEvent.click(screen.getByRole('button', { name: /^Set as/ }));
      };
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await pick('Reservoir');
      await pick('Wetland');
      // Another tab, and back to Names, before the first write answers.
      rerender(<div />);
      rerender(<NamesTab bodyId="wb1" />);
      // The tab joins the queue that is there: the waiting choice shows, never the older record.
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Wetland/);
      await pick('Slow river reach');
      await act(async () => land());
      await waitFor(() => expect(record().type).toBe('river'));
      // One write at a time, in press order; the waiting Wetland was replaced, never sent last.
      expect(mocks.calls.map((c) => (c[1] as { bodyClass: string }).bodyClass)).toEqual([
        'reservoir',
        'river',
      ]);
    });

    it('Back to the catalogs’ class, then Reservoir again before the first answer: the catalogs’ class shows at once, ends on Reservoir', async () => {
      // A moderator's class over the catalogs' Lake or pond (`baseClass`, the class a clear puts back).
      mocks.results.set(get, { available: true, body: { ...BODY, type: 'reservoir' } });
      mocks.results.set(
        identity,
        identityOf({ bodyClass: 'reservoir', moderatorClass: 'reservoir', baseClass: 'lakePond' }),
      );
      mocks.server = (name, args) => {
        if (name !== 'waterBodies:setClass') return;
        const cls = (args.bodyClass as string | null) ?? 'lakePond';
        mocks.results.set(get, { available: true, body: { ...BODY, type: cls } });
        mocks.results.set(
          identity,
          identityOf({ bodyClass: cls, moderatorClass: args.bodyClass, baseClass: 'lakePond' }),
        );
      };
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Back to the catalogs’ class' }));
      // Shown at once: the catalogs' class is checked, and Reservoir can be set again.
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Lake or pond/i);
      expect(screen.queryByRole('button', { name: 'Back to the catalogs’ class' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: /Another class/ }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reservoir' }));
      await userEvent.click(screen.getByRole('button', { name: 'Set as Reservoir' }));
      await act(async () => land());
      await waitFor(() =>
        expect(mocks.calls.map((c) => (c[1] as { bodyClass: string | null }).bodyClass)).toEqual([
          null,
          'reservoir',
        ]),
      );
      rerender(<NamesTab bodyId="wb1" />);
      expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Reservoir/);
    });
  });

  it('holds its place while the record loads, and for a body that is not listed', () => {
    mocks.results.delete(getFunctionName(api.waterBodies.get));
    const { container, rerender } = render(<NamesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    mocks.results.set(getFunctionName(api.waterBodies.get), { available: false });
    rerender(<NamesTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  /**
   * Each write control, once the read returns what `setWaterBodyName` answers (from its source: a
   * chosen name becomes the record's name with a `user` claim over the catalogs'; `null` puts the
   * catalogs' first back and drops the `user` claim): the lever is gone or inert, and a second
   * press writes nothing.
   */
  describe('after the server answers, a write control is gone and a second press writes nothing', () => {
    const get = getFunctionName(api.waterBodies.get);
    beforeEach(() => {
      mocks.server = (_name, args) => {
        const prior = (mocks.results.get(get) as { body: typeof BODY }).body;
        const catalog = prior.nameClaims.filter((c) => c.source !== 'user');
        const chosen = args.name as string | null;
        mocks.results.set(get, {
          available: true,
          body:
            chosen === null
              ? { ...prior, name: catalog[0]?.value ?? prior.name, nameClaims: catalog }
              : {
                  ...prior,
                  name: chosen,
                  nameClaims: [{ source: 'user', value: chosen }, ...catalog],
                },
        });
      };
    });
    const rowOf = (text: string) =>
      screen
        .getAllByText(text)
        .map((el) => el.closest('li, [data-slot="name-rung"], tr'))
        .find((el): el is HTMLElement => el instanceof HTMLElement);

    it('Display this', async () => {
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
      rerender(<NamesTab bodyId="wb1" />);
      await waitFor(() =>
        expect(
          within(rowOf('The Basin') as HTMLElement).queryByRole('button', { name: 'Display this' }),
        ).toBeNull(),
      );
      expect(mocks.calls).toEqual([
        ['waterBodies:setWaterBodyName', { waterBodyId: 'wb1', name: 'The Basin' }],
      ]);
    });

    it('Back to the catalogs’ ranking', async () => {
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Back to the catalogs’ ranking' }));
      rerender(<NamesTab bodyId="wb1" />);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Back to the catalogs’ ranking' })).toBeNull(),
      );
      expect(mocks.calls).toHaveLength(1);
    });

    it('A community name, and Clear the name', async () => {
      mocks.results.set(get, {
        available: true,
        body: {
          ...BODY,
          name: 'Low Plains',
          nameClaims: [{ source: 'user', value: 'Low Plains' }],
        },
      });
      const { rerender } = render(<NamesTab bodyId="wb1" />);
      const field = screen.getByRole('textbox', { name: 'Community name' });
      await userEvent.clear(field);
      await userEvent.type(field, 'Low Plains Pond{Enter}');
      rerender(<NamesTab bodyId="wb1" />);
      // The record now holds the name: ⏎ again on it writes nothing.
      await userEvent.type(screen.getByRole('textbox', { name: 'Community name' }), '{Enter}');
      expect(mocks.calls).toEqual([
        ['waterBodies:setWaterBodyName', { waterBodyId: 'wb1', name: 'Low Plains Pond' }],
      ]);
    });
  });

  describe('a switch to another body that is already read', () => {
    const community = (id: string, name: string) =>
      mocks.results.set(getFunctionName(api.waterBodies.get), {
        available: true,
        body: { ...BODY, _id: id, name, nameClaims: [{ source: 'user', value: name }] },
      });

    it('drops the typed name; nothing typed for one body is sent for the other', async () => {
      community('wb1', 'Low Plains');
      const { rerender } = render(<BodyTabHost Wiring={NamesTab} bodyId="wb1" />);
      const field = screen.getByRole('textbox', { name: 'Community name' });
      await userEvent.clear(field);
      await userEvent.type(field, 'Low Plains Pond');
      // The other body holds the same name, so its record moving can't reset the draft (`useDraft`
      // follows the record): only the body's own subtree can.
      community('wb2', 'Low Plains');
      rerender(<BodyTabHost Wiring={NamesTab} bodyId="wb2" />);
      const next = screen.getByRole('textbox', { name: 'Community name' });
      expect(next).toHaveValue('Low Plains');
      await userEvent.type(next, '{Enter}');
      expect(mocks.calls).toEqual([]);
    });

    it('a write started on one body still lands after the switch, and its receipt names that body', async () => {
      let land: () => void = () => {};
      mocks.hold = new Promise<void>((r) => {
        land = r;
      });
      const { rerender } = render(
        <BodyTabHost Wiring={NamesTab} name="Mascoma Lake" bodyId="wb1" />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Display this' }));
      community('wb2', 'High Meadow');
      rerender(<BodyTabHost Wiring={NamesTab} name="Crystal Lake" bodyId="wb2" />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      // Pressed is committed: it lands on its own body, and its receipt says whose it was.
      expect(mocks.announce).toHaveBeenCalledTimes(1);
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
      expect(toasts).toEqual([]);
      expect(mocks.calls).toEqual([
        ['waterBodies:setWaterBodyName', { waterBodyId: 'wb1', name: 'The Basin' }],
      ]);
    });
  });
});
