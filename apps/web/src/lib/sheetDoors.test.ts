import { openPostSheet, type PostSheet, postSheetForEdit } from '@skating/core';
import type { ConvexReactClient } from 'convex/react';
import { describe, expect, it, vi } from 'vitest';
import { openWebDoor, restoreMatchesDoor } from './sheetDoors';

const NOW = Date.UTC(2026, 0, 10, 20);
let seq = 0;
const mint = () => `id-${++seq}`;

/** A Convex client that answers from a table of canned results, keyed by the query's arg shape. */
function fakeConvex(answers: {
  report?: unknown;
  post?: Record<string, unknown>;
  body?: unknown;
}): ConvexReactClient {
  return {
    query: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if ('reportId' in args)
        return answers.post?.postId !== undefined ? answers.post : answers.report;
      if ('waterBodyId' in args) return answers.body;
      return null;
    }),
  } as unknown as ConvexReactClient;
}

describe('openWebDoor', () => {
  it('a lake door opens one Report on it, with the author put-in default applied', async () => {
    const convex = fakeConvex({ body: { available: true, body: { name: 'Lake Morey' } } });
    const post = await openWebDoor(convex, { body: 'wb1' }, false, NOW);
    expect(post?.door).toBe('body');
    expect(post?.reports).toHaveLength(1);
    expect(post?.reports[0]?.sheet.waterBodyId).toBe('wb1');
    expect(post?.reports[0]?.bodyName).toBe('Lake Morey');
    expect(post?.reports[0]?.sheet.scalars.showPutIn).toBe(false);
  });

  it('a lake door with the name in the URL asks nothing of the server', async () => {
    const convex = fakeConvex({});
    const post = await openWebDoor(convex, { body: 'wb1', name: 'Morey' }, undefined, NOW);
    expect(post?.reports[0]?.bodyName).toBe('Morey');
    expect(convex.query).not.toHaveBeenCalled();
  });

  it('no params is a blank Post — the words lead and the lake is picked in the console', async () => {
    const post = await openWebDoor(fakeConvex({}), {}, undefined, NOW);
    expect(post?.door).toBe('page');
    expect(post?.reports[0]?.sheet.waterBodyId).toBeUndefined();
  });

  it('an edit door seeds from the published Report and its Post, and saves rather than posts', async () => {
    const convex = {
      query: vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
        if (args.waterBodyId) return { available: true, body: { name: 'Lake Morey' } };
        // Two `reportId` queries: the Report, then its Post's words.
        return (convex.query as ReturnType<typeof vi.fn>).mock.calls.length === 1
          ? {
              _id: 'rep-1',
              waterBodyId: 'wb1',
              skateEndTime: NOW,
              iceTypes: ['black_ice'],
              surfaceTags: [],
              photoIds: [],
              hazardIdsCreated: [],
              point: { lat: 43.9, lng: -72.1 },
              notes: 'Glass.',
            }
          : { postId: 'post-1', title: 'Morey', body: 'Words.' };
      }),
    } as unknown as ConvexReactClient;
    const post = await openWebDoor(convex, { edit: 'rep-1' }, undefined, NOW);
    expect(post?.mode).toEqual({ kind: 'edit', reportId: 'rep-1', postId: 'post-1' });
    expect(post?.title).toBe('Morey');
    expect(post?.reports[0]?.sheet.scalars.notes).toBe('Glass.');
  });

  it('a Report that is gone, or not the viewer’s, is null rather than a blank console', async () => {
    const convex = { query: vi.fn(async () => null) } as unknown as ConvexReactClient;
    expect(await openWebDoor(convex, { edit: 'rep-1' }, undefined, NOW)).toBeNull();
  });
});

describe('restoreMatchesDoor', () => {
  const onMorey = (): PostSheet =>
    openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);

  it('a restored create answers a bare door, and the lake door it is about', () => {
    expect(restoreMatchesDoor(onMorey(), {})).toBe(true);
    expect(restoreMatchesDoor(onMorey(), { body: 'wb1' })).toBe(true);
  });

  it('a different lake in the URL wins over what was restored', () => {
    expect(restoreMatchesDoor(onMorey(), { body: 'wb2' })).toBe(false);
  });

  it('an edit door only accepts that Report’s own sheet', () => {
    const edit = postSheetForEdit(
      { reportId: 'rep-1', waterBodyId: 'wb1', skateEndTime: NOW, photoIds: [] },
      null,
      NOW,
      mint,
    );
    expect(restoreMatchesDoor(edit, { edit: 'rep-1' })).toBe(true);
    expect(restoreMatchesDoor(edit, { edit: 'rep-2' })).toBe(false);
    // …and a create is never served to an edit door, nor an edit to a create door.
    expect(restoreMatchesDoor(onMorey(), { edit: 'rep-1' })).toBe(false);
    expect(restoreMatchesDoor(edit, {})).toBe(false);
  });
});
