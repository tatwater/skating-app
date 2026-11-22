import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { photoDialogWords } from './FlagActions';
import { BOARD_ZONE } from './flagFixtures';
import { subjectOf, verbGroups } from './flagModel';
import type { LiveTarget } from './flagTypes';
import {
  KATE_AUTHOR,
  PHOTO_HIDDEN,
  PHOTO_ITEM,
  PHOTO_MAX,
  PHOTO_NO_ACCESS,
  PHOTO_NO_FILE,
  PHOTO_OFF_REPORT,
  PHOTO_PURGED,
  PHOTO_REMOVED,
  PHOTO_THIRD,
  photoItem,
  photoOf,
  reportPhotos,
} from './photoFixtures';
import {
  captionLine,
  photoStatus,
  photoViewOf,
  placeOnReport,
  purgeLine,
  siblingsCutLine,
  siblingViews,
  stageState,
} from './photoModel';
import { PHOTO_WORDS } from './photoWords';
import { photoReceiptLine } from './useFlagWrites';

type PhotoTarget = Extract<LiveTarget, { targetType: 'photo' }>;
const targetOf = (item: typeof PHOTO_ITEM) => item.target as PhotoTarget;
const viewOf = (item: typeof PHOTO_ITEM) => photoViewOf(targetOf(item));

describe('what the stage may draw', () => {
  it('draws the photo only when the server says the viewer may see it', () => {
    expect(stageState(viewOf(PHOTO_THIRD))).toMatchObject({ kind: 'stage' });
    // An address served without the server's word is never painted.
    const leaked = photoOf(0, reportPhotos(2), { canReveal: false });
    expect(leaked.url).not.toBeNull();
    expect(stageState(leaked)).toEqual({ kind: 'noAccess' });
    // The seam's field absent (the read not yet wired): the conservative answer.
    const { canReveal: _, ...unwired } = photoOf(0, reportPhotos(2));
    expect(stageState(unwired)).toEqual({ kind: 'noAccess' });
  });

  it('a viewer without content.read: no image, in words', () => {
    expect(stageState(viewOf(PHOTO_NO_ACCESS))).toEqual({ kind: 'noAccess' });
  });

  it('a missing file is said, not drawn broken', () => {
    expect(stageState(viewOf(PHOTO_NO_FILE))).toEqual({ kind: 'noFile' });
  });

  it('a purged photo is a tombstone, whatever else it says', () => {
    const view = viewOf(PHOTO_PURGED);
    expect(stageState(view)).toEqual({
      kind: 'purged',
      purgedAt: view.purgedAt,
      removedAt: view.moderatedAt,
    });
    // Even were an address still served, a purged photo draws none.
    expect(stageState({ ...view, url: 'u', thumbUrl: 't', canReveal: true }).kind).toBe('purged');
  });

  it('the stage reveals the full address and pixelates the thumbnail, never swapped', () => {
    const v = viewOf(PHOTO_THIRD);
    expect(stageState(v)).toEqual({ kind: 'stage', thumb: v.thumbUrl, full: v.url });
    expect(v.thumbUrl).not.toBe(v.url);
  });
});

