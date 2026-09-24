import { describe, expect, it } from 'vitest';
import { createPostDraft, createReportDraft, type DraftPhoto } from './draftQueue';
import {
  addEarlierVisit,
  addLake,
  addPostPhotos,
  assignCandidates,
  bundledIds,
  dropPhoto,
  findPhoto,
  movePhotoToReport,
  openPostSheet,
  type PostSheet,
  photoCounts,
  placePhotoByHand,
  postRefusals,
  postSheetForEdit,
  postSheetFromDraft,
  reassignPool,
  removeReport,
  reportEndMs,
  reportsInTimeOrder,
  SHEET_SECTION_COUNT,
  type SheetReport,
  sectionsFilled,
  sendPhotoToAccess,
  sheetLabel,
  toPostDraft,
  unassignedPhotos,
  updateReport,
} from './postSheet';
import { emptyReportForm } from './reportForm';
import { selectedValues, sheetReducer } from './reportSheet';

const NOW = Date.UTC(2026, 0, 10, 20);
let seq = 0;
const mint = () => `id-${++seq}`;

function filled(post: ReturnType<typeof openPostSheet>) {
  const first = post.reports[0];
  if (!first) throw new Error('no report');
  return updateReport(post, first.id, (r) => ({
    ...r,
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
    ].reduce(sheetReducer, r.sheet),
  }));
}

describe('openPostSheet', () => {
  it('opens one Report on the body with the door, keys minted, nothing dirty', () => {
    const post = openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
    expect(post.reports).toHaveLength(1);
    expect(post.reports[0]?.sheet.waterBodyId).toBe('wb1');
    expect(post.reports[0]?.bodyName).toBe('Morey');
    expect(post.door).toBe('body');
    expect(post.dirty).toBe(false);
    expect(post.draftId).not.toBe(post.idempotencyKey);
    expect(sheetLabel(post)).toBe('Morey');
  });

  it('a track door stamps the GPS end (and start) exactly (D192)', () => {
    const post = openPostSheet(
      'track',
      {
        waterBodyId: 'wb1',
        trackDraftId: 't1',
        gpsWindow: { endMs: NOW - 3600e3, startMs: NOW - 7200e3 },
      },
      NOW,
      mint,
    );
    const sheet = post.reports[0]?.sheet;
    expect(selectedValues(sheet as NonNullable<typeof sheet>, 'endTime')).toEqual([
      { ms: NOW - 3600e3, precision: 'gps' },
    ]);
    expect(sheet?.scalars.skateStartTime).toBe(NOW - 7200e3);
    expect(post.reports[0]?.trackDraftId).toBe('t1');
  });

  it('a GPS end with no start leaves the start unasked, not zero', () => {
    const post = openPostSheet(
      'track',
      { waterBodyId: 'wb1', gpsWindow: { endMs: NOW - 3600e3 } },
      NOW,
      mint,
    );
    const sheet = post.reports[0]?.sheet;
    expect(selectedValues(sheet as NonNullable<typeof sheet>, 'endTime')).toEqual([
      { ms: NOW - 3600e3, precision: 'gps' },
    ]);
    expect(sheet?.scalars.skateStartTime).toBeUndefined();
    expect(sheet?.touchedScalars.skateStartTime).toBeUndefined();
  });
});

describe('the multi-Report sheet (§4.3)', () => {
  it('adds a lake after the last, an earlier visit right after its source on the same body, never removes the last', () => {
    let post = openPostSheet(
      'body',
      { waterBodyId: 'wb1', bodyName: 'Morey', showPutIn: false },
      NOW,
      mint,
    );
    post = addLake(post, { waterBodyId: 'wb2', bodyName: 'Fairlee' }, NOW, mint);
    expect(post.reports.map((r) => r.bodyName)).toEqual(['Morey', 'Fairlee']);
    expect(post.reports[1]?.sheet.scalars.showPutIn).toBe(false); // the switch carries
    const first = post.reports[0] as NonNullable<(typeof post.reports)[0]>;
    post = addEarlierVisit(post, first.id, NOW, mint);
    expect(post.reports.map((r) => r.bodyName)).toEqual(['Morey', 'Morey', 'Fairlee']);
    expect(post.reports[1]?.sheet.waterBodyId).toBe('wb1');
    expect(post.dirty).toBe(true);
    expect(sheetLabel(post)).toBe('Morey · Morey · Fairlee');
    expect(addEarlierVisit(post, 'nope', NOW, mint)).toBe(post);
    const two = removeReport(post, first.id);
    expect(two.reports).toHaveLength(2);
    const one = removeReport(removeReport(two, two.reports[0]?.id ?? ''), two.reports[1]?.id ?? '');
    expect(one.reports).toHaveLength(1);
  });

  it('updateReport marks dirty only when the update changed something', () => {
    const post = openPostSheet('body', { waterBodyId: 'wb1' }, NOW, mint);
    const id = post.reports[0]?.id ?? '';
    expect(updateReport(post, id, (r) => r)).toBe(post);
    expect(updateReport(post, 'other', (r) => ({ ...r })).dirty).toBe(false);
    expect(updateReport(post, id, (r) => ({ ...r, bodyName: 'X' })).dirty).toBe(true);
    // The sheet's own doing — a ghost offered, a default preselected — applies but is not the author's.
    const quiet = updateReport(post, id, (r) => ({ ...r, bodyName: 'X' }), { quiet: true });
    expect(quiet.reports[0]?.bodyName).toBe('X');
    expect(quiet.dirty).toBe(false);
  });
});

