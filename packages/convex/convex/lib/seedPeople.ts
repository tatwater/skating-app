/**
 * **The dev inbox seed's fake people** (D287, B01-5): who they are, and the one predicate every
 * sender asks before it reaches outside Convex.
 *
 * The seed (`scripts/seed-inbox`, `inboxSeed.ts`) files flags, asks, alerts, drawn bodies and tickets
 * through the same public mutations a skater's app calls, signed as these people. They have profiles
 * and **no Clerk account**: their `clerkUserId` is `seed_inbox_<n>`, a shape Clerk never issues (its
 * ids are `user_…`), so no real subject can collide with one, and every last name starts with
 * "Test-", so no screen, export or count can mistake one for a person.
 *
 * **Never contacted.** Their notification toggles and both channels are off, and on top of that
 * every sender that could reach one asks {@link isSeedProfile} and skips them: Clerk's ban lock
 * (`clerkAdmin.setBanned`) and its daily reconcile (`clerkReconcile`, D277 — counted, never
 * repaired), account deletion's Clerk delete (`clerkAdmin.deleteUser`), the Clerk email lookup
 * (`lib/clerkEmail`), the notification queue's gate (`lib/notificationQueue.recipientWants`, which
 * both the enqueue and the flush ask) and the transports (`notificationDelivery.loadForDelivery`).
 * And what a fake person does never pages the operator: the safety-flag alert (`contentFlags.flag`)
 * and the new-ticket alert (`support.create`) skip a seed filer.
 */

import { ConvexError } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isDevDeployment } from './deployment';

/** The prefix of every fake person's `clerkUserId`. Clerk's own ids start `user_`. */
export const SEED_CLERK_PREFIX = 'seed_inbox_';

/** Every fake person's last name starts with this (the founder's rule, D287). */
export const SEED_SURNAME_PREFIX = 'Test-';

/** What the seed's writes are made through (D256): the audit row reads "Teagan via seed-inbox". */
export const SEED_VIA = 'seed-inbox';

/**
 * **The one predicate**: is this a fake person from the dev seed? Asked with a profile, or with the
 * Clerk subject alone where a sender holds nothing else (the Clerk actions, the email lookup).
 */
export function isSeedProfile(who: string | { clerkUserId: string } | null | undefined): boolean {
  if (who === null || who === undefined) return false;
  const subject = typeof who === 'string' ? who : who.clerkUserId;
  return subject.startsWith(SEED_CLERK_PREFIX);
}

/** The last name of a display name: everything after its first space ("Ada Test-Lindqvist"). */
export function surnameOf(displayName: string): string {
  const name = displayName.trim();
  const at = name.indexOf(' ');
  return at === -1 ? '' : name.slice(at + 1).trim();
}

/** Whether a display name obeys the founder's rule. */
export function hasTestSurname(displayName: string): boolean {
  return surnameOf(displayName).startsWith(SEED_SURNAME_PREFIX);
}

/** One fake person: a stable key the seed's plan names them by, and their profile's fields. */
export interface SeedPerson {
  key: SeedPersonKey;
  clerkUserId: string;
  displayName: string;
  username: string;
  /** Varied, so People's trust column has a spread (cosmetic, D17). */
  reputationPoints: number;
}

export const SEED_PERSON_KEYS = [
  'ada',
  'ben',
  'cleo',
  'dev',
  'elin',
  'finn',
  'gus',
  'hana',
] as const;
export type SeedPersonKey = (typeof SEED_PERSON_KEYS)[number];

/**
 * **The cast.** Invented names — none taken from the boards, the corpus or anyone real — each with a
 * "Test-" surname (held by a test, and refused by `ensurePeople`).
 */
