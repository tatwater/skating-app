/**
 * **The Corpus tasks' decisions** (B01-6a, `corpusWrites.ts`): `decideName` and `decideClass` through
 * their real mutations — each one transaction, the rule first and its words thrown, the domain write
 * through its own impl and that write's row the task's — and their undo through `api.undo.run`: a
 * round trip per inverse, the overtaken cases, the capability refusals. The rule on its own is
 * `lib/corpusRules.test.ts`.
 */

import { primaryReviewReason, REVIEW_REASONS, type ReviewReason } from '@skating/core';
import { convexTest } from 'convex-test';
import type { Polygon } from 'geojson';
import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { SHOWN_PICK } from './corpusWrites';
import { capturingAudit, writeAudit } from './lib/audit';
import { ALREADY_SHOWN, type CorpusVerb, corpusCan, NOT_A_CATALOG_NAME } from './lib/corpusRules';
import { NO_SUCH_TASK, syncBodyTasks, TASK_LEFT, taskKeyOf } from './lib/corpusTasks';
import {
  CORPUS_UNDO_HANDLERS,
  SETTLE_ASKED_AGAIN,
  SETTLE_NOT_FOUND,
} from './lib/undoHandlersCorpus';
import type { UndoWriters } from './lib/undoTypes';
import schema from './schema';

const modules = import.meta.glob('./**/*.*s');
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72, 44],
      [-72, 44.01],
      [-71.99, 44.01],
      [-71.99, 44],
      [-72, 44],
    ],
  ],
};

const NOTIF_PREFS = {
  activityDetected: true,
  bountyRequest: true,
  hazardConfirmation: true,
  bountyAnswered: true,
  reportRated: true,
  reportCommented: true,
  contentFlagResolved: true,
  favoriteReport: true,
  nearbyReportDigest: false,
  greatReportNearby: false,
  moderatorDecision: false,
};

async function seedUser(
  t: T,
  subject: string,
  role: Doc<'profiles'>['role'] = 'moderator',
  extra: Partial<Doc<'profiles'>> = {},
) {
  const id = await t.run((ctx) =>
    ctx.db.insert('profiles', {
      clerkUserId: subject,
      displayName: subject,
      username: subject,
      driveTimePrefMinutes: 60,
      profileVisibility: 'public' as const,
      notificationPrefs: NOTIF_PREFS,
      dateOfBirth: Date.UTC(1990, 0, 1),
      reputationPoints: 0,
      role,
      status: 'active' as const,
      createdAt: Date.now(),
      ...extra,
    }),
  );
  return { id, as: t.withIdentity({ subject }) };
}

/** A body carrying `reasons`, its tasks filed by the writer. */
async function seedBody(
  t: T,
  reasons: ReviewReason[],
  extra: Partial<Doc<'waterBodies'>> = {},
): Promise<Id<'waterBodies'>> {
  const id = await t.run((ctx) =>
    ctx.db.insert('waterBodies', {
      name: 'The Basin',
      searchText: 'The Basin Lake Auburn',
      type: 'lakePond',
      source: 'osm',
      polygon: SQUARE,
      bbox: { minLat: 44, minLng: -72, maxLat: 44.01, maxLng: -71.99 },
      centroid: { lat: 44.005, lng: -71.995 },
      surfaceAreaSqM: 900_000,
      dedupStatus: 'clean',
      createdAt: Date.now(),
      displayScore: 0.6,
      nameClaims: [
        { source: 'nhd', value: 'The Basin' },
        { source: 'osm', value: 'Lake Auburn' },
      ],
      classClaims: [
        { source: 'nhd', value: 'wetland', token: 'nhd:fcode=46600' },
        { source: 'osm', value: 'lakePond', token: 'osm:water=pond' },
      ],
      // As the import stores them: in the canonical order, the primary one surfaced.
      reviewReasons: REVIEW_REASONS.filter((r) => reasons.includes(r)),
      reviewReason: primaryReviewReason(reasons),
      ...extra,
    }),
  );
  await t.run((ctx) => syncBodyTasks(ctx, id));
  return id;
}

