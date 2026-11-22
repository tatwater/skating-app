import type { Id, TableNames } from '@skating/convex/dataModel';

import { at, KATE, SARAH } from './flagFixtures';
import type { AuthorBlockData, FlagItem, FlagMember, InboxWriteResultData } from './flagTypes';
import type { PhotoSibling, PhotoStaffFields, PhotoSubjectData } from './photoModel';

/**
 * **Board 2.7 (Content flags · Photo), as data**, and every state no board draws: a photo already
 * hidden, removed inside its 30 days, purged to a tombstone; a viewer who can't see photos; a missing
 * file; a report with the most photos and a list the read cut short; a photo on no report; an
 * uploader who has left. Stories and tests only.
 *
 * **Built on the seam's fields** (`moderationStatus`, `canReveal`, `moderatedAt`, `purgeAt`,
 * `purgedAt`, `siblingsCut`, a sibling's `moderationStatus`): the read doesn't serve them yet, so the
 * fixtures carry them past its type (`photoTarget`). The integrator wires the real read.
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
  const shift = (seed * 37) % 60;
  const warm = [0.36, 0.5, 0.62]
    .map(
      (x, i) =>
        `<ellipse cx="${(x + ((seed + i) % 3) * 0.03) * w}" cy="${(0.44 + i * 0.03) * h}" rx="${0.05 * w}" ry="${0.11 * h}" fill="rgb(${190 + i * 10},${150 + shift / 2},${120 + i * 6})"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><!--${size}-${seed}--><rect width="${w}" height="${h * 0.32}" fill="rgb(${140 + shift},${150 + shift},${158 + shift})"/><rect y="${h * 0.32}" width="${w}" height="${h * 0.2}" fill="rgb(96,104,110)"/><rect y="${h * 0.52}" width="${w}" height="${h * 0.48}" fill="rgb(${70 + shift / 3},${74 + shift / 3},${78 + shift / 3})"/>${warm}</svg>`;
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

/** A report's photos, `n` of them, ids `ph_1`…; each its own scene. */
export const reportPhotos = (n: number, over: (i: number) => Partial<PhotoSibling> = () => ({})) =>
  Array.from(
    { length: n },
    (_, i): PhotoSibling => ({
      photoId: id<'photos'>(`ph_${i + 1}`),
      thumbUrl: scene(i + 1, 'thumb'),
      ...over(i),
    }),
  );

type PhotoFixture = PhotoSubjectData & PhotoStaffFields & { siblings: PhotoSibling[] };

/** The photo `index` (0-based) of `siblings`, as the subject's view serves it. */
export function photoOf(
  index: number,
  siblings: PhotoSibling[],
  over: Partial<PhotoFixture> = {},
): PhotoFixture {
  const self = siblings[index];
  if (self === undefined) throw new Error(`no photo ${index}`);
  return {
    photoId: self.photoId,
    caption: null,
    takenAt: at(10, 11, 14, 22),
    createdAt: at(10, 11, 15, 2),
    url: scene(index + 1, 'full'),
    thumbUrl: self.thumbUrl,
    reportId: REPORT,
    body: CRYSTAL,
    siblings,
    indexOnReport: index,
    moderationStatus: 'visible',
    canReveal: true,
    moderatedAt: null,
    purgeAt: null,
    purgedAt: null,
    siblingsCut: false,
    ...over,
  };
}

/** Every flag verb a visible photo offers (2.7's bar). */
export const PHOTO_CAN = { hide: null, remove: null, dismiss: null } as const;

/** A flag item on `photo`, the seam's fields carried past the read's type. */
export function photoItem(photo: PhotoFixture, over: Partial<FlagItem> = {}): FlagItem {
  const status = photo.moderationStatus ?? 'visible';
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
      photo: photo as PhotoSubjectData,
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

/** Removed, and its file deleted on the clock: a tombstone, no image to anyone. */
export const PHOTO_PURGED = photoItem(
  photoOf(2, FOUR, {
    moderationStatus: 'removed',
    moderatedAt: at(9, 10, 9),
    purgeAt: at(10, 10, 9),
    purgedAt: at(10, 10, 9, 30),
    url: null,
    thumbUrl: null,
  }),
  { can: { dismiss: null } },
);

/**
 * A viewer without `content.read`: the server serves no address, for the photo or its report's
 * others, and says it can't be revealed. The levers are the server's to grant: Dismiss here.
 */
export const PHOTO_NO_ACCESS = photoItem(
  photoOf(
    2,
    reportPhotos(4, () => ({ thumbUrl: null })),
    { canReveal: false, url: null, thumbUrl: null },
  ),
  { can: { dismiss: null } },
);

/** The viewer may see it, but no file was served (the blob is gone). */
export const PHOTO_NO_FILE = photoItem(photoOf(2, FOUR, { url: null, thumbUrl: null }));

/**
 * The busiest report: 24 photos served of more (the read's bound cut the list, a floor), most of them
 * moderated, the flagged one the seventh.
 */
export const PHOTO_MAX = photoItem(
  photoOf(
    6,
    reportPhotos(24, (i) => ({
      moderationStatus:
        i === 6 ? 'visible' : i % 4 === 0 ? 'visible' : i % 2 ? 'hidden' : 'removed',
    })),
    { siblingsCut: true },
  ),
  { itemId: id<'inboxItems'>('i_photo_max') },
);

/** A photo on no report (a hazard's): no *On the same report*, no place on one. */
export const PHOTO_OFF_REPORT = photoItem(
  photoOf(0, reportPhotos(1), {
    reportId: null,
    body: null,
    indexOnReport: null,
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
    dismiss: 'This is your own photo, so another staff member decides it',
    hide: 'This is your own photo, so another staff member decides it',
    remove: 'This is your own photo, so another staff member decides it',
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
