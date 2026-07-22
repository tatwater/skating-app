import { describe, expect, it } from 'vitest';
import {
  classifyFlushError,
  createDraft,
  type DraftFlushEffects,
  type DraftPhoto,
  flushableDrafts,
  flushDraft,
  isFlushable,
  type ReportDraft,
} from './draftQueue';
import { emptyReportForm, type ReportFormState } from './reportForm';

const NOW = Date.UTC(2026, 0, 10);

function photo(id: string, extra: Partial<DraftPhoto> = {}): DraftPhoto {
  return { id, fullUri: `${id}-full`, thumbUri: `${id}-thumb`, placeOnMap: false, ...extra };
}

function draftWith(overrides: Partial<ReportDraft> = {}, form?: ReportFormState): ReportDraft {
  return {
    ...createDraft({
      id: 'd1',
      idempotencyKey: 'key-1',
      now: NOW,
      form: form ?? emptyReportForm(NOW),
      waterBodyId: 'wb-1',
    }),
    ...overrides,
  };
}

/** A recording fake for the injected effects, with optional per-call failure injection. */
function makeEffects(overrides: Partial<DraftFlushEffects> = {}): {
  effects: DraftFlushEffects;
  calls: {
    uploads: string[];
    rows: Array<Parameters<DraftFlushEffects['createPhotoRow']>[0]>;
    reports: Array<Parameters<DraftFlushEffects['createReport']>[0]>;
    resolves: number;
    persisted: ReportDraft[];
  };
} {
  const calls = {
    uploads: [] as string[],
    rows: [] as Array<Parameters<DraftFlushEffects['createPhotoRow']>[0]>,
    reports: [] as Array<Parameters<DraftFlushEffects['createReport']>[0]>,
    resolves: 0,
    persisted: [] as ReportDraft[],
  };
  let storageSeq = 0;
  let photoSeq = 0;
  const effects: DraftFlushEffects = {
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
    createReport: async (input) => {
      calls.reports.push(input);
      return 'report-1';
    },
    persist: async (d) => {
      calls.persisted.push(d);
    },
    ...overrides,
  };
  return { effects, calls };
}

