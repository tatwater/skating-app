import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type KeyedLink, linkChanges } from './links/linksModel';
import { createListWriter, sameList } from './listWriter';

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
  (change: (base: readonly KeyedLink[]) => readonly KeyedLink[]): Change =>
  (base) =>
    change(base.map(toLink)).map(toItem);
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

  describe('the console’s binding (`alive`)', () => {
    /** A queue bound to `alive`, whose sends wait for the test's answer. */
    const bound = () => {
      let alive = true;
      const sent: (readonly string[])[] = [];
      const answers: ((ok: boolean) => void)[] = [];
      const writer = createListWriter<string>(
        (next) =>
          new Promise<boolean>((resolve) => {
            sent.push(next);
            answers.push(resolve);
          }),
        sameList,
        () => alive,
      );
      writer.observe(['a']);
      return {
        writer,
        sent,
        answer: (ok: boolean) => answers.shift()?.(ok),
        die: () => {
          alive = false;
        },
      };
    };

    it('a change queued behind one on its way is never taken up once its console has gone', async () => {
      const q = bound();
      const first = q.writer.push((base) => [...base, 'b']);
      const second = q.writer.push((base) => [...base, 'c']);
      await settle();
      expect(q.sent).toEqual([['a', 'b']]);
      q.die();
      q.answer(true);
      // The first landed, but its answer is not taken in; the second is dropped, never sent.
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      expect(q.sent).toHaveLength(1);
    });

    it('a dead queue takes up nothing new', async () => {
      const q = bound();
      q.die();
      await expect(q.writer.push((base) => [...base, 'b'])).resolves.toBe(false);
      expect(q.sent).toEqual([]);
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
