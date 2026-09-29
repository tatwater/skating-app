import { describe, expect, it } from 'vitest';
import {
  addLake,
  openPostSheet,
  type PostSheet,
  postSheetForEdit,
  type SheetReport,
  updateReport,
} from './postSheet';
import { selectedValues, sheetReducer } from './reportSheet';
import {
  photosEndSuggestion,
  shareLanding,
  shareReportFor,
  suggestEndFromPhotos,
} from './sharedPhotos';

const NOW = Date.UTC(2026, 0, 10, 20);
const H = 3_600_000;
let n = 0;
const mint = () => `s${++n}`;

function withEnd(post: PostSheet, id: string, ms: number, start?: number): PostSheet {
  return updateReport(post, id, (r) => ({
    ...r,
    sheet: {
      ...sheetReducer(r.sheet, {
        type: 'select',
        field: 'endTime',
        key: 'chosen',
        value: { ms, precision: 'minute' },
      }),
      scalars: { ...r.sheet.scalars, ...(start !== undefined ? { skateStartTime: start } : {}) },
    },
  }));
}

describe('shareLanding', () => {
  it('opens a new report when nothing is open, or the open sheet is untouched', () => {
    expect(shareLanding(null)).toBe('new');
    expect(shareLanding(openPostSheet('page', {}, NOW, mint))).toBe('new');
  });

  it('asks first when the open sheet has something in it', () => {
    const open = openPostSheet('page', {}, NOW, mint);
    expect(shareLanding({ ...open, dirty: true })).toBe('ask');
    expect(shareLanding({ ...open, door: 'draft' })).toBe('ask');
    const edit = postSheetForEdit(
      {
        reportId: 'r1',
        waterBodyId: 'wb',
        skateEndTime: NOW,
        iceTypes: [],
        surfaceTags: [],
        point: { lat: 43, lng: -72 },
        photoIds: [],
        hazardIds: [],
      },
      null,
      NOW,
      mint,
    );
    expect(shareLanding(edit)).toBe('ask');
  });
});

describe('shareReportFor', () => {
  const twoLakes = () => {
    let post = openPostSheet('body', { waterBodyId: 'c', bodyName: 'Crystal' }, NOW, mint);
    post = addLake(post, { waterBodyId: 'm', bodyName: 'Mascoma' }, NOW, mint);
    const [c, m] = post.reports as [SheetReport, SheetReport];
    post = withEnd(post, c.id, NOW, NOW - 2 * H);
    post = withEnd(post, m.id, NOW - 4 * H, NOW - 5 * H);
    return { post, c, m };
  };

  it('goes to the Report its time falls in, whichever tab is on screen', () => {
    const { post, c, m } = twoLakes();
    expect(shareReportFor(post, { takenAtMs: NOW - 4.5 * H }, c.id)).toBe(m.id);
    expect(shareReportFor(post, { takenAtMs: NOW - H }, m.id)).toBe(c.id);
  });

  it('goes to the tab on screen when its time says nothing', () => {
    const { post, m } = twoLakes();
    expect(shareReportFor(post, { takenAtMs: NOW - 3 * H }, m.id)).toBe(m.id);
    expect(shareReportFor(post, {}, m.id)).toBe(m.id);
  });

  it('falls back to the first Report when the tab is unknown', () => {
    const { post, c } = twoLakes();
    expect(shareReportFor(post, {}, 'gone')).toBe(c.id);
    expect(shareReportFor(post, {}, undefined)).toBe(c.id);
  });
});

describe('photosEndSuggestion', () => {
  it('suggests the latest capture, never a future one', () => {
    expect(photosEndSuggestion([{ takenAtMs: NOW - 2 * H }, { takenAtMs: NOW - H }, {}], NOW)).toBe(
      NOW - H,
    );
    expect(photosEndSuggestion([{ takenAtMs: NOW + H }, { takenAtMs: NOW - H }], NOW)).toBe(
      NOW - H,
    );
    expect(photosEndSuggestion([{}, { takenAtMs: Number.NaN }], NOW)).toBeUndefined();
  });
});

describe('suggestEndFromPhotos', () => {
  it('offers the time as a ghost — never selected, so never sent until tapped (D188)', () => {
    const post = openPostSheet('share', {}, NOW, mint);
    const sheet = suggestEndFromPhotos((post.reports[0] as SheetReport).sheet, NOW - H);
    const chip = sheet.fields.endTime.chips.find((c) => c.key === 'photos');
    expect(chip).toMatchObject({ tier: 'ghost', source: 'photos', value: { ms: NOW - H } });
    expect(selectedValues(sheet, 'endTime')).toEqual([]);
    // A tap makes it the end.
    const tapped = sheetReducer(sheet, { type: 'select', field: 'endTime', key: 'photos' });
    expect(selectedValues(tapped, 'endTime')[0]?.ms).toBe(NOW - H);
  });
});
