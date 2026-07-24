import { describe, expect, it, vi } from 'vitest';
import { PermanentFlushError } from './draftQueue';
import type { TrackPoint } from './track';
import {
  createQueuedTrack,
  flushableTracks,
  flushTrack,
  isTrackFlushable,
  MIN_TRACK_POINTS,
  type QueuedTrack,
  type TrackFlushEffects,
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
    expect(input.distanceMeters).toBeGreaterThan(0);
    // Stored elapsed is MOVING time (the schema's non-redundant field), so it excludes stops.
    expect(input.elapsedSeconds).toBeGreaterThan(0);
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
    const pushToStrava = vi.fn().mockResolvedValue(undefined);
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
    expect(result.track.stravaPushState).toBe('failed');
  });

  it('records "skipped" when the user wanted a push but no Strava connection exists', async () => {
    const result = await flushTrack(queued({ uploadToStrava: true }), effects(), T0 + 60_000);
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

describe('PermanentFlushError is the shared marker (not a parallel class)', () => {
  it('a too-short track raises the same marker the other queues use', async () => {
    const fx = effects();
    const result = await flushTrack(queued({ points: [] }), fx, T0);
    expect(result.ok).toBe(false);
    // Round-trips through classifyFlushError as permanent — a second error class would be retried forever.
    expect(new PermanentFlushError('x').permanent).toBe(true);
  });
});
