/**
 * The offline hazard queue (Phase 9 offline) — the pure half of "flag it now, send it later".
 *
 * Reuses the F2 report-queue contract rather than inventing a second one: same `DraftStatus`
 * machine, same transient-vs-permanent classification, same "persist after every advance" rule, so
 * one flush loop drains all three kinds and there's a single definition of what a retry does.
 *
 * **Why this matters more for hazards than for reports.** A report written offline is written from a
 * lake you've left. A hazard is flagged *while standing next to it*, which is exactly when there's no
 * signal — so the offline path isn't a fallback here, it's the common case. Two consequences shape
 * the design:
 *
 * 1. **Duplicates are worse than for reports.** Two overlapping footprints read as two hazards, and
 *    the confirm loop then has to retire both. So a queued hazard carries an `idempotencyKey` from
 *    capture and keeps it across every retry; the server returns the original on a lost-ack replay.
 * 2. **A confirmation records when you *stood there*, not when it sent.** `observedAt` is stamped at
 *    capture and passed through the flush, because a confirmation that surfaces hours later must not
 *    reset the hazard's freshness clock to the moment the phone found signal. Getting that backwards
 *    would make a stale hazard look freshly verified by someone who was nowhere near it.
 */

import type { DraftPhoto, DraftStatus, FlushErrorKind } from './draftQueue';
import { classifyFlushError, PermanentFlushError } from './draftQueue';
import type { LatLng } from './geometry';
import { type HazardShape, isValidHazardShape } from './hazardGeometry';
import type { HazardVerdict } from './hazardLifecycle';
import type { HazardType } from './types';

/**
 * The verdict, as the confirm mutation takes it (D52 + D65's `never_existed`).
 *
 * Deliberately a re-declaration rather than an import of `HazardVerdict`: this is the wire shape of a
 * row already sitting in a phone's SQLite queue, so widening it is a decision about what an *older*
 * build may have written, not just about what the server accepts today. Adding a verdict is safe in
 * that direction — an old client never wrote one — and it keeps the offline path able to carry the
 * new one the moment the drawer offers it.
 */
export type QueuedVerdict = 'still_there' | 'healing_unsafe' | 'fully_healed' | 'never_existed';

/**
 * The re-declaration is deliberate; **drifting from it is not.** These two lines fail to compile if
 * the wire shape and the live vocabulary stop agreeing in either direction — a verdict the server
 * accepts that the queue can't carry, or one the queue can write that the server would reject.
 *
 * That is the whole value of writing it twice: the duplication is a *statement* that an old build's
 * rows are still readable, and an assertion is what stops it decaying into an oversight. Widening
 * stays safe (an old client never wrote the new value); if a verdict is ever *removed*, the second
 * line breaks here and the decision about already-queued rows gets made deliberately.
 */
type _QueuedVerdictCoversLive = HazardVerdict extends QueuedVerdict ? true : never;
type _LiveCoversQueuedVerdict = QueuedVerdict extends HazardVerdict ? true : never;

/**
 * How a queued confirmation was triggered — mirrors the backend `HAZARD_CONFIRM_VIA` enum. Carried on
 * the queue item so the origin survives an offline round-trip: a confirmation cast from the proximity
 * banner (`proximity_alert`, standing within alert range — strong evidence) must not be indistinguishable
 * from one tapped in the hazard drawer (`app_open_nearby`) after the queue drains. D50 will weigh these.
 */
export type QueuedConfirmVia =
  | 'app_open_nearby'
  | 'proximity_alert'
  | 'report_flow'
  | 'strava_path'
  | 'duplicate_nudge';

/** A hazard captured on the ice, waiting for signal. */
export interface QueuedHazard {
  kind: 'hazard';
  id: string;
  /** Client-generated at capture, carried across every flush retry (server dedup). */
  idempotencyKey: string;
  status: DraftStatus;
  errorMessage?: string;
  /** Resolved locally at capture via the Layer-2 body cache; absent ⇒ resolved from `coord` at flush. */
  waterBodyId?: string;
  /** Device GPS at capture — resolves the lake at flush when `waterBodyId` is absent. */
  coord?: LatLng;
  type: HazardType;
  shape: HazardShape;
  description?: string;
  /**
   * Photos, flushed through the same checkpointed upload path as report photos.
   *
   * The on-ice capture UI doesn't attach photos yet, so in practice this is empty today — the field
   * exists now so adding the camera later is a UI change rather than an on-device schema migration,
   * the same discipline `bodyCache` uses for its future tile-pack column.
   */
  photos: DraftPhoto[];
  capturedAt: number;
  /**
   * The pin the draw-time nudge offered and this skater said was a **different** hazard (N5c / D80).
   *
   * **Queued rather than dropped, and that is the whole point of the field existing.** The nudge fires
   * hardest exactly where there is no signal — two skaters, one ridge, both flagging it — so the
   * offline path is where a dismissal is most likely to be made and, without this, most likely to be
   * lost. A pin that flushes an hour later without it would be auto-merged into the very hazard the
   * skater looked at and rejected: the machine overruling a person who was standing on the ice, which
   * is the one thing `dismissedDuplicateOf` exists to prevent.
   *
   * Same discipline as `capturedAt` and a confirmation's `observedAt`: what the skater decided on the
   * ice must survive the round trip to signal unchanged.
   */
  dismissedDuplicateOf?: string;
  createdAt: number;
  updatedAt: number;
}

