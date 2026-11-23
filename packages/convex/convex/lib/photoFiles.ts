/**
 * **A photo's stored files — the invariants, and the one module that keeps them** (B01-5e). A storage
 * id works like a key to its bytes, and a photo's bytes are evidence (D248) or private (D42), so:
 *
 * 1. **Every stored photo file is named by exactly one thing at every committed instant**: a photo
 *    row's image or thumbnail slot; or one `photoFiles` row — an in-flight rotation copy (`copy`) or a
 *    file owed a deletion (`doomed`); or it was stored by a rotation attempt that isn't reconciled
 *    yet, inside that attempt's own window, with a source file's sha256 (`photoRotations`) — so a
 *    sweep always finds it. (Rows written before B01-5e may share a file between photos; nothing new
 *    can, `photos.create`.)
 * 2. **A file any photo row names is never deleted** — a legacy row sharing a file included. A
 *    rotation copies for its own row and leaves a shared source to the row still holding it.
 * 3. **A copy exists only if recorded first or findable afterwards, whenever its attempt ran**: the
 *    attempt row is written before anything is stored, each copy is recorded the moment it is
 *    stored, and the reconcile searches each attempt's own window (`startedAt` to its action's
 *    lifetime), paged to the end, for one stored and never recorded.
 * 4. **A deletion that fails is retried until the file is gone** — a `doomed` row, by the attempts
 *    rule (1 min, 10 min, 1 h, then parked and daily), mirrored to Machinery (`photoRotation`,
 *    `file:<id>`), bounded per run, never forgotten.
 * 5. **The watch ends only when nothing of the photo's is in flight or owed**: no attempt
 *    unreconciled, no `photoFiles` row.
 * 6. **No storage id leaves the server to any caller**: a photo document goes out only through
 *    {@link projectPhoto}'s allow-list; reads serve URLs.
 * 7. **No write accepts a storage id that is named, reserved, or not a fresh unattached upload**
 *    ({@link fileTaken}).
 */
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { type AttemptState, failedAttempt } from './attempts';
import { blobReferenced } from './photoAccess';
import { clearFailure, mirrorFailure } from './recurringWork';
import { deleteStoredBlob } from './storageBlobs';

/** An action's longest life (Convex's 10-minute limit): an attempt older than this is not running. */
export const ACTION_LIFETIME_MS = 10 * 60 * 1000;
/** Stored files the reconcile reads at most per attempt per pass; the rest next pass. */
export const SCAN_PAGE = 200;
/** Doomed files one pass tries at most. */
export const DOOMED_PER_PASS = 50;
/** A doomed file's retries: 1 min, 10 min, 1 h; parked after three failures, then daily. */
export const DOOMED_RETRY_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Machinery key of a doomed file. */
const failureKey = (storageId: string) => `file:${storageId}`;

/** The `photoFiles` row naming `storageId`, if any — one point read. */
export function ledgerRowOf(ctx: QueryCtx, storageId: string): Promise<Doc<'photoFiles'> | null> {
  return ctx.db
    .query('photoFiles')
    .withIndex('by_storage', (q) => q.eq('storageId', storageId))
    .first();
}

/**
 * **Whether a write must refuse `storageId`** (invariant 7): a photo row names it, or the ledger does
 * (a rotation's reserved copy, a file owed a deletion).
 */
export async function fileTaken(ctx: QueryCtx, storageId: string): Promise<boolean> {
  return (await blobReferenced(ctx, storageId)) || (await ledgerRowOf(ctx, storageId)) !== null;
}

/**
 * **Let a file go** — one no row is to name any more (a released old file, an unwanted copy, a stray).
 * A file a photo row names is left alone (invariant 2), its ledger row dropped. Otherwise it is
 * deleted honestly; a delete that fails leaves (or makes) a `doomed` row, retried until it is gone
 * (invariant 4). `true` when the file is gone now.
 */
export async function releaseFile(
  ctx: MutationCtx,
  photoId: Id<'photos'>,
  storageId: string,
  now: number,
): Promise<boolean> {
  const ledger = await ledgerRowOf(ctx, storageId);
  // Checked here, in the transaction that deletes: a row that came to name the file since it was
  // released (a doomed file's retry, days on) keeps it, and nothing is owed any more.
  if (await blobReferenced(ctx, storageId)) {
    if (ledger) {
      await ctx.db.delete(ledger._id);
      if (ledger.state === 'doomed')
        await clearFailure(ctx, 'photoRotation', failureKey(storageId));
    }
    return false;
  }
  const failure = await deleteStoredBlob(ctx, storageId as Id<'_storage'>);
  if (failure === null) {
    if (ledger) {
      await ctx.db.delete(ledger._id);
      if (ledger.state === 'doomed')
        await clearFailure(ctx, 'photoRotation', failureKey(storageId));
    }
    return true;
  }
  const state: AttemptState = ledger?.state === 'doomed' ? attemptsOf(ledger) : {};
  const { next } = failedAttempt(state, 'FileKept', now);
  const fields = {
    state: 'doomed' as const,
    nextTryAt: now + retryDelay(next),
    attempts: next.attempts,
    errorClass: next.errorClass,
    parkedAt: next.parkedAt,
  };
  if (ledger) await ctx.db.patch(ledger._id, fields);
  else await ctx.db.insert('photoFiles', { storageId, photoId, createdAt: now, ...fields });
  await mirrorFailure(ctx, 'photoRotation', failureKey(storageId), next, now);
  console.warn(`photoFiles: ${storageId} could not be deleted (${failure}); retried`);
  return false;
}

