import {
  emptySheet,
  openPostSheet,
  type PostSheet,
  type ReportRefusal,
  SHEET_SECTIONS,
  sheetReducer,
} from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  ago,
  defaultFold,
  gapsFor,
  meterCells,
  meterLabel,
  missingCount,
  OPEN_BY_DEFAULT,
  openGaps,
  refusalMessage,
  removeLake,
  savedState,
  setReportBody,
} from './sheetModel';

let seq = 0;
const mint = () => `m-${++seq}`;
const NOW = Date.UTC(2027, 0, 16, 16, 52);

const refusals: ReportRefusal[] = [
  {
    reportId: 'a',
    bodyName: 'Mascoma Lake',
    gaps: ['howWasIt', 'observation'],
    message: 'Add how it was.',
  },
  { reportId: 'a', gaps: ['body'], message: 'Pick the lake.' },
  { reportId: '', gaps: [], message: 'Say where 2 photos are from.' },
];

describe('refusals', () => {
  it('mark the sections a Report needs, and nothing for the lake or the pool', () => {
    expect([...gapsFor(refusals, 'a')].sort()).toEqual(['howWasIt', 'iceAndSurface']);
    expect(gapsFor(refusals, 'b').size).toBe(0);
  });

  it('count every gap, and one for a refusal with none', () => {
    expect(missingCount(refusals)).toBe(4);
    expect(missingCount([])).toBe(0);
  });

  it('name the lake only when the Post has several', () => {
    expect(refusalMessage(refusals, 1)).toBe('Add how it was.');
    expect(refusalMessage(refusals, 2)).toBe('Mascoma Lake: Add how it was.');
    expect(refusalMessage([refusals[1] as ReportRefusal], 2)).toBe('Pick the lake.');
    expect(refusalMessage([], 1)).toBe('');
  });
});

describe('the meter', () => {
  it('lights what is answered, then what a refusal needs, within ten', () => {
    expect(meterCells(3, 2)).toEqual([
      'on',
      'on',
      'on',
      'need',
      'need',
      'off',
      'off',
      'off',
      'off',
      'off',
    ]);
    expect(meterCells(12, 3).every((c) => c === 'on')).toBe(true);
    expect(meterCells(-1, -1).every((c) => c === 'off')).toBe(true);
    expect(meterCells(9, 5).filter((c) => c === 'need')).toHaveLength(1);
  });

  it('counts, and never says ready (D3)', () => {
    for (let n = 0; n <= 10; n++) {
      expect(meterLabel(n)).toBe(`${n} of 10 questions answered`);
      expect(meterLabel(n)).not.toMatch(/ready|safe|good to go/i);
    }
  });
});

describe('the fold', () => {
  it('keeps the minimum-set questions open and folds the rest, once', () => {
    const sheet = emptySheet(NOW, 'b1');
    const folded = defaultFold(sheet);
    for (const s of SHEET_SECTIONS) expect(folded?.collapsed[s]).toBe(!OPEN_BY_DEFAULT.has(s));
    expect(defaultFold(folded ?? sheet)).toBeNull();
  });

  it('opens what a refusal needs, and leaves an open sheet as it is', () => {
    const folded = defaultFold(emptySheet(NOW, 'b1')) ?? emptySheet(NOW);
    const opened = openGaps(folded, new Set(['endTime']));
    expect(opened.collapsed.endTime).toBe(false);
    expect(opened.collapsed.snow).toBe(true);
    expect(openGaps(opened, new Set(['endTime']))).toBe(opened);
  });
});