describe('toPostDraft / postSheetFromDraft — the round trip', () => {
  it('saves held or queued, carries photos, the track and the bundle choice, and reopens as itself', () => {
    let post = filled(openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint));
    const id = post.reports[0]?.id ?? '';
    post = updateReport(post, id, (r) => ({
      ...r,
      photos: [{ id: 'p1', fullUri: 'f', thumbUri: 't', placeOnMap: false }],
      trackDraftId: 'track-1',
      bundleCandidateIds: ['h1', 'local:q1'],
      unbundledHazardIds: ['h1'],
    }));
    post = { ...post, title: ' Morey ', body: 'Glass. ' };
    const held = toPostDraft(post, 'draft', NOW);
    expect(held.status).toBe('draft');
    expect(held.title).toBe('Morey');
    expect(held.body).toBe('Glass.');
    expect(held.reports[0]).toMatchObject({
      id,
      waterBodyId: 'wb1',
      bodyName: 'Morey',
      trackDraftId: 'track-1',
      hazardRefs: [{ localId: 'q1' }],
    });
    expect(held.reports[0]?.photos).toHaveLength(1);
    expect(bundledIds(post.reports[0] as NonNullable<(typeof post.reports)[0]>)).toEqual([
      'local:q1',
    ]);

    const reopened = postSheetFromDraft(held, NOW + 1000);
    expect(reopened?.door).toBe('draft');
    expect(reopened?.title).toBe('Morey');
    expect(reopened?.reports[0]?.sheet).toEqual(post.reports[0]?.sheet);
    expect(reopened?.reports[0]?.savedHazardRefs).toEqual([{ localId: 'q1' }]);
    expect(reopened?.reports[0]?.sheet.openedAtMs).toBe(NOW); // the pinned minute survives a resume

    // Queued, with a prior row's clock and resolved track kept.
    const queued = toPostDraft(reopened as NonNullable<typeof reopened>, 'pending', NOW + 2000, {
      ...held,
      createdAt: NOW - 5000,
      reports: [
        { ...(held.reports[0] as NonNullable<(typeof held.reports)[0]>), activityId: 'act-1' },
      ],
    });
    expect(queued.status).toBe('pending');
    expect(queued.createdAt).toBe(NOW - 5000);
    expect(queued.updatedAt).toBe(NOW + 2000);
    expect(queued.reports[0]?.activityId).toBe('act-1');
    // Before the candidates load, a reopened draft keeps the refs it saved.
    expect(queued.reports[0]?.hazardRefs).toEqual([{ localId: 'q1' }]);
  });

  it('saves a body-less capture by its coord, and labels the lake it cannot name', () => {
    const post = filled(openPostSheet('body', { coord: { lat: 43.9, lng: -72.1 } }, NOW, mint));
    const draft = toPostDraft(post, 'draft', NOW);
    expect(draft.reports[0]?.coord).toEqual({ lat: 43.9, lng: -72.1 });
    expect(draft.reports[0]?.waterBodyId).toBeUndefined();
    expect(draft.reports[0]?.bodyName).toBeUndefined();
    expect(sheetLabel(post)).toBe('Unknown lake');
  });

  it("carries the sheet's own activity to a first save, with no prior row to read", () => {
    const post = filled(
      openPostSheet('activity', { waterBodyId: 'wb1', activityId: 'act-9' }, NOW, mint),
    );
    expect(toPostDraft(post, 'draft', NOW).reports[0]?.activityId).toBe('act-9');
  });

  it('lifts a pre-sheet form draft into a sheet, keeping the pin and a body-less capture body-less', () => {
    const form = {
      ...emptyReportForm(NOW),
      skateQuality: 'fair' as const,
      surfaceTags: ['glass' as const],
    };
    const legacy = createPostDraft({
      id: 'd1',
      idempotencyKey: 'k1',
      now: NOW,
      reports: [
        createReportDraft({
          id: 'r1',
          idempotencyKey: 'rk1',
          form,
          coord: { lat: 44, lng: -72 },
          putInPin: { lat: 44.1, lng: -72 },
        }),
      ],
    });
    const post = postSheetFromDraft(legacy, NOW);
    const sheet = post?.reports[0]?.sheet;
    expect(sheet?.waterBodyId).toBeUndefined();
    expect(selectedValues(sheet as NonNullable<typeof sheet>, 'quality')).toEqual(['fair']);
    expect(sheet?.scalars.point).toEqual({ lat: 44.1, lng: -72 });
    expect(post?.reports[0]?.coord).toEqual({ lat: 44, lng: -72 });
    expect(postSheetFromDraft({ ...legacy, reports: [] }, NOW)).toBeNull();
    expect(
      postSheetFromDraft(
        {
          ...legacy,
          reports: [
            { ...(legacy.reports[0] as NonNullable<(typeof legacy.reports)[0]>), form: undefined },
          ],
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe('postSheetForEdit', () => {
  it('seeds from the published Report and its Post, keeps the attached photos, and edits rather than posts', () => {
    const post = postSheetForEdit(
      {
        reportId: 'rep-1',
        waterBodyId: 'wb1',
        bodyName: 'Morey',
        skateEndTime: NOW - 3600e3,
        skateQuality: 'good',
        photoIds: ['ph1'],
      },
      { postId: 'post-1', title: 'Morey', body: 'Words.' },
      NOW,
      mint,
    );
    expect(post.mode).toEqual({ kind: 'edit', reportId: 'rep-1', postId: 'post-1' });
    expect(post.title).toBe('Morey');
    expect(post.reports[0]?.keptPhotoIds).toEqual(['ph1']);
    expect(post.reports[0]?.id).toBe('rep-1');
    // An edit is never held to the create-only rules — an old skate stays editable (D199).
    expect(postRefusals(post, NOW + 30 * 24 * 3600e3)).toEqual([]);
    const noPost = postSheetForEdit(
      { reportId: 'rep-1', skateEndTime: NOW, photoIds: [] },
      null,
      NOW,
      mint,
    );
    expect(noPost.mode).toEqual({ kind: 'edit', reportId: 'rep-1' });
  });
});

describe('postRefusals (D189 / D199 before Post)', () => {
  it('names the lake and the gaps per Report, in the server’s words; a bundled hazard counts', () => {
    let post = openPostSheet('body', { waterBodyId: 'wb1', bodyName: 'Morey' }, NOW, mint);
    post = addLake(post, { waterBodyId: 'wb2', bodyName: 'Fairlee' }, NOW, mint);
    const refusals = postRefusals(post, NOW);
    expect(refusals.map((r) => r.bodyName)).toEqual(['Morey', 'Fairlee']);
    expect(refusals[0]?.gaps).toEqual(['endTime', 'howWasIt', 'observation']);
    expect(refusals[0]?.message).toMatch(/^Before this can post/);

    const ok = filled(post);
    const second = ok.reports[1] as NonNullable<(typeof ok.reports)[1]>;
    const withHazard = updateReport(ok, second.id, (r) => ({
      ...r,
      bundleCandidateIds: ['h1'],
      sheet: [
        {
          type: 'select' as const,
          field: 'suitability' as const,
          key: 'dont_go',
          value: 'dont_go',
        },
        {
          type: 'select' as const,
          field: 'endTime' as const,
          key: 'pinned',
          value: { ms: NOW - 60_000, precision: 'minute' },
        },
      ].reduce(sheetReducer, r.sheet),
    }));
    expect(postRefusals(withHazard, NOW)).toEqual([]);
  });

  it('a body-less capture with no coord is a gap; with a coord it validates against the flush', () => {
    const post = filled(openPostSheet('page', {}, NOW, mint));
    expect(postRefusals(post, NOW)[0]?.gaps).toEqual(['body']);
    const located = updateReport(post, post.reports[0]?.id ?? '', (r) => ({
      ...r,
      coord: { lat: 44, lng: -72 },
    }));
    expect(postRefusals(located, NOW)).toEqual([]);
  });

  it('a week-old end time is refused with the window sentence; a future one too', () => {
    const post = filled(openPostSheet('body', { waterBodyId: 'wb1' }, NOW, mint));
    const old = updateReport(post, post.reports[0]?.id ?? '', (r) => ({
      ...r,
      sheet: sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'old',
        value: { ms: NOW - 8 * 24 * 3600e3, precision: 'half_hour' },
      }),
    }));
    expect(postRefusals(old, NOW)[0]?.message).toMatch(/up to a week/);
    const future = updateReport(post, post.reports[0]?.id ?? '', (r) => ({
      ...r,
      sheet: sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'future',
        value: { ms: NOW + 3 * 3600e3, precision: 'half_hour' },
      }),
    }));
    expect(postRefusals(future, NOW)[0]?.message).toMatch(/future/);
  });
});

describe('reportsInTimeOrder / sectionsFilled (A10-6)', () => {
  const NOW = Date.UTC(2026, 0, 10, 20);
  const mint = (() => {
    let n = 0;
    return () => `id${++n}`;
  })();
  const withEnd = (post: PostSheet, reportId: string, ms: number): PostSheet =>
    updateReport(post, reportId, (r) => ({
      ...r,
      sheet: sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'chosen',
        value: { ms, precision: 'minute' },
      }),
    }));

  it('sorts by end time, earliest first, and keeps untimed Reports after in their own order', () => {
    let post = openPostSheet('body', { waterBodyId: 'a', bodyName: 'A' }, NOW, mint);
    post = addLake(post, { waterBodyId: 'b', bodyName: 'B' }, NOW, mint);
    post = addLake(post, { waterBodyId: 'c', bodyName: 'C' }, NOW, mint);
    const [a, b, c] = post.reports as [SheetReport, SheetReport, SheetReport];
    post = withEnd(post, a.id, NOW - 3600_000);
    post = withEnd(post, c.id, NOW - 7200_000);
    expect(reportsInTimeOrder(post).map((r) => r.bodyName)).toEqual(['C', 'A', 'B']);
    expect(post.reports.map((r) => r.bodyName)).toEqual(['A', 'B', 'C']);
    expect(reportEndMs(b)).toBeUndefined();
  });

  it('counts the sections with something in them', () => {
    let post = openPostSheet('body', { waterBodyId: 'a', bodyName: 'A' }, NOW, mint);
    const first = post.reports[0] as SheetReport;
    expect(sectionsFilled(first.sheet)).toBe(0);
    post = withEnd(post, first.id, NOW - 60_000);
    post = updateReport(post, first.id, (r) => ({
      ...r,
      sheet: sheetReducer(r.sheet, {
        type: 'select',
        field: 'quality',
        key: 'good',
        value: 'good',
      }),
    }));
    expect(sectionsFilled((post.reports[0] as SheetReport).sheet)).toBe(2);
    expect(SHEET_SECTION_COUNT).toBe(10);
  });
});

