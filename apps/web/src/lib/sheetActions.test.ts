import { openPostSheet, type PostSheet, sheetReducer } from '@skating/core';
import type { ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postSheetOnWeb, saveSheetEditOnWeb } from './sheetActions';

const NOW = Date.UTC(2026, 0, 10, 20);
let seq = 0;
const mint = () => `id-${++seq}`;

vi.mock('../components/photoPipeline', () => ({
  uploadToStorage: vi.fn(async () => `storage-${Math.random().toString(36).slice(2, 8)}`),
}));

// The blobs behind the sheet's photos live in a module map; the test stands one in.
const blobs = new Map<string, File>();
vi.mock('./sheetPhotos', () => ({
  sheetPhotoBlob: (uri: string) => blobs.get(uri) ?? null,
}));

/** A filled one-lake Post: a quality, an ice type and an end time — D189's minimum set. */
function filled(): PostSheet {
  const post = openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
  const first = post.reports[0] as NonNullable<(typeof post.reports)[0]>;
  return {
    ...post,
    title: 'Morey',
    body: 'Glass.',
    reports: [
      {
        ...first,
        sheet: [
          { type: 'select' as const, field: 'quality' as const, key: 'good', value: 'good' },
          {
            type: 'select' as const,
            field: 'iceTypes' as const,
            key: 'black_ice',
            value: { type: 'black_ice' },
          },
          {
            type: 'select' as const,
            field: 'endTime' as const,
            key: 'pinned',
            value: { ms: NOW - 60_000, precision: 'minute' },
          },
        ].reduce(sheetReducer, first.sheet),
      },
    ],
  };
}

interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** A Convex client that records every call and answers with canned ids. */
function recorder(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  // `api.posts.create` is a proxy, not a string — `getFunctionName` is how Convex names one.
  const nameOf = (fn: unknown) => getFunctionName(fn as Parameters<typeof getFunctionName>[0]);
  const client = {
    query: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
      const name = nameOf(fn);
      calls.push({ name, args });
      return overrides[name]?.(args) ?? null;
    }),
    mutation: vi.fn(async (fn: unknown, args: Record<string, unknown>) => {
      const name = nameOf(fn);
      calls.push({ name, args });
      if (overrides[name]) return overrides[name]?.(args);
      if (name.endsWith('generateUploadUrl')) return 'https://upload.test/1';
      if (name.endsWith('create') && name.includes('photos')) return 'photo-1';
      return 'ok';
    }),
  } as unknown as ConvexReactClient;
  return { client, calls, find: (tail: string) => calls.filter((c) => c.name.includes(tail)) };
}

beforeEach(() => {
  blobs.clear();
  vi.clearAllMocks();
});

