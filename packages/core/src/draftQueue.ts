/**
 * Offline draft-queue logic (Phase 02a §6.2/D30; reshaped around Posts in A10 §9.1) — the pure,
 * testable heart of the mobile offline queue.
 *
 * The mobile app persists a **list** of captured-but-unsent **Post drafts** (a day of offline
 * lake-hopping) in `expo-sqlite`, with photo files in `expo-file-system`, and flushes them on
 * reconnect. A Post draft is the unit — the author's title and prose plus one or more Report drafts,
 * each with its own body, form, photos, track and hazards — and it flushes as **one `posts.create`**
 * (D186), so a two-lake day can never land as one lake. All the *I/O* is native + impure (sqlite,
 * file reads, `fetch` uploads, Convex mutations); everything *decision-shaped* lives here so it's
 * unit-testable in isolation and shares one contract with the hazard and track queues:
 *   - the draft record shape + status machine (`pending → uploading → creating → done | error`),
 *   - **idempotent, checkpointed** flush orchestration (`flushPost`) — each photo's `storageId` /
 *     `photoId` is persisted the instant it lands, so a lost-ack retry *resumes* (reusing uploaded
 *     objects, sending the same `photoIds`) instead of re-uploading and orphaning blobs; the Post
 *     itself dedupes on its `idempotencyKey` server-side, each Report on its own,
 *   - transient-vs-permanent failure classification, so a dropped connection auto-retries while a
 *     server rejection (validation, a removed lake, a coord that matches no lake) parks the draft in
 *     `error` for the user instead of looping forever.
 *
 * All external effects are injected (`PostFlushEffects`), so tests drive the whole orchestration
 * with fakes. Ids are opaque strings here (framework-free); the mobile layer casts to Convex `Id`s.
 *
 * **D55 rides the draft** (§9.1): each Report draft carries `hazardRefs` — the author's own hazards
 * to bundle, by server id when they were picked online, by the *queue's* local id when they were
 * captured on the ice with no signal. The flush resolves a local ref through the hazard queue
 * (`resolveHazardId`), which keeps a flushed hazard's row, with its server id, until no draft points
 * at it. A ref that cannot be resolved is dropped, never blocks the Post: a hazard already posted on
 * its own is still on the map; the report simply doesn't claim it.
 */

import { type AccessAlertTarget, isAccessCondition } from './accessAlert';
import type { LatLng } from './geometry';
import { photoUploadCoord } from './photo';
import { type ReportInput, validateReportInput } from './report';
import { buildReportInput, formCreateRefusal, type ReportFormState } from './reportForm';
import { type ReportSheetState, selectedValues, toReportInput } from './reportSheet';

/**
 * A captured photo inside a draft. `fullUri`/`thumbUri` are **persistent** file-system paths (the
 * already-optimized + EXIF-stripped output copied out of the picker cache at capture, so it survives
 * OS eviction over the days a draft may sit). The `*StorageId` / `photoId` fields are **flush
 * checkpoints** — written back as each upload / row-create lands so a retry never repeats them.
 */
export interface DraftPhoto {
  id: string;
  fullUri: string;
  thumbUri: string;
  /** EXIF GPS if the original carried it — only ever *sent* on the `placeOnMap` opt-in (D42). */
  coord?: LatLng;
  placeOnMap: boolean;
  /** EXIF capture time, epoch ms, when the original carried it — what assigns a photo to a Report (A10-7). Never sent. */
  takenAtMs?: number;
  /** A Post-pool photo the author sent to the put-in or the lot instead of a Report (A10-7): filed as an access photo after the Post lands. */
  attachTo?: AccessPhotoTarget;
  /** Flush checkpoint for an `attachTo` photo: the access row is filed (or refused and skipped). */
  attachedAccess?: boolean;
  fullStorageId?: string;
  thumbStorageId?: string;
  photoId?: string;
}

/**
 * Persisted status. `draft` is **held** (A10 §Post-and-draft, founder call 2026-09-21): a Post the
 * author saved to come back to, or quit the app in the middle of, and it is never sent until they
 * tap *Post* — before A10-3 a saved draft and a queued Post shared `pending` and both flushed on
 * reconnect, which made *Save draft* a slower *Post*. `pending` is queued. `uploading`/`creating`
 * are in-flight markers; a draft found in one at launch (app killed mid-flush) is treated as
 * resumable (`isFlushable`) — its checkpoints make the resume cheap. `error` is a *permanent*
 * failure needing the user; a transient failure resets to `pending`, except one that lost the
 * create's ack, which stays `creating` (see the catch in `flushPost`).
 */
export type DraftStatus = 'draft' | 'pending' | 'uploading' | 'creating' | 'done' | 'error';

