import { describe, expect, it } from 'vitest';
import {
  classifyFlushError,
  createPostDraft,
  createReportDraft,
  type DraftPhoto,
  flushablePosts,
  flushErrorMessage,
  flushPost,
  type HazardRefResolution,
  isFlushable,
  type PostDraft,
  type PostFlushEffects,
  postDraftFromLegacy,
  postDraftLabel,
  postDraftPhotoUris,
  type ReportDraft,
  referencedHazardLocalIds,
  referencedTrackIds,
} from './draftQueue';
import { emptyReportForm, type ReportFormState } from './reportForm';

const NOW = Date.UTC(2026, 0, 10);

function photo(id: string, extra: Partial<DraftPhoto> = {}): DraftPhoto {
  return { id, fullUri: `${id}-full`, thumbUri: `${id}-thumb`, placeOnMap: false, ...extra };
}

/**
 * A form that meets the minimum set (D189, asked at flush since A10-2) — quality and one chip —
 * so the fixtures stay about the queue, not about the rule.
 */
function observedForm(opts?: Parameters<typeof emptyReportForm>[1]): ReportFormState {
  return { ...emptyReportForm(NOW, opts), skateQuality: 'good', iceTypes: ['black_ice'] };
}

function reportWith(overrides: Partial<ReportDraft> = {}, form?: ReportFormState): ReportDraft {
  return {
    ...createReportDraft({
      id: 'r1',
      idempotencyKey: 'rkey-1',
      form: form ?? observedForm(),
      waterBodyId: 'wb-1',
      bodyName: 'Morey',
    }),
    ...overrides,
  };
}

/** A one-Report Post draft — the legacy shape, and what the pre-sheet form still saves. */
function draftWith(
  overrides: Partial<PostDraft> = {},
  report: Partial<ReportDraft> = {},
  form?: ReportFormState,
): PostDraft {
  return {
    ...createPostDraft({
      id: 'd1',
      idempotencyKey: 'key-1',
      now: NOW,
      reports: [reportWith(report, form)],
    }),
    ...overrides,
  };
}

type CreatePostInput = Parameters<PostFlushEffects['createPost']>[0];

/** A recording fake for the injected effects, with optional per-call failure injection. */
function makeEffects(overrides: Partial<PostFlushEffects> = {}): {
  effects: PostFlushEffects;
  calls: {
    uploads: string[];
    rows: Array<Parameters<PostFlushEffects['createPhotoRow']>[0]>;
    posts: CreatePostInput[];
    reports: CreatePostInput['reports'];
    resolves: number;
    persisted: PostDraft[];
  };
} {
  const calls = {
    uploads: [] as string[],
    rows: [] as Array<Parameters<PostFlushEffects['createPhotoRow']>[0]>,
    posts: [] as CreatePostInput[],
    reports: [] as CreatePostInput['reports'],
    resolves: 0,
    persisted: [] as PostDraft[],
  };
  let storageSeq = 0;
  let photoSeq = 0;
  const effects: PostFlushEffects = {
    resolveBody: async () => {
      calls.resolves++;
      return 'wb-resolved';
    },
    uploadPhoto: async (uri) => {
      calls.uploads.push(uri);
      return `storage-${storageSeq++}`;
    },
    createPhotoRow: async (input) => {
      calls.rows.push(input);
      return `photo-${photoSeq++}`;
    },
    createPost: async (input) => {
      calls.posts.push(input);
      calls.reports.push(...input.reports);
      return { postId: 'post-1', reportIds: input.reports.map((_, i) => `report-${i + 1}`) };
    },
    persist: async (d) => {
      calls.persisted.push(d);
    },
    ...overrides,
  };
  return { effects, calls };
}