const taskOf = async (
  t: T,
  bodyId: Id<'waterBodies'>,
  reason: 'name-conflict' | 'class-conflict',
) =>
  t.run(async (ctx) => {
    const tasks = await ctx.db
      .query('corpusTasks')
      .withIndex('by_key', (q) => q.eq('key', taskKeyOf(reason, bodyId)))
      .collect();
    // The newest on the key: a re-asked question files a new task beside the decided one.
    const task = tasks.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!task) throw new Error(`no ${reason} task`);
    return task;
  });

const rowsOn = (t: T, bodyId: Id<'waterBodies'>) =>
  t.run((ctx) =>
    ctx.db
      .query('moderationActions')
      .filter((q) => q.eq(q.field('targetId'), bodyId))
      .collect(),
  );

const bodyOf = (t: T, id: Id<'waterBodies'>) => t.run((ctx) => ctx.db.get(id));

/** Reasons and settles, as the undo puts them back. */
const reasonsOf = (b: Doc<'waterBodies'> | null) => ({
  reviewReasons: b?.reviewReasons ?? [],
  reviewReason: b?.reviewReason,
  settled: (b?.reviewSettled ?? []).map((s) => s.reason),
});

describe('decideName', () => {
  test('a pick renames through the Body console’s own write, whose row decides the task', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');

    const result = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: ' lake auburn',
    });

    const after = await bodyOf(t, bodyId);
    expect(after?.name).toBe('Lake Auburn');
    // The refused name stays a claim, and searchable.
    expect(after?.nameClaims?.map((c) => c.value)).toContain('The Basin');
    expect(after?.searchText).toContain('The Basin');
    expect(reasonsOf(after)).toEqual({
      reviewReasons: [],
      reviewReason: undefined,
      settled: ['name-conflict'],
    });
    const rows = await rowsOn(t, bodyId);
    expect(rows.map((r) => r.action)).toEqual(['set_water_body_name']);
    const decided = await taskOf(t, bodyId, 'name-conflict');
    expect(decided).toMatchObject({
      status: 'decided',
      decision: 'renamed',
      decidedByUserId: mod.id,
      decisionActionId: rows[0]?._id,
    });
    expect(result).toEqual({
      taskId: task._id,
      actionId: rows[0]?._id,
      undoable: true,
      undoNeedsReason: false,
    });
  });

  test('Keep settles with its own row and leaves the name', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict', 'class-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');

    const result = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });

    const after = await bodyOf(t, bodyId);
    expect(after?.name).toBe('The Basin');
    // The next reason surfaces for the old readers; its own task stands in its own lane.
    expect(reasonsOf(after)).toEqual({
      reviewReasons: ['class-conflict'],
      reviewReason: 'class-conflict',
      settled: ['name-conflict'],
    });
    const rows = await rowsOn(t, bodyId);
    expect(rows.map((r) => [r.action, r.reason])).toEqual([
      ['settle_review_reason', 'Kept the name "The Basin"'],
    ]);
    expect(await taskOf(t, bodyId, 'name-conflict')).toMatchObject({
      status: 'decided',
      decision: 'kept',
      decisionActionId: rows[0]?._id,
    });
    expect((await taskOf(t, bodyId, 'class-conflict')).status).toBe('open');
    expect(result.actionId).toBe(rows[0]?._id);
    expect(result.undoable).toBe(true);
  });

  test('a pick that names no catalog’s name, or the one shown, writes nothing', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const before = await bodyOf(t, bodyId);

    await expect(
      mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: 'Auburn Reservoir' }),
    ).rejects.toThrow(NOT_A_CATALOG_NAME);
    await expect(
      mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: 'THE BASIN' }),
    ).rejects.toThrow(ALREADY_SHOWN);

    expect(await rowsOn(t, bodyId)).toEqual([]);
    expect(await bodyOf(t, bodyId)).toEqual(before);
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('open');
  });

  test('a second decision on a decided task meets the lock, in the decider’s name', async () => {
    const t = harness();
    const mod = await seedUser(t, 'Casey Example');
    const other = await seedUser(t, 'other');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    await mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: SHOWN_PICK });
    await expect(
      other.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: 'Lake Auburn' }),
    ).rejects.toThrow('Decided by Casey Example · kept');
    expect((await bodyOf(t, bodyId))?.name).toBe('The Basin');
  });
});