/**
 * One hazard a Report draft bundles (D55). `hazardId` when it was picked from the server's list
 * (online, or an already-flushed capture); `localId` when it is still — or was — a row in the
 * device's hazard queue. Exactly one is set at capture; the flush fills `hazardId` in from the
 * local one.
 */
export interface HazardRef {
  hazardId?: string;
  localId?: string;
}

/**
 * What the hazard queue says about a bundled local ref at flush (D55 offline): `sent` with its
 * server id; `waiting` — still queued, so the Post waits for it; `refused` — parked in `error`, so
 * the Post parks with a sentence saying so; `gone` — the author deleted it from the queue, so there
 * is nothing left to attach.
 */
export type HazardRefResolution =
  | { kind: 'sent'; hazardId: string }
  | { kind: 'waiting' }
  | { kind: 'refused'; message: string }
  | { kind: 'gone' };

/**
 * One Report inside a Post draft (A10 / D186). Fully serialized + reopenable, so the sheet can
 * hydrate it for offline editing and the flush can rebuild the report input — one source of truth
 * for both. Carries no status of its own: the Post is the unit that is pending, sent or parked.
 */
export interface ReportDraft {
  id: string;
  /** Client-generated at capture, carried across every flush retry (per-Report server dedup). */
  idempotencyKey: string;
  /** Resolved locally at capture (Layer-2 body cache); absent ⇒ coord-only, resolved at flush. */
  waterBodyId?: string;
  /** For the drafts-list label when the lake is known. */
  bodyName?: string;
  /** Device GPS at capture — resolves the lake at flush when `waterBodyId` is absent. */
  coord?: LatLng;
  /** Optional put-in pin (offline this defaults to the capture location, D42/S1). Pre-sheet drafts only. */
  putInPin?: LatLng;
  /**
   * The content, in one of two shapes: the sheet's state (A10-3, every draft the sheet saves) or
   * the pre-sheet form's (rows queued before it, and the web form's mirror). Exactly one is set;
   * `reportDraftInput` reads whichever it is, so the flush has one rule.
   */
  sheet?: ReportSheetState;
  form?: ReportFormState;
  photos: DraftPhoto[];
  /**
   * The **local** id of a recorded track this report describes (Phase 08). Both may be captured offline
   * on the same lake, so neither has a server id at capture time; the flush resolves this to an
   * `activityId` once the track has been ingested (`TrackFlushEffects` → `resolveActivityId`).
   */
  trackDraftId?: string;
  /** Flush checkpoint: the server `gpsActivities` id, once resolved. */
  activityId?: string;
  /** The author's own hazards to bundle into this report (D55) — see `HazardRef`. */
  hazardRefs?: HazardRef[];
  /**
   * Flush checkpoint: the condition alerts (D197) already filed for this Report, by reason — filed
   * after the Post exists (they carry its id as provenance), each on its own idempotency key, so a
   * retry files the rest and never a second plank.
   */
  filedAccessReasons?: string[];
}

/** A queued offline Post draft: the words, and the Reports, flushed as one `posts.create`. */
/** Where a pool photo goes when it documents infrastructure rather than ice (A06d's access photos). */
export interface AccessPhotoTarget {
  kind: 'put_in' | 'parking_area';
  id: string;
}