describe('createPostDraft / createReportDraft / isFlushable / flushablePosts', () => {
  it('creates a pending Post draft over its Reports, with now timestamps', () => {
    const d = createPostDraft({
      id: 'x',
      idempotencyKey: 'k',
      now: NOW,
      title: 'Morey',
      reports: [reportWith()],
    });
    expect(d).toMatchObject({ kind: 'post', status: 'pending', title: 'Morey', createdAt: NOW });
    expect(d.reports[0]?.photos).toEqual([]);
    expect(() => createPostDraft({ id: 'x', idempotencyKey: 'k', now: NOW, reports: [] })).toThrow(
      /at least one report/,
    );
  });

  it('treats done + permanent-error as not flushable, everything else as flushable', () => {
    expect(isFlushable(draftWith({ status: 'pending' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'uploading' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'creating' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'done' }))).toBe(false);
    expect(isFlushable(draftWith({ status: 'error' }))).toBe(false);
  });

  it('returns the flushable subset oldest-first', () => {
    const drafts: PostDraft[] = [
      draftWith({ id: 'b', status: 'pending', createdAt: 200 }),
      draftWith({ id: 'done', status: 'done', createdAt: 50 }),
      draftWith({ id: 'a', status: 'uploading', createdAt: 100 }),
      draftWith({ id: 'err', status: 'error', createdAt: 10 }),
    ];
    expect(flushablePosts(drafts).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('lists every photo file and every referenced track and hazard across the members', () => {
    const d = draftWith();
    d.reports = [
      reportWith({
        id: 'a',
        photos: [photo('p1')],
        trackDraftId: 't1',
        hazardRefs: [{ localId: 'h1' }],
      }),
      reportWith({
        id: 'b',
        photos: [photo('p2')],
        trackDraftId: 't2',
        hazardRefs: [{ hazardId: 'server-h' }, { localId: 'h2' }],
      }),
    ];
    expect(postDraftPhotoUris(d)).toEqual(['p1-full', 'p1-thumb', 'p2-full', 'p2-thumb']);
    expect([...referencedTrackIds([d])]).toEqual(['t1', 't2']);
    expect([...referencedHazardLocalIds([d])]).toEqual(['h1', 'h2']);
  });

  it('carries an edit’s activityId checkpoint, so a re-save does not re-resolve the track', () => {
    const r = reportWith({ trackDraftId: 't1' });
    expect(createReportDraft({ ...r, activityId: 'act-1' }).activityId).toBe('act-1');
    expect(createReportDraft(r)).not.toHaveProperty('activityId');
  });

  it('labels a queued Post by its title, else by its lakes in the author’s order (§9.2)', () => {
    const d = draftWith();
    d.reports = [
      reportWith({ id: 'a', bodyName: 'Lake Morey' }),
      reportWith({ id: 'b', bodyName: undefined }),
    ];
    expect(postDraftLabel(d)).toBe('Lake Morey · Unknown lake');
    expect(postDraftLabel({ ...d, title: 'Two lakes, one day' })).toBe('Two lakes, one day');
    expect(postDraftLabel({ ...d, title: '' })).toBe('Lake Morey · Unknown lake');
  });
});

describe('postDraftFromLegacy — the on-device migration', () => {
  it('lifts a pre-A10-2b row into the one-Report Post it is, keys and status intact', () => {
    const legacy = {
      ...reportWith({ id: 'old', idempotencyKey: 'old-key' }),
      status: 'error' as const,
      errorMessage: 'Water body not found',
      createdAt: 5,
      updatedAt: 9,
    };
    const post = postDraftFromLegacy(legacy);
    expect(post).toMatchObject({
      kind: 'post',
      id: 'old',
      idempotencyKey: 'old-key',
      status: 'error',
      errorMessage: 'Water body not found',
      createdAt: 5,
      updatedAt: 9,
    });
    expect(post.reports).toHaveLength(1);
    expect(post.reports[0]?.idempotencyKey).toBe('old-key');
    expect(post.reports[0]).not.toHaveProperty('status');
  });
});

describe('classifyFlushError', () => {
  it('classifies a ConvexError (by name) as permanent', () => {
    const e = new Error('invalid_report');
    e.name = 'ConvexError';
    expect(classifyFlushError(e)).toBe('permanent');
  });

  it('classifies a plain error / non-error as transient', () => {
    expect(classifyFlushError(new Error('network'))).toBe('transient');
    expect(classifyFlushError('boom')).toBe('transient');
  });
});

describe('flushPost — happy path', () => {
  it('uploads full+thumb, rows the photo, and creates the Post with its key and the Report with its own', async () => {
    const draft = draftWith({ title: 'Morey 1/10', body: 'Glass.' }, { photos: [photo('p1')] });
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.postId).toBe('post-1');
      expect(res.reportIds).toEqual(['report-1']);
      expect(res.draft.status).toBe('done');
      expect(res.draft.postId).toBe('post-1');
    }
    expect(calls.uploads).toEqual(['p1-full', 'p1-thumb']);
    expect(calls.rows).toHaveLength(1);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatchObject({
      idempotencyKey: 'key-1',
      title: 'Morey 1/10',
      body: 'Glass.',
    });
    expect(calls.reports[0]?.waterBodyId).toBe('wb-1');
    expect(calls.reports[0]?.idempotencyKey).toBe('rkey-1');
    expect(calls.reports[0]?.photoIds).toEqual(['photo-0']);
  });

  it('a two-lake Post is one create with both Reports, in the author’s order', async () => {
    const draft = draftWith();
    draft.reports = [
      reportWith({ id: 'a', idempotencyKey: 'ka', waterBodyId: 'wb-a', bodyName: 'Morey' }),
      reportWith({ id: 'b', idempotencyKey: 'kb', waterBodyId: 'wb-b', bodyName: 'Fairlee' }),
    ];
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.posts).toHaveLength(1);
    expect(calls.reports.map((r) => [r.waterBodyId, r.idempotencyKey])).toEqual([
      ['wb-a', 'ka'],
      ['wb-b', 'kb'],
    ]);
  });

  it('sends the geotag coord only on the placeOnMap opt-in (D42)', async () => {
    const geo = { lat: 44, lng: -73 };
    const draft = draftWith(
      {},
      { photos: [photo('a', { coord: geo, placeOnMap: true }), photo('b', { coord: geo })] },
    );
    const { effects, calls } = makeEffects();
    await flushPost(draft, effects, NOW);
    expect(calls.rows[0]?.coord).toEqual(geo); // opted in
    expect(calls.rows[1]?.coord).toBeUndefined(); // not opted in
  });

  it('carries the put-in opt-out to the server, and only the opt-out (Phase 04 #7)', async () => {
    const { effects, calls } = makeEffects();
    await flushPost(draftWith({}, {}, observedForm({ showPutIn: false })), effects, NOW);
    await flushPost(draftWith({ id: 'd2' }, {}, observedForm()), effects, NOW);
    expect(calls.reports[0]?.showPutIn).toBe(false); // the choice made offline reaches the row
    expect(calls.reports[1]).not.toHaveProperty('showPutIn'); // shown is the stored default
  });
});