export const SEED_CAST: readonly SeedPerson[] = [
  { key: 'ada', displayName: 'Ada Test-Lindqvist', reputationPoints: 420 },
  { key: 'ben', displayName: 'Ben Test-Okafor', reputationPoints: 35 },
  { key: 'cleo', displayName: 'Cleo Test-Marchetti', reputationPoints: 160 },
  { key: 'dev', displayName: 'Dev Test-Raman', reputationPoints: 90 },
  { key: 'elin', displayName: 'Elin Test-Haugen', reputationPoints: 610 },
  { key: 'finn', displayName: 'Finn Test-Aguilar', reputationPoints: 12 },
  { key: 'gus', displayName: 'Gus Test-Whitcombe', reputationPoints: 240 },
  { key: 'hana', displayName: 'Hana Test-Sato', reputationPoints: 75 },
].map((p, i) => ({
  ...p,
  key: p.key as SeedPersonKey,
  clerkUserId: `${SEED_CLERK_PREFIX}${i + 1}`,
  username: `test_${p.displayName.toLowerCase().replace(/[^a-z]+/g, '_')}`,
}));

/** One cast member by key. */
export function seedPerson(key: SeedPersonKey): SeedPerson {
  const person = SEED_CAST.find((p) => p.key === key);
  if (!person) throw new Error(`No seed person "${key}"`);
  return person;
}

/** Which deployment this is: the one exact check, shared with the run rows (`lib/deployment`). */
export { DEV_DEPLOYMENT, DEV_HOST, isDevDeployment } from './deployment';

/** What the seed's functions say on any deployment that isn't dev. */
export const SEED_DEV_ONLY = 'The inbox seed runs only on the dev deployment.';

/** Refuse, before any read or write, on a deployment that isn't dev. */
export function assertSeedDeployment(): void {
  if (!isDevDeployment()) throw new ConvexError(SEED_DEV_ONLY);
}

// ── Telling seed from real on a real write path, cheaply ───────────────────────────────────────

/**
 * Whether a person is from the dev seed, as the write paths ask it (D287): the gates on real
 * skaters' writes — the notification enqueue, the report audience, corroboration, bounties, the
 * contradiction cluster, the pin merge — ask {@link seedSideOf} rather than read profiles themselves.
 *
 * **What it costs a real write.** One indexed read per transaction — is there any seed person at
 * all? — shared by every gate the write runs. On prod, and on dev while no seed is loaded, the answer
 * is no and no profile is read: every author is real. Only while a seed is loaded does a gate read an
 * author, and then each distinct author at most once per transaction. The candidates' side can't be
 * skipped when the acting author is real: a real pin must not fold into a seed pin, nor a real report
 * corroborate a seed one, so both sides are asked whenever a seed exists.
 */
export interface SeedSide {
  /** Whether any seed person exists on this deployment (read once). */
  any(): Promise<boolean>;
  /** Whether this person is from the seed; `false` without a read when no seed person exists. */
  isSeed(userId: Id<'profiles'> | undefined): Promise<boolean>;
}

const SIDES = new WeakMap<object, SeedSide>();

/** The transaction's {@link SeedSide}, made once per `ctx` and shared by every gate it runs. */
export function seedSideOf(ctx: QueryCtx): SeedSide {
  const known = SIDES.get(ctx);
  if (known) return known;
  let any: Promise<boolean> | undefined;
  const people = new Map<Id<'profiles'>, Promise<boolean>>();
  const side: SeedSide = {
    any: () => {
      any ??= ctx.db
        .query('profiles')
        .withIndex('by_clerk_user_id', (q) =>
          q.gte('clerkUserId', SEED_CLERK_PREFIX).lt('clerkUserId', `${SEED_CLERK_PREFIX}\uffff`),
        )
        .first()
        .then((p) => p !== null);
      return any;
    },
    isSeed: async (userId) => {
      if (userId === undefined || !(await side.any())) return false;
      let seed = people.get(userId);
      if (seed === undefined) {
        seed = ctx.db.get(userId).then((p) => isSeedProfile(p));
        people.set(userId, seed);
      }
      return seed;
    },
  };
  SIDES.set(ctx, side);
  return side;
}
