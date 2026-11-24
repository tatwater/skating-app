/**
 * **The terms acceptance, Know Before You Go, and the record of both** (D295–D298, B03 §9.5).
 *
 * A skater's way in is Account → Terms → Know Before You Go → Home → Profile, and the profile row is
 * born here, at *Record acceptance* — never before — so "a profile exists ⇒ an acceptance was
 * recorded" holds by construction (D298). Three ideas carry the file:
 *
 * **1. The server stamps every moment, and the client proves nothing by asserting it.** The reader
 * opening (`openTerms`) and its end on screen (`reachTermsEnd`) are server-stamped onto a reading row
 * keyed by the Clerk subject (no profile may exist yet); `acceptTerms` refuses unless that row says the
 * end was reached, then copies its stamps into the record and deletes it. What the client sends about
 * itself — which surface, its user agent — is stored labeled `client_reported` and capped. The words
 * accepted are named by core's committed version and SHA-256 (`isCurrentTerms`,
 * `isCurrentPrivacyNotice`, `isCurrentKnowBeforeYouGo`): a client showing other words is refused
 * (`terms_changed`, `questions_changed`), and the record stores the server's constants, never the
 * client's.
 *
 * **2. The record is sealed** (D297). One `consentRecords` row per acceptance and per completion, with
 * the identity as attested. After the insert only named fill-once fields change — the IP
 * (`setIp`), the copy's outcome and an email the token lacked (`setCopyOutcome`) — plus the finalize
 * stage's sever (`accountDeletion.ts`); `purgeDue` is the only delete. `packages/guards`
 * `consentWriters.test.ts` holds that. Wrong quiz picks have no field anywhere: the client keeps
 * them in memory and the completion says only that all seven were answered.
 *
 * **3. Nothing slow or fallible happens inside the acceptance.** The IP (Clerk's session record) and
 * the emailed copy (Resend) are scheduled actions after the commit; each fills its field once and
 * never throws, and the acceptance never waits on either.
 *
 * The profile's five routing fields (`termsVersion`, `termsAcceptedAt`, `knowBeforeYouGoAt`,
 * `knowBeforeYouGoVersion`, `welcomeStep`) are a denormalization of the newest records, written only
 * here, for `resolveEntryRoute` (core `entryRoute.ts`) to read off `profiles.current`.
 */