describe('flushPost — coord-only resolution (Layer-2 fallback)', () => {
  it('resolves the lake from the coord and posts against it', async () => {
    const draft = draftWith({}, { waterBodyId: undefined, coord: { lat: 44, lng: -73 } });
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.draft.reports[0]?.waterBodyId).toBe('wb-resolved');
    expect(calls.resolves).toBe(1);
    expect(calls.reports[0]?.waterBodyId).toBe('wb-resolved');
  });

  it('parks the draft in error when no lake matches (permanent)', async () => {
    const draft = draftWith({}, { waterBodyId: undefined, coord: { lat: 44, lng: -73 } });
    const { effects, calls } = makeEffects({ resolveBody: async () => null });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
      expect(res.draft.errorMessage).toMatch(/match your location/i);
    }
    expect(calls.posts).toHaveLength(0);
  });
});

describe('flushPost — failures', () => {
  it('a permanently-invalid Report fails the Post before any upload', async () => {
    // A far-future skate-end time is rejected by validateReportInput — a permanent failure.
    const badForm = { ...observedForm(), skateEndTime: NOW + 30 * 24 * 60 * 60 * 1000 };
    const draft = draftWith({}, { photos: [photo('p1')] }, badForm);
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
    }
    expect(calls.uploads).toHaveLength(0);
    expect(calls.posts).toHaveLength(0);
  });

  it('one bad leg parks the whole Post, named by its lake — a two-lake day never lands as one', async () => {
    const draft = draftWith();
    draft.reports = [
      reportWith({ id: 'a', bodyName: 'Morey' }),
      reportWith({ id: 'b', bodyName: 'Fairlee' }, emptyReportForm(NOW)),
    ];
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/^Fairlee: Before this can post/);
    expect(calls.posts).toHaveLength(0);
  });

  it('every leg is checked before any leg uploads — a sound first leg spends nothing on a Post its second leg sinks', async () => {
    const draft = draftWith();
    draft.reports = [
      reportWith({ id: 'a', bodyName: 'Morey', photos: [photo('p1'), photo('p2')] }),
      // The second leg fails the create-only rules (nothing observed) — known before any upload.
      reportWith({ id: 'b', bodyName: 'Fairlee' }, emptyReportForm(NOW)),
    ];
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/^Fairlee: /);
    expect(calls.uploads).toEqual([]);
    expect(calls.rows).toEqual([]);
    expect(calls.posts).toEqual([]);
    // And the same when the second leg is invalid rather than under-observed.
    const invalid = draftWith();
    invalid.reports = [
      reportWith({ id: 'a', bodyName: 'Morey', photos: [photo('p1')] }),
      reportWith({ id: 'b', bodyName: 'Fairlee', waterBodyId: undefined, coord: undefined }),
    ];
    const second = makeEffects();
    expect((await flushPost(invalid, second.effects, NOW)).ok).toBe(false);
    expect(second.calls.uploads).toEqual([]);
  });

  it('a ConvexError from createPost is permanent (parks in error)', async () => {
    const draft = draftWith();
    const { effects } = makeEffects({
      createPost: async () => {
        const e = new Error('Water body not found');
        e.name = 'ConvexError';
        throw e;
      },
    });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
    }
  });
});