describe('postSheetOnWeb', () => {
  it('sends one transactional posts.create with the content whole', async () => {
    const { client, find } = recorder({
      'posts:create': () => ({ postId: 'post-1', reportIds: ['rep-1'] }),
    });
    const outcome = await postSheetOnWeb(client, filled(), NOW);
    expect(outcome).toEqual({ kind: 'posted', postId: 'post-1', reportId: 'rep-1' });
    const create = find('posts:create')[0];
    expect(create?.args.title).toBe('Morey');
    expect(create?.args.body).toBe('Glass.');
    const reports = create?.args.reports as Record<string, unknown>[];
    expect(reports).toHaveLength(1);
    // The content goes through whole — the fields a by-name mapping has historically dropped.
    expect(reports[0]).toMatchObject({
      waterBodyId: 'wb1',
      skateQuality: 'good',
      skateEndTime: NOW - 60_000,
      skateEndPrecision: 'minute',
      iceTypes: [{ type: 'black_ice' }],
    });
    expect(reports[0]?.idempotencyKey).toEqual(expect.any(String));
  });

  /**
   * The server's own refusals — D189's set, D199's window — come back as the sentence the server
   * would have used, because the flush asks core's rules before it spends anything.
   */
  it('a Report that cannot post is refused before a single upload', async () => {
    const bare = openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
    const { client, find } = recorder();
    const outcome = await postSheetOnWeb(client, bare, NOW);
    expect(outcome.kind).toBe('refused');
    expect(find('posts:create')).toHaveLength(0);
    expect(find('generateUploadUrl')).toHaveLength(0);
  });

  it('a retry resumes from the failed attempt — the photo that landed is not uploaded twice', async () => {
    blobs.set('p1:full', new File([''], 'a.jpg'));
    blobs.set('p1:thumb', new File([''], 'a-t.jpg'));
    const post = filled();
    const first = post.reports[0] as NonNullable<(typeof post.reports)[0]>;
    const withPhoto: PostSheet = {
      ...post,
      reports: [
        {
          ...first,
          photos: [{ id: 'p1', fullUri: 'p1:full', thumbUri: 'p1:thumb', placeOnMap: false }],
        },
      ],
    };

    // Attempt one: the photo uploads, then the create fails.
    const failing = recorder({
      'posts:create': () => {
        throw new Error('Network request failed');
      },
    });
    const refused = await postSheetOnWeb(failing.client, withPhoto, NOW);
    expect(refused.kind).toBe('refused');
    expect(failing.find('generateUploadUrl')).toHaveLength(2); // full + thumb
    const draft = refused.kind === 'refused' ? refused.draft : null;
    expect(draft?.reports[0]?.photos[0]?.photoId).toBe('photo-1');

    // Attempt two, handed the checkpointed draft: nothing re-uploads, and the create carries the id.
    const retry = recorder({ 'posts:create': () => ({ postId: 'post-1', reportIds: ['rep-1'] }) });
    const posted = await postSheetOnWeb(retry.client, withPhoto, NOW, draft);
    expect(posted.kind).toBe('posted');
    expect(retry.find('generateUploadUrl')).toHaveLength(0);
    const reports = retry.find('posts:create')[0]?.args.reports as Record<string, unknown>[];
    expect(reports[0]?.photoIds).toEqual(['photo-1']);
  });

  /** D197: the chips file against the put-in once the Report exists to be their provenance. */
  it('files the access conditions after the create, with the new Report as provenance', async () => {
    const post = filled();
    const first = post.reports[0] as NonNullable<(typeof post.reports)[0]>;
    const withCondition: PostSheet = {
      ...post,
      reports: [
        {
          ...first,
          sheet: [
            { type: 'setScalar' as const, key: 'putInId' as const, value: 'put-1' },
            {
              type: 'select' as const,
              field: 'accessConditions' as const,
              key: 'plank_needed',
              value: 'plank_needed',
            },
          ].reduce(sheetReducer, first.sheet),
        },
      ],
    };
    const { client, find } = recorder({
      'posts:create': () => ({ postId: 'post-1', reportIds: ['rep-1'] }),
    });
    await postSheetOnWeb(client, withCondition, NOW);
    const filed = find('accessAlerts:create')[0];
    expect(filed?.args).toMatchObject({
      targetType: 'put_in',
      putInId: 'put-1',
      reason: 'plank_needed',
      reportId: 'rep-1',
    });
    expect(filed?.args.idempotencyKey).toEqual(expect.any(String));
  });
});

describe('saveSheetEditOnWeb', () => {
  it('refuses a sheet that is not an edit', async () => {
    const { client } = recorder();
    await expect(saveSheetEditOnWeb(client, filled())).rejects.toThrow('Not an edit');
  });

  it('sends the whole content block with the kept photos leading the new ones', async () => {
    blobs.set('p1:full', new File([''], 'a.jpg'));
    blobs.set('p1:thumb', new File([''], 'a-t.jpg'));
    const base = filled();
    const first = base.reports[0] as NonNullable<(typeof base.reports)[0]>;
    const editing: PostSheet = {
      ...base,
      mode: { kind: 'edit', reportId: 'rep-1', postId: 'post-1' },
      reports: [
        {
          ...first,
          keptPhotoIds: ['photo-kept'],
          photos: [{ id: 'p1', fullUri: 'p1:full', thumbUri: 'p1:thumb', placeOnMap: false }],
        },
      ],
    };
    const { client, find } = recorder();
    expect(await saveSheetEditOnWeb(client, editing)).toBe('rep-1');
    const update = find('reports:update')[0];
    expect(update?.args).toMatchObject({ reportId: 'rep-1', skateQuality: 'good' });
    // Last-write-wins over `photoIds`: an edit that forgot the kept ones would detach them.
    expect(update?.args.photoIds).toEqual(['photo-kept', 'photo-1']);
    expect(update?.args).not.toHaveProperty('waterBodyId');
    expect(find('posts:update')[0]?.args).toMatchObject({
      postId: 'post-1',
      title: 'Morey',
      body: 'Glass.',
    });
  });
});
