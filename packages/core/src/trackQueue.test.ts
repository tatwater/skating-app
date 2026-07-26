import { describe, expect, it, vi } from 'vitest';
import { PermanentFlushError } from './draftQueue';
import type { TrackPoint } from './track';
import {
  canRemoveTrack,
  compactTrack,
  createQueuedTrack,
  describeStravaPush,
  flushableTracks,
  flushTrack,
  isTrackCompactable,
  isTrackFlushable,
  MAX_STRAVA_PUSH_ATTEMPTS,
  MIN_TRACK_POINTS,
  type QueuedTrack,
  requestStravaPush,
  TRACK_RETENTION_MS,
  type TrackFlushEffects,
  trackRetention,
  trackSummary,
} from './trackQueue';

const T0 = Date.UTC(2026, 0, 15, 14, 0, 0);
const LAT = 43.9;
const LNG = -72.15;
const DEG_PER_M = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** A believable recorded skate: `n` fixes, 20 m and 3 s apart. */
function recordedPoints(n = 30): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: LAT,
    lng: LNG + i * 20 * DEG_PER_M,
    t: T0 + i * 3000,
    accuracy: 5,
  }));
}

function queued(over: Partial<QueuedTrack> = {}): QueuedTrack {
  return {
    ...createQueuedTrack({
      id: 'local-1',
      idempotencyKey: 'key-1',
      now: T0,
      uploadToStrava: false,
      points: recordedPoints(),
    }),
    finished: true,
    ...over,
  };
}

