import { describe, expect, it, vi } from 'vitest'
import type { LatLng } from './geometry'
import { pointRadiusShape } from './hazardGeometry'
import {
  createQueuedConfirmation,
  createQueuedHazard,
  flushableHazardItems,
  flushHazardItem,
  type HazardFlushEffects,
  type HazardQueueItem,
  isHazardItemFlushable,
  type QueuedHazard,
} from './hazardQueue'

const AT: LatLng = { lat: 44.4759, lng: -73.2121 }
const NOW = Date.UTC(2026, 0, 10, 12, 0)
const SHAPE = pointRadiusShape(AT, 40)

function effects(overrides: Partial<HazardFlushEffects> = {}) {
  const persisted: HazardQueueItem[] = []
  const eff: HazardFlushEffects = {
    resolveBody: vi.fn(async () => 'body1'),
    uploadPhoto: vi.fn(async (uri: string) => `storage-${uri}`),
    createPhotoRow: vi.fn(async () => 'photo1'),
    createHazard: vi.fn(async () => 'hazard1'),
    confirmHazard: vi.fn(async () => {}),
    persist: vi.fn(async (item: HazardQueueItem) => {
      persisted.push(item)
    }),
    ...overrides,
  }
  return { eff, persisted }
}

function hazard(overrides: Partial<QueuedHazard> = {}): QueuedHazard {
  return {
    ...createQueuedHazard({
      id: 'q1',
      idempotencyKey: 'key-1',
      now: NOW,
      type: 'open_water',
      shape: SHAPE,
      waterBodyId: 'body1',
    }),
    ...overrides,
  }
}

describe('flushableHazardItems', () => {
  it('skips finished and permanently-failed items, oldest first', () => {
    const items: HazardQueueItem[] = [
      hazard({ id: 'b', createdAt: 2 }),
      hazard({ id: 'done', status: 'done' }),
      hazard({ id: 'err', status: 'error' }),
      hazard({ id: 'a', createdAt: 1 }),
    ]
    expect(flushableHazardItems(items).map((i) => i.id)).toEqual(['a', 'b'])
  })

  // An item found mid-flight at launch (app killed during a flush) must be picked up again, not
  // stranded — its checkpoints make the resume cheap.
  it('treats an interrupted in-flight item as flushable', () => {
    expect(isHazardItemFlushable(hazard({ status: 'uploading' }))).toBe(true)
    expect(isHazardItemFlushable(hazard({ status: 'creating' }))).toBe(true)
  })
})

describe('flushHazardItem — hazards', () => {
  it('creates the hazard and marks the item done', async () => {
    const { eff } = effects()
    const result = await flushHazardItem(hazard(), eff, NOW)
    expect(result.ok).toBe(true)
    expect(result.item.status).toBe('done')
    expect(eff.createHazard).toHaveBeenCalledWith(
      expect.objectContaining({ waterBodyId: 'body1', type: 'open_water', photoIds: [] }),
    )
  })

  // Two overlapping footprints read as two hazards and the confirm loop then has to retire both, so
  // the capture-time key has to survive every retry unchanged.
  it('sends the capture-time idempotency key, so a lost ack replays to the same pin', async () => {
    const { eff } = effects()
    const item = hazard()
    await flushHazardItem(item, eff, NOW)
    await flushHazardItem(item, eff, NOW + 60_000)
    const keys = (eff.createHazard as ReturnType<typeof vi.fn>).mock.calls.map(
      ([arg]) => arg.idempotencyKey,
    )
    expect(keys).toEqual(['key-1', 'key-1'])
  })

  it('resolves the lake from the capture coord when none was known on-device', async () => {
    const { eff } = effects()
    const item = hazard({ waterBodyId: undefined, coord: AT })
    const result = await flushHazardItem(item, eff, NOW)
    expect(eff.resolveBody).toHaveBeenCalledWith(AT)
    expect(result.ok).toBe(true)
  })

  it('parks permanently when the coord matches no known lake', async () => {
    const { eff } = effects({ resolveBody: vi.fn(async () => null) })
    const result = await flushHazardItem(hazard({ waterBodyId: undefined, coord: AT }), eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'permanent' })
    expect(result.item.status).toBe('error')
    expect(eff.createHazard).not.toHaveBeenCalled()
  })

  it('parks permanently when there is neither a lake nor a location', async () => {
    const { eff } = effects()
    const result = await flushHazardItem(hazard({ waterBodyId: undefined }), eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'permanent' })
  })

  // A shape the server would reject is broken, not offline — fail before spending uploads on it.
  it('rejects an incomplete shape before uploading anything', async () => {
    const { eff } = effects()
    const broken = hazard({
      shape: { geometryKind: 'line', geometry: { type: 'LineString', coordinates: [] } },
    })
    const result = await flushHazardItem(broken, eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'permanent' })
    expect(eff.uploadPhoto).not.toHaveBeenCalled()
    expect(eff.createHazard).not.toHaveBeenCalled()
  })

  // A dropped connection must not park the item — that's what the next flush is for.
  it('returns to pending on a transient failure', async () => {
    const { eff } = effects({
      createHazard: vi.fn(async () => {
        throw new Error('network request failed')
      }),
    })
    const result = await flushHazardItem(hazard(), eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'transient' })
    expect(result.item.status).toBe('pending')
    expect(result.item.errorMessage).toBeUndefined()
  })

  it('parks on a server rejection', async () => {
    const convexError = Object.assign(new Error('Users under 18 cannot post hazards'), {
      name: 'ConvexError',
    })
    const { eff } = effects({
      createHazard: vi.fn(async () => {
        throw convexError
      }),
    })
    const result = await flushHazardItem(hazard(), eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'permanent' })
    expect(result.item.errorMessage).toContain('under 18')
  })

  it('persists after every advance, so an interruption anywhere leaves a resumable item', async () => {
    const { eff, persisted } = effects()
    await flushHazardItem(hazard(), eff, NOW)
    expect(persisted.map((p) => p.status)).toEqual(['uploading', 'creating', 'done'])
  })
})