function attemptsOf(row: Doc<'photoFiles'>): AttemptState {
  return {
    ...(row.attempts !== undefined ? { attempts: row.attempts } : {}),
    ...(row.errorClass !== undefined ? { errorClass: row.errorClass } : {}),
    ...(row.parkedAt !== undefined ? { parkedAt: row.parkedAt } : {}),
  };
}

function retryDelay(state: AttemptState): number {
  if (state.parkedAt !== undefined) return DAY_MS;
  return DOOMED_RETRY_MS[(state.attempts ?? 1) - 1] ?? DAY_MS;
}

/** Rows naming `storageId` in either slot, other than `exceptId` — at most `n`. */
export async function holdersOf(
  ctx: QueryCtx,
  storageId: string,
  exceptId: Id<'photos'>,
  n = SAME_BYTES_MAX,
): Promise<Doc<'photos'>[]> {
  const out = new Map<string, Doc<'photos'>>();
  for (const index of ['by_storage', 'by_thumb_storage'] as const) {
    const field = index === 'by_storage' ? 'storageId' : 'thumbStorageId';
    const rows = await ctx.db
      .query('photos')
      .withIndex(index, (q) => q.eq(field as never, storageId as never))
      .take(n + 1);
    for (const r of rows) if (r._id !== exceptId && out.size < n) out.set(r._id, r);
  }
  return [...out.values()];
}

/** The most twins a photo records, and the Inbox names. */
export const SAME_BYTES_MAX = 8;

/** A copy just stored, recorded before anything else can lose it (invariant 3). */
export async function recordCopy(
  ctx: MutationCtx,
  attempt: Doc<'photoRotations'>,
  storageId: string,
  now: number,
): Promise<void> {
  await ctx.db.insert('photoFiles', {
    storageId,
    state: 'copy',
    photoId: attempt.photoId,
    attemptId: attempt._id,
    createdAt: now,
    nextTryAt: now,
  });
}

/** The ledger rows of one photo (copies and doomed files), a bounded page. */
export function ledgerOfPhoto(
  ctx: QueryCtx,
  photoId: Id<'photos'>,
  n: number,
): Promise<Doc<'photoFiles'>[]> {
  return ctx.db
    .query('photoFiles')
    .withIndex('by_photo', (q) => q.eq('photoId', photoId))
    .take(n);
}

/** The attempts of one photo not yet reconciled. */
export async function openAttempts(
  ctx: QueryCtx,
  photoId: Id<'photos'>,
): Promise<Doc<'photoRotations'>[]> {
  const out: Doc<'photoRotations'>[] = [];
  for (const status of ['running', 'ended'] as const) {
    out.push(
      ...(await ctx.db
        .query('photoRotations')
        .withIndex('by_photo_status', (q) => q.eq('photoId', photoId).eq('status', status))
        .take(20)),
    );
  }
  return out;
}

/** The content-type parameter a rotation copy carries: `gli-rotation=<attempt id>`. */
const COPY_TAG = 'gli-rotation';

/**
 * A rotation copy's content type: the source's, with its attempt's tag as a parameter (any earlier
 * tag replaced). A MIME parameter, so the copy still serves as the image it is; and only this
 * attempt's action writes it, so the window's search deletes nothing it didn't store.
 */
export function copyContentType(sourceType: string, attemptId: Id<'photoRotations'>): string {
  const base = sourceType
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !p.toLowerCase().startsWith(`${COPY_TAG}=`))
    .join('; ');
  return `${base || 'application/octet-stream'}; ${COPY_TAG}=${attemptId}`;
}

/** Whether a stored file's content type carries this attempt's tag. */
export function isCopyOf(
  contentType: string | undefined,
  attemptId: Id<'photoRotations'>,
): boolean {
  return (contentType ?? '')
    .split(';')
    .map((p) => p.trim().toLowerCase())
    .includes(`${COPY_TAG}=${attemptId}`.toLowerCase());
}

/** Whether a stored file is any attempt's rotation copy — which only the rotation's own steps let go. */
export function isRotationCopy(contentType: string | undefined): boolean {
  return (contentType ?? '')
    .split(';')
    .some((p) => p.trim().toLowerCase().startsWith(`${COPY_TAG}=`));
}