describe('the photo pool (A10-7)', () => {
  const NOW = Date.UTC(2026, 0, 10, 20);
  const H = 3600_000;
  let n = 0;
  const mint = () => `p${++n}`;
  const crystal = { minLat: 43.63, maxLat: 43.65, minLng: -72.15, maxLng: -72.12 };
  const photo = (id: string, over: Partial<DraftPhoto> = {}): DraftPhoto => ({
    id,
    fullUri: `${id}:full`,
    thumbUri: `${id}:thumb`,
    placeOnMap: false,
    ...over,
  });
  const twoLakes = () => {
    let post = openPostSheet('body', { waterBodyId: 'c', bodyName: 'Crystal' }, NOW, mint);
    post = addLake(post, { waterBodyId: 'm', bodyName: 'Mascoma' }, NOW, mint);
    const [c, m] = post.reports as [SheetReport, SheetReport];
    const end = (p: PostSheet, id: string, ms: number, start?: number) =>
      updateReport(p, id, (r) => ({
        ...r,
        sheet: {
          ...sheetReducer(r.sheet, {
            type: 'select',
            field: 'endTime',
            key: 'chosen',
            value: { ms, precision: 'minute' },
          }),
          scalars: {
            ...r.sheet.scalars,
            ...(start !== undefined ? { skateStartTime: start } : {}),
          },
        },
      }));
    post = end(post, c.id, NOW, NOW - 2 * H);
    post = end(post, m.id, NOW - 4 * H, NOW - 5 * H);
    return { post, c, m };
  };

  it('adds photos where the day says, places the ones on the lake, pools the rest', () => {
    const { post, c, m } = twoLakes();
    const candidates = assignCandidates(post, { c: crystal });
    const next = addPostPhotos(
      post,
      [
        photo('a', { takenAtMs: NOW - H, coord: { lat: 43.64, lng: -72.13 } }),
        photo('b', { takenAtMs: NOW - 4.5 * H }),
        photo('lunch', { takenAtMs: NOW - 3 * H }),
        photo('nowhere'),
      ],
      candidates,
    );
    const onC = next.reports.find((r) => r.id === c.id)?.photos ?? [];
    const onM = next.reports.find((r) => r.id === m.id)?.photos ?? [];
    expect(onC.map((p) => [p.id, p.placeOnMap])).toEqual([['a', true]]);
    expect(onM.map((p) => p.id)).toEqual(['b']);
    expect(unassignedPhotos(next).map((p) => p.id)).toEqual(['lunch', 'nowhere']);
    expect(next.dirty).toBe(true);
    expect(photoCounts(next)).toEqual({ total: 4, assigned: 2 });
    // The pool is the Post's refusal, ahead of any Report's.
    expect(postRefusals(next, NOW)[0]).toMatchObject({
      reportId: '',
      message: expect.stringMatching(/2 photos aren't on a lake yet/),
    });
  });

  it('re-runs the rules quietly when a lake’s box arrives', () => {
    const { post, c } = twoLakes();
    const before = addPostPhotos(
      post,
      [photo('x', { coord: { lat: 43.64, lng: -72.13 } })],
      assignCandidates(post, {}),
    );
    expect(unassignedPhotos(before)).toHaveLength(1);
    const clean = { ...before, dirty: false };
    const after = reassignPool(clean, assignCandidates(clean, { c: crystal }));
    expect(unassignedPhotos(after)).toHaveLength(0);
    expect(after.reports.find((r) => r.id === c.id)?.photos[0]).toMatchObject({
      id: 'x',
      placeOnMap: true,
    });
    expect(after.dirty).toBe(false);
    expect(reassignPool(after, assignCandidates(after, { c: crystal }))).toBe(after);
  });

  it('the author says: this lake, the put-in, leave it out, place it here', () => {
    const { post, c, m } = twoLakes();
    let next = addPostPhotos(post, [photo('q')], assignCandidates(post, {}));
    next = movePhotoToReport(next, 'q', m.id, assignCandidates(next, {}));
    expect(findPhoto(next, 'q')?.reportId).toBe(m.id);
    expect(unassignedPhotos(next)).toHaveLength(0);
    next = sendPhotoToAccess(next, 'q', { kind: 'put_in', id: 'launch-1' });
    expect(findPhoto(next, 'q')?.reportId).toBeNull();
    expect(next.photos?.[0]?.attachTo).toEqual({ kind: 'put_in', id: 'launch-1' });
    expect(postRefusals(next, NOW).find((r) => r.reportId === '')).toBeUndefined();
    expect(photoCounts(next)).toEqual({ total: 1, assigned: 1 });
    next = movePhotoToReport(next, 'q', c.id, assignCandidates(next, {}));
    expect(findPhoto(next, 'q')?.photo.attachTo).toBeUndefined();
    next = placePhotoByHand(next, 'q', { lat: 43.64, lng: -72.13 });
    expect(findPhoto(next, 'q')?.photo).toMatchObject({
      coord: { lat: 43.64, lng: -72.13 },
      placeOnMap: true,
    });
    next = dropPhoto(next, 'q');
    expect(findPhoto(next, 'q')).toBeNull();
    expect(dropPhoto(next, 'q')).toBe(next);
  });

  it('carries the pool through the draft round trip', () => {
    const { post } = twoLakes();
    const withPool = addPostPhotos(post, [photo('z')], assignCandidates(post, {}));
    const draft = toPostDraft(withPool, 'draft', NOW);
    expect(draft.photos?.map((p) => p.id)).toEqual(['z']);
    const back = postSheetFromDraft(draft, NOW);
    expect(back?.photos?.map((p) => p.id)).toEqual(['z']);
    const empty = toPostDraft(post, 'draft', NOW);
    expect(empty.photos).toBeUndefined();
  });
});