describe('the photo on its report', () => {
  it('finds the flagged photo by its id, not its place in the list', () => {
    const views = siblingViews(viewOf(PHOTO_THIRD));
    expect(views.map((v) => v.self)).toEqual([false, false, true, false]);
    expect(views.find((v) => v.self)?.photoId).toBe(targetOf(PHOTO_THIRD).targetId);
    expect(views.find((v) => v.self)?.label).toBe('Flagged');
    expect(views.filter((v) => !v.self).every((v) => v.label === null)).toBe(true);
  });

  it('labels a moderated sibling by its axis', () => {
    const views = siblingViews(viewOf(PHOTO_MAX));
    expect(views).toHaveLength(24);
    expect(views[1]?.label).toBe('Hidden');
    expect(views[2]?.label).toBe('Removed');
    expect(views[4]?.label).toBeNull();
    expect(views[6]).toMatchObject({ self: true, label: 'Flagged', n: 7 });
  });

  it('a photo alone on its report, or on none, has no list', () => {
    expect(siblingViews(viewOf(PHOTO_OFF_REPORT))).toEqual([]);
    expect(siblingViews(photoOf(0, reportPhotos(1)))).toEqual([]);
    expect(placeOnReport(viewOf(PHOTO_OFF_REPORT))).toBeNull();
  });

  it('says its place, as a floor when the list was cut', () => {
    expect(placeOnReport(viewOf(PHOTO_ITEM))).toBe('1 of 4 on the report');
    expect(placeOnReport(viewOf(PHOTO_THIRD))).toBe('3 of 4 on the report');
    expect(placeOnReport(viewOf(PHOTO_MAX))).toBe('7 of 24+ on the report');
    expect(siblingsCutLine(viewOf(PHOTO_MAX))).toBe('Showing 24 of 24+ photos');
    expect(siblingsCutLine(viewOf(PHOTO_THIRD))).toBeNull();
  });

  it('marks exactly the flagged photo, wherever it sits (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 30 }).chain((n) => fc.tuple(fc.constant(n), fc.nat(n - 1))),
        ([n, i]) => {
          const views = siblingViews(photoOf(i, reportPhotos(n)));
          const selves = views.filter((v) => v.self);
          expect(selves).toHaveLength(1);
          expect(selves[0]?.n).toBe(i + 1);
          expect(placeOnReport(photoOf(i, reportPhotos(n)))).toBe(`${i + 1} of ${n} on the report`);
        },
      ),
    );
  });

  it('captions when it was taken, and where', () => {
    expect(captionLine(viewOf(PHOTO_ITEM), BOARD_ZONE)).toBe('11 Oct 14:22 · Crystal Lake');
    expect(captionLine(viewOf(PHOTO_OFF_REPORT), BOARD_ZONE)).toBe('11 Oct 14:22');
  });
});

describe('the photo’s state', () => {
  it('reads its own axis, else the target’s', () => {
    expect(photoStatus(viewOf(PHOTO_HIDDEN), targetOf(PHOTO_HIDDEN))).toBe('hidden');
    const { moderationStatus: _, ...bare } = viewOf(PHOTO_HIDDEN);
    expect(photoStatus(bare, { moderationStatus: 'removed' })).toBe('removed');
    expect(photoStatus(bare, { moderationStatus: null })).toBe('visible');
  });

  it('a removal says its deletion day, only while it waits', () => {
    expect(purgeLine(viewOf(PHOTO_REMOVED), 'removed', BOARD_ZONE)).toBe(
      'Its file is deleted on 12 Nov unless it is restored',
    );
    expect(purgeLine(viewOf(PHOTO_PURGED), 'removed', BOARD_ZONE)).toBeNull();
    expect(purgeLine(viewOf(PHOTO_HIDDEN), 'hidden', BOARD_ZONE)).toBeNull();
  });
});