/** A three-tier confirmation cast on the ice, waiting for signal. */
export interface QueuedHazardConfirmation {
  kind: 'hazard_confirmation';
  id: string;
  status: DraftStatus;
  errorMessage?: string;
  hazardId: string;
  verdict: QueuedVerdict;
  /** The trigger that produced this vote, preserved across the offline round-trip (D50 evidence). */
  via: QueuedConfirmVia;
  atCoord?: LatLng;
  /** When the skater actually observed it — see the module note on why this isn't the send time. */
  observedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type HazardQueueItem = QueuedHazard | QueuedHazardConfirmation;

/** Still needs sending unless it's already `done` or parked in a permanent `error`. */
export function isHazardItemFlushable(item: HazardQueueItem): boolean {
  return item.status !== 'done' && item.status !== 'error';
}

/** The flushable subset, oldest first (capture order) — the reconnect-flush work list. */
export function flushableHazardItems(items: readonly HazardQueueItem[]): HazardQueueItem[] {
  return items.filter(isHazardItemFlushable).sort((a, b) => a.createdAt - b.createdAt);
}

export function createQueuedHazard(args: {
  id: string;
  idempotencyKey: string;
  now: number;
  type: HazardType;
  shape: HazardShape;
  waterBodyId?: string;
  coord?: LatLng;
  description?: string;
  photos?: DraftPhoto[];
  capturedAt?: number;
  dismissedDuplicateOf?: string;
}): QueuedHazard {
  return {
    kind: 'hazard',
    id: args.id,
    idempotencyKey: args.idempotencyKey,
    status: 'pending',
    waterBodyId: args.waterBodyId,
    coord: args.coord,
    type: args.type,
    shape: args.shape,
    description: args.description,
    photos: args.photos ?? [],
    capturedAt: args.capturedAt ?? args.now,
    dismissedDuplicateOf: args.dismissedDuplicateOf,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

export function createQueuedConfirmation(args: {
  id: string;
  now: number;
  hazardId: string;
  verdict: QueuedVerdict;
  via: QueuedConfirmVia;
  atCoord?: LatLng;
  observedAt?: number;
}): QueuedHazardConfirmation {
  return {
    kind: 'hazard_confirmation',
    id: args.id,
    status: 'pending',
    hazardId: args.hazardId,
    verdict: args.verdict,
    via: args.via,
    atCoord: args.atCoord,
    observedAt: args.observedAt ?? args.now,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** External effects, injected so the orchestration is testable with fakes (as `DraftFlushEffects`). */
export interface HazardFlushEffects {
  resolveBody(coord: LatLng): Promise<string | null>;
  uploadPhoto(localUri: string): Promise<string>;
  createPhotoRow(input: {
    storageId: string;
    thumbStorageId: string;
    placeOnMap: boolean;
    coord?: LatLng;
  }): Promise<string>;
  createHazard(input: {
    waterBodyId: string;
    idempotencyKey: string;
    type: HazardType;
    shape: HazardShape;
    description?: string;
    photoIds: string[];
    // The on-ice capture moment, forwarded so a draft that flushes after the skate ends is still
    // stamped `firstReportedAt` at capture time — the D55 auto-bundle keys on it. Analogous to a
    // confirmation's `observedAt`: neither must reset to signal-recovery time.
    capturedAt: number;
    /** Carried so a dismissal made offline still blocks the merge it was made about (D80). */
    dismissedDuplicateOf?: string;
  }): Promise<string>;
  confirmHazard(input: {
    hazardId: string;
    verdict: QueuedVerdict;
    via: QueuedConfirmVia;
    atCoord?: LatLng;
    observedAt: number;
  }): Promise<void>;
  persist(item: HazardQueueItem): Promise<void>;
}

export type HazardFlushResult =
  | { ok: true; item: HazardQueueItem; hazardId?: string }
  | { ok: false; item: HazardQueueItem; kind: FlushErrorKind; message: string };

function replacePhoto(photos: readonly DraftPhoto[], updated: DraftPhoto): DraftPhoto[] {
  return photos.map((p) => (p.id === updated.id ? updated : p));
}

/**
 * Flush one queued item. Never throws: a failure is classified and the item parked (`error` =
 * permanent, needs the user; `pending` = transient, retried on the next flush) and returned.
 */
export async function flushHazardItem(
  item: HazardQueueItem,
  effects: HazardFlushEffects,
  now: number,
): Promise<HazardFlushResult> {
  let current: HazardQueueItem = item;
  const save = async (patch: Partial<QueuedHazard> & Partial<QueuedHazardConfirmation>) => {
    current = { ...current, ...patch, updatedAt: now } as HazardQueueItem;
    await effects.persist(current);
  };

  try {
    await save({ status: 'uploading', errorMessage: undefined });

    if (current.kind === 'hazard_confirmation') {
      await save({ status: 'creating' });
      const c = current as QueuedHazardConfirmation;
      // `observedAt` is the capture moment, not `now` — a confirmation that sends hours later must
      // not reset the hazard's freshness clock to when the phone found signal.
      await effects.confirmHazard({
        hazardId: c.hazardId,
        verdict: c.verdict,
        via: c.via,
        ...(c.atCoord ? { atCoord: c.atCoord } : {}),
        observedAt: c.observedAt,
      });
      await save({ status: 'done' });
      return { ok: true, item: current };
    }

    const h = current as QueuedHazard;

    // 1. Resolve the lake — the id captured on-device, else the coord at flush time.
    let waterBodyId = h.waterBodyId;
    if (waterBodyId === undefined) {
      if (h.coord === undefined) {
        throw new PermanentFlushError('This hazard has no lake and no location to find one.');
      }
      const resolved = await effects.resolveBody(h.coord);
      if (resolved === null) {
        throw new PermanentFlushError("Couldn't match this hazard's location to a known lake.");
      }
      waterBodyId = resolved;
      await save({ waterBodyId });
    }

    // 2. Re-validate the geometry before spending any uploads on it. A shape the server will reject
    //    is permanently broken, not a network problem.
    if (!isValidHazardShape(h.shape)) {
      throw new PermanentFlushError('This hazard’s shape is incomplete.');
    }

    // 3. Photos, checkpointing each id the instant it lands so a partial failure keeps what uploaded.
    const photoIds: string[] = [];
    for (const original of h.photos) {
      let p = original;
      if (p.photoId === undefined) {
        let fullStorageId = p.fullStorageId;
        if (fullStorageId === undefined) {
          fullStorageId = await effects.uploadPhoto(p.fullUri);
          p = { ...p, fullStorageId };
          await save({ photos: replacePhoto((current as QueuedHazard).photos, p) });
        }
        let thumbStorageId = p.thumbStorageId;
        if (thumbStorageId === undefined) {
          thumbStorageId = await effects.uploadPhoto(p.thumbUri);
          p = { ...p, thumbStorageId };
          await save({ photos: replacePhoto((current as QueuedHazard).photos, p) });
        }
        const photoId = await effects.createPhotoRow({
          storageId: fullStorageId,
          thumbStorageId,
          placeOnMap: p.placeOnMap,
          ...(p.coord ? { coord: p.coord } : {}),
        });
        p = { ...p, photoId };
        await save({ photos: replacePhoto((current as QueuedHazard).photos, p) });
        photoIds.push(photoId);
      } else {
        photoIds.push(p.photoId);
      }
    }

    // 4. Create — idempotent on the capture-time key, so a lost ack replays to the same pin.
    await save({ status: 'creating' });
    const hazardId = await effects.createHazard({
      waterBodyId,
      idempotencyKey: h.idempotencyKey,
      type: h.type,
      shape: h.shape,
      ...(h.description !== undefined ? { description: h.description } : {}),
      photoIds,
      capturedAt: h.capturedAt,
      // The skater already answered this question, on the ice, before they lost signal.
      ...(h.dismissedDuplicateOf !== undefined
        ? { dismissedDuplicateOf: h.dismissedDuplicateOf }
        : {}),
    });
    await save({ status: 'done' });
    return { ok: true, item: current, hazardId };
  } catch (error) {
    const kind = classifyFlushError(error);
    const message = error instanceof Error ? error.message : String(error);
    await save({
      status: kind === 'permanent' ? 'error' : 'pending',
      errorMessage: kind === 'permanent' ? message : undefined,
    });
    return { ok: false, item: current, kind, message };
  }
}