describe('decideClass', () => {
  test('a new class reclasses through setClass’s own write, whose row decides the task', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['class-conflict']);
    const task = await taskOf(t, bodyId, 'class-conflict');

    const result = await mod.as.mutation(api.corpusWrites.decideClass, {
      taskId: task._id,
      bodyClass: 'wetland',
    });

    const after = await bodyOf(t, bodyId);
    expect(after).toMatchObject({ type: 'wetland', moderatorClass: 'wetland' });
    const rows = await rowsOn(t, bodyId);
    expect(rows.map((r) => r.action)).toEqual(['set_class']);
    expect(await taskOf(t, bodyId, 'class-conflict')).toMatchObject({
      status: 'decided',
      decision: 'reclassed',
      decisionActionId: rows[0]?._id,
    });
    expect(result.actionId).toBe(rows[0]?._id);
  });

  test('the body’s own class is Keep, whatever the button said', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['class-conflict']);
    const task = await taskOf(t, bodyId, 'class-conflict');

    await mod.as.mutation(api.corpusWrites.decideClass, {
      taskId: task._id,
      bodyClass: 'lakePond',
    });

    const after = await bodyOf(t, bodyId);
    expect(after?.type).toBe('lakePond');
    expect(after?.moderatorClass).toBeUndefined();
    expect((await rowsOn(t, bodyId)).map((r) => r.action)).toEqual(['settle_review_reason']);
    expect((await taskOf(t, bodyId, 'class-conflict')).decision).toBe('kept');
  });
});

