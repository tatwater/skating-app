import type { Id, TableNames } from '@skating/convex/dataModel';

import { at, KATE, SARAH } from './flagFixtures';
import type { AuthorBlockData, FlagItem, FlagMember, InboxWriteResultData } from './flagTypes';
import type { PhotoView } from './photoModel';
import { fixtureReveal } from './photoRevealContext';

/**
 * **Board 2.7 (Content flags · Photo), as data**, and every state no board draws: a photo already
 * hidden, removed inside its 30 days, purged to a tombstone; a viewer who can't see photos; a missing
 * file; a report with the most photos and a list the read cut short; a photo on no report; an
 * uploader who has left. Stories and tests only.
 *
 * **As `inbox.item` serves it** (S5's photo subject): the thumbnail only — each full image lives in
 * {@link PHOTO_FULL}, answered by the stories' reveal ({@link PHOTO_REVEAL}) as `inbox.photoReveal`
 * would, so a test can prove the full address is nowhere in the item's data before Show; the
 * report's *other* photos as siblings (never the flagged one), at most twelve, with `photoCount`.
 *
 * **The staged photo is not always the report's first**: the wiring test's photo is the third of
 * four, so a lever that sent the first photo's id, or a stage that drew the first thumbnail, fails.
 */

const id = <T extends TableNames>(s: string) => s as Id<T>;

// ── The images: generated scenes, never a real person ───────────────────────────────────────────

/**
 * A stand-in photo as an SVG data address: a shore under a gray sky, warm shapes where the board's
 * figures stand. `full` and `thumb` are distinct addresses (a test tells them apart), and `seed`
 * varies the scene so each photo of a report differs.
 */