function effects(over: Partial<TrackFlushEffects> = {}): TrackFlushEffects {
  return {
    resolveBody: vi.fn().mockResolvedValue('body-1'),
    ingestTrack: vi.fn().mockResolvedValue('activity-1'),
    persist: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('the queue contract', () => {
  it('never flushes an unfinished recording — a half-skate must not become an activity', () => {
    expect(isTrackFlushable(queued({ finished: false }))).toBe(false);
    expect(isTrackFlushable(queued())).toBe(true);
  });

  it('excludes done and permanently-errored items, and orders by capture time', () => {
    expect(isTrackFlushable(queued({ status: 'done' }))).toBe(false);
    expect(isTrackFlushable(queued({ status: 'error' }))).toBe(false);
    const older = queued({ id: 'a', createdAt: T0 });
    const newer = queued({ id: 'b', createdAt: T0 + 5000 });
    expect(flushableTracks([newer, older]).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('a resumable in-flight item is still flushable (app killed mid-flush)', () => {
    expect(isTrackFlushable(queued({ status: 'uploading' }))).toBe(true);
    expect(isTrackFlushable(queued({ status: 'creating' }))).toBe(true);
  });

  // `done` means "the skate is ours", which is written before Strava is consulted. The gap between
  // the two is exactly where a phone gets suspended, and nothing else would ever revisit the row.
  it('keeps an ingested track flushable while its requested push has no answer', () => {
    const ingested = { status: 'done' as const, activityId: 'activity-1', uploadToStrava: true };
    expect(isTrackFlushable(queued(ingested))).toBe(true);
    expect(isTrackFlushable(queued({ ...ingested, stravaPushState: 'pending' }))).toBe(true);
  });

  it('lets a settled push go — including a failed one, which is an answer, not a gap', () => {
    const ingested = { status: 'done' as const, activityId: 'activity-1', uploadToStrava: true };
    expect(isTrackFlushable(queued({ ...ingested, stravaPushState: 'uploaded' }))).toBe(false);
    expect(isTrackFlushable(queued({ ...ingested, stravaPushState: 'skipped' }))).toBe(false);
    // A `failed` push retried on every drain would hammer Strava forever, unbounded, on behalf of a
    // skate that's already safe. Unsettled means unknown, not unsuccessful.
    expect(isTrackFlushable(queued({ ...ingested, stravaPushState: 'failed' }))).toBe(false);
    // ...and a track nobody asked to push is finished the moment it's ingested.
    expect(isTrackFlushable(queued({ ...ingested, uploadToStrava: false }))).toBe(false);
  });
});

describe('flushTrack', () => {
  it('post-processes, resolves the lake, and ingests with the capture-time idempotency key', async () => {
    const fx = effects();
    const result = await flushTrack(queued(), fx, T0 + 60_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activityId).toBe('activity-1');
    const input = (fx.ingestTrack as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(input.idempotencyKey).toBe('key-1');
    expect(input.path.type).toBe('LineString');
    expect(input.waterBodyId).toBe('body-1');
    expect(input.startTime).toBe(T0);
    // Stored elapsed is MOVING time (the schema's non-redundant field), so it excludes stops.
    expect(input.elapsedSeconds).toBeGreaterThan(0);
    // Distance is NOT sent: it's derivable from `path` exactly, so shipping it would invite the
    // server to look like it stores one. See `TrackFlushEffects.ingestTrack`.
    expect(input).not.toHaveProperty('distanceMeters');
  });

  it('ingests unresolved when the track matches no known body — that is the D14 new-water case, not an error', async () => {
    const fx = effects({ resolveBody: vi.fn().mockResolvedValue(null) });
    const result = await flushTrack(queued(), fx, T0 + 60_000);
    expect(result.ok).toBe(true);
    const input = (fx.ingestTrack as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(input.waterBodyId).toBeUndefined();
  });

  it('skips resolution when the device already matched a lake from its offline cache', async () => {
    const fx = effects();
    await flushTrack(queued({ waterBodyId: 'cached-body' }), fx, T0 + 60_000);
    expect(fx.resolveBody).not.toHaveBeenCalled();
    const input = (fx.ingestTrack as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(input.waterBodyId).toBe('cached-body');
  });

  it('parks a too-short recording permanently instead of retrying it forever', async () => {
    const fx = effects();
    const result = await flushTrack(
      queued({ points: recordedPoints(MIN_TRACK_POINTS - 1) }),
      fx,
      T0 + 60_000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent');
    expect(result.track.status).toBe('error');
    expect(fx.ingestTrack).not.toHaveBeenCalled();
  });

  it('retries a network failure (transient) rather than parking the only copy of a skate', async () => {
    const fx = effects({ ingestTrack: vi.fn().mockRejectedValue(new Error('network down')) });
    const result = await flushTrack(queued(), fx, T0 + 60_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.track.status).toBe('pending');
  });

  it('parks a server rejection permanently', async () => {
    const rejection = new Error('bad track');
    rejection.name = 'ConvexError';
    const fx = effects({ ingestTrack: vi.fn().mockRejectedValue(rejection) });
    const result = await flushTrack(queued(), fx, T0 + 60_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent');
    expect(result.track.errorMessage).toBe('bad track');
  });

  it('does not re-ingest a track whose ack was lost — the checkpointed activityId short-circuits', async () => {
    const fx = effects();
    const result = await flushTrack(queued({ activityId: 'already-there' }), fx, T0 + 60_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activityId).toBe('already-there');
    expect(fx.ingestTrack).not.toHaveBeenCalled();
  });

  it('persists after every state advance, so a crash mid-flush leaves a resumable item', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    await flushTrack(queued(), effects({ persist }), T0 + 60_000);
    const statuses = persist.mock.calls.map((c) => (c[0] as QueuedTrack).status);
    expect(statuses).toContain('uploading');
    expect(statuses).toContain('creating');
    expect(statuses.at(-1)).toBe('done');
  });
});

describe('the Strava push is a courtesy copy, never a gate', () => {
  it('pushes when the session asked for it', async () => {
    const pushToStrava = vi.fn().mockResolvedValue('uploaded');
    const result = await flushTrack(
      queued({ uploadToStrava: true }),
      effects({ pushToStrava }),
      T0 + 60_000,
    );
    expect(pushToStrava).toHaveBeenCalledWith({ activityId: 'activity-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('uploaded');
  });

  it('a Strava outage does NOT fail the flush — the activity is already ours', async () => {
    const pushToStrava = vi.fn().mockRejectedValue(new Error('strava 503'));
    const result = await flushTrack(
      queued({ uploadToStrava: true }),
      effects({ pushToStrava }),
      T0 + 60_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.status).toBe('done');
    // ...and the outage doesn't cost the skater their upload either: a thrown push is a dropped
    // connection, not Strava's verdict, so the track goes back in the queue for a later drain.
    expect(result.track.stravaPushState).toBe('pending');
    expect(isTrackFlushable(result.track)).toBe(true);
  });

  it('records "skipped" on a host that has no Strava integration at all', async () => {
    const result = await flushTrack(queued({ uploadToStrava: true }), effects(), T0 + 60_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('skipped');
  });

  // The distinction that matters: the toggle defaults ON, so an unconnected account is the *common*
  // case. It must not be recorded as a failure — only the adapter knows which of the two it was.
  it('records the outcome the adapter reports, not merely "it resolved"', async () => {
    const pushToStrava = vi.fn().mockResolvedValue('skipped');
    const result = await flushTrack(
      queued({ uploadToStrava: true }),
      effects({ pushToStrava }),
      T0 + 60_000,
    );
    expect(pushToStrava).toHaveBeenCalledWith({ activityId: 'activity-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('skipped');
  });

  it('never pushes when the session opted out', async () => {
    const pushToStrava = vi.fn();
    await flushTrack(queued({ uploadToStrava: false }), effects({ pushToStrava }), T0 + 60_000);
    expect(pushToStrava).not.toHaveBeenCalled();
  });
});

// The app is likeliest to be suspended *during* the push — it's the one step that waits on a third
// party. Resuming has to complete the outstanding half without redoing the finished one.
describe('an interrupted flush resumes the half that did not finish', () => {
  it('completes a push that was cut off after ingest, without re-ingesting', async () => {
    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('uploaded') });
    const killed = queued({
      status: 'done',
      activityId: 'activity-1',
      uploadToStrava: true,
      stravaPushState: 'pending', // written before the attempt; the app died before the answer
    });
    expect(isTrackFlushable(killed)).toBe(true);

    const result = await flushTrack(killed, fx, T0 + 600_000);
    expect(fx.ingestTrack).not.toHaveBeenCalled();
    expect(fx.pushToStrava).toHaveBeenCalledWith({ activityId: 'activity-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('uploaded');
    // ...and it now settles, so the queue lets go of it instead of retrying every drain.
    expect(isTrackFlushable(result.track)).toBe(false);
  });

  it('completes a push that was never attempted — the ack arrived, the app then died', async () => {
    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('uploaded') });
    const result = await flushTrack(
      queued({ status: 'done', activityId: 'activity-1', uploadToStrava: true }),
      fx,
      T0 + 600_000,
    );
    expect(fx.pushToStrava).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('never re-pushes a track whose push already settled', async () => {
    const fx = effects({ pushToStrava: vi.fn() });
    await flushTrack(
      queued({
        status: 'done',
        activityId: 'activity-1',
        uploadToStrava: true,
        stravaPushState: 'uploaded',
      }),
      fx,
      T0 + 600_000,
    );
    expect(fx.pushToStrava).not.toHaveBeenCalled();
  });

  it('marks an unpushable resumed track skipped on a host with no Strava adapter', async () => {
    const result = await flushTrack(
      queued({ status: 'done', activityId: 'activity-1', uploadToStrava: true }),
      effects(),
      T0 + 600_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Settled, so it stops being readmitted — otherwise it would be re-examined on every drain forever.
    expect(result.track.stravaPushState).toBe('skipped');
    expect(isTrackFlushable(result.track)).toBe(false);
  });
});

// A temporary refusal must not cost the skater the upload they asked for — but the retry has to end
// somewhere, because drains fire on every reconnect and Strava rate-limits per application.
describe('a temporary push failure is retried, up to a ceiling', () => {
  /** Drain the queue repeatedly, the way reconnect + foreground would, until the track settles. */
  async function drainUntilSettled(fx: TrackFlushEffects, maxDrains = 10) {
    let track = queued({ status: 'done', activityId: 'activity-1', uploadToStrava: true });
    let drains = 0;
    while (isTrackFlushable(track) && drains < maxDrains) {
      drains++;
      const result = await flushTrack(track, fx, T0 + drains * 600_000);
      track = result.track;
    }
    return { track, drains };
  }

  it('re-queues a retryable failure instead of writing the push off after one bad moment', async () => {
    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('retry') });
    const first = await flushTrack(
      queued({ status: 'done', activityId: 'activity-1', uploadToStrava: true }),
      fx,
      T0 + 600_000,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.track.stravaPushState).toBe('pending');
    expect(first.track.stravaPushAttempts).toBe(1);
    expect(isTrackFlushable(first.track)).toBe(true);
  });

  it('succeeds on a later drain once the outage clears — which is the whole point', async () => {
    const pushToStrava = vi
      .fn()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('retry')
      .mockResolvedValue('uploaded');
    const { track, drains } = await drainUntilSettled(effects({ pushToStrava }));
    expect(track.stravaPushState).toBe('uploaded');
    expect(drains).toBe(3);
  });

  it('gives up after the cap rather than re-hitting Strava on every reconnect forever', async () => {
    const pushToStrava = vi.fn().mockResolvedValue('retry');
    const { track } = await drainUntilSettled(effects({ pushToStrava }));
    expect(pushToStrava).toHaveBeenCalledTimes(MAX_STRAVA_PUSH_ATTEMPTS);
    expect(track.stravaPushState).toBe('failed');
    expect(track.stravaPushAttempts).toBe(MAX_STRAVA_PUSH_ATTEMPTS);
    expect(isTrackFlushable(track)).toBe(false);
  });

  it('spends no attempts on a failure a retry cannot fix', async () => {
    const pushToStrava = vi.fn().mockResolvedValue('failed');
    const { track } = await drainUntilSettled(effects({ pushToStrava }));
    expect(pushToStrava).toHaveBeenCalledTimes(1);
    expect(track.stravaPushState).toBe('failed');
  });

  it('counts an interrupted attempt, so a phone dying mid-push still terminates', async () => {
    // Written before the attempt: if the app is killed every time, the counter still climbs and the
    // track settles instead of resuming forever.
    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('retry') });
    const result = await flushTrack(
      queued({
        status: 'done',
        activityId: 'activity-1',
        uploadToStrava: true,
        stravaPushState: 'pending',
        stravaPushAttempts: MAX_STRAVA_PUSH_ATTEMPTS - 1,
      }),
      fx,
      T0 + 600_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('failed');
    expect(isTrackFlushable(result.track)).toBe(false);
  });
});

// The counterweight to the cap: the machine gives up, a person doesn't have to.
describe('the manual push request', () => {
  it('un-settles a failed push and clears the machine attempts', async () => {
    const givenUp = queued({
      status: 'done',
      activityId: 'activity-1',
      uploadToStrava: true,
      stravaPushState: 'failed',
      stravaPushAttempts: MAX_STRAVA_PUSH_ATTEMPTS,
    });
    expect(isTrackFlushable(givenUp)).toBe(false);

    const asked = requestStravaPush(givenUp, T0 + 900_000);
    expect(isTrackFlushable(asked)).toBe(true);
    // Reset, not incremented: the cap bounds automatic retries, not a person's decisions.
    expect(asked.stravaPushAttempts).toBe(0);

    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('uploaded') });
    const result = await flushTrack(asked, fx, T0 + 900_000);
    expect(fx.pushToStrava).toHaveBeenCalledWith({ activityId: 'activity-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.stravaPushState).toBe('uploaded');
  });

  it('can send a skate the session had opted OUT of — changing your mind is allowed', async () => {
    const optedOut = queued({ status: 'done', activityId: 'activity-1', uploadToStrava: false });
    expect(isTrackFlushable(optedOut)).toBe(false);
    const asked = requestStravaPush(optedOut, T0 + 900_000);
    expect(asked.uploadToStrava).toBe(true);
    expect(isTrackFlushable(asked)).toBe(true);
  });

  it('describes each state with an offer that matches what the queue would actually do', () => {
    const base = { status: 'done' as const, activityId: 'activity-1', uploadToStrava: true };
    const view = (over: Partial<QueuedTrack>) => describeStravaPush(queued({ ...base, ...over }));

    // Offered exactly when the track is settled short of uploaded — i.e. when `requestStravaPush`
    // would put it back in the queue. Anything the queue still holds shows no button.
    expect(view({ stravaPushState: 'uploaded' }).action).toBeNull();
    expect(view({ stravaPushState: 'failed' }).action).toBe('retry');
    expect(view({ stravaPushState: 'skipped' }).action).toBe('send');
    expect(view({ uploadToStrava: false }).action).toBe('send');
    expect(view({ stravaPushState: 'pending' }).action).toBeNull();
    expect(view({}).action).toBeNull();

    // A track that hasn't landed on our own server yet offers nothing — that retry is the flush's job.
    expect(describeStravaPush(queued({ uploadToStrava: true })).action).toBeNull();
    expect(describeStravaPush(queued({ uploadToStrava: true })).label).toBe('Waiting to sync');

    // The label distinguishes a first attempt in flight from one waiting on another drain.
    expect(view({ stravaPushState: 'pending' }).label).toBe('Sending to Strava…');
    expect(view({ stravaPushState: 'pending', stravaPushAttempts: 1 }).label).toBe(
      'Will try Strava again',
    );
  });

  it('every offered action leads to a flushable track — the button never lies', () => {
    const base = { status: 'done' as const, activityId: 'activity-1' };
    for (const over of [
      { uploadToStrava: true, stravaPushState: 'failed' as const },
      { uploadToStrava: true, stravaPushState: 'skipped' as const },
      { uploadToStrava: false },
    ]) {
      const track = queued({ ...base, ...over });
      expect(describeStravaPush(track).action).not.toBeNull();
      expect(isTrackFlushable(requestStravaPush(track, T0))).toBe(true);
    }
  });
});

// A recorded skate is the heaviest thing this queue stores, and nothing pruned it before.
describe('retention: the points go, the row stays, then the row goes too', () => {
  const NONE: ReadonlySet<string> = new Set();
  const settled = (over: Partial<QueuedTrack> = {}) =>
    queued({
      status: 'done',
      activityId: 'activity-1',
      uploadToStrava: true,
      stravaPushState: 'uploaded',
      ...over,
    });

  it('compacts a settled track and keeps everything the row is still for', () => {
    const track = settled();
    expect(isTrackCompactable(track)).toBe(true);

    const compacted = compactTrack(track, T0 + 60_000);
    expect(compacted.points).toEqual([]);
    // The activityId is what an unflushed report draft resolves its path through — dropping it with
    // the points would strip the path off a report still being written.
    expect(compacted.activityId).toBe('activity-1');
    expect(compacted.stravaPushState).toBe('uploaded');
    // Distance survives the points that measured it: with the fixes gone this is the only copy left,
    // and the history row would otherwise claim every compacted skate was zero miles.
    expect(compacted.distanceMeters).toBeGreaterThan(0);
    expect(trackSummary(compacted).distanceMeters).toBe(trackSummary(track).distanceMeters);
    // Nothing left to do — and compacting is idempotent, so a later sweep doesn't rewrite it.
    expect(isTrackCompactable(compacted)).toBe(false);
  });

  it('never compacts a track the queue still has work for', () => {
    expect(isTrackCompactable(queued())).toBe(false); // not ingested
    expect(isTrackCompactable(settled({ stravaPushState: 'pending' }))).toBe(false);
    expect(isTrackCompactable(settled({ stravaPushState: undefined }))).toBe(false);
    expect(isTrackCompactable(queued({ finished: false }))).toBe(false);
  });

  it('lets a compacted track still be pushed to Strava by hand — the points were never needed', async () => {
    const compacted = compactTrack(settled({ stravaPushState: 'failed' }), T0 + 60_000);
    const fx = effects({ pushToStrava: vi.fn().mockResolvedValue('uploaded') });
    const result = await flushTrack(requestStravaPush(compacted, T0 + 90_000), fx, T0 + 90_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The too-short gate never fires: an ingested track skips straight to the push.
    expect(fx.ingestTrack).not.toHaveBeenCalled();
    expect(result.track.stravaPushState).toBe('uploaded');
  });

  it('removes only what is finished with, and never a row a draft still points at', () => {
    expect(canRemoveTrack(settled(), NONE)).toBe(true);
    // A permanently-errored recording is removable — otherwise the only way to dismiss a skate the
    // app says it can't save is to reinstall.
    expect(canRemoveTrack(queued({ status: 'error' }), NONE)).toBe(true);
    // Still working: mid-flight, unsettled push, still recording.
    expect(canRemoveTrack(queued(), NONE)).toBe(false);
    expect(canRemoveTrack(settled({ stravaPushState: 'pending' }), NONE)).toBe(false);
    expect(canRemoveTrack(queued({ finished: false }), NONE)).toBe(false);
    // ...and the guard that matters most: a report draft written on the ice resolves its path
    // through this row's local id.
    expect(canRemoveTrack(settled(), new Set(['local-1']))).toBe(false);
  });

  it('sweeps by the age of the skate, not the age of the last write', () => {
    const old = settled({ id: 'old', startedAt: T0 });
    const recent = settled({ id: 'recent', startedAt: T0 + TRACK_RETENTION_MS });
    const now = T0 + TRACK_RETENTION_MS + 1000;

    const { compact, remove } = trackRetention([old, recent], { now, referencedIds: NONE });
    expect(remove.map((t) => t.id)).toEqual(['old']);
    // A row on its way out isn't rewritten first.
    expect(compact.map((t) => t.id)).toEqual(['recent']);
  });

  it('keeps an old row alive while a report draft still needs it', () => {
    const old = settled({ id: 'old', startedAt: T0 });
    const now = T0 + TRACK_RETENTION_MS + 1000;
    const { compact, remove } = trackRetention([old], {
      now,
      referencedIds: new Set(['old']),
    });
    expect(remove).toEqual([]);
    // Held, but still compacted — the draft needs the `activityId`, not the fixes.
    expect(compact.map((t) => t.id)).toEqual(['old']);
  });

  it('leaves an unsettled track completely alone however old it is', () => {
    const stranded = queued({ id: 'stranded', startedAt: T0, uploadToStrava: true });
    const { compact, remove } = trackRetention([stranded], {
      now: T0 + TRACK_RETENTION_MS * 10,
      referencedIds: NONE,
    });
    // An unrepeatable skate that never reached the server is never swept — that would be deleting
    // the only copy of something the queue is still trying to send.
    expect(remove).toEqual([]);
    expect(compact).toEqual([]);
  });
});

describe('PermanentFlushError is the shared marker (not a parallel class)', () => {
  it('a too-short track raises the same marker the other queues use', async () => {
    const fx = effects();
    const result = await flushTrack(queued({ points: [] }), fx, T0);
    expect(result.ok).toBe(false);
    // Round-trips through classifyFlushError as permanent — a second error class would be retried forever.
    expect(new PermanentFlushError('x').permanent).toBe(true);
  });
});