describe('the rule and the write say the same thing', () => {
  type Case = {
    name: string;
    role?: Doc<'profiles'>['role'];
    leaving?: boolean;
    setup?: (t: T, bodyId: Id<'waterBodies'>) => Promise<void>;
    names?: Doc<'waterBodies'>['nameClaims'];
  };
  const CASES: Case[] = [
    { name: 'allowed' },
    { name: 'a member', role: 'member' },
    { name: 'a staffer leaving', leaving: true },
    {
      name: 'decided',
      setup: async (t, bodyId) => {
        const by = await seedUser(t, 'Casey Example');
        for (const reason of ['name-conflict', 'class-conflict'] as const) {
          const task = await taskOf(t, bodyId, reason);
          await t.run((ctx) =>
            ctx.db.patch(task._id, { status: 'decided', decidedByUserId: by.id, decision: 'kept' }),
          );
        }
      },
    },
    {
      name: 'removed',
      setup: (t, bodyId) => t.run((ctx) => ctx.db.patch(bodyId, { removedAt: Date.now() })),
    },
    {
      name: 'merged away',
      setup: (t, bodyId) => t.run((ctx) => ctx.db.patch(bodyId, { dedupStatus: 'merged' })),
    },
    {
      name: 'left: no longer asked',
      setup: async (t, bodyId) => {
        for (const reason of ['name-conflict', 'class-conflict'] as const) {
          const task = await taskOf(t, bodyId, reason);
          await t.run((ctx) =>
            ctx.db.patch(task._id, { status: 'left', leftBecause: 'notAsserted' }),
          );
        }
      },
    },
    { name: 'no other catalog name', names: [{ source: 'nhd', value: 'The Basin' }] },
  ];

  /** Each verb and the arguments that ask it. */
  const VERBS: [CorpusVerb, 'decideName' | 'decideClass', Record<string, string>][] = [
    ['pickName', 'decideName', { pick: 'Lake Auburn' }],
    ['keepName', 'decideName', { pick: SHOWN_PICK }],
    ['setClass', 'decideClass', { bodyClass: 'wetland' }],
    ['keepClass', 'decideClass', { bodyClass: 'lakePond' }],
  ];

  test.each(CASES)(
    '$name: every verb the read allows succeeds, every one it refuses throws its words',
    async (c) => {
      for (const [verb, fn, args] of VERBS) {
        const t = harness();
        const viewer = await seedUser(t, 'viewer', c.role ?? 'moderator', {
          ...(c.leaving ? { deletionRequestedAt: Date.now() } : {}),
        });
        const bodyId = await seedBody(t, ['name-conflict', 'class-conflict'], {
          ...(c.names ? { nameClaims: c.names } : {}),
        });
        await c.setup?.(t, bodyId);
        const reason =
          verb === 'pickName' || verb === 'keepName' ? 'name-conflict' : 'class-conflict';
        const task = await taskOf(t, bodyId, reason);
        const said = await t.run(async (ctx) => {
          const v = await ctx.db.get(viewer.id);
          const b = await ctx.db.get(bodyId);
          return (await corpusCan(ctx, v as Doc<'profiles'>, task, b))[verb];
        });
        expect(said, `${c.name} / ${verb}`).not.toBeUndefined();
        const write = viewer.as.mutation(api.corpusWrites[fn], {
          taskId: task._id,
          ...args,
        } as never);
        if (said === null) {
          await expect(write, `${c.name} / ${verb}`).resolves.toMatchObject({ taskId: task._id });
        } else {
          await expect(write, `${c.name} / ${verb}`).rejects.toThrow(said);
          // A refusal writes nothing: no row, the task as it was.
          expect(await rowsOn(t, bodyId)).toEqual([]);
          expect(await taskOf(t, bodyId, reason)).toEqual(task);
        }
      }
    },
  );

  test('the capability refusal is requireCapability’s, and comes before the lock', async () => {
    const t = harness();
    const member = await seedUser(t, 'member', 'member');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    await t.run((ctx) => ctx.db.patch(task._id, { status: 'left', leftBecause: 'notAsserted' }));
    for (const pick of [SHOWN_PICK, 'Lake Auburn']) {
      await expect(
        member.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick }),
      ).rejects.toThrow('Requires moderator role');
    }
  });

  test('a task in another lane is refused by the lane, not the capability', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['class-conflict']);
    const task = await taskOf(t, bodyId, 'class-conflict');
    await expect(
      mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: SHOWN_PICK }),
    ).rejects.toThrow('This task isn’t a name conflict.');
  });

  test('a task that no longer exists is refused in its words, before the capability, writing nothing', async () => {
    const t = harness();
    const member = await seedUser(t, 'member', 'member');
    const bodyId = await seedBody(t, ['name-conflict', 'class-conflict']);
    const names = await taskOf(t, bodyId, 'name-conflict');
    const classes = await taskOf(t, bodyId, 'class-conflict');
    await t.run(async (ctx) => {
      await ctx.db.delete(names._id);
      await ctx.db.delete(classes._id);
    });
    // A member, so a capability check that came first would say so instead.
    await expect(
      member.as.mutation(api.corpusWrites.decideName, { taskId: names._id, pick: SHOWN_PICK }),
    ).rejects.toThrow(NO_SUCH_TASK);
    await expect(
      member.as.mutation(api.corpusWrites.decideClass, {
        taskId: classes._id,
        bodyClass: 'wetland',
      }),
    ).rejects.toThrow(NO_SUCH_TASK);
    expect(await rowsOn(t, bodyId)).toEqual([]);
  });

  test('an open task on a body deleted since says so', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    await t.run((ctx) => ctx.db.delete(bodyId));
    await expect(
      mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: SHOWN_PICK }),
    ).rejects.toThrow(TASK_LEFT.deleted);
  });
});