describe('flushHazardItem — photos', () => {
  const photo = {
    id: 'p1',
    fullUri: 'file://full.jpg',
    thumbUri: 'file://thumb.jpg',
    placeOnMap: false,
  }

  it('uploads and attaches a photo', async () => {
    const { eff } = effects()
    const result = await flushHazardItem(hazard({ photos: [photo] }), eff, NOW)
    expect(result.ok).toBe(true)
    expect(eff.createHazard).toHaveBeenCalledWith(expect.objectContaining({ photoIds: ['photo1'] }))
  })

  // The whole point of checkpointing: a retry reuses what already uploaded instead of orphaning a
  // duplicate blob in storage.
  it('reuses an already-uploaded photo on retry rather than re-uploading', async () => {
    const { eff } = effects()
    const done = hazard({ photos: [{ ...photo, photoId: 'already' }] })
    await flushHazardItem(done, eff, NOW)
    expect(eff.uploadPhoto).not.toHaveBeenCalled()
    expect(eff.createHazard).toHaveBeenCalledWith(
      expect.objectContaining({ photoIds: ['already'] }),
    )
  })

  it('keeps the full upload when the thumb upload fails', async () => {
    const uploadPhoto = vi
      .fn()
      .mockResolvedValueOnce('storage-full')
      .mockRejectedValueOnce(new Error('offline'))
    const { eff } = effects({ uploadPhoto })
    const result = await flushHazardItem(hazard({ photos: [photo] }), eff, NOW)
    expect(result.ok).toBe(false)
    const photos = (result.item as QueuedHazard).photos
    expect(photos[0]?.fullStorageId).toBe('storage-full')
    expect(photos[0]?.thumbStorageId).toBeUndefined()
  })
})

describe('flushHazardItem — confirmations', () => {
  it('sends the verdict and marks it done', async () => {
    const { eff } = effects()
    const item = createQueuedConfirmation({
      id: 'c1',
      now: NOW,
      hazardId: 'h1',
      verdict: 'still_there',
    })
    const result = await flushHazardItem(item, eff, NOW)
    expect(result.ok).toBe(true)
    expect(eff.confirmHazard).toHaveBeenCalledWith(
      expect.objectContaining({ hazardId: 'h1', verdict: 'still_there' }),
    )
  })

  // The reason `observedAt` exists at all: a confirmation that sends hours later must stamp when the
  // skater stood there, not when the phone found signal — otherwise a stale hazard looks freshly
  // verified by someone who was nowhere near it.
  it('stamps when the skater observed it, not when it finally sent', async () => {
    const { eff } = effects()
    const observedAt = NOW - 4 * 3_600_000
    const item = createQueuedConfirmation({
      id: 'c1',
      now: NOW,
      hazardId: 'h1',
      verdict: 'still_there',
      observedAt,
    })
    await flushHazardItem(item, eff, NOW + 9_000_000)
    expect(eff.confirmHazard).toHaveBeenCalledWith(expect.objectContaining({ observedAt }))
  })

  it('carries the coord the skater stood at, when there was one', async () => {
    const { eff } = effects()
    const item = createQueuedConfirmation({
      id: 'c1',
      now: NOW,
      hazardId: 'h1',
      verdict: 'fully_healed',
      atCoord: AT,
    })
    await flushHazardItem(item, eff, NOW)
    expect(eff.confirmHazard).toHaveBeenCalledWith(expect.objectContaining({ atCoord: AT }))
  })

  it('retries a dropped connection rather than parking the verdict', async () => {
    const { eff } = effects({
      confirmHazard: vi.fn(async () => {
        throw new Error('timeout')
      }),
    })
    const item = createQueuedConfirmation({
      id: 'c1',
      now: NOW,
      hazardId: 'h1',
      verdict: 'healing_unsafe',
    })
    const result = await flushHazardItem(item, eff, NOW)
    expect(result).toMatchObject({ ok: false, kind: 'transient' })
    expect(result.item.status).toBe('pending')
  })

  it('never touches the hazard-creation path', async () => {
    const { eff } = effects()
    const item = createQueuedConfirmation({
      id: 'c1',
      now: NOW,
      hazardId: 'h1',
      verdict: 'still_there',
    })
    await flushHazardItem(item, eff, NOW)
    expect(eff.createHazard).not.toHaveBeenCalled()
    expect(eff.resolveBody).not.toHaveBeenCalled()
  })
})