/** Whether an attempt's action may still be alive. */
export const attemptAlive = (a: Doc<'photoRotations'>, now: number) =>
  a.status === 'running' && now - a.startedAt < ACTION_LIFETIME_MS;

/**
 * **Reconcile one attempt** that can no longer store anything (ended, or running past its action's
 * lifetime): its unswapped copies released; then a page of its window searched for a file it stored
 * and never recorded — a source file's sha256, named by no row and no ledger row — each released. The
 * window is `startedAt` to the earlier of now and its lifetime's end; `scanFrom` moves past each page,
 * and the attempt is `reconciled` once a page comes back short. Returns whether it is reconciled.
 */
export async function reconcileAttempt(
  ctx: MutationCtx,
  attempt: Doc<'photoRotations'>,
  now: number,
): Promise<boolean> {
  if (attemptAlive(attempt, now)) return false;
  if (attempt.status === 'running') await ctx.db.patch(attempt._id, { status: 'ended' });
  for (const row of await ledgerOfPhoto(ctx, attempt.photoId, 50)) {
    if (row.state === 'copy' && row.attemptId === attempt._id) {
      await releaseFile(ctx, attempt.photoId, row.storageId, now);
    }
  }
  const windowEnd = Math.min(now, attempt.startedAt + ACTION_LIFETIME_MS);
  const page = await ctx.db.system
    .query('_storage')
    .withIndex('by_creation_time', (q) =>
      q.gt('_creationTime', attempt.scanFrom).lte('_creationTime', windowEnd),
    )
    .take(SCAN_PAGE);
  for (const f of page) {
    // Provably this attempt's copy, never anyone's same bytes: its content type carries this
    // attempt's tag (`copyContentType`), which only this attempt's action writes — a skater's fresh
    // upload of the same image, a legacy twin's file and another attempt's copy all lack it.
    if (!isCopyOf(f.contentType, attempt._id)) continue;
    if (!attempt.sha256.includes(f.sha256)) continue;
    if (await fileTaken(ctx, f._id)) continue;
    await releaseFile(ctx, attempt.photoId, f._id, now);
  }
  const last = page.at(-1);
  if (page.length < SCAN_PAGE) {
    await ctx.db.patch(attempt._id, { status: 'reconciled', scanFrom: windowEnd });
    return true;
  }
  await ctx.db.patch(attempt._id, { scanFrom: (last as { _creationTime: number })._creationTime });
  return false;
}

/** Try the due doomed files — of one photo, or any — at most {@link DOOMED_PER_PASS}. */
export async function retryDoomed(
  ctx: MutationCtx,
  now: number,
  photoId?: Id<'photos'>,
): Promise<number> {
  const due =
    photoId === undefined
      ? await ctx.db
          .query('photoFiles')
          .withIndex('by_state_next', (q) => q.eq('state', 'doomed').lte('nextTryAt', now))
          .take(DOOMED_PER_PASS)
      : (await ledgerOfPhoto(ctx, photoId, DOOMED_PER_PASS)).filter(
          (r) => r.state === 'doomed' && r.nextTryAt <= now,
        );
  let gone = 0;
  for (const row of due) if (await releaseFile(ctx, row.photoId, row.storageId, now)) gone++;
  return gone;
}

/** Whether nothing of the photo's is in flight or owed (invariant 5). */
export async function photoFilesSettled(ctx: QueryCtx, photoId: Id<'photos'>): Promise<boolean> {
  return (
    (await openAttempts(ctx, photoId)).length === 0 &&
    (await ledgerOfPhoto(ctx, photoId, 1)).length === 0
  );
}

/** The fields of a photo document any read may return (invariant 6): an allow-list, never a strip. */
export function projectPhoto(photo: Doc<'photos'>) {
  return {
    _id: photo._id,
    _creationTime: photo._creationTime,
    uploaderId: photo.uploaderId,
    ...(photo.caption !== undefined ? { caption: photo.caption } : {}),
    ...(photo.takenAt !== undefined ? { takenAt: photo.takenAt } : {}),
    ...(photo.coord !== undefined ? { coord: photo.coord } : {}),
    placeOnMap: photo.placeOnMap,
    ...(photo.reportId !== undefined ? { reportId: photo.reportId } : {}),
    createdAt: photo.createdAt,
    moderationStatus: photo.moderationStatus,
    ...(photo.moderatedAt !== undefined ? { moderatedAt: photo.moderatedAt } : {}),
    ...(photo.purgeAt !== undefined ? { purgeAt: photo.purgeAt } : {}),
    ...(photo.purgedAt !== undefined ? { purgedAt: photo.purgedAt } : {}),
    ...(photo.bytesMissingAt !== undefined ? { bytesMissingAt: photo.bytesMissingAt } : {}),
    ...(photo.sameBytesAs !== undefined ? { sameBytesAs: photo.sameBytesAs } : {}),
  };
}