describe('undo: the domain inverse, then the task reopens', () => {
  /** Reasons, settles and the task, as they stood before any decision. */
  const openState = async (
    t: T,
    bodyId: Id<'waterBodies'>,
    reason: 'name-conflict' | 'class-conflict',
  ) => {
    const b = await bodyOf(t, bodyId);
    const task = await taskOf(t, bodyId, reason);
    return {
      reasons: reasonsOf(b),
      task: {
        status: task.status,
        facet: task.facet,
        decision: task.decision,
        decisionActionId: task.decisionActionId,
      },
    };
  };

  test('a rename’s undo puts the name back and asks the question again', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const before = await openState(t, bodyId, 'name-conflict');

    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: 'Lake Auburn',
    });
    await mod.as.mutation(api.undo.run, { actionId });

    expect((await bodyOf(t, bodyId))?.name).toBe('The Basin');
    expect(await openState(t, bodyId, 'name-conflict')).toEqual(before);
    // The undo's own row is the domain verb's, tagged as the undo; nothing else is written.
    const rows = await rowsOn(t, bodyId);
    expect(rows.map((r) => [r.action, r.undoesActionId])).toEqual([
      ['set_water_body_name', undefined],
      ['set_water_body_name', actionId],
    ]);
    // And the task can be decided again.
    await mod.as.mutation(api.corpusWrites.decideName, { taskId: task._id, pick: SHOWN_PICK });
    expect((await taskOf(t, bodyId, 'name-conflict')).decision).toBe('kept');
  });

  test('a reclass’s undo puts the class back and asks the question again', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['class-conflict']);
    const task = await taskOf(t, bodyId, 'class-conflict');
    const before = await openState(t, bodyId, 'class-conflict');

    const { actionId } = await mod.as.mutation(api.corpusWrites.decideClass, {
      taskId: task._id,
      bodyClass: 'wetland',
    });
    await mod.as.mutation(api.undo.run, { actionId });

    const after = await bodyOf(t, bodyId);
    expect(after?.type).toBe('lakePond');
    expect(after?.moderatorClass).toBeUndefined();
    expect(await openState(t, bodyId, 'class-conflict')).toEqual(before);
  });

  test('a Keep’s undo is the question asked again, recorded as unsettle_review_reason', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict', 'class-conflict']);
    const task = await taskOf(t, bodyId, 'class-conflict');
    const before = await openState(t, bodyId, 'class-conflict');

    const { actionId } = await mod.as.mutation(api.corpusWrites.decideClass, {
      taskId: task._id,
      bodyClass: 'lakePond',
    });
    await mod.as.mutation(api.undo.run, { actionId });

    expect(await openState(t, bodyId, 'class-conflict')).toEqual(before);
    const rows = await rowsOn(t, bodyId);
    expect(rows.map((r) => [r.action, r.undoesActionId])).toEqual([
      ['settle_review_reason', undefined],
      ['unsettle_review_reason', actionId],
    ]);
    // The unsettle is not itself undone: it is settled again from its lane.
    await expect(
      mod.as.mutation(api.undo.run, { actionId: rows[1]?._id as Id<'moderationActions'> }),
    ).rejects.toThrow('Settle it again from its lane.');
  });

  test('a Body console rename that decided no task undoes as it always did', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    await mod.as.mutation(api.waterBodies.setWaterBodyName, {
      waterBodyId: bodyId,
      name: 'Lake Auburn',
    });
    const [row] = await rowsOn(t, bodyId);
    await mod.as.mutation(api.undo.run, { actionId: row?._id as Id<'moderationActions'> });
    expect((await bodyOf(t, bodyId))?.name).toBe('The Basin');
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('open');
  });
});

describe('the library’s rows follow a settle and its undo', () => {
  /** The body's library rows' *intake* facet (it reads `reviewReason`), a value per row. */
  const intakeOf = (t: T, bodyId: Id<'waterBodies'>) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('bodyLibraryRows')
          .withIndex('by_body', (q) => q.eq('waterBodyId', bodyId))
          .collect()
      ).map((r) => r.intake),
    );
  const drain = (t: T) => t.mutation(internal.bodyLibrary.drainQueue, {});

  test('a Keep takes the body out of the intake facet; its undo puts it back', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');

    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    // The decision's audit row refreshed the rows while the reason still stood; the settle queued
    // the body, so the next drain reads the reason gone.
    await drain(t);
    const settled = await intakeOf(t, bodyId);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every((intake) => intake === false)).toBe(true);

    await mod.as.mutation(api.undo.run, { actionId });
    await drain(t);
    expect((await intakeOf(t, bodyId)).every((intake) => intake === true)).toBe(true);
  });

  test('a rename’s undo, whose row is written before the task reopens, puts it back too', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');

    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: 'Lake Auburn',
    });
    await drain(t);
    expect((await intakeOf(t, bodyId)).every((intake) => intake === false)).toBe(true);

    await mod.as.mutation(api.undo.run, { actionId });
    await drain(t);
    const reopened = await intakeOf(t, bodyId);
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.every((intake) => intake === true)).toBe(true);
  });
});