describe('createDraft / isFlushable / flushableDrafts', () => {
  it('creates a pending draft with empty photos and now timestamps', () => {
    const d = createDraft({ id: 'x', idempotencyKey: 'k', now: NOW, form: emptyReportForm(NOW) });
    expect(d.status).toBe('pending');
    expect(d.photos).toEqual([]);
    expect(d.createdAt).toBe(NOW);
    expect(d.updatedAt).toBe(NOW);
  });

  it('treats done + permanent-error as not flushable, everything else as flushable', () => {
    expect(isFlushable(draftWith({ status: 'pending' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'uploading' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'creating' }))).toBe(true);
    expect(isFlushable(draftWith({ status: 'done' }))).toBe(false);
    expect(isFlushable(draftWith({ status: 'error' }))).toBe(false);
  });

  it('returns the flushable subset oldest-first', () => {
    const drafts: ReportDraft[] = [
      draftWith({ id: 'b', status: 'pending', createdAt: 200 }),
      draftWith({ id: 'done', status: 'done', createdAt: 50 }),
      draftWith({ id: 'a', status: 'uploading', createdAt: 100 }),
      draftWith({ id: 'err', status: 'error', createdAt: 10 }),
    ];
    expect(flushableDrafts(drafts).map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('classifyFlushError', () => {
  it('classifies a ConvexError (by name) as permanent', () => {
    const e = new Error('invalid_report');
    e.name = 'ConvexError';
    expect(classifyFlushError(e)).toBe('permanent');
  });

  it('classifies a plain error / non-error as transient', () => {
    expect(classifyFlushError(new Error('network down'))).toBe('transient');
    expect(classifyFlushError('boom')).toBe('transient');
  });
});

describe('flushDraft — happy path', () => {
  it('uploads full+thumb, rows the photo, and creates the report with key + photoIds', async () => {
    const draft = draftWith({ photos: [photo('p1')] });
    const { effects, calls } = makeEffects();
    const res = await flushDraft(draft, effects, NOW);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reportId).toBe('report-1');
      expect(res.draft.status).toBe('done');
    }
    expect(calls.uploads).toEqual(['p1-full', 'p1-thumb']);
    expect(calls.rows).toHaveLength(1);
    expect(calls.reports).toHaveLength(1);
    expect(calls.reports[0]?.waterBodyId).toBe('wb-1');
    expect(calls.reports[0]?.idempotencyKey).toBe('key-1');
    expect(calls.reports[0]?.photoIds).toEqual(['photo-0']);
  });

  it('sends the geotag coord only on the placeOnMap opt-in (D42)', async () => {
    const geo = { lat: 44, lng: -73 };
    const draft = draftWith({
      photos: [photo('a', { coord: geo, placeOnMap: true }), photo('b', { coord: geo })],
    });
    const { effects, calls } = makeEffects();
    await flushDraft(draft, effects, NOW);
    expect(calls.rows[0]?.coord).toEqual(geo); // opted in
    expect(calls.rows[1]?.coord).toBeUndefined(); // not opted in
  });
});

describe('flushDraft — coord-only resolution (Layer-2 fallback)', () => {
  it('resolves the lake from the coord and posts against it', async () => {
    const draft = draftWith({ waterBodyId: undefined, coord: { lat: 44, lng: -73 } });
    const { effects, calls } = makeEffects();
    const res = await flushDraft(draft, effects, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.draft.waterBodyId).toBe('wb-resolved');
    expect(calls.resolves).toBe(1);
    expect(calls.reports[0]?.waterBodyId).toBe('wb-resolved');
  });

  it('parks the draft in error when no lake matches (permanent)', async () => {
    const draft = draftWith({ waterBodyId: undefined, coord: { lat: 44, lng: -73 } });
    const { effects, calls } = makeEffects({ resolveBody: async () => null });
    const res = await flushDraft(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
      expect(res.draft.errorMessage).toMatch(/match your location/i);
    }
    expect(calls.reports).toHaveLength(0);
  });
});

describe('flushDraft — failures', () => {
  it('a permanently-invalid draft fails before any upload', async () => {
    // A far-future skate-end time is rejected by validateReportInput — a permanent failure.
    const badForm = { ...emptyReportForm(NOW), skateEndTime: NOW + 30 * 24 * 60 * 60 * 1000 };
    const draft = draftWith({ photos: [photo('p1')] }, badForm);
    const { effects, calls } = makeEffects();
    const res = await flushDraft(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
    }
    expect(calls.uploads).toHaveLength(0);
    expect(calls.reports).toHaveLength(0);
  });

  it('a ConvexError from createReport is permanent (parks in error)', async () => {
    const draft = draftWith();
    const { effects } = makeEffects({
      createReport: async () => {
        const e = new Error('Water body not found');
        e.name = 'ConvexError';
        throw e;
      },
    });
    const res = await flushDraft(draft, effects, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('permanent');
      expect(res.draft.status).toBe('error');
    }
  });
});

describe('flushDraft — checkpointing (no orphaned uploads on retry)', () => {
  it('checkpoints the full storageId when the thumb upload fails, then resumes', async () => {
    const draft = draftWith({ photos: [photo('p1')] });
    // First attempt: full uploads, thumb throws a transient (network) error.
    const first = makeEffects({
      uploadPhoto: async (uri) => {
        if (uri === 'p1-thumb') throw new Error('network dropped');
        return 'storage-full';
      },
    });
    const res1 = await flushDraft(draft, first.effects, NOW);

    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.kind).toBe('transient');
      expect(res1.draft.status).toBe('pending'); // reset for the next flush
      const p = res1.draft.photos[0];
      expect(p?.fullStorageId).toBe('storage-full'); // checkpointed…
      expect(p?.thumbStorageId).toBeUndefined(); // …but the thumb didn't land
      expect(p?.photoId).toBeUndefined();
    }

    // Second attempt (reconnected): must NOT re-upload the full — only the thumb.
    const second = makeEffects();
    const res2 = await flushDraft(res1.ok ? draft : res1.draft, second.effects, NOW);
    expect(res2.ok).toBe(true);
    expect(second.calls.uploads).toEqual(['p1-thumb']); // full reused from the checkpoint
    expect(second.calls.reports).toHaveLength(1);
  });

  it('reuses a fully-uploaded photo (photoId present) without re-uploading or re-rowing', async () => {
    const draft = draftWith({
      photos: [photo('p1', { fullStorageId: 's', thumbStorageId: 't', photoId: 'existing-photo' })],
    });
    const { effects, calls } = makeEffects();
    const res = await flushDraft(draft, effects, NOW);
    expect(res.ok).toBe(true);
    expect(calls.uploads).toHaveLength(0);
    expect(calls.rows).toHaveLength(0);
    expect(calls.reports[0]?.photoIds).toEqual(['existing-photo']);
  });
});
