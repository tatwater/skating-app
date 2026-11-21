/**
 * **The rule and the write agree for a moderator too** (B01-5, the second review's finding 3): the
 * 110-cell table (`inboxRulesVsWrites.test.ts`) runs as an admin, so a lever an admin holds and a
 * moderator doesn't — a restore or takedown request's approval (`body.remove`), Support — was never
 * seen from a moderator's chair. Here every cell runs as a moderator, for both answers a page draws:
 *
 * - **the item's `can`** (`inbox.item`'s rule over the facts it reads) must equal the write: allowed ↔
 *   it succeeds, refused ↔ it refuses with the same sentence;
 * - **the row's `can`** (`listPage`'s, who may act) must never offer a verb the write refuses for who
 *   the viewer is: a refusal it gives is the write's sentence, and where it allows, the write may
 *   only refuse for the content's own state (a precondition the row doesn't read).
 */

import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { InboxVerb } from './inbox';
import {
  CELLS,
  type Cell,
  rule,
  type Setup,
  sentence,
  type W,
  world,
  write,
} from './inboxRulesVsWrites.test';
import { DECIDED_REFUSAL, OWN_FILING_REFUSAL } from './lib/inboxRules';
import { itemOfRef } from './lib/inboxViews';
import { OWN_CONTENT_REFUSAL } from './lib/ownContent';

/**
 * The requests whose approval is an admin's lever (`body.remove`): a takedown on a body that is up,
 * and a restore of one taken off the map. The admin table has no reason to hold them; this pass does.
 */
const ADMIN_LEVER_CELLS: Cell[] = [
  {
    kind: 'request (takedown)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: async (w) => {
      const requestId = await w.author.as.mutation(api.corpusRequests.create, {
        kind: 'takedown',
        coord: { lat: 0.2, lng: 0.2 },
        waterBodyId: w.active,
      });
      return { ref: `request:${requestId}`, requestId };
    },
  },
  {
    kind: 'request (restore)',
    state: 'open',
    verbs: ['approve', 'decline'],
    setup: async (w) => {
      await w.t.run((ctx) =>
        ctx.db.patch(w.active, { removedAt: Date.now(), removalReason: 'landowner_request' }),
      );
      await w.t.mutation(internal.waterBodies.backfillCells, {});
      const requestId = await w.author.as.mutation(api.corpusRequests.create, {
        kind: 'restore',
        coord: { lat: 0.2, lng: 0.2 },
        waterBodyId: w.active,
      });
      return { ref: `request:${requestId}`, requestId };
    },
  },
];

/** A refusal for who the viewer is (rules 1–4), which a row must already say. */
const forWho = (s: string | null) =>
  s !== null &&
  (/^Requires \w+ role$/.test(s) ||
    s === DECIDED_REFUSAL ||
    s === OWN_FILING_REFUSAL ||
    s === OWN_CONTENT_REFUSAL);

/** The row's `can` for the item, as the moderator's list draws it; `undefined` when no row shows. */
async function rowCan(w: W, verb: InboxVerb, s: Setup): Promise<string | null | undefined> {
  const item = await w.t.run((ctx) => itemOfRef(ctx, s.ref));
  if (!item) return undefined;
  const lane = item.status === 'decided' ? ('decided' as const) : item.lane;
  try {
    const page = await w.viewer.as.query(api.inbox.listPage, { lane, pageSize: 100 });
    const row = page.rows.find((r) => r.itemId === item._id);
    return row === undefined || !(verb in row.can) ? undefined : (row.can[verb] ?? null);
  } catch {
    return undefined; // a lane the moderator may not read (Support): no row to draw
  }
}

describe('the rule and the write, from a moderator’s chair', () => {
  test('the item’s can and the row’s can agree with every write', async () => {
    const disagreements: string[] = [];
    let size = 0;
    for (const cell of [...CELLS, ...ADMIN_LEVER_CELLS]) {
      for (const verb of cell.verbs) {
        size++;
        const w = await world();
        await w.t.run((ctx) => ctx.db.patch(w.viewer.id, { role: 'moderator' }));
        const s = await cell.setup(w);
        const said = await rule(w, verb, s);
        const row = await rowCan(w, verb, s);
        let did: string | null = null;
        try {
          await write(w, verb, s);
        } catch (err) {
          did = sentence(err);
        }
        const at = `${cell.kind} · ${cell.state} · ${verb}`;
        if (said !== did)
          disagreements.push(`${at}: item ${JSON.stringify(said)}, write ${JSON.stringify(did)}`);
        if (row !== undefined) {
          const rowAgrees = row === null ? !forWho(did) : row === did;
          if (!rowAgrees)
            disagreements.push(`${at}: row ${JSON.stringify(row)}, write ${JSON.stringify(did)}`);
        }
      }
    }
    expect(size).toBe([...CELLS, ...ADMIN_LEVER_CELLS].reduce((n, c) => n + c.verbs.length, 0));
    expect(disagreements).toEqual([]);
  }, 600_000);
});
