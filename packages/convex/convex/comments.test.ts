import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.*s')

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyFulfilled: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
}

async function seedUser(t: ReturnType<typeof convexTest>, subject: string, minor = false) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: minor ? Date.UTC(new Date().getUTCFullYear() - 16, 0, 1) : Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role: 'member' as const,
      status: 'active' as const,
      createdAt: Date.now(),
    }),
  )
  return { id, as: t.withIdentity({ subject }) }
}

async function seedBody(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'Lake Morey',
      type: 'lake' as const,
      source: 'osm' as const,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      bbox: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      centroid: { lat: 0.5, lng: 0.5 },
      dedupStatus: 'clean' as const,
      createdAt: Date.now(),
    }),
  )
}

async function seedReport(
  t: ReturnType<typeof convexTest>,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
  moderationStatus: 'visible' | 'hidden' | 'removed' = 'visible',
) {
  const now = Date.now()
  return t.run((ctx) =>
    ctx.db.insert('reports', {
      authorId,
      waterBodyId,
      point: { lat: 0.5, lng: 0.5 },
      skateEndTime: now,
      reportTime: now,
      source: 'native' as const,
      iceTypes: ['black_ice' as const],
      surfaceTags: [],
      photoIds: [],
      moderationStatus,
      hazardIdsCreated: [],
      createdAt: now,
      updatedAt: now,
    }),
  )
}

describe('comments.create', () => {
  test('requires authentication', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    await expect(t.mutation(api.comments.create, { reportId, body: 'hi' })).rejects.toThrow(
      /not authenticated/i,
    )
  })

  test('rejects a minor author (read-only, D41)', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const minor = await seedUser(t, 'm', true)
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    await expect(minor.as.mutation(api.comments.create, { reportId, body: 'hi' })).rejects.toThrow(
      /under 18/i,
    )
  })

  test('rejects an empty body and a comment on a hidden report', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const visible = await seedReport(t, author.id, body)
    const hidden = await seedReport(t, author.id, body, 'hidden')
    await expect(
      author.as.mutation(api.comments.create, { reportId: visible, body: '  ' }),
    ).rejects.toThrow(/between 1 and 2000/i)
    await expect(
      author.as.mutation(api.comments.create, { reportId: hidden, body: 'hi' }),
    ).rejects.toThrow(/report not found/i)
  })

  test('enforces the 2-level cap — a reply’s parent must be top-level (D25)', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const top = await author.as.mutation(api.comments.create, { reportId, body: 'top' })
    const reply = await author.as.mutation(api.comments.create, {
      reportId,
      parentCommentId: top,
      body: 'reply',
    })
    // Replying to a reply is rejected (client should flatten via resolveReplyParentId).
    await expect(
      author.as.mutation(api.comments.create, { reportId, parentCommentId: reply, body: 'deep' }),
    ).rejects.toThrow(/one level deep/i)
  })
})

describe('comments.listByReport', () => {
  test('returns a 2-level thread with author attribution', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const top = await author.as.mutation(api.comments.create, { reportId, body: 'top' })
    await author.as.mutation(api.comments.create, { reportId, parentCommentId: top, body: 'reply' })

    const thread = await author.as.query(api.comments.listByReport, { reportId })
    expect(thread).toHaveLength(1)
    expect(thread[0]?.comment?.body).toBe('top')
    expect(thread[0]?.comment?.author?.username).toBe('a')
    expect(thread[0]?.comment?.isOwn).toBe(true)
    expect(thread[0]?.replies[0]?.comment?.body).toBe('reply')
  })

  test('hides a blocked author’s comment but keeps the report visible (D3)', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const other = await seedUser(t, 'b')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    await other.as.mutation(api.comments.create, { reportId, body: 'from b' })

    // `a` blocks `b`. b's comment disappears for a…
    await author.as.mutation(api.blocks.block, { targetUserId: other.id })
    const thread = await author.as.query(api.comments.listByReport, { reportId })
    expect(thread).toHaveLength(0)
    // …but the report itself is untouched by the block (still returned by reports.get).
    const report = await author.as.query(api.reports.get, { reportId })
    expect(report).not.toBeNull()
  })

  test('renders a moderation-hidden parent with a visible reply as a [hidden] placeholder', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const top = await author.as.mutation(api.comments.create, { reportId, body: 'top' })
    await author.as.mutation(api.comments.create, { reportId, parentCommentId: top, body: 'reply' })
    // Author soft-removes the top-level comment.
    await author.as.mutation(api.comments.remove, { commentId: top })

    const thread = await author.as.query(api.comments.listByReport, { reportId })
    expect(thread).toHaveLength(1)
    expect(thread[0]?.hidden).toBe(true)
    expect(thread[0]?.comment).toBeNull() // no content leaked
    expect(thread[0]?.replies[0]?.comment?.body).toBe('reply')
  })
})

describe('comments.update / remove', () => {
  test('author-only edit stamps editedAt; a non-author is rejected', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const other = await seedUser(t, 'b')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'orig' })

    await author.as.mutation(api.comments.update, { commentId, body: 'edited' })
    const edited = await t.run((ctx) => ctx.db.get(commentId))
    expect(edited?.body).toBe('edited')
    expect(edited?.editedAt).toBeGreaterThan(0)

    await expect(
      other.as.mutation(api.comments.update, { commentId, body: 'hijack' }),
    ).rejects.toThrow(/only the author/i)
  })

  test('author soft-remove sets moderationStatus removed', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'bye' })
    await author.as.mutation(api.comments.remove, { commentId })
    const removed = await t.run((ctx) => ctx.db.get(commentId))
    expect(removed?.moderationStatus).toBe('removed')
  })

  test('a moderated (removed) comment can no longer be edited', async () => {
    const t = convexTest(schema, modules)
    const author = await seedUser(t, 'a')
    const body = await seedBody(t)
    const reportId = await seedReport(t, author.id, body)
    const commentId = await author.as.mutation(api.comments.create, { reportId, body: 'orig' })
    await author.as.mutation(api.comments.remove, { commentId })
    await expect(
      author.as.mutation(api.comments.update, { commentId, body: 'sneaky' }),
    ).rejects.toThrow(/moderated/i)
  })
})