describe('flushPost — checkpointing (no orphaned uploads on retry)', () => {
  it('checkpoints the full storageId when the thumb upload fails, then resumes', async () => {
    const draft = draftWith({}, { photos: [photo('p1')] });
    // First attempt: full uploads, thumb throws a transient (network) error.
    const first = makeEffects({
      uploadPhoto: async (uri) => {
        if (uri === 'p1-thumb') throw new Error('network dropped');
        return 'storage-full';
      },
    });
    const res1 = await flushPost(draft, first.effects, NOW);

    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.kind).toBe('transient');
      expect(res1.draft.status).toBe('pending'); // reset for the next flush
      const p = res1.draft.reports[0]?.photos[0];
      expect(p?.fullStorageId).toBe('storage-full'); // checkpointed…
      expect(p?.thumbStorageId).toBeUndefined(); // …but the thumb didn't land
      expect(p?.photoId).toBeUndefined();
    }

    // Second attempt (reconnected): must NOT re-upload the full — only the thumb.
    const second = makeEffects();
    const res2 = await flushPost(res1.ok ? draft : res1.draft, second.effects, NOW);
    expect(res2.ok).toBe(true);
    expect(second.calls.uploads).toEqual(['p1-thumb']); // full reused from the checkpoint
    expect(second.calls.posts).toHaveLength(1);
  });

  it('reuses a fully-uploaded photo (photoId present) without re-uploading or re-rowing', async () => {
    const draft = draftWith(
      {},
      {
        photos: [
          photo('p1', { fullStorageId: 's', thumbStorageId: 't', photoId: 'existing-photo' }),
        ],
      },
    );
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.uploads).toHaveLength(0);
    expect(calls.rows).toHaveLength(0);
    expect(calls.reports[0]?.photoIds).toEqual(['existing-photo']);
  });
});

describe('flushPost — linked recorded track (Phase 08, offline linkage)', () => {
  it('resolves a local track id to an activityId and attaches it to the report', async () => {
    const draft = draftWith({}, { trackDraftId: 'local-track-1' });
    const { effects, calls } = makeEffects({
      resolveActivityId: async (id) => (id === 'local-track-1' ? 'activity-9' : null),
    });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.reports[0]?.activityId).toBe('activity-9');
  });

  it('a track that cannot be sent NEVER blocks the report — it just goes out without a path (D24)', async () => {
    const draft = draftWith({}, { trackDraftId: 'local-track-1' });
    const { effects, calls } = makeEffects({ resolveActivityId: async () => null });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.posts).toHaveLength(1);
    expect(calls.reports[0]?.activityId).toBeUndefined();
  });

  it('checkpoints the resolved activityId, so a retry does not re-resolve it', async () => {
    const draft = draftWith({}, { trackDraftId: 'local-track-1' });
    let resolveCalls = 0;
    const { effects } = makeEffects({
      resolveActivityId: async () => {
        resolveCalls++;
        return 'activity-9';
      },
    });
    const first = await flushPost(draft, effects, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await flushPost(first.draft, effects, NOW);
    expect(resolveCalls).toBe(1);
  });

  it('does nothing when the draft has no linked track', async () => {
    let called = false;
    const { effects, calls } = makeEffects({
      resolveActivityId: async () => {
        called = true;
        return 'nope';
      },
    });
    await flushPost(draftWith(), effects, NOW);
    expect(called).toBe(false);
    expect(calls.reports[0]?.activityId).toBeUndefined();
  });
});

