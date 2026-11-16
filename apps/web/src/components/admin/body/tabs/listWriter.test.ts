import { render, renderHook } from '@testing-library/react';
import fc from 'fast-check';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { type KeyedLink, linkChanges } from './links/linksModel';
import {
  chipChange,
  createListWriter,
  ListWritersProvider,
  sameList,
  useListMemory,
} from './listWriter';

type Item = { id: string; label: string };
type Change = (base: readonly Item[]) => readonly Item[];

/** A change as a tab makes one: by the item's id, from what the render showed. */
const CHANGES = {
  add:
    (id: string): Change =>
    (base) => [...base, { id, label: id }],
  remove:
    (id: string): Change =>
    (base) =>
      base.filter((x) => x.id !== id),
  edit:
    (id: string, label: string): Change =>
    (base) =>
      base.map((x) => (x.id === id ? { ...x, label } : x)),
  /** A reorder names the order it wants; ids it doesn't know of stay last, in their order. */
  order:
    (ids: readonly string[]): Change =>
    (base) => {
      const byId = new Map(base.map((x) => [x.id, x]));
      const named = ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as Item] : []));
      return [...named, ...base.filter((x) => !ids.includes(x.id))];
    },
};

/** Links' changes over the same items: a link keyed by the item's id, its words the label. */
const toLink = ({ id, label }: Item): KeyedLink => ({ key: id, label, url: `https://${label}` });
const toItem = ({ key, label }: KeyedLink): Item => ({ id: key, label });
const lift =
  (change: (base: readonly KeyedLink[]) => readonly KeyedLink[] | null): Change =>
  (base) =>
    (change(base.map(toLink)) ?? base.map(toLink)).map(toItem);
const LINK_CHANGES: typeof CHANGES = {
  add: (id) => lift(linkChanges.add(toLink({ id, label: id }))),
  remove: (id) => lift(linkChanges.remove(id)),
  edit: (id, label) => lift(linkChanges.edit(id, { label, url: `https://${label}` })),
  order: (ids) => lift(linkChanges.order(ids)),
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** The server, the queue, and what the page shows — driven one event at a time. */
function world(initial: readonly Item[]) {
  let server = initial;
  let shown = initial;
  const inFlight: { next: readonly Item[]; resolve: (ok: boolean) => void; tag: number }[] = [];
  const bases: { base: readonly Item[]; server: readonly Item[] }[] = [];
  // The press whose change is being sent: a change and its send run back to back in the queue.
  let sending = -1;
  const writer = createListWriter<Item>(
    (next) => new Promise<boolean>((resolve) => inFlight.push({ next, resolve, tag: sending })),
  );
  writer.observe(server);
  return {
    get server() {
      return server;
    },
    get shown() {
      return shown;
    },
    get idle() {
      return inFlight.length === 0;
    },
    bases,
    /** A press: the change is made from the shown list's ids, applied by the queue to its base. */
    press(change: Change, tag = -1) {
      void writer.push((base) => {
        bases.push({ base, server });
        sending = tag;
        return change(base);
      });
    },
    /**
     * The server answers the oldest write: committed then acknowledged, or refused. `echoFirst`:
     * the page renders the committed list before the acknowledgment lands (the console's order —
     * Convex shows a write before its promise resolves, and the receipt is a further round trip).
     */
    answer(ok: boolean, echoFirst = false): number | undefined {
      const w = inFlight.shift();
      if (w === undefined) return undefined;
      if (ok) server = w.next;
      if (ok && echoFirst) {
        shown = server;
        writer.observe(server);
      }
      w.resolve(ok);
      return w.tag;
    },
    /** A render: the page reads the server's list. */
    render() {
      shown = server;
      writer.observe(server);
    },
    /** A render that read the server before the latest change reached it. */
    renderStale(list: readonly Item[]) {
      shown = list;
      writer.observe(list);
    },
    /** Another moderator's write, and the render it brings. */
    external(change: Change) {
      server = change(server);
      this.render();
    },
  };
}

type Op =
  | { kind: 'press'; what: 'add' | 'remove' | 'edit' | 'order'; pick: number; seed: number }
  | { kind: 'answer'; ok: boolean; echoFirst?: boolean }
  | { kind: 'render' }
  | { kind: 'external'; pick: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('press' as const),
    what: fc.constantFrom('add' as const, 'remove' as const, 'edit' as const, 'order' as const),
    pick: fc.nat(),
    seed: fc.nat(),
  }),
  // Acknowledgments as often as presses, so some land fast and some queue behind slow ones; some
  // land after the page already shows the write.
  fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  fc.record({
    kind: fc.constant('answer' as const),
    ok: fc.constant(true),
    echoFirst: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('render' as const) }),
  fc.record({ kind: fc.constant('external' as const), pick: fc.nat() }),
);