describe('the bar and its words', () => {
  it('2.7’s order: Photo (Hide, Remove), then Flag (Dismiss)', () => {
    expect(verbGroups(PHOTO_ITEM).map((g) => [g.label, g.verbs])).toEqual([
      ['Photo', ['hide', 'remove']],
      ['Flag', ['dismiss']],
    ]);
  });

  it('a photo already down offers Restore in their place; a purged one, Dismiss only', () => {
    expect(verbGroups(PHOTO_HIDDEN).map((g) => g.verbs)).toEqual([['restore'], ['dismiss']]);
    expect(verbGroups(PHOTO_PURGED).map((g) => g.verbs)).toEqual([['dismiss']]);
  });

  it('every lever from can alone', () => {
    expect(verbGroups({ ...PHOTO_ITEM, can: { remove: null } }).map((g) => g.verbs)).toEqual([
      ['remove'],
    ]);
    expect(verbGroups({ ...PHOTO_ITEM, can: { hide: 'No', remove: 'No', dismiss: 'No' } })).toEqual(
      [],
    );
  });

  it('a receipt names the body, else “A photo” — never the uploader', () => {
    expect(subjectOf(PHOTO_ITEM)).toBe('Crystal Lake');
    expect(subjectOf(PHOTO_OFF_REPORT)).toBe('A photo');
    const gone = photoItem(photoOf(0, reportPhotos(2)), {
      target: { targetType: 'photo', targetId: 'ph_gone', exists: false },
      author: KATE_AUTHOR,
    });
    expect(subjectOf(gone)).toBe('A photo');
  });

  it('a takedown says: off its link now, shown to no one, a device that opened it may keep it', () => {
    for (const verb of ['hide', 'remove'] as const) {
      const { body } = photoDialogWords(verb);
      expect(body).toContain('It comes off its link now and is shown to no one.');
      expect(body).toContain('may still see it on their own device for up to 30 days');
      expect(body).toContain('Closes every open flag on it');
    }
    expect(photoDialogWords('hide').body).toContain('You can restore it at any time.');
    expect(photoDialogWords('remove').body).toContain(
      'It is deleted for good in 30 days unless it is restored before then.',
    );
    expect(photoDialogWords('hide').title).toBe('Hide this photo?');
    expect(photoDialogWords('remove').title).toBe('Remove this photo?');
  });

  it('each write’s receipt says what it did to the photo, and only for a photo', () => {
    const hide = { kind: 'takeDown', status: 'hidden', reason: 'r' } as const;
    const remove = { kind: 'takeDown', status: 'removed', reason: 'r' } as const;
    expect(photoReceiptLine(PHOTO_ITEM, hide)).toBe(
      'Off its link and shown to no one; restorable at any time',
    );
    expect(photoReceiptLine(PHOTO_ITEM, remove)).toContain('deleted for good in 30 days');
    expect(photoReceiptLine(PHOTO_HIDDEN, { kind: 'restore' })).toBe(
      'Shown again where it was attached',
    );
    expect(photoReceiptLine(PHOTO_ITEM, { kind: 'dismiss' })).toBeNull();
  });
});

/**
 * Every word a photo shows before its removal's 30 days are up: none may claim the photo can no
 * longer be seen by anyone, is gone from everywhere, or is erased or deleted already — a device that
 * opened it may keep a copy (the dev proof), and its file is deleted only on the clock. The purge's own
 * words (`purged`, `purgedSub`) are after the fact, and are left out.
 */
describe('no word claims the photo is unreachable or erased before its purge', () => {
  const strings = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : typeof v === 'function'
        ? strings((v as (...a: unknown[]) => unknown)('12 Nov', '10 Sep'))
        : v !== null && typeof v === 'object'
          ? Object.values(v).flatMap(strings)
          : [];
  const { purged: _a, purgedSub: _b, ...beforePurge } = PHOTO_WORDS;
  const said = [
    ...strings(beforePurge),
    ...(['hide', 'remove'] as const).map((v) => photoDialogWords(v).body),
  ];
  const CLAIMS = [
    /\bgone\b/i,
    /everywhere/i,
    /no one can/i,
    /nobody can/i,
    /can(no|’)t be (seen|opened)/i,
    /unreachable/i,
    /\berased\b/i,
    /\bdeleted (now|at once|immediately)\b/i,
    /\bpermanently\b/i,
    /stops? working/i,
    /\baddress\b/i,
    /\bcache\b/i,
    /\bblob\b/i,
    /\bCDN\b/,
  ];

  it.each(CLAIMS.map((c) => [String(c), c] as const))('none says %s', (_, claim) => {
    expect(said.filter((w) => claim.test(w))).toEqual([]);
  });

  it('a removal’s deletion is always conditional on no restore, and in the future', () => {
    const deletes = said.filter((w) => /delete/i.test(w));
    expect(deletes.length).toBeGreaterThan(0);
    for (const w of deletes) expect(w).toMatch(/unless (it is )?restored/);
  });
});