describe('flushPost — the bundled hazards ride the draft (D55 / A10 §9.1)', () => {
  it('a server id passes through; a local id is resolved through the hazard queue and checkpointed', async () => {
    const draft = draftWith({}, { hazardRefs: [{ hazardId: 'srv-1' }, { localId: 'local-7' }] });
    let resolveCalls = 0;
    const { effects, calls } = makeEffects({
      resolveHazardId: async (localId) => {
        resolveCalls++;
        return localId === 'local-7' ? { kind: 'sent', hazardId: 'srv-7' } : { kind: 'gone' };
      },
    });
    const first = await flushPost(draft, effects, NOW);
    expect(first.ok).toBe(true);
    expect(calls.reports[0]?.attachHazardIds).toEqual(['srv-1', 'srv-7']);
    if (!first.ok) return;
    expect(first.draft.reports[0]?.hazardRefs).toEqual([
      { hazardId: 'srv-1' },
      { localId: 'local-7', hazardId: 'srv-7' },
    ]);
    await flushPost(first.draft, effects, NOW);
    expect(resolveCalls).toBe(1); // checkpointed, so a retry does not ask again
  });

  it('a hazard the author deleted from the queue is left out — there is nothing left to attach', async () => {
    const draft = draftWith({}, { hazardRefs: [{ localId: 'gone' }] });
    const { effects, calls } = makeEffects({ resolveHazardId: async () => ({ kind: 'gone' }) });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.reports[0]).not.toHaveProperty('attachHazardIds');
  });

  it('a checked hazard still waiting holds the Post in the queue — never posted without it', async () => {
    const draft = draftWith(
      {},
      { hazardRefs: [{ hazardId: 'srv-1' }, { localId: 'q7' }], photos: [photo('p1')] },
    );
    let sent = false;
    const { effects, calls } = makeEffects({
      resolveHazardId: async () =>
        sent ? { kind: 'sent', hazardId: 'srv-7' } : { kind: 'waiting' },
    });
    const held = await flushPost(draft, effects, NOW);
    expect(held).toMatchObject({ ok: false, kind: 'transient' });
    expect(held.draft.status).toBe('pending');
    expect(isFlushable(held.draft)).toBe(true);
    expect(calls.uploads).toEqual([]);
    expect(calls.posts).toEqual([]);
    // The hazard sends; the next drain posts the Post with it.
    sent = true;
    const res = await flushPost(held.draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.reports[0]?.attachHazardIds).toEqual(['srv-1', 'srv-7']);
  });

  it('a checked hazard the server refused parks the Post with a sentence, by lake on a two-lake day', async () => {
    const refused = 'A hazard you checked (Pressure ridge) could not be sent.';
    const base = draftWith({}, { hazardRefs: [{ localId: 'q7' }], photos: [photo('p1')] });
    const [first] = base.reports;
    if (!first) throw new Error('fixture');
    const twoLakes: PostDraft = {
      ...base,
      reports: [
        { ...first, id: 'r1', bodyName: 'Shelburne Pond', hazardRefs: [] },
        { ...first, id: 'r2', bodyName: 'Lake Iroquois' },
      ],
    };
    const { effects, calls } = makeEffects({
      resolveHazardId: async () => ({ kind: 'refused', message: refused }),
    });
    const res = await flushPost(twoLakes, effects, NOW);
    expect(res).toMatchObject({
      ok: false,
      kind: 'permanent',
      message: `Lake Iroquois: ${refused}`,
    });
    expect(res.draft.status).toBe('error');
    expect(res.draft.errorMessage).toBe(`Lake Iroquois: ${refused}`);
    expect(calls.uploads).toEqual([]);
    expect(calls.posts).toEqual([]);
  });

  it('a draft whose create was already sent is not held or parked for a hazard — it may be live', async () => {
    for (const resolution of [
      { kind: 'waiting' },
      { kind: 'refused', message: 'no' },
    ] as const satisfies readonly HazardRefResolution[]) {
      const { effects, calls } = makeEffects({ resolveHazardId: async () => resolution });
      const resumed = draftWith({ status: 'creating' }, { hazardRefs: [{ localId: 'q7' }] });
      const res = await flushPost(resumed, effects, NOW);
      expect(res.ok).toBe(true);
      expect(calls.reports[0]).not.toHaveProperty('attachHazardIds');
    }
  });

  it('a ref that resolves to nothing does not count toward the minimum set — refused before the uploads', async () => {
    const dontGo = { ...emptyReportForm(NOW), skateQuality: 'poor' as const };
    const draft = draftWith(
      {},
      { hazardRefs: [{ localId: 'gone' }], photos: [photo('p1')] },
      dontGo,
    );
    const { effects, calls } = makeEffects({ resolveHazardId: async () => ({ kind: 'gone' }) });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/^Before this can post/);
    expect(calls.uploads).toEqual([]);
    expect(calls.posts).toEqual([]);
  });

  it('a bundled hazard is the observation the minimum set asks for (D189)', async () => {
    const dontGo = { ...emptyReportForm(NOW), skateQuality: 'poor' as const };
    const draft = draftWith({}, { hazardRefs: [{ hazardId: 'srv-1' }] }, dontGo);
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.posts).toHaveLength(1);
  });
});