describe('undo: overtaken', () => {
  /** What a campaign does when the evidence moved (D306): the settle dropped, the reason back. */
  const askAgain = async (t: T, bodyId: Id<'waterBodies'>, reason: ReviewReason) => {
    await t.run(async (ctx) => {
      const b = await ctx.db.get(bodyId);
      await ctx.db.patch(bodyId, {
        reviewReasons: [...(b?.reviewReasons ?? []), reason],
        reviewReason: b?.reviewReason ?? reason,
        reviewSettled: (b?.reviewSettled ?? []).filter((s) => s.reason !== reason),
      });
    });
    await t.run((ctx) => syncBodyTasks(ctx, bodyId));
  };

  test('a Keep whose question a campaign asked again is not offered, and refused', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    await askAgain(t, bodyId, 'name-conflict');
    const asked = await taskOf(t, bodyId, 'name-conflict');
    expect(asked._id).not.toBe(task._id);
    expect(asked.status).toBe('open');

    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(SETTLE_ASKED_AGAIN);
    // Nothing moved: the decided task stays decided, the new one open.
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.status).toBe('decided');
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('open');
  });

  test('a rename whose question was asked again: the name goes back, the asked task stands alone', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: 'Lake Auburn',
    });
    await askAgain(t, bodyId, 'name-conflict');
    const asked = await taskOf(t, bodyId, 'name-conflict');

    await mod.as.mutation(api.undo.run, { actionId });

    expect((await bodyOf(t, bodyId))?.name).toBe('The Basin');
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.status).toBe('decided');
    // The asked task is the same open question; only its search text follows the name back.
    const after = await taskOf(t, bodyId, 'name-conflict');
    const { searchText, refreshedAt, ...rest } = after;
    const { searchText: _was, refreshedAt: _at, ...askedRest } = asked;
    expect(rest).toEqual(askedRest);
    expect(searchText?.split('\n')[0]).toBe('The Basin');
    expect(refreshedAt).toBeGreaterThanOrEqual(asked.refreshedAt);
  });

  test('a later write on the body overtakes a decision, as any row is overtaken', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict', 'class-conflict']);
    const nameTask = await taskOf(t, bodyId, 'name-conflict');
    const classTask = await taskOf(t, bodyId, 'class-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: nameTask._id,
      pick: SHOWN_PICK,
    });
    await mod.as.mutation(api.corpusWrites.decideClass, {
      taskId: classTask._id,
      bodyClass: 'wetland',
    });
    const offer = await t.query(internal.moderation.undoOfferForRow, { actorId: mod.id, actionId });
    expect(offer).toEqual({ undoable: false });
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      'Something changed this since',
    );
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('decided');
  });

  test('a Keep on a body removed since is refused, and writes nothing', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    // Removed without a row on the body (a script's removal): the handler, not the engine, refuses.
    await t.run((ctx) => ctx.db.patch(bodyId, { removedAt: Date.now() }));
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(
      'This question has closed since',
    );
    expect((await rowsOn(t, bodyId)).map((r) => r.action)).toEqual(['settle_review_reason']);
  });

  test('the run refuses on its own, past a refusal check that let it through, and reopens nothing', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    await askAgain(t, bodyId, 'name-conflict');
    const hand = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'settle_review_reason',
        targetType: 'waterbody',
        targetId: bodyId,
        reason: 'Settled by a script.',
        createdAt: Date.now(),
      }),
    );
    const runOn = (id: Id<'moderationActions'>) =>
      t.run(async (ctx) => {
        const row = await ctx.db.get(id);
        const actor = await ctx.db.get(mod.id);
        await CORPUS_UNDO_HANDLERS.settle_review_reason?.run({
          ctx,
          actor: actor as Doc<'profiles'>,
          row: row as Doc<'moderationActions'>,
          reason: 'Undone.',
          writers: {} as UndoWriters,
        });
      });
    // Asked again since: the reopen is overtaken. Written by hand: nothing records it.
    await expect(runOn(actionId)).rejects.toThrow(SETTLE_ASKED_AGAIN);
    await expect(runOn(hand)).rejects.toThrow(SETTLE_NOT_FOUND);
    expect((await t.run((ctx) => ctx.db.get(task._id)))?.status).toBe('decided');
    expect((await rowsOn(t, bodyId)).map((r) => r.action)).toEqual([
      'settle_review_reason',
      'settle_review_reason',
    ]);
  });
});

