/**
 * **No new photo deleter without the hold** (B01-5e; D248: an author can't drop evidence; D222). Every
 * path that deletes a photo row or a photo's blob is listed here with how it respects flags and
 * verdicts; a file that deletes one and isn't listed fails, until it is added with its check.
 *
 * This lint finds, in the convex sources (comments and strings blanked first):
 *
 * - every call of `deletePhotoAndBlobs(` — which asks `photoHeld` itself (held below) — by function;
 * - every call of `purgePhotoBlobs(` (the purge's blob half), which only `photoPurge.ts` may make;
 * - every `ctx.db.delete(` whose argument names a photo (`photo`, `photoId`, a `photos` id);
 * - every `deleteStoredBlob(` / `storage.delete(` whose argument names a photo's blob
 *   (`storageId`, `thumbStorageId`, a rotation's old or new id) — export bundles' own blobs are
 *   listed apart;
 *
 * and holds each to the inventory. It also holds that `deletePhotoAndBlobs` asks `photoHeld(` before
 * it deletes, and that `photoHeld` reads the photo's status, a standing verdict and an open flag.
 *
 * **What it can't see:** a delete whose target arrives through a variable named nothing like a photo,
 * or a helper that wraps `ctx.db.delete` generically. `convex/photoDeleters.test.ts` drives every
 * listed deleter against a held photo; this is the lint that makes a new one show up there.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

const CONVEX = resolve(__dirname, '../../convex/convex');

/** Each function that deletes a photo row or blob, and how it keeps a held photo. */
const PHOTO_DELETERS: Record<string, string> = {
  // The one delete of a photo row and its blobs: asks `photoHeld` itself.
  'lib/photoOrphans.ts:deletePhotoAndBlobs': 'asks photoHeld, answers `held`',
  'lib/photoOrphans.ts:deleteBlobsOf': 'the two blobs, for deletePhotoAndBlobs and the purge alone',
  'lib/photoOrphans.ts:purgePhotoBlobs': 'the purge’s blob half: the row stays a tombstone',
  // The callers of deletePhotoAndBlobs — each keeps a `held` answer's photo.
  'photos.ts:remove': 'the uploader’s delete: a held photo is withdrawn instead (fork 1)',
  'storageHygiene.ts:examinePhoto': 'the orphan walk’s retry of an erased photo',
  'storageHygiene.ts:expireDepartedPhotos': 'season expiry',
  'photoReconcile.ts:sweepStillMarked': 'the reconcile’s delete phase',
  'accountDeletion.ts:erasePhotos': 'account deletion',
  'lib/contentPurge.ts:sweepPhotos': 'the departed-content purge',
  'erasure.ts:settleStep': 'the photo settlement (the orphan walk owes its candidates here)',
  // Blob deletes outside the row delete.
  'photoPurge.ts:purgeOne':
    'a removed photo whose 30-day clock is due, re-checked in its own transaction',
  'photos.ts:swapRotated':
    'the rotation: old blobs, only while the row is still down and holds them',
  'photos.ts:dropRotationCopies': 'a rotation’s own copies, never on any row',
  'photos.ts:recordRotationCopy': 'a copy just stored, when its rotation no longer applies (on no row)',
  'lib/photoRotation.ts:sweepRotationCopies':
    'a rotation’s copies no row names (blobReferenced asked of each), while no run can be alive',
  'photos.ts:removeBlob': 'a fresh upload no photo row names (blobReferenced, PENDING_UPLOAD_MS)',
};

/** Blob deletes that aren't a photo's, by function. */
const NOT_PHOTO_BLOBS: Record<string, string> = {
  'lib/exportBundles.ts:reclaimExportBlob': 'an export bundle',
  'dataExport.ts:finishExport': 'an export bundle',
};

/** The honest delete itself (`lib/storageBlobs`), which every blob delete above goes through. */
const SKIPPED_FILES = new Set(['lib/storageBlobs.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Comments and string contents blanked, positions kept (templates' `${…}` kept). */
function blank(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => `'${' '.repeat(m.length - 2)}'`);
}