describe('the create-only rules at flush (A10 §9.4)', () => {
  it('a week-old draft is surfaced, not posted — and spends no uploads first', async () => {
    const { effects, calls } = makeEffects();
    const stale = draftWith({}, { photos: [photo('p1')] });
    const res = await flushPost(stale, effects, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.message).toBe('Reports can be posted up to a week after you got off the ice.');
    }
    expect(calls.uploads).toEqual([]);
    expect(calls.posts).toEqual([]);
  });

  it('a draft already sent once (found in `creating`) is left to the server’s dedup, not refused here', async () => {
    const { effects, calls } = makeEffects();
    const resumed = draftWith({ status: 'creating' });
    const res = await flushPost(resumed, effects, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(res.ok).toBe(true);
    expect(calls.posts).toHaveLength(1); // the server answers with the existing Post (D30)
  });

  it('a create that lost its ack stays `creating`, so the retry is the server’s call — not a refusal', async () => {
    let attempts = 0;
    const { effects, calls } = makeEffects({
      createPost: async (input) => {
        attempts++;
        if (attempts === 1) throw new Error('Network request failed');
        return { postId: 'post-1', reportIds: input.reports.map((_, i) => `report-${i + 1}`) };
      },
    });
    const first = await flushPost(draftWith(), effects, NOW);
    expect(first).toMatchObject({ ok: false, kind: 'transient' });
    expect(first.draft.status).toBe('creating');
    expect(isFlushable(first.draft)).toBe(true);
    // Eight days on: a fresh create would be refused, but this one may already be live server-side.
    const second = await flushPost(first.draft, effects, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(second.ok).toBe(true);
    expect(calls.uploads).toEqual([]);
  });

  it('a transient failure before the create still resets to `pending`', async () => {
    const { effects } = makeEffects({
      uploadPhoto: async () => {
        throw new Error('offline');
      },
    });
    const res = await flushPost(draftWith({}, { photos: [photo('p1')] }), effects, NOW);
    expect(res).toMatchObject({ ok: false, kind: 'transient' });
    expect(res.draft.status).toBe('pending');
  });

  it('a retry of a `creating` draft keeps the mark through a transient failure before the create', async () => {
    let calls = 0;
    const { effects, calls: made } = makeEffects({
      resolveHazardId: async () => {
        calls++;
        if (calls === 1) throw new Error('Network request failed');
        return { kind: 'sent', hazardId: 'srv-1' };
      },
    });
    const resumed = draftWith({ status: 'creating' }, { hazardRefs: [{ localId: 'q1' }] });
    const again = await flushPost(resumed, effects, NOW);
    expect(again).toMatchObject({ ok: false, kind: 'transient' });
    // Still `creating`: the fact that the create was sent survives, and every persisted step said so.
    expect(again.draft.status).toBe('creating');
    expect(made.persisted.every((d) => d.status === 'creating')).toBe(true);
    // So the next retry, past the window, is still the server's call rather than a refusal.
    const third = await flushPost(again.draft, effects, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(third.ok).toBe(true);
  });

  it('a draft that says nothing is parked with what to add', async () => {
    const { effects, calls } = makeEffects();
    const res = await flushPost(draftWith({}, {}, emptyReportForm(NOW)), effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/^Before this can post, add how it was and one thing/);
    expect(calls.posts).toEqual([]);
  });

  it('a server refusal parks the draft with the server’s sentence, not the wire form', () => {
    const wire = new Error(
      '[Request ID: abc] Server Error Uncaught ConvexError: {"code":"minimum_set","message":"Before this can post, add how it was."}',
    );
    wire.name = 'ConvexError';
    (wire as Error & { data: unknown }).data = {
      code: 'minimum_set',
      message: 'Before this can post, add how it was.',
    };
    expect(flushErrorMessage(wire)).toBe('Before this can post, add how it was.');
    const plain = new Error('Water body not found');
    plain.name = 'ConvexError';
    (plain as Error & { data: unknown }).data = 'Water body not found';
    expect(flushErrorMessage(plain)).toBe('Water body not found');
    expect(flushErrorMessage(new TypeError('Network request failed'))).toBe(
      'Network request failed',
    );
  });
});

// ── A10-3: held drafts, sheet-shaped Reports, the condition alerts ─────────────────────────────

import {
  accessConditionFilings,
  accessConditionKey,
  isHeldDraft,
  POST_SENT_COPY,
  postCreateSent,
  reportDraftEndTime,
  reportDraftInput,
} from './draftQueue';
import { emptySheet, type ReportSheetState, sheetReducer } from './reportSheet';

/** A sheet that meets the minimum set: quality, one chip, an end time. */
function observedSheet(extra: Partial<ReportSheetState['scalars']> = {}): ReportSheetState {
  const base = emptySheet(NOW - 60_000, 'wb-1');
  const s = [
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
  ].reduce(sheetReducer, base);
  return { ...s, scalars: { ...s.scalars, ...extra } };
}

describe('held drafts (A10-3 — a draft never auto-posts)', () => {
  it('a draft is held: not flushable, not in the flush list, and says so', () => {
    const held = createPostDraft({
      id: 'd-held',
      idempotencyKey: 'k-held',
      now: NOW,
      reports: [reportWith()],
      status: 'draft',
    });
    expect(held.status).toBe('draft');
    expect(isHeldDraft(held)).toBe(true);
    expect(isFlushable(held)).toBe(false);
    expect(flushablePosts([held, draftWith()])).toHaveLength(1);
    expect(isHeldDraft(draftWith())).toBe(false);
  });
});

describe('a sent Post (PR #77 review — a change after the send would be dropped)', () => {
  it('is sent once the create went out, answered or not, and not before', () => {
    expect(postCreateSent(null)).toBe(false);
    expect(postCreateSent(undefined)).toBe(false);
    for (const status of ['draft', 'pending', 'uploading', 'error'] as const) {
      expect(postCreateSent(draftWith({ status }))).toBe(false);
    }
    // Sent, no answer: the Post may be live.
    expect(postCreateSent(draftWith({ status: 'creating' }))).toBe(true);
    // Landed, then a later step failed and put it back to `pending`: the Post is live.
    expect(postCreateSent(draftWith({ status: 'pending', postId: 'post-1' }))).toBe(true);
  });

  it('says it may be up, never that it is, and where a change goes instead', () => {
    expect(POST_SENT_COPY).toMatch(/may already be up/);
    expect(POST_SENT_COPY).toMatch(/edit it from its page/);
  });
});

describe('sheet-shaped Report drafts (A10-3)', () => {
  it('a Report draft carries a sheet or a form, exactly one', () => {
    expect(() => createReportDraft({ id: 'x', idempotencyKey: 'k' })).toThrow(/exactly one/);
    expect(() =>
      createReportDraft({
        id: 'x',
        idempotencyKey: 'k',
        form: observedForm(),
        sheet: observedSheet(),
      }),
    ).toThrow(/exactly one/);
    const r = createReportDraft({ id: 'x', idempotencyKey: 'k', sheet: observedSheet() });
    expect(r.sheet).toBeDefined();
    expect(r.form).toBeUndefined();
  });

  it('reportDraftInput serializes the sheet with the resolved body; a form goes through buildReportInput', () => {
    const sheet = observedSheet({ point: { lat: 44, lng: -72 } });
    const r = createReportDraft({ id: 'x', idempotencyKey: 'k', sheet });
    const input = reportDraftInput(r, 'wb-resolved');
    expect(input?.waterBodyId).toBe('wb-resolved');
    expect(input?.iceTypes).toEqual([{ type: 'black_ice' }]);
    expect(input?.point).toEqual({ lat: 44, lng: -72 });
    expect(reportDraftEndTime(r)).toBe(NOW - 60_000);
    const legacy = reportWith();
    expect(reportDraftInput(legacy, 'wb-1')?.skateEndTime).toBe(NOW);
    expect(reportDraftEndTime(legacy)).toBe(NOW);
    expect(reportDraftInput({ ...legacy, form: undefined }, 'wb-1')).toBeNull();
    expect(reportDraftEndTime({ ...legacy, form: undefined })).toBeNaN();
  });

  it('a sheet draft flushes through the same path — one create, the sheet’s content', async () => {
    const draft = draftWith(
      {},
      createReportDraft({
        id: 'r1',
        idempotencyKey: 'rkey-1',
        sheet: observedSheet(),
        waterBodyId: 'wb-1',
      }),
    );
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.reports[0]).toMatchObject({ waterBodyId: 'wb-1', skateQuality: 'good' });
  });

  it('a row with neither shape parks as permanent, before any upload', async () => {
    const draft = draftWith({}, { form: undefined, photos: [photo('p1')] });
    const { effects, calls } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res).toMatchObject({ ok: false, kind: 'permanent' });
    expect(calls.uploads).toEqual([]);
  });
});

