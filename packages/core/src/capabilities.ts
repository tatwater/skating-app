/**
 * The operator capability map (D217, Phase B01).
 *
 * One table says who may do each operator thing. The server gates a function by naming a
 * capability (`requireCapability(ctx, 'people.role')` in `packages/convex/convex/lib/auth.ts`); the
 * console asks the same table before it draws a control, and the rail hides a mode the caller can't
 * use. A control the server would refuse is never drawn. To move the line, change a row here.
 *
 * Each row is the minimum role and whether the capability **writes**. The flag picks the server's
 * gate: a read stays open to an operator who has asked to delete their account (they keep their
 * reads through the 30-day window, D62), a write does not (`requireContributorRole`). A query must
 * name a read capability and a mutation a write one; `capabilities.test.ts` in the Convex package
 * holds every gated function to that.
 *
 * Role model unchanged (D37): `member < moderator < admin`.
 */

import type { UserRole } from './types';

/** Role precedence: admin ⊇ moderator ⊇ member (D37). */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = { member: 0, moderator: 1, admin: 2 };

/** Whether `role` is at least `minRole`. */
export function roleMeets(role: UserRole, minRole: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export interface CapabilityRule {
  /** The lowest role that holds it. */
  readonly role: Exclude<UserRole, 'member'>;
  /** Writes are refused to an operator on their way out; reads are not. */
  readonly write: boolean;
  /** Why the line is where it is — the sentence to read before moving it. */
  readonly why: string;
}

const read = <R extends CapabilityRule['role']>(role: R, why: string) => ({
  role,
  write: false as const,
  why,
});
const write = <R extends CapabilityRule['role']>(role: R, why: string) => ({
  role,
  write: true as const,
  why,
});

export const CAPABILITIES = {
  // ── Overview and the audit log ────────────────────────────────────────────────────────────────
  'audit.read': read('moderator', 'The audit feed and every History panel: who did what, and why.'),

  // ── Inbox: what a person filed ────────────────────────────────────────────────────────────────
  'inbox.read': read(
    'moderator',
    'Flags, requests, place asks and drawn bodies, with their counts.',
  ),
  'inbox.flag': write('moderator', 'Action or dismiss a flag; the flagger hears the verdict.'),
  'inbox.request': write(
    'moderator',
    'Decide a corpus request. Restore and takedown also need body.remove (D48).',
  ),
  'inbox.drawnBody': write('moderator', "Approve or reject a skater's drawn body."),
  'inbox.support.read': read(
    'admin',
    'Support tickets carry PII: the submitter, their device, their words (D37).',
  ),
  'inbox.support': write(
    'admin',
    'Assign, note, reply to and resolve a support ticket (PII, D37).',
  ),

  // ── Reports and other content ─────────────────────────────────────────────────────────────────
  'content.read': read('moderator', 'Edit history and hidden content, read in full (D205, D225).'),
  'content.moderate': write(
    'moderator',
    'Hide, remove and restore reports, posts, comments, hazards and photos.',
  ),

  // ── Access ────────────────────────────────────────────────────────────────────────────────────
  'access.rule': write('moderator', 'Rule a body open or without public access (A06f).'),
  'access.alert': write('moderator', 'Pin, unpin or retract an access alert (A06d).'),

  // ── Corpus: what a machine found ──────────────────────────────────────────────────────────────
  'corpus.read': read(
    'moderator',
    'The intake queue, duplicates, standing lanes, place names, the pre-ice pass.',
  ),
  'corpus.duplicates': write('moderator', 'Merge two bodies or say they are distinct (D36).'),
  'corpus.placeNames': write(
    'moderator',
    'Set, file, dismiss or reopen a place name from the emails (D202).',
  ),
  'corpus.preIce': write(
    'moderator',
    'Suppress, promote and recompute recurrence; promote, demote and unmerge hazards.',
  ),

  // ── Body console: one body, every lever ───────────────────────────────────────────────────────
  'body.read': read(
    'moderator',
    "A body's operator view: landmarks with removed ones, asks, stats, candidates.",
  ),
  'body.identity': write('moderator', 'Name, aliases, class, curated boost and reference links.'),
  'body.shape': write(
    'moderator',
    'Draw, redraw, rename, delist and restore sub-areas (D60, D201).',
  ),
  'body.places': write('moderator', 'Create, edit, move, remove and restore landmarks (D202).'),
  'body.access': write('moderator', 'Put-ins, parking, approaches and posted rules (A06d, A06e).'),
  'body.water': write('moderator', 'Depth, weather sample points and the satellite link.'),
  'body.standing': write('moderator', 'Set a body dormant or bring it back (A07b).'),
  'body.remove': write('admin', 'Take a body off the map or put it back (D48).'),

  // ── People ────────────────────────────────────────────────────────────────────────────────────
  'people.read': read('moderator', 'Find any account and read its operator view and trend (D37).'),
  'people.discipline': write(
    'moderator',
    'Restrict posting, set the bounty limit, suspend, ban and lift (D57).',
  ),
  'people.trustScore': read('admin', 'The raw trust number (D50); moderators see the trust class.'),
  'people.role': write('admin', 'Grant and revoke moderator and admin (D37).'),

  // ── Machinery ─────────────────────────────────────────────────────────────────────────────────
  'machinery.read': read(
    'admin',
    'Import runs name deployments, source URLs and checksums (A06c §6.2).',
  ),
  'machinery.imagery': write(
    'admin',
    'Start, pause, retry and poll the live imagery pipeline (A06i).',
  ),

  // ── Season ────────────────────────────────────────────────────────────────────────────────────
  'season.read': read('admin', 'The season watch, its settings and the replay (A06i, D213).'),
  'season.settings': write(
    'admin',
    'Save threshold versions, reset a watch, field dates, history fill (D213).',
  ),

  // ── Instruments ───────────────────────────────────────────────────────────────────────────────
  'instruments.calibration': read(
    'moderator',
    "D160's dark instrument has to be reachable; it is read-only.",
  ),
  'instruments.tuning': read(
    'admin',
    'The metric rollups behind the tuning constants (Phase 07-2).',
  ),
} as const satisfies Record<string, CapabilityRule>;

export type Capability = keyof typeof CAPABILITIES;

/** Capabilities a query may name. */
export type ReadCapability = {
  [K in Capability]: (typeof CAPABILITIES)[K]['write'] extends false ? K : never;
}[Capability];

/** Capabilities a mutation may name. */
export type WriteCapability = Exclude<Capability, ReadCapability>;

/** Whether `role` holds `capability`. The client's question before drawing a control. */
export function can(role: UserRole | undefined, capability: Capability): boolean {
  return role !== undefined && roleMeets(role, CAPABILITIES[capability].role);
}

/**
 * The client's whole question before drawing a control: the role holds the capability, and — for a
 * write — the operator is not on their way out. The same split the server draws (`requireCapability`
 * picks `requireContributorRole` for a write), so a control is drawn exactly when the server would
 * accept it.
 */
export function canUse(
  role: UserRole | undefined,
  leaving: boolean,
  capability: Capability,
): boolean {
  return can(role, capability) && !(CAPABILITIES[capability].write && leaving);
}