import {
  CONSENT_REFUSAL_MESSAGES,
  type ConsentRefusalCode,
  capClientReported,
  isCurrentKnowBeforeYouGo,
  isCurrentPrivacyNotice,
  isCurrentTerms,
  isMinor,
  isValidDisplayName,
  KNOW_BEFORE_YOU_GO,
  KNOW_BEFORE_YOU_GO_REPEAT_MS,
  KNOW_BEFORE_YOU_GO_SHA256,
  meetsMinimumAge,
  needsProfileSetup,
  normalizeDisplayName,
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  storableAvatarUrl,
  TERMS,
  TERMS_SHA256,
  termsAcceptanceContext,
  termsEmailBlocks,
  watchSeasonTitle,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { getCurrentProfile, requireContributor, requireProfile } from './lib/auth';
import { clerkEmailLookup } from './lib/clerkEmail';
import { sessionIpFor } from './lib/clerkSessions';
import {
  consentSurface,
  copyEmailStatus,
  ipMatch,
  ipUnavailableReason,
  termsReaderVia,
  welcomeStep,
} from './lib/consentValidators';
import { type EmailBlock, renderBlocksHtml, renderBlocksText } from './lib/emailBlocks';
import { refreshPersonRow } from './lib/peopleRows';
import { assertMayRename, checkUsername, newProfileDefaults } from './lib/profileIdentity';
import { sendEmailOutcome } from './lib/resend';

/** Rows `pruneReadings` and `purgeDue` delete per run; a full page schedules the next at once. */
export const CONSENT_SWEEP_PAGE = 256;

/** How long an unaccepted reading is kept: 30 days after it opened. */
export const READING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Records the CLI lookups return at most, newest first. */
const LOOKUP_CAP = 200;

/** A refusal the clients show as a toast (D268): the code to branch on, core's words to show. */
function refuse(code: ConsentRefusalCode): never {
  throw new ConvexError({ code, message: CONSENT_REFUSAL_MESSAGES[code] });
}

/** The caller's Clerk identity, or the refusal every unauthenticated call gets. */
async function requireIdentity(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError('Not authenticated');
  return identity;
}

/** The caller's reading of the current terms, if they opened them. */
function currentReading(ctx: QueryCtx, clerkUserId: string) {
  return ctx.db
    .query('termsReadings')
    .withIndex('by_clerk_version', (q) =>
      q.eq('clerkUserId', clerkUserId).eq('termsVersion', TERMS.version),
    )
    .first();
}

/** A client-reported string as the record stores it, or nothing when it is empty. */
function reported(value: string | undefined) {
  const capped = value === undefined ? '' : capClientReported(value);
  return capped === '' ? undefined : { value: capped, source: 'client_reported' as const };
}

/**
 * A Clerk session id from the client, kept only if it looks like one: it goes into a request path
 * in `lib/clerkSessions`, which checks it again.
 */
function sessionIdArg(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_]{1,128}$/.test(value) ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The watch
// ─────────────────────────────────────────────────────────────────────────────

/** The Ice Watch's newest live opening, as the season rule and the season card read it. */
export interface WatchAnchor {
  /** `winter-YYYY-YY`. */
  season: string;
  /** "Winter 2027–28". */
  label: string;
  /** Epoch ms the system recorded the opening (`detectedAt`), the season rule's anchor. */
  openedAt: number;
}

/**
 * The anchor (B03 §9.2, R7): `detectedAt` on the live `imageryIngestSeasons` row with the greatest
 * season — the instant the system knew, not `opensOn`, a backdated observation. A reset moves its row
 * to `imageryIngestSeasonsSuperseded`, which postpones the opening, so a superseded row never anchors:
 * until the next tick re-opens the season, the newest live row is the previous one. `null` before any
 * season has opened.
 */
async function newestWatch(ctx: QueryCtx): Promise<WatchAnchor | null> {
  const row = await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season')
    .order('desc')
    .first();
  if (row === null) return null;
  let label = row.season;
  try {
    label = watchSeasonTitle(row.season);
  } catch {
    // A row whose key isn't a season label still anchors; it just has no friendlier name.
  }
  return { season: row.season, label, openedAt: row.detectedAt };
}

/**
 * The watch the routing rule reads beside `profiles.current` (`resolveEntryRoute`'s `watch`, as
 * `{ openedAt }`; the season card's kicker from `label`). Ungated: it is the same for everyone.
 */
export const watchAnchor = query({
  args: {},
  handler: (ctx): Promise<WatchAnchor | null> => newestWatch(ctx),
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading the terms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reader opened (board 10.3): the reading row, stamped now, or the one already open — its first
 * `openedAt` is kept, so reopening the page never moves it. Refuses words other than this build's.
 */
export const openTerms = mutation({
  args: { termsVersion: v.string(), termsHash: v.string(), surface: consentSurface },
  handler: async (ctx, args): Promise<null> => {
    const identity = await requireIdentity(ctx);
    if (!isCurrentTerms({ version: args.termsVersion, hash: args.termsHash })) {
      refuse('terms_changed');
    }
    if ((await currentReading(ctx, identity.subject)) !== null) return null;
    await ctx.db.insert('termsReadings', {
      clerkUserId: identity.subject,
      termsVersion: TERMS.version,
      openedAt: Date.now(),
      surface: args.surface,
    });
    return null;
  },
});

/**
 * The end marker was on screen (board 10.4), in the page's reader or the full-screen one: stamped
 * once — a second reach changes nothing, so the first stays the evidence.
 */
export const reachTermsEnd = mutation({
  args: { termsVersion: v.string(), termsHash: v.string(), via: termsReaderVia },
  handler: async (ctx, args): Promise<null> => {
    const identity = await requireIdentity(ctx);
    if (!isCurrentTerms({ version: args.termsVersion, hash: args.termsHash })) {
      refuse('terms_changed');
    }
    const reading = await currentReading(ctx, identity.subject);
    if (reading === null) refuse('terms_not_opened');
    if (reading.reachedEndAt !== undefined) return null;
    await ctx.db.patch(reading._id, { reachedEndAt: Date.now(), reachedEndVia: args.via });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The acceptance
// ─────────────────────────────────────────────────────────────────────────────

/** The Account step's fields, carried in client memory to the acceptance (nothing is written before). */
const accountArgs = v.object({
  displayName: v.string(),
  username: v.string(),
  /** UTC-midnight epoch ms, as core's `composeDateOfBirth` makes it. */
  dateOfBirth: v.number(),
});

/** The Account step's fields, checked by the same rules as every other profile writer. */
async function checkAccount(
  ctx: MutationCtx,
  account: { displayName: string; username: string; dateOfBirth: number },
  clerkUserId: string,
  now: number,
): Promise<{ displayName: string; username: string; dateOfBirth: number }> {
  // The 18+ gate (D294): core's rule, at the server's clock, before anything else about the account.
  if (!meetsMinimumAge(account.dateOfBirth, now)) refuse('underage');
  const displayName = normalizeDisplayName(account.displayName);
  if (!isValidDisplayName(displayName)) refuse('name_invalid');
  const verdict = await checkUsername(ctx, account.username, clerkUserId);
  if (!verdict.ok) refuse(verdict.reason === 'taken' ? 'username_taken' : 'username_invalid');
  return { displayName, username: verdict.username, dateOfBirth: account.dateOfBirth };
}

/**
 * ***Record acceptance*** (boards 10.3–10.5; D295, D298). One transaction: the profile (created for a
 * new account, re-introduced in place for a canceled deletion's emptied row, or only its terms fields
 * for anyone else), the record, the reading consumed, the People row, then the two actions — the IP
 * and the emailed copy — scheduled after the commit.
 *
 * - **No row:** `account` is required; the 18+ gate, the name and username rules; the row is born
 *   with every new account's defaults (`lib/profileIdentity`), the Clerk mirrors, the terms fields and
 *   `welcomeStep: 'home'`.
 * - **A canceled deletion's row** (`needsProfileSetup`): `account` is required and patched in place —
 *   the same row, under the rename cooldown when the handle changes — with the new-account
 *   visibility and `welcomeStep: 'home'`. Its old records stay as they were; this adds one.
 * - **Any other row:** `account` must be absent; only the terms fields change. Inactive or suspended
 *   accounts get `requireProfile`'s refusals, and a pending deletion `deletion_pending` (its way back
 *   is the cancel in Settings).
 *
 * Every time is the server's. The client's `surface` and `userAgent` are stored as client-reported.
 */
export const acceptTerms = mutation({
  args: {
    termsVersion: v.string(),
    termsHash: v.string(),
    privacyVersion: v.string(),
    privacyHash: v.string(),
    surface: consentSurface,
    userAgent: v.optional(v.string()),
    clientSessionId: v.optional(v.string()),
    account: v.optional(accountArgs),
  },
  handler: async (ctx, args): Promise<{ recordId: Id<'consentRecords'> }> => {
    const identity = await requireIdentity(ctx);
    const subject = identity.subject;
    if (
      !isCurrentTerms({ version: args.termsVersion, hash: args.termsHash }) ||
      !isCurrentPrivacyNotice({ version: args.privacyVersion, hash: args.privacyHash })
    ) {
      refuse('terms_changed');
    }
    const reading = await currentReading(ctx, subject);
    if (reading?.reachedEndAt === undefined) refuse('terms_not_read');

    const now = Date.now();
    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', subject))
      .unique();
    // A row that can't act gets the gate's own refusal (D37): banned, being finalized, suspended.
    if (existing !== null) await requireProfile(ctx);
    if (existing?.deletionRequestedAt !== undefined) refuse('deletion_pending');
    // Live: a row that is neither new nor a canceled deletion's emptied one.
    const live = existing !== null && !needsProfileSetup(existing) ? existing : null;

    let profileId: Id<'profiles'>;
    let attested: { fullName: string; email?: string; dateOfBirth: number };
    const email = identity.email ?? existing?.email;
    const termsFields = { termsVersion: TERMS.version, termsAcceptedAt: now };
    if (live !== null) {
      if (args.account !== undefined) refuse('account_unexpected');
      profileId = live._id;
      attested = { fullName: live.displayName, dateOfBirth: live.dateOfBirth };
      await ctx.db.patch(profileId, termsFields);
    } else {
      if (args.account === undefined) refuse('account_required');
      const account = await checkAccount(ctx, args.account, subject, now);
      attested = { fullName: account.displayName, dateOfBirth: account.dateOfBirth };
      const minor = isMinor(account.dateOfBirth, now);
      const defaults = newProfileDefaults(now, minor);
      // The Clerk mirrors, as `upsertFromClerk` takes them: an unmapped claim leaves them alone.
      const mirrors = {
        ...(identity.pictureUrl !== undefined
          ? { profileImageUrl: storableAvatarUrl(identity.pictureUrl) }
          : {}),
        ...(identity.email !== undefined ? { email: identity.email } : {}),
      };
      if (existing === null) {
        profileId = await ctx.db.insert('profiles', {
          clerkUserId: subject,
          displayName: account.displayName,
          username: account.username,
          ...mirrors,
          dateOfBirth: account.dateOfBirth,
          ...defaults,
          ...termsFields,
          welcomeStep: 'home',
        });
      } else {
        // Re-introduced: the same row, so its history, reputation and old records stay its own. A new
        // handle is a rename under the cooldown, or this would be the way round it.
        profileId = existing._id;
        const renamed = account.username !== existing.username;
        if (renamed) assertMayRename(existing, now);
        await ctx.db.patch(profileId, {
          displayName: account.displayName,
          username: account.username,
          ...(renamed ? { usernameChangedAt: now } : {}),
          dateOfBirth: account.dateOfBirth,
          ...mirrors,
          // The request set it private on the way out; the Profile step that follows shows the
          // new-account default (D298), so the row starts from it too.
          profileVisibility: defaults.profileVisibility,
          ...termsFields,
          welcomeStep: 'home',
        });
      }
    }
    if (email !== undefined) attested.email = email;

    const context = termsAcceptanceContext(
      live !== null
        ? { profile: 'live', termsVersion: live.termsVersion }
        : { profile: existing === null ? 'none' : 'emptied' },
    );
    const userAgent = reported(args.userAgent);
    const recordId = await ctx.db.insert('consentRecords', {
      kind: 'terms',
      profileId,
      clerkUserId: subject,
      identity: attested,
      version: TERMS.version,
      contentHash: TERMS_SHA256,
      privacyVersion: PRIVACY_NOTICE_VERSION,
      privacyHash: PRIVACY_NOTICE_SHA256,
      context,
      openedAt: reading.openedAt,
      reachedEndAt: reading.reachedEndAt,
      ...(reading.reachedEndVia !== undefined ? { reachedEndVia: reading.reachedEndVia } : {}),
      recordedAt: now,
      surface: { value: args.surface, source: 'client_reported' },
      ...(userAgent !== undefined ? { userAgent } : {}),
      ipStatus: 'pending',
      copyEmail: { status: 'pending' },
    });
    await ctx.db.delete(reading._id);
    await refreshPersonRow(ctx, profileId);
    await scheduleIp(ctx, recordId, identity, args.clientSessionId);
    await ctx.scheduler.runAfter(0, internal.consent.sendTermsCopy, {
      recordId,
      clerkUserId: subject,
    });
    return { recordId };
  },
});

/** Schedule the IP capture for a new record, with every session hint the caller gave. */
async function scheduleIp(
  ctx: MutationCtx,
  recordId: Id<'consentRecords'>,
  identity: { subject: string; sid?: unknown },
  clientSessionId: string | undefined,
): Promise<void> {
  const tokenSessionId = typeof identity.sid === 'string' ? sessionIdArg(identity.sid) : undefined;
  const client = sessionIdArg(clientSessionId);
  await ctx.scheduler.runAfter(0, internal.consent.captureIp, {
    recordId,
    clerkUserId: identity.subject,
    ...(tokenSessionId !== undefined ? { tokenSessionId } : {}),
    ...(client !== undefined ? { clientSessionId: client } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Know Before You Go
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's newest record of a kind, if any. */
function newestRecord(ctx: QueryCtx, profileId: Id<'profiles'>, kind: 'terms' | 'questions') {
  return ctx.db
    .query('consentRecords')
    .withIndex('by_profile', (q) => q.eq('profileId', profileId).eq('kind', kind))
    .order('desc')
    .first();
}

/**
 * *Continue* on board 10.9: all seven answered (D296). The record — which version, when, the season
 * current at that instant — and the profile's two fields, then the IP. The answers themselves are not
 * an argument: the client holds them, and a wrong pick has no field anywhere.
 *
 * The terms come first (`terms_first`): the questions are answered under the current terms. A second
 * call within 60 s of the first (a double tap, a retry after a lost answer) returns the first's answer
 * and writes nothing.
 */
export const completeKnowBeforeYouGo = mutation({
  args: {
    version: v.string(),
    hash: v.string(),
    surface: consentSurface,
    userAgent: v.optional(v.string()),
    clientSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ season: string | null }> => {
    const profile = await requireContributor(ctx);
    if (profile.termsVersion !== TERMS.version) refuse('terms_first');
    if (!isCurrentKnowBeforeYouGo({ version: args.version, hash: args.hash })) {
      refuse('questions_changed');
    }
    const now = Date.now();
    if (
      profile.knowBeforeYouGoAt !== undefined &&
      now - profile.knowBeforeYouGoAt < KNOW_BEFORE_YOU_GO_REPEAT_MS
    ) {
      const first = await newestRecord(ctx, profile._id, 'questions');
      return { season: first?.season ?? null };
    }

    const identity = await requireIdentity(ctx);
    const watch = await newestWatch(ctx);
    const season = watch?.season ?? null;
    const email = identity.email ?? profile.email;
    const userAgent = reported(args.userAgent);
    const recordId = await ctx.db.insert('consentRecords', {
      kind: 'questions',
      profileId: profile._id,
      clerkUserId: profile.clerkUserId,
      identity: {
        fullName: profile.displayName,
        ...(email !== undefined ? { email } : {}),
        dateOfBirth: profile.dateOfBirth,
      },
      version: KNOW_BEFORE_YOU_GO.version,
      contentHash: KNOW_BEFORE_YOU_GO_SHA256,
      context: profile.knowBeforeYouGoAt === undefined ? 'first_run' : 'season',
      recordedAt: now,
      season,
      surface: { value: args.surface, source: 'client_reported' },
      ...(userAgent !== undefined ? { userAgent } : {}),
      ipStatus: 'pending',
    });
    await ctx.db.patch(profile._id, {
      knowBeforeYouGoAt: now,
      knowBeforeYouGoVersion: KNOW_BEFORE_YOU_GO.version,
    });
    await scheduleIp(ctx, recordId, identity, args.clientSessionId);
    return { season };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Home and Profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A welcome step finished, saved or skipped (boards 10.10–10.12): Home → Profile → done. A `from`
 * that isn't the current step is a no-op, so a repeated tap or a stale tab can't skip one.
 */
export const advanceWelcome = mutation({
  args: { from: welcomeStep },
  handler: async (ctx, { from }): Promise<{ welcomeStep: 'home' | 'profile' | null }> => {
    const profile = await requireContributor(ctx);
    if (profile.welcomeStep !== from) return { welcomeStep: profile.welcomeStep ?? null };
    const next = from === 'home' ? ('profile' as const) : undefined;
    await ctx.db.patch(profile._id, { welcomeStep: next });
    return { welcomeStep: next ?? null };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The receipt and the emailed copy
// ─────────────────────────────────────────────────────────────────────────────

/** What board 10.5 knows about the copy: `ReceiptCopy` in core. */
export type ReceiptCopyState = 'pending' | 'sent' | 'not_sent';

/**
 * The receipt's line (board 10.5) for the caller's newest acceptance: where the copy went, and
 * whether it did — `accepted` and `unknown` read `sent` (it may have gone; never claim it didn't),
 * `rejected` reads `not_sent`. No times: the stamps are evidence, not interface (D295). `null` before
 * any acceptance.
 */
export const latestTermsReceipt = query({
  args: {},
  handler: async (ctx): Promise<{ email: string | null; copy: ReceiptCopyState } | null> => {
    const profile = await getCurrentProfile(ctx);
    if (profile === null) return null;
    const record = await newestRecord(ctx, profile._id, 'terms');
    if (record === null) return null;
    const status = record.copyEmail?.status ?? 'rejected';
    return {
      email: record.identity.email ?? null,
      copy: status === 'pending' ? 'pending' : status === 'rejected' ? 'not_sent' : 'sent',
    };
  },
});

/** The words of the copy's email. The terms themselves are core's (`termsEmailBlocks`). */
export const TERMS_COPY_SUBJECT = 'Your copy of the Gli Terms of Use';
const TERMS_COPY_INTRO = 'Here’s a copy of the Terms of Use you accepted in Gli, for your records.';

/** The copy as HTML and text, from one source: an intro line, then the terms (version, no times). */
export function termsCopyEmail(): { subject: string; html: string; text: string } {
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: TERMS_COPY_INTRO },
    ...termsEmailBlocks(TERMS),
  ];
  return {
    subject: TERMS_COPY_SUBJECT,
    html: `<div style="font-family:system-ui,sans-serif;max-width:600px">${renderBlocksHtml(blocks)}</div>`,
    text: renderBlocksText(blocks),
  };
}

/** What the copy's send needs off its record: the address, and whether it's still owed. */
export const copyTarget = internalQuery({
  args: { recordId: v.id('consentRecords') },
  handler: async (ctx, { recordId }) => {
    const record = await ctx.db.get(recordId);
    if (record === null || record.copyEmail?.status !== 'pending') return null;
    return { email: record.identity.email ?? null };
  },
});

/**
 * **The emailed copy** (R8), scheduled by the acceptance: the address from the record, else the
 * caller's Clerk account (filled onto the record once); the email under the record id as Resend's
 * idempotency key, so a repeat within Resend's 24 hours sends nothing again; then the outcome, filled
 * once. No address — Clerk has none, or couldn't be asked — is `rejected`: definitely not sent.
 * Never throws.
 */
export const sendTermsCopy = internalAction({
  args: { recordId: v.id('consentRecords'), clerkUserId: v.string() },
  handler: async (ctx, { recordId, clerkUserId }): Promise<void> => {
    try {
      const target = await ctx.runQuery(internal.consent.copyTarget, { recordId });
      if (target === null) return;
      let to = target.email;
      let found: string | undefined;
      if (to === null) {
        const lookup = await clerkEmailLookup(clerkUserId);
        if (lookup.kind !== 'found') {
          await ctx.runMutation(internal.consent.setCopyOutcome, { recordId, status: 'rejected' });
          return;
        }
        to = lookup.email;
        found = lookup.email;
      }
      const outcome = await sendEmailOutcome({
        to,
        ...termsCopyEmail(),
        context: 'terms copy',
        idempotencyKey: recordId,
      });
      await ctx.runMutation(internal.consent.setCopyOutcome, {
        recordId,
        status: outcome.kind,
        ...(found !== undefined ? { email: found } : {}),
      });
    } catch (err) {
      console.error(`consent: the terms copy for ${recordId} threw`, err);
    }
  },
});

/**
 * The copy's outcome, filled once from `pending` (and the address the send found, if the record had
 * none). A record already settled, or gone, is left alone.
 */
export const setCopyOutcome = internalMutation({
  args: {
    recordId: v.id('consentRecords'),
    status: copyEmailStatus,
    email: v.optional(v.string()),
  },
  handler: async (ctx, { recordId, status, email }): Promise<void> => {
    const record = await ctx.db.get(recordId);
    if (record === null || record.copyEmail?.status !== 'pending' || status === 'pending') return;
    const fillEmail = email !== undefined && record.identity.email === undefined;
    await ctx.db.patch(recordId, {
      copyEmail: { status, at: Date.now() },
      ...(fillEmail ? { identity: { ...record.identity, email } } : {}),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The IP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **The record's IP** (R4), scheduled by every record's write: the caller's Clerk session's
 * latest-activity IP (`lib/clerkSessions`), then `setIp`. Never throws, never retries: a record
 * without an IP says why.
 */
export const captureIp = internalAction({
  args: {
    recordId: v.id('consentRecords'),
    clerkUserId: v.string(),
    tokenSessionId: v.optional(v.string()),
    clientSessionId: v.optional(v.string()),
  },
  handler: async (ctx, { recordId, ...who }): Promise<void> => {
    try {
      const found = await sessionIpFor(who);
      await ctx.runMutation(
        internal.consent.setIp,
        found.kind === 'captured'
          ? { recordId, address: found.address, match: found.match }
          : { recordId, unavailable: found.reason },
      );
    } catch (err) {
      console.error(`consent: the IP capture for ${recordId} threw`, err);
    }
  },
});

/** The IP, or why there is none, filled once from `pending`. */
export const setIp = internalMutation({
  args: {
    recordId: v.id('consentRecords'),
    address: v.optional(v.string()),
    match: v.optional(ipMatch),
    unavailable: v.optional(ipUnavailableReason),
  },
  handler: async (ctx, { recordId, address, match, unavailable }): Promise<void> => {
    const record = await ctx.db.get(recordId);
    if (record === null || record.ipStatus !== 'pending') return;
    if (address !== undefined && match !== undefined) {
      await ctx.db.patch(recordId, {
        ipStatus: 'captured',
        ip: { address, source: 'clerk_session_activity', match, fetchedAt: Date.now() },
      });
      return;
    }
    await ctx.db.patch(recordId, {
      ipStatus: 'unavailable',
      ipUnavailable: unavailable ?? 'error',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Retention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The daily prune of readings that never became an acceptance: opened more than 30 days ago. Bounded
 * by `CONSENT_SWEEP_PAGE`; a full page schedules the next run at once.
 */
export const pruneReadings = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - READING_TTL_MS;
    const rows = await ctx.db
      .query('termsReadings')
      .withIndex('by_opened', (q) => q.lt('openedAt', cutoff))
      .take(CONSENT_SWEEP_PAGE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length >= CONSENT_SWEEP_PAGE) {
      await ctx.scheduler.runAfter(0, internal.consent.pruneReadings, {});
    }
    return { deleted: rows.length };
  },
});

/**
 * **The six years' end** (D297): the daily purge of severed records whose `purgeAt` has come. The only
 * delete of a record.
 *
 * ⚠ `by_purge` is an index on an optional field, and not sparse: every live record sits in it with
 * `undefined`, which sorts before every number. A bare `lte('purgeAt', now)` would match — and delete —
 * every record of every living account. The range starts at `gte('purgeAt', 1)`, and each row is
 * checked again before it goes: two guards for the one job whose failure is evidence lost for good.
 */
export const purgeDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const now = Date.now();
    const rows = await ctx.db
      .query('consentRecords')
      .withIndex('by_purge', (q) => q.gte('purgeAt', 1).lte('purgeAt', now))
      .take(CONSENT_SWEEP_PAGE);
    let deleted = 0;
    for (const record of rows) {
      if (record.purgeAt === undefined || record.purgeAt > now || record.severedAt === undefined) {
        continue;
      }
      await ctx.db.delete(record._id);
      deleted++;
    }
    if (rows.length >= CONSENT_SWEEP_PAGE) {
      await ctx.scheduler.runAfter(0, internal.consent.purgeDue, {});
    }
    return { deleted };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// The evidence lookups (CLI only: nothing on any screen reads them)
// ─────────────────────────────────────────────────────────────────────────────

/** An account's records, newest first — `npx convex run consent:recordsFor '{"profileId": …}'`. */
export const recordsFor = internalQuery({
  args: { profileId: v.id('profiles') },
  handler: async (ctx, { profileId }) => {
    const rows = await ctx.db
      .query('consentRecords')
      .withIndex('by_profile', (q) => q.eq('profileId', profileId))
      .take(LOOKUP_CAP);
    return rows.sort((a, b) => b.recordedAt - a.recordedAt);
  },
});

/**
 * The records made under an email, newest first — how a severed record is found once its account is
 * gone. Exact match on the address as it was attested, and on its lowercase form.
 */
export const recordsByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const forms = [...new Set([email.trim(), email.trim().toLowerCase()])];
    const rows: Doc<'consentRecords'>[] = [];
    for (const form of forms) {
      rows.push(
        ...(await ctx.db
          .query('consentRecords')
          .withIndex('by_email', (q) => q.eq('identity.email', form))
          .take(LOOKUP_CAP)),
      );
    }
    return rows.sort((a, b) => b.recordedAt - a.recordedAt);
  },
});