describe('undo: the offer matches the run', () => {
  test('a Keep whose settle no longer stands on the body is never offered, nor run', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    // The settle's entry gone with no task asking again (a campaign that dropped it, with no row).
    await t.run((ctx) => ctx.db.patch(bodyId, { reviewSettled: undefined }));
    expect(
      await t.query(internal.moderation.undoOfferForRow, { actorId: mod.id, actionId }),
    ).toEqual({ undoable: false });
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(SETTLE_ASKED_AGAIN);
  });

  test('a settle no task records (a row written by hand) is never offered, nor run', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, ['name-conflict']);
    const actionId = await t.run((ctx) =>
      ctx.db.insert('moderationActions', {
        actorId: mod.id,
        action: 'settle_review_reason',
        targetType: 'waterbody',
        targetId: bodyId,
        reason: 'Settled by a script.',
        createdAt: Date.now(),
      }),
    );
    expect(
      await t.query(internal.moderation.undoOfferForRow, { actorId: mod.id, actionId }),
    ).toEqual({ undoable: false });
    await expect(mod.as.mutation(api.undo.run, { actionId })).rejects.toThrow(SETTLE_NOT_FOUND);
    expect((await rowsOn(t, bodyId)).map((r) => r.action)).toEqual(['settle_review_reason']);
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('open');
  });
});

describe('capturingAudit: the domain write’s row, scoped to its own call', () => {
  test('two captures in one mutation each see only their own rows; a nested one, both', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const bodyId = await seedBody(t, []);
    const write = (ctx: Parameters<typeof writeAudit>[0]) =>
      writeAudit(ctx, {
        actorId: mod.id,
        action: 'set_class',
        targetType: 'waterbody',
        targetId: bodyId,
        reason: 'test',
      });
    const seen = await t.run(async (ctx) => {
      await write(ctx); // outside any capture
      const first = await capturingAudit(ctx, () => write(ctx));
      const second = await capturingAudit(ctx, async () => {
        await write(ctx);
        return capturingAudit(ctx, () => write(ctx));
      });
      const failed = await capturingAudit(ctx, async () => {
        await write(ctx);
        throw new Error('refused');
      }).catch(() => 'threw');
      const after = await capturingAudit(ctx, () => write(ctx));
      return {
        first: first.rows.length,
        outer: second.rows.length,
        inner: second.value.rows.length,
        failed,
        after: after.rows.length,
        firstIsItsOwn: first.rows[0]?.actionId === first.value,
      };
    });
    expect(seen).toEqual({
      first: 1,
      outer: 2,
      inner: 1,
      failed: 'threw',
      after: 1,
      firstIsItsOwn: true,
    });
  });
});

describe('undo: capability', () => {
  test('a member is never offered a decision’s undo, and is refused it', async () => {
    const t = harness();
    const mod = await seedUser(t, 'mod');
    const member = await seedUser(t, 'member', 'member');
    const bodyId = await seedBody(t, ['name-conflict']);
    const task = await taskOf(t, bodyId, 'name-conflict');
    const { actionId } = await mod.as.mutation(api.corpusWrites.decideName, {
      taskId: task._id,
      pick: SHOWN_PICK,
    });
    await expect(member.as.mutation(api.undo.run, { actionId })).rejects.toThrow();
    expect((await taskOf(t, bodyId, 'name-conflict')).status).toBe('decided');
  });
});