describe('lakes', () => {
  it('sets a Report’s lake through the reducer', () => {
    const post = openPostSheet('page', {}, NOW, mint);
    const id = post.reports[0]?.id ?? '';
    const next = setReportBody(post, id, { waterBodyId: 'b1', name: 'Mascoma Lake' });
    expect(next.reports[0]?.bodyName).toBe('Mascoma Lake');
    expect(next.reports[0]?.sheet.waterBodyId).toBe('b1');
    expect(next.dirty).toBe(true);
  });

  it('removes one of several lakes, and starts the only one over with its photos', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Mascoma Lake' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    const photo = { id: 'ph1', fullUri: 'f', thumbUri: 't', placeOnMap: false };
    const answered = {
      ...post,
      reports: [
        {
          ...first,
          photos: [photo],
          sheet: sheetReducer(first.sheet, {
            type: 'select',
            field: 'quality',
            key: 'good',
            value: 'good',
          }),
        },
      ],
    };
    const restarted = removeLake(answered, first.id, NOW, mint);
    expect(restarted.reports).toHaveLength(1);
    expect(restarted.reports[0]?.sheet.waterBodyId).toBeUndefined();
    expect(restarted.reports[0]?.photos).toEqual([photo]);
    expect(restarted.reports[0]?.sheet.fields.quality.chips).toEqual([]);
    expect(restarted.dirty).toBe(true);

    const two = {
      ...answered,
      reports: [...answered.reports, { ...first, id: 'second', photos: [] }],
    };
    const one = removeLake(two, 'second', NOW, mint);
    expect(one.reports.map((r) => r.id)).toEqual([first.id]);
    expect(one.photos).toBe(two.photos);
    expect(removeLake(answered, 'missing', NOW, mint)).toBe(answered);
    expect(removeLake(two, 'missing', NOW, mint)).toBe(two);
  });

  it('keeps a removed lake’s photos in the pool when other lakes stay, un-placed', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Mascoma Lake' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    const pinned = {
      id: 'ph1',
      fullUri: 'f1',
      thumbUri: 't1',
      coord: { lat: 43.6, lng: -72.1 },
      placeOnMap: true,
    };
    const loose = { id: 'ph2', fullUri: 'f2', thumbUri: 't2', placeOnMap: false };
    const pooled = { id: 'ph0', fullUri: 'f0', thumbUri: 't0', placeOnMap: false };
    const two: PostSheet = {
      ...post,
      photos: [pooled],
      reports: [first, { ...first, id: 'second', photos: [pinned, loose] }],
    };
    const one = removeLake(two, 'second', NOW, mint);
    expect(one.reports.map((r) => r.id)).toEqual([first.id]);
    expect(one.photos).toEqual([pooled, { ...pinned, placeOnMap: false }, loose]);
    expect(one.dirty).toBe(true);
    // A sheet from before the pool gets one.
    const { photos: _none, ...prePool } = two;
    expect(removeLake(prePool, 'second', NOW, mint).photos).toEqual([
      { ...pinned, placeOnMap: false },
      loose,
    ]);
  });

  it('un-places the only lake’s photos when it goes, so a re-pick never posts the old pins', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Mascoma Lake' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    const pinned = {
      id: 'ph1',
      fullUri: 'f',
      thumbUri: 't',
      coord: { lat: 43.6, lng: -72.1 },
      placeOnMap: true,
    };
    const placed = { ...post, reports: [{ ...first, photos: [pinned] }] };
    const restarted = removeLake(placed, first.id, NOW, mint);
    const id = restarted.reports[0]?.id ?? '';
    expect(restarted.reports[0]?.photos).toEqual([{ ...pinned, placeOnMap: false }]);
    const repicked = setReportBody(restarted, id, { waterBodyId: 'b2', name: 'Morey Pond' });
    expect(repicked.reports[0]?.photos.every((ph) => !ph.placeOnMap)).toBe(true);
  });

  it('un-places a Report’s photos when its lake changes, and keeps them on a re-pick of the same', () => {
    const post = openPostSheet('body', { waterBodyId: 'b1', bodyName: 'Mascoma Lake' }, NOW, mint);
    const first = post.reports[0];
    if (first === undefined) throw new Error('no report');
    const pinned = { id: 'ph1', fullUri: 'f', thumbUri: 't', placeOnMap: true };
    const placed = { ...post, reports: [{ ...first, photos: [pinned] }] };
    const same = setReportBody(placed, first.id, { waterBodyId: 'b1', name: 'Mascoma Lake' });
    expect(same.reports[0]?.photos).toEqual([pinned]);
    const other = setReportBody(placed, first.id, { waterBodyId: 'b2', name: 'Morey Pond' });
    expect(other.reports[0]?.photos).toEqual([{ ...pinned, placeOnMap: false }]);
  });
});

describe('the status line', () => {
  it('says what is kept where, and never claims more', () => {
    expect(savedState({ editing: true, persistedAt: 1, online: true, now: NOW })).toEqual({
      tone: 'hollow',
      text: 'Editing the published report',
    });
    expect(savedState({ editing: false, persistedAt: null, online: true, now: NOW }).text).toBe(
      'Not saved yet',
    );
    expect(savedState({ editing: false, persistedAt: NOW, online: false, now: NOW })).toEqual({
      tone: 'warn',
      text: 'Offline · saved on this device',
    });
    expect(savedState({ editing: false, persistedAt: NOW, online: true, now: NOW }).text).toBe(
      'Saved on this device · just now',
    );
  });

  it('ages in words', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(NOW - 60_000, NOW)).toBe('1 min ago');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(ago(NOW - 60 * 60_000, NOW)).toBe('1 hr ago');
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe('3 hr ago');
    expect(ago(NOW + 5000, NOW)).toBe('just now');
  });
});