describe('the condition alerts file after the Post (D197 / §7.2)', () => {
  it('accessConditionFilings targets the put-in, the lot for lot-shaped reasons, nothing with no target', () => {
    const chips = (s: ReportSheetState) =>
      [
        {
          type: 'select' as const,
          field: 'accessConditions' as const,
          key: 'plank_needed',
          value: 'plank_needed',
        },
        {
          type: 'select' as const,
          field: 'accessConditions' as const,
          key: 'icy_lot',
          value: 'icy_lot',
        },
      ].reduce(sheetReducer, s);
    expect(accessConditionFilings(chips(observedSheet()))).toEqual([]);
    expect(
      accessConditionFilings(
        chips(observedSheet({ putInId: 'pi-1', accessNote: ' plank by the ramp ' })),
      ),
    ).toEqual([
      {
        targetType: 'put_in',
        putInId: 'pi-1',
        reason: 'plank_needed',
        note: 'plank by the ramp',
        observedAt: NOW - 60_000,
      },
      {
        targetType: 'put_in',
        putInId: 'pi-1',
        reason: 'icy_lot',
        note: 'plank by the ramp',
        observedAt: NOW - 60_000,
      },
    ]);
    // Observed when the skater got off, not when the flush happens to run.
    expect(
      accessConditionFilings(chips(observedSheet({ putInId: 'pi-1', parkingAreaId: 'lot-1' }))),
    ).toEqual([
      { targetType: 'put_in', putInId: 'pi-1', reason: 'plank_needed', observedAt: NOW - 60_000 },
      {
        targetType: 'parking_area',
        parkingAreaId: 'lot-1',
        reason: 'icy_lot',
        observedAt: NOW - 60_000,
      },
    ]);
    expect(accessConditionFilings(chips(observedSheet({ parkingAreaId: 'lot-1' })))).toEqual([
      {
        targetType: 'parking_area',
        parkingAreaId: 'lot-1',
        reason: 'plank_needed',
        observedAt: NOW - 60_000,
      },
      {
        targetType: 'parking_area',
        parkingAreaId: 'lot-1',
        reason: 'icy_lot',
        observedAt: NOW - 60_000,
      },
    ]);
    expect(accessConditionKey('rkey-1', 'icy_lot')).toBe('rkey-1:access:icy_lot');
  });

  it('files each condition with the created Report as provenance, checkpointed by reason', async () => {
    const sheet = [
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'plank_needed',
        value: 'plank_needed',
      },
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'walk_in',
        value: 'walk_in',
      },
    ].reduce(sheetReducer, observedSheet({ putInId: 'pi-1' }));
    const draft = draftWith(
      {},
      createReportDraft({ id: 'r1', idempotencyKey: 'rkey-1', sheet, waterBodyId: 'wb-1' }),
    );
    const filed: unknown[] = [];
    const { effects, calls } = makeEffects({
      createAccessAlert: async (input) => {
        filed.push(input);
      },
    });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(filed).toEqual([
      {
        targetType: 'put_in',
        putInId: 'pi-1',
        reason: 'plank_needed',
        observedAt: NOW - 60_000,
        reportId: 'report-1',
        idempotencyKey: 'rkey-1:access:plank_needed',
      },
      {
        targetType: 'put_in',
        putInId: 'pi-1',
        reason: 'walk_in',
        observedAt: NOW - 60_000,
        reportId: 'report-1',
        idempotencyKey: 'rkey-1:access:walk_in',
      },
    ]);
    const last = calls.persisted[calls.persisted.length - 1];
    expect(last?.reports[0]?.filedAccessReasons).toEqual(['plank_needed', 'walk_in']);
    expect(last?.status).toBe('done');
  });

  it('a network failure on an alert leaves the Post id checkpointed; the retry files only the rest and re-asks no create-only rule', async () => {
    const sheet = [
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'plank_needed',
        value: 'plank_needed',
      },
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'walk_in',
        value: 'walk_in',
      },
    ].reduce(sheetReducer, observedSheet({ putInId: 'pi-1' }));
    const draft = draftWith(
      {},
      createReportDraft({ id: 'r1', idempotencyKey: 'rkey-1', sheet, waterBodyId: 'wb-1' }),
    );
    let attempts = 0;
    const filed: string[] = [];
    const { effects, calls } = makeEffects({
      createAccessAlert: async (input) => {
        attempts++;
        if (attempts === 2) throw new Error('offline');
        filed.push(input.reason);
      },
    });
    const first = await flushPost(draft, effects, NOW);
    expect(first).toMatchObject({ ok: false, kind: 'transient' });
    expect(first.draft.postId).toBe('post-1');
    expect(first.draft.status).toBe('pending');
    expect(first.draft.reports[0]?.filedAccessReasons).toEqual(['plank_needed']);

    // Eight days on: the window would refuse a fresh create, but this Post is live already.
    const second = await flushPost(first.draft, effects, NOW + 8 * 24 * 60 * 60 * 1000);
    expect(second.ok).toBe(true);
    expect(filed).toEqual(['plank_needed', 'walk_in']);
    expect(calls.posts).toHaveLength(2); // the idempotent create ran again and returned the same ids
  });

  it('a server refusal on one alert skips it — the Post is live, and a plank nobody can file is not an error', async () => {
    const sheet = [
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'plank_needed',
        value: 'plank_needed',
      },
    ].reduce(sheetReducer, observedSheet({ putInId: 'pi-hidden' }));
    const draft = draftWith(
      {},
      createReportDraft({ id: 'r1', idempotencyKey: 'rkey-1', sheet, waterBodyId: 'wb-1' }),
    );
    const { effects } = makeEffects({
      createAccessAlert: async () => {
        const e = new Error('Put-in not found');
        e.name = 'ConvexError';
        throw e;
      },
    });
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(res.draft.status).toBe('done');
    expect(res.draft.reports[0]?.filedAccessReasons).toEqual(['plank_needed']);
  });

  it('without the effect, nothing files and the flush is unchanged', async () => {
    const sheet = [
      {
        type: 'select' as const,
        field: 'accessConditions' as const,
        key: 'plank_needed',
        value: 'plank_needed',
      },
    ].reduce(sheetReducer, observedSheet({ putInId: 'pi-1' }));
    const draft = draftWith(
      {},
      createReportDraft({ id: 'r1', idempotencyKey: 'rkey-1', sheet, waterBodyId: 'wb-1' }),
    );
    const { effects } = makeEffects();
    const res = await flushPost(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(res.draft.reports[0]?.filedAccessReasons).toBeUndefined();
  });
});