describe('createListWriter', () => {
  it('applies a change to the newest acknowledged list, never the one a render held', async () => {
    const w = world([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    // A reorder is saving; Remove is pressed on the list the page still shows.
    w.press(CHANGES.order(['b', 'a']));
    await settle();
    w.press(CHANGES.remove('a'));
    w.answer(true);
    await settle();
    // Acknowledged, not yet rendered: the remove applies to the reorder's list.
    w.answer(true);
    await settle();
    expect(w.server).toEqual([{ id: 'b', label: 'B' }]);
  });

  it('drops a refused change and builds the next on what the server holds', async () => {
    const w = world([{ id: 'a', label: 'A' }]);
    w.press(CHANGES.add('b'));
    await settle();
    w.press(CHANGES.edit('a', 'Aa'));
    w.answer(false);
    await settle();
    w.answer(true);
    await settle();
    expect(w.server).toEqual([{ id: 'a', label: 'Aa' }]);
  });

  it('sends nothing for a change that changes nothing', async () => {
    const w = world([{ id: 'a', label: 'A' }]);
    w.press(CHANGES.remove('gone'));
    await settle();
    expect(w.idle).toBe(true);
  });

  it('a write the page already shows when it is acknowledged builds the next on the page’s own list', async () => {
    // Rows carrying page-only ids (Links' keys): the queue's copy of a row it added has an id the
    // page never drew, so once the page shows the write, the next change must apply to the page's.
    type Row = { key: string; label: string };
    let page: readonly Row[] = [{ key: 'p1', label: 'A' }];
    const sent: (readonly Row[])[] = [];
    const words = (a: readonly Row[], b: readonly Row[]) =>
      a.length === b.length && a.every((r, i) => r.label === b[i]?.label);
    const writer = createListWriter<Row>(async (next) => {
      sent.push(next);
      // The echo renders first, with the page's own id for the new row.
      page = next.map((r, i) => ({ key: `p${i + 1}`, label: r.label }));
      writer.observe(page);
      return true;
    }, words);
    writer.observe(page);
    await writer.push((base) => [...base, { key: 'queue-minted', label: 'B' }]);
    // Edit the new row by the id the page drew for it.
    await writer.push((base) => base.map((r) => (r.key === 'p2' ? { ...r, label: 'Bb' } : r)));
    expect(sent.map((l) => l.map((r) => r.label))).toEqual([
      ['A', 'B'],
      ['A', 'Bb'],
    ]);
  });

  it('a render that hasn’t caught up with an acknowledgment never rolls the base back', async () => {
    const w = world([{ id: 'a', label: 'A' }]);
    w.press(CHANGES.add('b'));
    await settle();
    // The render was already under way with the old list when the write was acknowledged.
    const stale = w.server;
    w.answer(true);
    await settle();
    w.renderStale(stale);
    w.press(CHANGES.add('c'));
    await settle();
    w.answer(true);
    await settle();
    expect(w.server.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  describe('the server’s compare-and-set (`expected`)', () => {
    /** A queue over a server that refuses a write built on a list that moved. */
    const guarded = (server: { list: string[] }) => {
      const sent: { next: readonly string[]; base: readonly string[] }[] = [];
      let unapplied = 0;
      const writer = createListWriter<string>(
        async (next, base) => {
          sent.push({ next, base });
          if (!sameList(base, server.list)) return { current: [...server.list] };
          server.list = [...next];
          return true;
        },
        sameList,
        () => {
          unapplied++;
        },
      );
      writer.observe(server.list);
      return { writer, sent, unapplied: () => unapplied };
    };

    it('names the list each write was built on', async () => {
      const server = { list: ['a'] };
      const q = guarded(server);
      await q.writer.push((base) => [...base, 'b']);
      expect(q.sent).toEqual([{ next: ['a', 'b'], base: ['a'] }]);
    });

    it('a list that moved underneath is refused with the current one; the change is re-applied on top', async () => {
      const server = { list: ['a'] };
      const q = guarded(server);
      // Another moderator's write lands before ours, which was built on ['a'].
      server.list = ['a', 'x'];
      await expect(q.writer.push((base) => [...base, 'b'])).resolves.toBe(true);
      expect(q.sent.map((w) => w.base)).toEqual([['a'], ['a', 'x']]);
      expect(server.list).toEqual(['a', 'x', 'b']);
    });

    it('a change that no longer applies is said (`unapplied`), never sent or dropped quietly', async () => {
      const server = { list: ['a', 'b'] };
      const q = guarded(server);
      server.list = ['a'];
      // An edit of 'b', which another moderator removed meanwhile.
      const edit = (base: readonly string[]) =>
        base.includes('b') ? base.map((x) => (x === 'b' ? 'B' : x)) : null;
      await expect(q.writer.push(edit)).resolves.toBe(false);
      expect(q.unapplied()).toBe(1);
      expect(server.list).toEqual(['a']);
    });

    it('a change already on the list as it now stands sends nothing more', async () => {
      const server = { list: ['a'] };
      const q = guarded(server);
      server.list = ['a', 'b'];
      await expect(
        q.writer.push((base) => (base.includes('b') ? base : [...base, 'b'])),
      ).resolves.toBe(true);
      expect(q.sent).toHaveLength(1);
    });
  });

  it('over any interleaving: the saved list is every change in press order, none lost or doubled, none built on a stale list', async () => {
    await everyInterleaving(CHANGES);
  });

  it('Links’ own changes, over any interleaving of reorder, add, edit, remove and another moderator', async () => {
    await everyInterleaving(LINK_CHANGES);
  });
});

/** The property, over one tab's changes. */
async function everyInterleaving(changes: typeof CHANGES) {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
      const initial = [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ];
      const w = world(initial);
      let minted = 0;
      // The replay: each event's change, in event order, kept unless its write is refused.
      const replay: { change: Change; ok: boolean | null; ours: boolean }[] = [];
      for (const o of ops) {
        if (o.kind === 'press') {
          const ids = w.shown.map((x) => x.id);
          const id = ids[o.pick % Math.max(1, ids.length)];
          let change: Change;
          if (o.what === 'add' || id === undefined) change = changes.add(`n${++minted}`);
          else if (o.what === 'remove') change = changes.remove(id);
          else if (o.what === 'edit') change = changes.edit(id, `${id}${o.seed % 9}`);
          else {
            const shuffled = [...ids].sort(
              (x, y) =>
                ((x + o.seed).length % 3) - ((y + o.seed).length % 3) ||
                (o.seed % 2 ? x.localeCompare(y) : y.localeCompare(x)),
            );
            change = changes.order(shuffled);
          }
          // `ok` stays null for a change that changed nothing (it sent nothing, owes no answer).
          replay.push({ change, ok: null, ours: true });
          w.press(change, replay.length - 1);
          await settle();
        } else if (o.kind === 'answer') {
          const i = w.answer(o.ok, o.echoFirst);
          if (i !== undefined) (replay[i] as { ok: boolean | null }).ok = o.ok;
          await settle();
        } else if (o.kind === 'render') {
          w.render();
        } else if (w.idle) {
          // Another moderator: only between our writes (the race the server must close).
          const change = changes.add(`x${++minted}`);
          replay.push({ change, ok: true, ours: false });
          w.external(change);
          await settle();
        }
      }
      // Drain: every write answered yes, and a render.
      while (!w.idle) {
        const i = w.answer(true);
        if (i !== undefined) (replay[i] as { ok: boolean | null }).ok = true;
        await settle();
      }
      w.render();
      let expected: readonly Item[] = initial;
      for (const r of replay) if (r.ok !== false) expected = r.change(expected);
      expect(w.server).toEqual(expected);
      // Nothing doubled.
      expect(new Set(w.server.map((x) => x.id)).size).toBe(w.server.length);
      // Every write was built on the server's list as it stood: never older than the last
      // acknowledgment.
      for (const { base, server } of w.bases) expect(sameList(base, server)).toBe(true);
    }),
    { numRuns: 300 },
  );
}

describe('useListMemory — what a queued change names lives beside its queue', () => {
  it('under the shell: a page coming back holds the same value; another list or name its own', () => {
    const seen: { current: { n: number } }[] = [];
    function Probe({ k, n }: { k: string; n: string }) {
      seen.push(useListMemory(k, n, () => ({ n: 0 })));
      return null;
    }
    // One provider across the mounts, as the shell's outlives the page.
    const tree = (probe: { k: string; n: string } | null) =>
      createElement(ListWritersProvider, null, probe && createElement(Probe, probe));
    const view = render(tree({ k: 'links:a', n: 'ids' }));
    const first = seen.at(-1) as { current: { n: number } };
    first.current.n = 1;
    view.rerender(tree(null));
    view.rerender(tree({ k: 'links:a', n: 'ids' }));
    expect(seen.at(-1)).toBe(first);
    view.rerender(tree({ k: 'links:b', n: 'ids' }));
    expect(seen.at(-1)?.current.n).toBe(0);
    view.rerender(tree({ k: 'links:a', n: 'unseen' }));
    expect(seen.at(-1)?.current.n).toBe(0);
  });

  it('outside the shell: the component’s own, started afresh when it names another list', () => {
    const view = renderHook(({ k }) => useListMemory(k, 'ids', () => ({ n: 0 })), {
      initialProps: { k: 'links:a' },
    });
    const own = view.result.current;
    own.current.n = 1;
    view.rerender({ k: 'links:a' });
    expect(view.result.current).toBe(own);
    view.rerender({ k: 'links:b' });
    expect(view.result.current).not.toBe(own);
    expect(view.result.current.current.n).toBe(0);
  });
});

describe('chipChange — a chip edit binds to the entries it names, never another by its text', () => {
  /** The server's fold (`setAliases`, a landmark's spellings): trimmed, one per case-insensitive word. */
  const fold = (list: readonly string[]) => {
    const seen = new Set<string>();
    return list
      .map((a) => a.trim())
      .filter((a) => {
        const k = a.toLowerCase();
        if (a === '' || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  };
  const word = fc.constantFrom('Basin', 'basin', 'BASIN', 'Cove', 'cove', 'Narrows', 'The Flats');
  const list = fc.array(word, { maxLength: 6 }).map(fold);
  const key = (a: string) => a.toLowerCase();

  it('removes what was taken off and adds what was put on — whatever case another moderator stored since', () => {
    fc.assert(
      fc.property(list, list, list, (shown, value, base) => {
        const next = fold(chipChange(shown, value)(base));
        // What the chips changed, word for word (a recased word is one taken off, one put on).
        const removed = shown.filter((a) => !value.includes(a));
        const added = value.filter((a) => !shown.includes(a));
        for (const r of removed) {
          if (added.some((a) => key(a) === key(r))) continue;
          expect(next.some((n) => key(n) === key(r))).toBe(false);
        }
        for (const a of added) expect(next.some((n) => key(n) === key(a))).toBe(true);
        // Every other entry the list holds now is untouched, in its own case.
        for (const b of base) {
          const touched = [...removed, ...added].some((x) => key(x) === key(b));
          if (!touched) expect(next).toContain(b);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('chipChange — the named cases', () => {
  it('takes off a word another moderator recased since, and adds nothing twice', () => {
    expect(chipChange(['basin'], [])(['Basin', 'Cove'])).toEqual(['Cove']);
    expect(chipChange([], ['Cove'])(['Cove'])).toEqual(['Cove']);
    expect(chipChange([], ['cove'])(['Cove', 'Narrows'])).toEqual(['Narrows', 'cove']);
    // A word recased on purpose takes the new case.
    expect(chipChange(['basin'], ['Basin'])(['basin', 'Cove'])).toEqual(['Cove', 'Basin']);
  });
});