export function scene(seed: number, size: 'full' | 'thumb'): string {
  const w = size === 'full' ? 1600 : 400;
  const h = size === 'full' ? 1000 : 250;
  const shift = (seed * 37) % 24;
  const warm = [0.36, 0.5, 0.62]
    .map(
      (x, i) =>
        `<ellipse cx="${(x + ((seed + i) % 3) * 0.03) * w}" cy="${(0.44 + i * 0.03) * h}" rx="${0.05 * w}" ry="${0.11 * h}" fill="rgb(${150 + i * 8},${112 + shift / 2},${88 + i * 5})"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><!--${size}-${seed}--><rect width="${w}" height="${h * 0.32}" fill="rgb(${84 + shift},${88 + shift},${92 + shift})"/><rect y="${h * 0.32}" width="${w}" height="${h * 0.2}" fill="rgb(62,66,70)"/><rect y="${h * 0.52}" width="${w}" height="${h * 0.48}" fill="rgb(${42 + shift / 3},${46 + shift / 3},${48 + shift / 3})"/>${warm}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ── The body, the uploader, the flag ───────────────────────────────────────────────────────────

export const CRYSTAL = {
  waterBodyId: id<'waterBodies'>('wb_crystal'),
  name: 'Crystal Lake',
  place: 'Enfield, NH',
  type: 'lakePond' as const,
  areaSqM: 1_300_000,
  removed: false,
  point: { lat: 43.6, lng: -72.12 },
};

/** Board 2.7's uploader: Kate Donovan, good standing, 9 reports, trusted at 22 points. */
export const KATE_AUTHOR: AuthorBlockData = {
  person: KATE,
  standing: { status: 'active', until: null, by: null },
  reports: { count: 9, capped: false },
  contradicted: { count: 0, capped: false },
  contradictedReports: [],
  priorActioned: { count: 0, capped: false, lastAt: null },
  openFlags: { count: 1, capped: false },
  restrictions: [],
};

/** Board 2.7's flag: Sarah, two hours before the boards' noon. */
export const PHOTO_FLAG: FlagMember = {
  flagId: id<'contentFlags'>('f_photo'),
  reason: 'inappropriate',
  note: 'Kids’ faces, close up. Parents might not want this public.',
  filedAt: at(10, 14, 10),
  status: 'open',
  filer: SARAH,
  autoFiled: false,
  occurrences: 1,
  lastOccurrenceAt: null,
  prior: null,
};

// ── The photo ──────────────────────────────────────────────────────────────────────────────────

const REPORT = id<'reports'>('r_crystal');

/** One of a report's photos, as its fixture holds it before the read picks the strip. */
export type ReportPhoto = {
  photoId: Id<'photos'>;
  thumbUrl: string | null;
  moderationStatus: PhotoView['moderationStatus'];
  openFlagId: Id<'contentFlags'> | null;
};

/** A report's photos, `n` of them, ids `ph_1`…; each its own scene. */
export const reportPhotos = (n: number, over: (i: number) => Partial<ReportPhoto> = () => ({})) =>
  Array.from(
    { length: n },
    (_, i): ReportPhoto => ({
      photoId: id<'photos'>(`ph_${i + 1}`),
      thumbUrl: scene(i + 1, 'thumb'),
      moderationStatus: 'visible',
      openFlagId: null,
      ...over(i),
    }),
  );

/** Every fixture photo's full image, by id — what `inbox.photoReveal` answers, never in the item. */
export const PHOTO_FULL: Readonly<Record<string, string>> = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [`ph_${i + 1}`, scene(i + 1, 'full')]),
);

/** The stories' reveal: each photo's full image from {@link PHOTO_FULL}, on Show only. */
export const PHOTO_REVEAL = fixtureReveal(PHOTO_FULL);

/** The read's strip bound (`PHOTO_SIBLINGS_READ`). */
const STRIP = 12;

/** The photo `index` (0-based) of the report's `photos`, as the subject's view serves it. */
export function photoOf(
  index: number,
  photos: ReportPhoto[],
  over: Partial<PhotoView> = {},
): PhotoView {
  const self = photos[index];
  if (self === undefined) throw new Error(`no photo ${index}`);
  const others = photos.filter((_, i) => i !== index);
  return {
    photoId: self.photoId,
    caption: null,
    takenAt: at(10, 11, 14, 22),
    createdAt: at(10, 11, 15, 2),
    thumbUrl: self.thumbUrl,
    reportId: REPORT,
    body: CRYSTAL,
    siblings: others.slice(0, STRIP),
    siblingsCut: others.length > STRIP,
    indexOnReport: index,
    photoCount: photos.length,
    moderationStatus: 'visible',
    moderatedAt: null,
    canReveal: true,
    withdrawnAt: null,
    purgeAt: null,
    purgedAt: null,
    bytesMissingAt: null,
    ...over,
  };
}

/**
 * The server's own sentences, as its rule answers each state (`lib/inboxRules`, `lib/recordRules`):
 * every fixture's `can` is what the server would serve for that state and viewer, never a lever it
 * doesn't offer.
 */
export const AUTHOR_DELETED_RESTORE = 'Its author deleted this, so it can’t be restored.';
export const ERASED_ALREADY = 'This was erased, so there is nothing left to act on.';
export const DECIDED = 'This has already been decided.';
export const OWN_CONTENT = 'This is yours, so another moderator decides on it.';
export const NEEDS_MODERATOR = 'Requires moderator role';

/** Every flag verb a visible photo offers (2.7's bar). */
export const PHOTO_CAN = { hide: null, remove: null, dismiss: null } as const;

/** A flag item on `photo`. */
export function photoItem(photo: PhotoView, over: Partial<FlagItem> = {}): FlagItem {
  const status = photo.moderationStatus;
  return {
    itemId: id<'inboxItems'>(`i_${photo.photoId}`),
    kind: 'flag',
    lane: 'flags',
    facet: 'photos',
    memberCount: 1,
    memberCountIsFloor: false,
    flagsCut: false,
    canCode: {},
    decided: null,
    filedAt: PHOTO_FLAG.filedAt,
    lastActivityAt: PHOTO_FLAG.filedAt,
    can: status === 'visible' ? PHOTO_CAN : { restore: null, dismiss: null },
    target: {
      targetType: 'photo',
      targetId: photo.photoId,
      exists: true,
      withdrawnAt: null,
      withdrawal: null,
      summary: 'A photo on a Crystal Lake report',
      moderationStatus: status,
      photo,
    },
    flags: [PHOTO_FLAG],
    author: KATE_AUTHOR,
    ...over,
  } as FlagItem;
}

const FOUR = reportPhotos(4);

/** Board 2.7: the first of four on Kate's Crystal Lake report, pixelated. */
export const PHOTO_ITEM = photoItem(photoOf(0, FOUR));

/**
 * The third of four, flagged: the wiring test's photo. Its id is not the first's, and its thumbnail
 * is not the first thumbnail.
 */
export const PHOTO_THIRD = photoItem(photoOf(2, FOUR), {
  itemId: id<'inboxItems'>('i_photo_third'),
});

/**
 * The third of four, its neighbors mixed: the first flagged on its own (still up), the second hidden,
 * the fourth up with no flag — so Show reveals the third and the fourth only.
 */
export const PHOTO_MIXED = photoItem(
  photoOf(
    2,
    reportPhotos(4, (i) =>
      i === 0
        ? { openFlagId: id<'contentFlags'>('f_ph_1_own') }
        : i === 1
          ? { moderationStatus: 'hidden' }
          : {},
    ),
  ),
  { itemId: id<'inboxItems'>('i_photo_mixed') },
);

/** Hidden elsewhere before this flag was read: Restore is what the bar offers. */
export const PHOTO_HIDDEN = photoItem(
  photoOf(2, FOUR, { moderationStatus: 'hidden', moderatedAt: at(10, 13, 9) }),
);

/** Removed, its file deleted on 12 Nov unless restored. */
export const PHOTO_REMOVED = photoItem(
  photoOf(2, FOUR, {
    moderationStatus: 'removed',
    moderatedAt: at(10, 13, 9),
    purgeAt: at(11, 12, 9),
  }),
);

/**
 * Hidden, and its rotation found the file gone (`bytesMissingAt`): nothing to show, and the server
 * refuses a restore — Dismiss is all the bar offers.
 */
export const PHOTO_BYTES_MISSING = photoItem(
  photoOf(2, FOUR, {
    moderationStatus: 'hidden',
    moderatedAt: at(10, 13, 9),
    bytesMissingAt: at(10, 13, 9, 2),
    thumbUrl: null,
  }),
  // Its rotation found it missing: the record reads it erased, so a restore is refused.
  { itemId: id<'inboxItems'>('i_photo_missing'), can: { dismiss: null, restore: ERASED_ALREADY } },
);

/** Removed, and its file deleted on the clock: a tombstone, no image to anyone. */
export const PHOTO_PURGED = photoItem(
  photoOf(2, FOUR, {
    moderationStatus: 'removed',
    moderatedAt: at(9, 10, 9),
    purgeAt: at(10, 10, 9),
    purgedAt: at(10, 10, 9, 30),
    thumbUrl: null,
  }),
  // A tombstone reads erased: a restore is refused.
  { can: { dismiss: null, restore: ERASED_ALREADY } },
);

/**
 * A viewer without `content.read`: the server serves no address, for the photo or its report's
 * others, and says it can't be revealed. Every flag verb needs a moderator's capability too
 * (`inbox.flag`, `content.moderate`, all moderator-level), so the server refuses each: no bar.
 */
export const PHOTO_NO_ACCESS = photoItem(
  photoOf(
    2,
    reportPhotos(4, () => ({ thumbUrl: null })),
    { canReveal: false, thumbUrl: null },
  ),
  { can: { dismiss: NEEDS_MODERATOR, hide: NEEDS_MODERATOR, remove: NEEDS_MODERATOR } },
);

/** The viewer may see it, but no file was served (the blob is gone). */
export const PHOTO_NO_FILE = photoItem(photoOf(2, FOUR, { thumbUrl: null }));

/**
 * A busy report: 24 photos (reports have no photo cap of their own), the strip cut at the read's
 * twelve others, most of them moderated, two with open flags of their own, the flagged one the
 * seventh.
 */
export const PHOTO_MAX = photoItem(
  photoOf(
    6,
    reportPhotos(24, (i) => ({
      moderationStatus:
        i === 6 ? 'visible' : i % 4 === 0 ? 'visible' : i % 2 ? 'hidden' : 'removed',
      openFlagId: i === 1 || i === 9 ? id<'contentFlags'>(`f_ph_${i + 1}`) : null,
    })),
  ),
  { itemId: id<'inboxItems'>('i_photo_max') },
);

/** Its uploader deleted it while this flag held it: kept out of sight, still decided here. */
export const PHOTO_WITHDRAWN = photoItem(
  photoOf(2, FOUR, {
    moderationStatus: 'removed',
    moderatedAt: at(10, 14, 11),
    withdrawnAt: at(10, 14, 11),
    purgeAt: at(11, 13, 11),
  }),
  // Its author deleted it: the server refuses a restore (the bar offers Dismiss alone).
  {
    itemId: id<'inboxItems'>('i_photo_withdrawn'),
    can: { restore: AUTHOR_DELETED_RESTORE, dismiss: null },
  },
);

/** A photo on no report (a hazard's): no *On the same report*, no place on one. */
export const PHOTO_OFF_REPORT = photoItem(
  photoOf(0, reportPhotos(1), {
    reportId: null,
    body: null,
    indexOnReport: null,
    photoCount: null,
    siblings: [],
    caption: 'Pressure ridge off the point',
  }),
);

/** The uploader has left: never named, no author menu. */
export const PHOTO_UPLOADER_GONE = photoItem(photoOf(2, FOUR), {
  author: {
    ...KATE_AUTHOR,
    person: { ...KATE, displayName: '', username: '', deleted: true },
  },
});

/** Decided by a colleague while it was open: the frame drops the bar. */
export const PHOTO_DECIDED = photoItem(photoOf(2, FOUR), {
  // A decided item: the server refuses every verb in one sentence (the frame drops the bar).
  can: { dismiss: DECIDED, hide: DECIDED, remove: DECIDED },
  decided: {
    at: at(10, 14, 11, 42),
    by: { userId: SARAH.userId, displayName: SARAH.displayName },
    decision: 'actioned',
    actionId: id<'moderationActions'>('a_sarah_photo'),
    byMe: false,
  },
});

/** The viewer's own photo (D269): every verb refused, no bar. */
export const PHOTO_OWN = photoItem(photoOf(2, FOUR), {
  can: {
    dismiss: OWN_CONTENT,
    hide: OWN_CONTENT,
    remove: OWN_CONTENT,
  },
});

/** A takedown that lands, undoable. */
export const PHOTO_LANDED: InboxWriteResultData = {
  itemId: PHOTO_THIRD.itemId,
  actionId: id<'moderationActions'>('a_photo'),
  flagsClosed: 1,
  undoable: true,
  undoNeedsReason: false,
};