/** The innermost named function (or `export const name =` handler) around `at`. */
function functionAt(text: string, at: number): string {
  const head = text.slice(0, at);
  const named = [
    ...head.matchAll(/(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\(/g),
    ...head.matchAll(/export const (\w+)\s*=\s*(?:internal)?(?:[Mm]utation|[Qq]uery|[Aa]ction)/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return named.at(-1)?.[1] ?? '<module>';
}

/** The argument text of the call that opens at `open` (the index of its `(`). */
function argsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const PHOTO_ROW = /\bphoto(?:Id|s)?\b|\bphoto\._id\b|Id<'photos'>/;
// Strings are blanked before matching, so a cast reads `as Id<'…'>` with its table name gone.
const PHOTO_BLOB = /storageId|thumbStorageId|\bwas\b|\bfresh\b|\bcopy\b|\bid as Id</;

function deleters(): { photo: Set<string>; other: Set<string> } {
  const photo = new Set<string>();
  const other = new Set<string>();
  for (const path of sources(CONVEX)) {
    const rel = relative(CONVEX, path);
    if (SKIPPED_FILES.has(rel)) continue;
    const text = blank(readFileSync(path, 'utf8'));
    const at = (re: RegExp, keep: (args: string) => 'photo' | 'other' | null) => {
      for (const m of text.matchAll(re)) {
        // A definition is not a call.
        if (/function\s+$/.test(text.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) continue;
        const open = (m.index ?? 0) + m[0].length - 1;
        const fn = `${rel}:${functionAt(text, m.index ?? 0)}`;
        const kind = fn in NOT_PHOTO_BLOBS ? 'other' : keep(argsAt(text, open));
        if (kind === null) continue;
        (kind === 'photo' ? photo : other).add(fn);
      }
    };
    at(/\bdeletePhotoAndBlobs\(/g, () => 'photo');
    at(/\bpurgePhotoBlobs\(/g, () => 'photo');
    at(/\bdeleteBlobsOf\(/g, () => 'photo');
    at(/\bctx\.db\.delete\(/g, (args) => (PHOTO_ROW.test(args) ? 'photo' : null));
    at(/\b(?:deleteStoredBlob|storage\.delete)\(/g, (args) =>
      PHOTO_BLOB.test(args) ? 'photo' : 'other',
    );
  }
  return { photo, other };
}

test('every function that deletes a photo row or blob is listed with how it keeps a held photo', () => {
  const { photo } = deleters();
  const unlisted = [...photo].filter((f) => !(f in PHOTO_DELETERS));
  expect(unlisted).toEqual([]);
  // A listed deleter that no longer deletes comes off the list.
  const stale = Object.keys(PHOTO_DELETERS).filter((f) => !photo.has(f));
  expect(stale).toEqual([]);
});

test('every other blob delete is a known non-photo blob', () => {
  const { other } = deleters();
  expect([...other].filter((f) => !(f in NOT_PHOTO_BLOBS) && !(f in PHOTO_DELETERS))).toEqual([]);
});

test('deletePhotoAndBlobs asks photoHeld before it deletes; photoHeld reads all three holds', () => {
  const orphans = blank(readFileSync(join(CONVEX, 'lib/photoOrphans.ts'), 'utf8'));
  const start = orphans.indexOf('export async function deletePhotoAndBlobs');
  const body = orphans.slice(start, orphans.indexOf('\n}\n', start));
  const held = body.indexOf('photoHeld(');
  expect(held).toBeGreaterThan(-1);
  expect(held).toBeLessThan(body.indexOf('deleteBlobsOf('));
  expect(held).toBeLessThan(body.indexOf('ctx.db.delete('));
  const access = readFileSync(join(CONVEX, 'lib/photoAccess.ts'), 'utf8');
  const fn = access.slice(access.indexOf('export async function photoHeld'));
  const holdBody = fn.slice(0, fn.indexOf('\n}\n'));
  expect(holdBody).toMatch(/photoVisible\(photo\)/);
  expect(holdBody).toMatch(/'contentVerdicts'[\s\S]*by_target_standing/);
  expect(holdBody).toMatch(
    /'contentFlags'[\s\S]*OPEN_FLAG_STATUSES|OPEN_FLAG_STATUSES[\s\S]*'contentFlags'/,
  );
});

test('only the purge calls the blob half', () => {
  const callers = [...deleters().photo].filter((f) => f.startsWith('photoPurge.ts:'));
  expect(callers).toEqual(['photoPurge.ts:purgeOne']);
  for (const path of sources(CONVEX)) {
    const rel = relative(CONVEX, path);
    if (rel === 'photoPurge.ts' || rel === 'lib/photoOrphans.ts') continue;
    expect(blank(readFileSync(path, 'utf8')), rel).not.toMatch(/\bpurgePhotoBlobs\(/);
  }
});

/**
 * **Every function that takes a storage id from outside** (B01-5e: an id works like a key) is listed
 * with its check. A public or internal function whose arguments name `v.id('_storage')` fails until
 * it is added here.
 */
const STORAGE_ID_TAKERS: Record<string, string> = {
  'photos.ts:create': 'refuses an id naming no file, the same id twice, and one any row holds',
  'photos.ts:removeBlob': 'deletes only a fresh upload no photo row names',
  'basemap.ts:getServingUrl': 'internal: the operator resolves an uploaded basemap’s URL',
};

test('every function that takes a storage id from a caller is listed with its check', () => {
  const takers = new Set<string>();
  for (const path of sources(CONVEX)) {
    const rel = relative(CONVEX, path);
    const text = blank(readFileSync(path, 'utf8'));
    for (const m of text.matchAll(/v\.id\('\s*'\)/g)) {
      // Strings are blanked: a `v.id('…')` of eight blanks is `'_storage'`.
      const raw = readFileSync(path, 'utf8').slice(m.index ?? 0, (m.index ?? 0) + m[0].length);
      if (!raw.includes("'_storage'")) continue;
      takers.add(`${rel}:${functionAt(text, m.index ?? 0)}`);
    }
  }
  expect([...takers].filter((f) => !(f in STORAGE_ID_TAKERS))).toEqual([]);
  expect(Object.keys(STORAGE_ID_TAKERS).filter((f) => !takers.has(f))).toEqual([]);
});

test('create and removeBlob ask whether a row already holds the blob; deleteBlobsOf leaves a shared one', () => {
  const photos = readFileSync(join(CONVEX, 'photos.ts'), 'utf8');
  const body = (name: string) => {
    const at = photos.indexOf(`export const ${name} = `);
    return photos.slice(at, photos.indexOf('\n});\n', at));
  };
  expect(body('create')).toMatch(/blobReferenced\(/);
  expect(body('removeBlob')).toMatch(/blobReferenced\(/);
  expect(body('removeBlob')).toMatch(/PENDING_UPLOAD_MS/);
  const orphans = readFileSync(join(CONVEX, 'lib/photoOrphans.ts'), 'utf8');
  const fn = orphans.slice(orphans.indexOf('async function deleteBlobsOf'));
  expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/blobReferenced\(/);
});