export interface PostDraft {
  kind: 'post';
  id: string;
  /** The Post's dedup key across every flush retry (D30, lifted to the Post in A10-2). */
  idempotencyKey: string;
  status: DraftStatus;
  /** Set when `status === 'error'` — the permanent reason, surfaced in the drafts list. */
  errorMessage?: string;
  title?: string;
  body?: string;
  /** Never empty — a Post requires a Report (D186); the sheet cannot save one without. */
  reports: ReportDraft[];
  /**
   * The Post's own photos (A10-7): the pool the day could not put on a Report. A held draft keeps
   * them so the author can still say; a flush refuses one without an `attachTo` and files the rest
   * as access photos after the Post lands (step 8). Absent on drafts from before A10-7.
   */
  photos?: DraftPhoto[];
  /** Flush checkpoint: the server Post id, once created, and its Reports' ids in the author's order. */
  postId?: string;
  reportIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * A report draft as devices queued them before A10-2b — one row, one report, its own status and
 * clock. Read only by the on-device migration (`postDraftFromLegacy`); never written again.
 */
export interface LegacyReportDraft extends ReportDraft {
  status: DraftStatus;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Lift a pre-A10-2b row into the one-Report Post it is. The Post takes the report's key as its own
 * and the report keeps it too, so the server sees the same key either way: a lost-ack retry of a
 * flush that went through the A10-2 `reports.create` (which keyed the Post it made with the row's
 * key) short-circuits on the Post's key. A retry of one that landed *before* A10-2 — a Report with
 * the key on its row and a backfilled Post with none — is refused by `posts.create` as a key
 * conflict and parks; only `reports.create` kept that older row-key rule, and this flush no longer
 * goes through it. Dev-only exposure (prod was never initialized), noted rather than built around.
 */
export function postDraftFromLegacy(legacy: LegacyReportDraft): PostDraft {
  const { status, errorMessage, createdAt, updatedAt, ...report } = legacy;
  return {
    kind: 'post',
    id: legacy.id,
    idempotencyKey: legacy.idempotencyKey,
    status,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    reports: [report],
    createdAt,
    updatedAt,
  };
}

/** Build one Report draft. `id` + `idempotencyKey` are injected (the mobile layer mints UUIDs). */
export function createReportDraft(args: {
  id: string;
  idempotencyKey: string;
  form?: ReportFormState;
  sheet?: ReportSheetState;
  waterBodyId?: string;
  bodyName?: string;
  coord?: LatLng;
  putInPin?: LatLng;
  photos?: DraftPhoto[];
  trackDraftId?: string;
  /** A flush checkpoint an edit carries forward, so a re-save does not re-resolve the track. */
  activityId?: string;
  hazardRefs?: HazardRef[];
}): ReportDraft {
  if ((args.form === undefined) === (args.sheet === undefined)) {
    throw new Error('A report draft carries a sheet or a form, and exactly one');
  }
  return {
    id: args.id,
    idempotencyKey: args.idempotencyKey,
    ...(args.waterBodyId !== undefined ? { waterBodyId: args.waterBodyId } : {}),
    ...(args.bodyName !== undefined ? { bodyName: args.bodyName } : {}),
    ...(args.coord !== undefined ? { coord: args.coord } : {}),
    ...(args.putInPin !== undefined ? { putInPin: args.putInPin } : {}),
    ...(args.sheet !== undefined ? { sheet: args.sheet } : {}),
    ...(args.form !== undefined ? { form: args.form } : {}),
    photos: args.photos ?? [],
    ...(args.trackDraftId !== undefined ? { trackDraftId: args.trackDraftId } : {}),
    ...(args.activityId !== undefined ? { activityId: args.activityId } : {}),
    ...(args.hazardRefs !== undefined && args.hazardRefs.length > 0
      ? { hazardRefs: args.hazardRefs }
      : {}),
  };
}

/**
 * The validator's input for one Report draft, whichever shape it carries: the sheet serializes
 * itself; a pre-sheet form goes through `buildReportInput` with its pin. `null` for a row with
 * neither, which no writer produces — the flush refuses it as permanent rather than guessing.
 */
export function reportDraftInput(r: ReportDraft, waterBodyId: string): ReportInput | null {
  if (r.sheet !== undefined) return { ...toReportInput(r.sheet), waterBodyId };
  if (r.form !== undefined) return buildReportInput(r.form, waterBodyId, r.putInPin);
  return null;
}

/** When the Report draft says the skater got off — for the queue's rows and the Post's label. */
export function reportDraftEndTime(r: ReportDraft): number {
  if (r.sheet !== undefined) {
    const [endTime] = selectedValues(r.sheet, 'endTime');
    return endTime?.ms ?? Number.NaN;
  }
  return r.form?.skateEndTime ?? Number.NaN;
}

/**
 * The condition alerts a sheet-shaped Report draft files once its Report exists (D197 / §7.2):
 * every selected condition chip, each against the put-in or the lot the sheet chose. Lot-shaped
 * reasons — an icy lot, a lot snowed in, a plowed trail from it — go to the lot when one was
 * chosen; everything else goes to the put-in; with only one target chosen, everything goes there.
 * With neither, nothing files: a condition needs a thing to be a condition of.
 */
export interface AccessConditionFiling {
  targetType: AccessAlertTarget;
  putInId?: string;
  parkingAreaId?: string;
  reason: string;
  note?: string;
  /** When the skater saw it — the Report's end time, so a flush days later does not read as fresh. */
  observedAt?: number;
}

const LOT_SHAPED_REASONS: ReadonlySet<string> = new Set(['icy_lot', 'snowed_in', 'plowed_trail']);

export function accessConditionFilings(sheet: ReportSheetState): AccessConditionFiling[] {
  const { putInId, parkingAreaId } = sheet.scalars;
  if (putInId === undefined && parkingAreaId === undefined) return [];
  const note = sheet.scalars.accessNote?.trim() || undefined;
  const [end] = selectedValues(sheet, 'endTime');
  return selectedValues(sheet, 'accessConditions')
    .filter((reason) => isAccessCondition(reason))
    .map((reason) => {
      const toLot =
        parkingAreaId !== undefined && (putInId === undefined || LOT_SHAPED_REASONS.has(reason));
      return {
        targetType: toLot ? ('parking_area' as const) : ('put_in' as const),
        ...(toLot ? { parkingAreaId: parkingAreaId as string } : { putInId: putInId as string }),
        reason,
        ...(note !== undefined ? { note } : {}),
        ...(end !== undefined ? { observedAt: end.ms } : {}),
      };
    });
}

/** The idempotency key one condition alert flushes under — the Report's key, the reason. */
export function accessConditionKey(reportKey: string, reason: string): string {
  return `${reportKey}:access:${reason}`;
}

/** Build a fresh Post draft over its Reports. Throws on zero Reports — the rule is the schema's. */
export function createPostDraft(args: {
  id: string;
  idempotencyKey: string;
  now: number;
  title?: string;
  body?: string;
  reports: ReportDraft[];
  /** The Post's pool photos (A10-7). */
  photos?: DraftPhoto[];
  /** `draft` holds it (never sent until *Post*); `pending` (the default) queues it. */
  status?: 'draft' | 'pending';
}): PostDraft {
  if (args.reports.length === 0) throw new Error('A post draft needs at least one report');
  return {
    kind: 'post',
    id: args.id,
    idempotencyKey: args.idempotencyKey,
    status: args.status ?? 'pending',
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    reports: args.reports,
    ...(args.photos !== undefined && args.photos.length > 0 ? { photos: args.photos } : {}),
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** A queued Post still needs sending unless it's held as a draft, already `done`, or parked in a permanent `error`. */
export function isFlushable(draft: PostDraft): boolean {
  return draft.status !== 'draft' && draft.status !== 'done' && draft.status !== 'error';
}

/** Held by the author — never flushed, listed under *Drafts*, not *Waiting to send*. */
export function isHeldDraft(draft: PostDraft): boolean {
  return draft.status === 'draft';
}

/**
 * The create was sent once already: it went out and no answer came back (`creating`), or it
 * landed and a later step failed (a `postId`). Either way the Post may be live, and the server's
 * idempotent create answers a retry with **the Post it already has** — so a change made after this
 * point would be dropped without a word. A sent Post is resent exactly as it went, never edited in
 * place; once it is up, its page's edit door is the way to change it (PR #77 review).
 */
export function postCreateSent(draft: PostDraft | null | undefined): boolean {
  return draft != null && (draft.status === 'creating' || draft.postId !== undefined);
}

/** What a sent Post says in place of taking a change (`postCreateSent`), on both surfaces. */
export const POST_SENT_COPY =
  "This post was sent, but the answer didn't come back, so it may already be up. It can't take changes until it has landed — then edit it from its page.";

/** The flushable subset of a queue, oldest first (capture order) — the reconnect-flush work list. */
export function flushablePosts(drafts: readonly PostDraft[]): PostDraft[] {
  return drafts.filter(isFlushable).sort((a, b) => a.createdAt - b.createdAt);
}

/** Every persistent photo file a Post draft owns (full + thumb per photo, every Report). */
export function postDraftPhotoUris(draft: PostDraft): string[] {
  const photos = [...draft.reports.flatMap((r) => r.photos), ...(draft.photos ?? [])];
  return photos.flatMap((p) => [p.fullUri, p.thumbUri]);
}

/** The local track ids a queue of Post drafts still points at — the retention guard's input. */
export function referencedTrackIds(drafts: readonly PostDraft[]): Set<string> {
  const ids = new Set<string>();
  for (const d of drafts)
    for (const r of d.reports) if (r.trackDraftId !== undefined) ids.add(r.trackDraftId);
  return ids;
}

/** The local hazard ids a queue of Post drafts still points at — same guard, for the hazard queue. */
export function referencedHazardLocalIds(drafts: readonly PostDraft[]): Set<string> {
  const ids = new Set<string>();
  for (const d of drafts)
    for (const r of d.reports)
      for (const ref of r.hazardRefs ?? []) if (ref.localId !== undefined) ids.add(ref.localId);
  return ids;
}

export type FlushErrorKind = 'transient' | 'permanent';

/**
 * Marker for a failure the queue must NOT auto-retry (it won't self-resolve).
 *
 * Exported so the hazard queue raises the *same* marker rather than a parallel one — a second class
 * would be classified `transient` by `classifyFlushError` and retried forever.
 */
export class PermanentFlushError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFlushError';
  }
}

/**
 * Classify a flush failure. A **permanent** failure won't fix itself on retry — our own
 * `PermanentFlushError` (invalid draft / unresolvable lake), or any `ConvexError` (server-side
 * validation, a removed lake, an idempotency-key conflict), duck-typed by name to avoid a
 * `convex/values` dependency in framework-free core. Everything else (network, `fetch`, timeout) is
 * **transient** — the reconnect flush will try again.
 */
export function classifyFlushError(error: unknown): FlushErrorKind {
  if (error instanceof PermanentFlushError) return 'permanent';
  if (error instanceof Error && error.name === 'ConvexError') return 'permanent';
  return 'transient';
}

/**
 * The words a parked draft shows. A `ConvexError` carries its payload in `data` — a plain string,
 * or an object whose `message` is the sentence the server wrote for the skater (`stale_report`,
 * `minimum_set`) — and its `message` is the wire form with a request id and the JSON, which is not
 * for anyone to read. Everything else falls back to the error's message.
 */
export function flushErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'ConvexError' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === 'string') return data;
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as { message?: unknown }).message === 'string'
    )
      return (data as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The one sentence for a pool photo nobody has placed (A10-7): the sheet and the flush both say it. */
export function unassignedPhotosMessage(count: number): string {
  return count === 1
    ? "One photo isn't on a lake yet — say which, or leave it out."
    : `${count} photos aren't on a lake yet — say which, or leave them out.`;
}

/** External effects the flush needs, all injected so the orchestration is testable with fakes. */
export interface PostFlushEffects {
  /** Resolve a coord-only draft to a lake (`waterBodies.resolveBodyForCoord`); null ⇒ no match. */
  resolveBody(coord: LatLng): Promise<string | null>;
  /** Upload one local file to storage (`photos.generateUploadUrl` → POST); returns its storageId. */
  uploadPhoto(localUri: string): Promise<string>;
  /** Create the photo row (`photos.create`); returns its photoId. */
  createPhotoRow(input: {
    storageId: string;
    thumbStorageId: string;
    placeOnMap: boolean;
    coord?: LatLng;
  }): Promise<string>;
  /**
   * Resolve a local track-draft id to its server `gpsActivities` id (Phase 08), flushing the track
   * first if it hasn't landed yet. Returns `null` when the track can't be sent — the report then goes
   * out **without** a path rather than waiting, because a report never requires one (D24) and the
   * observation about the ice is the part that matters.
   */
  resolveActivityId?(trackDraftId: string): Promise<string | null>;
  /**
   * Resolve a local hazard-queue id (D55 offline), flushing the hazard first if it hasn't landed.
   * A checked hazard is never quietly left out: one still `waiting` holds the Post in the queue,
   * one `refused` parks it — only one the author deleted (`gone`) is dropped.
   */
  resolveHazardId?(localId: string): Promise<HazardRefResolution>;
  /** Create the Post with its Reports inline (`posts.create`, idempotent on the Post's key). */
  createPost(input: {
    idempotencyKey: string;
    title?: string;
    body?: string;
    reports: (ReportInput & {
      waterBodyId: string;
      idempotencyKey: string;
      photoIds: string[];
      activityId?: string;
      attachHazardIds?: string[];
    })[];
  }): Promise<{ postId: string; reportIds: string[] }>;
  /**
   * File one condition alert (`accessAlerts.create`, D197) with the created Report as provenance,
   * idempotent on its key. Optional: a client without it files nothing and the sheet's conditions
   * stay in the draft.
   */
  createAccessAlert?(
    input: AccessConditionFiling & { reportId: string; idempotencyKey: string },
  ): Promise<void>;
  /**
   * Attach an uploaded photo to a put-in or a lot (`accessPoints.attachPhoto`, A06d), for a pool
   * photo the author sent there (A10-7). Optional: a client without it leaves such photos in the
   * draft. A refusal (the cap, a hidden launch) is skipped like a condition alert's.
   */
  attachAccessPhoto?(input: { photoId: string; target: AccessPhotoTarget }): Promise<void>;
  /** Persist the (checkpointed) draft back to sqlite — called after every state advance. */
  persist(draft: PostDraft): Promise<void>;
}

export type PostFlushResult =
  | { ok: true; draft: PostDraft; postId: string; reportIds: string[] }
  | { ok: false; draft: PostDraft; kind: FlushErrorKind; message: string };

function replacePhoto(photos: readonly DraftPhoto[], updated: DraftPhoto): DraftPhoto[] {
  return photos.map((p) => (p.id === updated.id ? updated : p));
}

/**
 * Flush one Post draft in two passes over its Reports — first every Report is resolved to its lake,
 * validated, its hazards claimed and the create-only rules asked; only then does any Report upload
 * its photos (checkpointing each id) and resolve its track; then the Post is created with every
 * Report inline (idempotent). Persists after every advance, so an interruption anywhere leaves a
 * resumable draft — a re-flush skips already-uploaded photos and the server dedupes the Post on its
 * key. Never throws: a failure is classified and the draft parked (`error` = permanent / `pending` =
 * transient-retry) via `persist`, and returned in the result.
 *
 * **All-or-nothing, like the server.** Every Report is checked before any Report spends an upload,
 * and every Report is prepared before any create; one Report that cannot post parks the whole Post
 * with that Report's reason, named by its lake, so a two-lake day never lands as one, the skater
 * knows which leg to fix, and a first leg's photos are not uploaded for a Post a second leg was
 * always going to sink.
 */
export async function flushPost(
  draft: PostDraft,
  effects: PostFlushEffects,
  now: number,
): Promise<PostFlushResult> {
  let d = draft;
  const save = async (patch: Partial<PostDraft>): Promise<void> => {
    d = { ...d, ...patch, updatedAt: now };
    await effects.persist(d);
  };
  const saveReport = async (report: ReportDraft): Promise<void> => {
    await save({ reports: d.reports.map((r) => (r.id === report.id ? report : r)) });
  };
  /** Prefix a member's failure with its lake, so a two-lake Post says which leg. */
  const leg = (report: ReportDraft, message: string): string =>
    d.reports.length > 1 && report.bodyName ? `${report.bodyName}: ${message}` : message;
  /** The create was sent once already (see the create-only rules below). */
  const createSent = postCreateSent(draft);

  try {
    if (d.reports.length === 0) throw new PermanentFlushError('This post has no report in it.');
    const unassigned = (d.photos ?? []).filter((p) => p.attachTo === undefined).length;
    if (unassigned > 0) throw new PermanentFlushError(unassignedPhotosMessage(unassigned));
    // A draft found in `creating` keeps the mark through its retry: it is the one fact that says
    // the create was sent (the check below, and the catch's reset, both read it), and downgrading it
    // to `uploading` here would lose it to a transient failure — or an app kill — before step 6,
    // after which the next retry would refuse a stale draft for a Post the server already has.
    await save({
      status: d.status === 'creating' ? 'creating' : 'uploading',
      errorMessage: undefined,
    });

    // Pass one — every Report resolved, validated, its hazards claimed and the rules asked, before
    // any Report's photos go up. (A hazard a ref flushes on demand here is not an upload spent on
    // this Post: it is safety content that goes first in every drain and posts on its own anyway.)
    const checked: {
      report: ReportDraft;
      input: ReportInput;
      waterBodyId: string;
      attachHazardIds: string[];
    }[] = [];
    for (const original of d.reports) {
      let r = original;

      // 1. Resolve the lake — local id from capture, else the coord at flush time.
      let waterBodyId = r.waterBodyId;
      if (waterBodyId === undefined) {
        if (r.coord === undefined) {
          throw new PermanentFlushError(
            leg(r, 'This report has no lake and no location to find one.'),
          );
        }
        const resolved = await effects.resolveBody(r.coord);
        if (resolved === null) {
          throw new PermanentFlushError(
            leg(r, "Couldn't match your location to a known lake — open the draft to pick one."),
          );
        }
        waterBodyId = resolved;
        r = { ...r, waterBodyId };
        await saveReport(r);
      }

      // 2. Rebuild + re-validate the report input (a permanently-invalid draft fails before uploads).
      const input = reportDraftInput(r, waterBodyId);
      if (input === null) throw new PermanentFlushError(leg(r, 'This report has no content.'));
      const validation = validateReportInput(input, { now });
      if (!validation.ok) {
        throw new PermanentFlushError(
          leg(r, validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ')),
        );
      }
      // 3. Resolve the bundled hazards (D55) — **before** the rules and the uploads: a server id passes
      //    through; a local id is asked of the hazard queue (which flushes it first if it hasn't
      //    landed — hazards go first in every drain anyway) and checkpointed onto the ref. A checked
      //    hazard is never quietly left out (D55 amended at A10-3): one still waiting holds the
      //    Post in the queue until it sends, one the server refused parks the Post with a sentence
      //    saying which, and only one the author deleted from the queue is dropped. Resolving here
      //    is what lets the minimum-set check below count only the hazards the Post will actually
      //    claim, so a ref that comes back empty cannot pass the check and then fail the create
      //    after the photos were spent.
      const attachHazardIds: string[] = [];
      if (r.hazardRefs && r.hazardRefs.length > 0) {
        const refs: HazardRef[] = [];
        for (const ref of r.hazardRefs) {
          let hazardId = ref.hazardId;
          if (hazardId === undefined && ref.localId !== undefined && effects.resolveHazardId) {
            const resolution = await effects.resolveHazardId(ref.localId);
            if (resolution.kind === 'sent') hazardId = resolution.hazardId;
            // A draft whose create was already sent posted with what it had; holding it now would
            // hold a Post that may be live (the same exemption as the create-only rules below).
            else if (!createSent && resolution.kind === 'waiting') {
              throw new Error('A hazard in this post is still waiting to send.');
            } else if (!createSent && resolution.kind === 'refused') {
              throw new PermanentFlushError(leg(r, resolution.message));
            }
          }
          refs.push(hazardId !== undefined ? { ...ref, hazardId } : ref);
          if (hazardId !== undefined && !attachHazardIds.includes(hazardId))
            attachHazardIds.push(hazardId);
        }
        r = { ...r, hazardRefs: refs };
        await saveReport(r);
      }

      // The create-only rules at flush too (A10 §9.4): a phone that comes back online after a week
      // must not post a stale report, and a draft the sheet never finished must not post half-made.
      // Asked before the uploads, in the words the server would refuse with, so an expired item is
      // surfaced to the skater rather than spending its photos first. A bundled hazard that resolved
      // counts as the observation (D189), as it does on the server.
      //
      // **Not for a draft found in `creating`, nor one that already has its Post id.** That draft's
      // create was already sent once — the ack was lost, or the create went through and a later step
      // (a condition alert) lost signal; its photos are spent, and the server's idempotent
      // short-circuit (D30) is the only thing that can tell "posted at day 6.9, retried at 7.1" from
      // "never posted" — refusing it here would show an error for a post that is live, and invite a
      // second by hand.
      if (!createSent) {
        const refusal = formCreateRefusal(validation.normalized, attachHazardIds.length, now);
        if (refusal !== null) throw new PermanentFlushError(leg(r, refusal));
      }

      checked.push({ report: r, input, waterBodyId, attachHazardIds });
    }

    // Pass two — the uploads and the track, each checkpointed; nothing here can refuse the Post,
    // only fail transiently, so a retry resumes from the checkpoint rather than re-spending.
    const prepared: Parameters<PostFlushEffects['createPost']>[0]['reports'] = [];
    for (const { report, input, waterBodyId, attachHazardIds } of checked) {
      let r = report;

      // 4. Upload photos, checkpointing each storageId / photoId the instant it lands (so a partial
      //    failure keeps what uploaded and a retry reuses it — the durable form of web's in-memory
      //    recording). A photo with a `photoId` is already fully done from a prior attempt.
      const photoIds: string[] = [];
      for (const photo of r.photos) {
        let p = photo;
        if (p.photoId === undefined) {
          let fullStorageId = p.fullStorageId;
          if (fullStorageId === undefined) {
            fullStorageId = await effects.uploadPhoto(p.fullUri);
            p = { ...p, fullStorageId };
            r = { ...r, photos: replacePhoto(r.photos, p) };
            await saveReport(r);
          }
          let thumbStorageId = p.thumbStorageId;
          if (thumbStorageId === undefined) {
            thumbStorageId = await effects.uploadPhoto(p.thumbUri);
            p = { ...p, thumbStorageId };
            r = { ...r, photos: replacePhoto(r.photos, p) };
            await saveReport(r);
          }
          const photoId = await effects.createPhotoRow({
            storageId: fullStorageId,
            thumbStorageId,
            placeOnMap: p.placeOnMap,
            coord: photoUploadCoord(p.placeOnMap, p.coord),
          });
          p = { ...p, photoId };
          r = { ...r, photos: replacePhoto(r.photos, p) };
          await saveReport(r);
          photoIds.push(photoId);
        } else {
          photoIds.push(p.photoId);
        }
      }

      // 5. Resolve a linked recorded track to its server id (Phase 08). Best-effort by design: a
      //    track that can't be sent must not hold back the report, so a null resolution drops the path.
      let activityId = r.activityId;
      if (activityId === undefined && r.trackDraftId !== undefined && effects.resolveActivityId) {
        activityId = (await effects.resolveActivityId(r.trackDraftId)) ?? undefined;
        if (activityId !== undefined) {
          r = { ...r, activityId };
          await saveReport(r);
        }
      }

      prepared.push({
        ...input,
        waterBodyId,
        idempotencyKey: r.idempotencyKey,
        photoIds,
        ...(activityId !== undefined ? { activityId } : {}),
        ...(attachHazardIds.length > 0 ? { attachHazardIds } : {}),
      });
    }

    // 6. Create the Post — idempotent on the draft's key, so a lost-ack retry returns the same one.
    await save({ status: 'creating' });
    const { postId, reportIds } = await effects.createPost({
      idempotencyKey: d.idempotencyKey,
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.body !== undefined ? { body: d.body } : {}),
      reports: prepared,
    });
    await save({ postId, reportIds });

    // 7. The condition alerts (D197 / §7.2), now that each Report has an id to be their provenance.
    //    Checkpointed by reason so a retry files only what is missing. A server refusal on one — a
    //    put-in a moderator hid since — skips it: the Post is live, and a plank nobody can file is
    //    not a reason to show the skater an error for a post that went through. A network failure
    //    throws as transient like any other, and the retry re-enters through the idempotent create.
    if (effects.createAccessAlert) {
      for (const [i, r] of d.reports.entries()) {
        if (r.sheet === undefined) continue;
        const reportId = reportIds[i];
        if (reportId === undefined) continue;
        const filed = new Set(r.filedAccessReasons ?? []);
        for (const filing of accessConditionFilings(r.sheet)) {
          if (filed.has(filing.reason)) continue;
          try {
            await effects.createAccessAlert({
              ...filing,
              reportId,
              idempotencyKey: accessConditionKey(r.idempotencyKey, filing.reason),
            });
          } catch (error) {
            if (classifyFlushError(error) === 'transient') throw error;
          }
          filed.add(filing.reason);
          await saveReport({ ...r, filedAccessReasons: [...filed] });
        }
      }
    }

    // 8. The Post's own photos that went to a put-in or a lot (A10-7): uploaded like a Report's,
    //    checkpointed the same way, then attached as an access photo (A06d) — a refusal (the cap, a
    //    launch a moderator hid since) is skipped, as a condition alert's is: the Post is live.
    if (effects.attachAccessPhoto) {
      for (const photo of d.photos ?? []) {
        const target = photo.attachTo;
        if (target === undefined || photo.attachedAccess === true) continue;
        let p = photo;
        const savePool = async (): Promise<void> => {
          await save({ photos: (d.photos ?? []).map((q) => (q.id === p.id ? p : q)) });
        };
        if (p.photoId === undefined) {
          let fullStorageId = p.fullStorageId;
          if (fullStorageId === undefined) {
            fullStorageId = await effects.uploadPhoto(p.fullUri);
            p = { ...p, fullStorageId };
            await savePool();
          }
          let thumbStorageId = p.thumbStorageId;
          if (thumbStorageId === undefined) {
            thumbStorageId = await effects.uploadPhoto(p.thumbUri);
            p = { ...p, thumbStorageId };
            await savePool();
          }
          // Never placed and never located: it documents a launch, whose location is the launch's.
          const photoId = await effects.createPhotoRow({
            storageId: fullStorageId,
            thumbStorageId,
            placeOnMap: false,
          });
          p = { ...p, photoId };
          await savePool();
        }
        try {
          await effects.attachAccessPhoto({ photoId: p.photoId as string, target });
        } catch (error) {
          if (classifyFlushError(error) === 'transient') throw error;
        }
        p = { ...p, attachedAccess: true };
        await savePool();
      }
    }

    await save({ status: 'done' });
    return { ok: true, draft: d, postId, reportIds };
  } catch (error) {
    const kind = classifyFlushError(error);
    const message = flushErrorMessage(error);
    // Permanent → park in `error` for the user; transient → back to `pending` for the next flush —
    // except a create that was sent and never answered (`creating`, no Post id yet), which stays
    // `creating`: that is the one fact the retry's create-only check above reads to know it must
    // leave the draft to the server's dedup, and resetting it to `pending` would let a lost ack at
    // day 6.9 be refused at day 7.1 for a Post that is already live. Still flushable (`isFlushable`).
    const sentUnanswered = d.status === 'creating' && d.postId === undefined;
    await save({
      status: kind === 'permanent' ? 'error' : sentUnanswered ? 'creating' : 'pending',
      errorMessage: kind === 'permanent' ? message : undefined,
    });
    return { ok: false, draft: d, kind, message };
  }
}

/**
 * The *Waiting to send* line (A10 §9.2) — the promise the queue makes, worded once. `offline` is
 * the one that matters: it has to say that closing the app is fine, because the fear it answers is
 * "if I leave this screen my report is gone".
 */
export const WAITING_TO_SEND_COPY = {
  offline:
    "No signal. Everything here is saved on your phone and sends on its own when you're back in range — it's safe to close the app.",
  online: 'Back online — sending now. Anything that needs attention stays here until you fix it.',
} as const;

/** A queued Post's one-line label: its title, else its lakes in the author's order. */
export function postDraftLabel(draft: PostDraft): string {
  if (draft.title) return draft.title;
  const names = draft.reports.map((r) => r.bodyName ?? 'Unknown lake');
  return names.join(' · ');
}
