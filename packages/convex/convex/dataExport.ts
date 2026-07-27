/**
 * Data export (D33, delivery settled in D62/N3) — "give me everything you have about me", as one
 * downloadable JSON bundle.
 *
 * **Photo bytes are embedded, not linked.** D33 said "a JSON bundle … plus their uploaded photo files",
 * and linking would have been far easier. It also fails at the exact moment the feature exists for: a
 * URL into our storage **dies when the account is deleted**, so a link-based export is worthless to
 * anyone who exports *then* deletes — which is the single most likely reason to ask for one. So photos
 * are base64'd into the bundle, under a byte budget, and anything that doesn't fit is reported rather
 * than dropped (the Phase 7 "no silent caps" rule, applied hardest to a file someone will reasonably
 * treat as their complete record).
 *
 * **Delivered by email *and* listed in settings** (founder call). Email is the delivery mechanism; the
 * in-app listing exists because Resend isn't provisioned until the prod cutover — so email-only would
 * ship this whole half of the phase unverifiable — and because a spam-filtered email shouldn't be a
 * dead end. The recipient address comes from **Clerk**, not from us: we deliberately never stored an
 * email address, so the action asks Clerk for it at send time.
 *
 * The bundle is deliberately short-lived (`dataExports.expiresAt`, swept by `storageHygiene`). It is
 * the densest concentration of one person's data anywhere in the system, and leaving it in storage
 * forever would quietly undo the care taken everywhere else.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { escapeHtml, sendEmail } from './lib/resend';

/** How long a built bundle stays downloadable. */
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Total embedded-photo budget. Actions have room for far more, but a bundle is also something a person
 * downloads on a phone over cell data — and past a point the useful part (the JSON) is buried in a file
 * that won't open. Photos beyond the budget are counted into `omittedPhotoCount` and named in the
 * bundle, never silently skipped.
 */
const PHOTO_BYTE_BUDGET = 25 * 1024 * 1024;

/** Per-table ceiling on what one bundle carries. Far above any real contributor. */
const ROW_CAP = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// The user-facing half
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask for an export. One at a time per user: a second request while one is building returns the
 * in-flight row rather than starting a parallel build, because the expensive part is re-reading a whole
 * account and a double-tap shouldn't cost that twice.
 */
export const requestExport = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db
      .query('dataExports')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();
    const building = existing.find((e) => e.status === 'building');
    if (building) return building._id;

    const now = Date.now();
    const exportId = await ctx.db.insert('dataExports', {
      userId: profile._id,
      status: 'building',
      requestedAt: now,
      expiresAt: now + EXPORT_TTL_MS,
    });
    await ctx.scheduler.runAfter(0, internal.dataExport.buildExport, { exportId });
    return exportId;
  },
});

/**
 * The caller's own exports, newest first, with a live download URL for each ready bundle.
 *
 * URLs are resolved per read rather than stored, so a swept bundle can't leave a dead link behind in a
 * cached row — the row disappears with the blob.
 */
export const myExports = query({
  args: {},
  handler: async (ctx) => {
    const profile = await getCurrentProfile(ctx);
    if (!profile) return [];
    const rows = await ctx.db
      .query('dataExports')
      .withIndex('by_user', (q) => q.eq('userId', profile._id))
      .collect();

    return Promise.all(
      rows
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map(async (row) => ({
          exportId: row._id,
          status: row.status,
          requestedAt: row.requestedAt,
          readyAt: row.readyAt,
          expiresAt: row.expiresAt,
          sizeBytes: row.sizeBytes,
          photoCount: row.photoCount,
          omittedPhotoCount: row.omittedPhotoCount,
          emailedAt: row.emailedAt,
          error: row.error,
          url:
            row.storageId !== undefined
              ? await ctx.storage.getUrl(row.storageId as Id<'_storage'>)
              : null,
        })),
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Building the bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything about one person that belongs in their export, minus the photo bytes (which the action
 * fetches from storage, since a query can't).
 *
 * What's deliberately **not** here: OAuth access/refresh tokens. They're the one thing in the account
 * that is a live credential rather than a record of something the person did, and handing someone a
 * downloadable copy of their own Strava token — in a file that then sits in a Downloads folder — is a
 * worse outcome than the small completeness loss. The *connection* is exported; the secret isn't.
 */
export const collect = internalQuery({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db.get(userId);
    if (!profile) throw new ConvexError('No such profile');

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_author', (q) => q.eq('authorId', userId))
      .take(ROW_CAP);
    const comments = await ctx.db
      .query('comments')
      .withIndex('by_author', (q) => q.eq('authorId', userId))
      .take(ROW_CAP);
    const hazards = await ctx.db
      .query('hazards')
      .withIndex('by_author_and_water_body', (q) => q.eq('createdByUserId', userId))
      .take(ROW_CAP);
    const activities = await ctx.db
      .query('gpsActivities')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(ROW_CAP);
    const favorites = await ctx.db
      .query('waterBodyFavorites')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(ROW_CAP);
    const ratings = await ctx.db
      .query('reportRatings')
      .withIndex('by_rater', (q) => q.eq('raterId', userId))
      .take(ROW_CAP);
    const points = await ctx.db
      .query('pointEvents')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(ROW_CAP);
    const confirmations = await ctx.db
      .query('hazardConfirmations')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(ROW_CAP);
    const connections = await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(ROW_CAP);
    const photos = await ctx.db
      .query('photos')
      .withIndex('by_uploader', (q) => q.eq('uploaderId', userId))
      .take(ROW_CAP);

    const {
      // Not exported: the Clerk subject is an internal identifier for a system the user already has
      // access to, and it's the join key an attacker would want most from a leaked bundle.
      clerkUserId: _clerkUserId,
      ...exportableProfile
    } = profile;

    return {
      profile: exportableProfile,
      reports: reports,
      comments: comments,
      hazards: hazards,
      hazardConfirmations: confirmations,
      gpsActivities: activities,
      waterBodyFavorites: favorites,
      reportRatings: ratings,
      pointEvents: points,
      // Secrets stripped — see the note above.
      activityConnections: connections.map((c) => ({
        provider: c.provider,
        externalUserId: c.externalUserId,
        scopes: c.scopes,
        connectedAt: c.connectedAt,
      })),
      photos: photos.map((p) => ({
        photoId: p._id,
        caption: p.caption,
        takenAt: p.takenAt,
        coord: p.coord,
        placeOnMap: p.placeOnMap,
        createdAt: p.createdAt,
        storageId: p.storageId,
      })),
    };
  },
});

/** Mark a bundle ready (or failed) — the only writer of the terminal states. */
export const finishExport = internalMutation({
  args: {
    exportId: v.id('dataExports'),
    storageId: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    photoCount: v.optional(v.number()),
    omittedPhotoCount: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { exportId, error, ...rest }) => {
    const row = await ctx.db.get(exportId);
    if (!row) return;
    if (error !== undefined) {
      await ctx.db.patch(exportId, { status: 'failed', error });
      return;
    }
    await ctx.db.patch(exportId, { status: 'ready', readyAt: Date.now(), ...rest });
  },
});

/** Record that the email went out. Separate from `finishExport` so a mail failure can't unready a bundle. */
export const markEmailed = internalMutation({
  args: { exportId: v.id('dataExports') },
  handler: async (ctx, { exportId }) => {
    await ctx.db.patch(exportId, { emailedAt: Date.now() });
  },
});

/**
 * Assemble the bundle: read the account, pull each photo out of storage under a byte budget, store the
 * JSON, then email a link.
 *
 * A failure is recorded on the row rather than thrown into the void — a user who clicked "export my
 * data" and sees nothing can't tell "still working" from "broken", and `status: 'failed'` with a reason
 * is the difference.
 */
export const buildExport = internalAction({
  args: { exportId: v.id('dataExports') },
  handler: async (ctx, { exportId }) => {
    const row = (await ctx.runQuery(internal.dataExport.readExport, {
      exportId,
    })) as Doc<'dataExports'> | null;
    if (!row) return;

    try {
      const data = await ctx.runQuery(internal.dataExport.collect, { userId: row.userId });

      let used = 0;
      let omitted = 0;
      const files: { photoId: string; contentType: string | null; base64: string }[] = [];
      for (const photo of data.photos) {
        const blob = await ctx.storage.get(photo.storageId as Id<'_storage'>);
        if (blob === null) continue; // already swept — its metadata still ships below
        const buffer = await blob.arrayBuffer();
        if (used + buffer.byteLength > PHOTO_BYTE_BUDGET) {
          omitted++;
          continue;
        }
        used += buffer.byteLength;
        files.push({
          photoId: photo.photoId,
          contentType: blob.type || null,
          base64: toBase64(buffer),
        });
      }

      const bundle = {
        exportedAt: new Date().toISOString(),
        format: 'skating-data-export/1',
        note: 'Photo files are base64-encoded in `photoFiles`, keyed by the `photoId` used in `photos`.',
        ...(omitted > 0
          ? {
              omittedPhotos: `${omitted} photo file(s) exceeded the ${Math.round(
                PHOTO_BYTE_BUDGET / (1024 * 1024),
              )} MB bundle budget and are listed in \`photos\` without their bytes.`,
            }
          : {}),
        ...data,
        photoFiles: files,
      };

      const json = JSON.stringify(bundle, null, 2);
      const storageId = await ctx.storage.store(
        new Blob([json], { type: 'application/json' }) as Blob,
      );

      await ctx.runMutation(internal.dataExport.finishExport, {
        exportId,
        storageId,
        sizeBytes: json.length,
        photoCount: files.length,
        omittedPhotoCount: omitted,
      });
      await emailBundle(ctx, exportId, row.userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`dataExport: build failed for ${exportId}: ${message}`);
      await ctx.runMutation(internal.dataExport.finishExport, { exportId, error: message });
    }
  },
});

/** Read one export row from an action. */
export const readExport = internalQuery({
  args: { exportId: v.id('dataExports') },
  handler: (ctx, { exportId }) => ctx.db.get(exportId),
});

/** Resolve a ready bundle's download URL from an action. */
export const exportUrl = internalQuery({
  args: { exportId: v.id('dataExports') },
  handler: async (ctx, { exportId }) => {
    const row = await ctx.db.get(exportId);
    if (!row?.storageId) return null;
    return ctx.storage.getUrl(row.storageId as Id<'_storage'>);
  },
});

/** The Clerk subject for a profile — needed to look up an email we deliberately never stored. */
export const clerkSubjectFor = internalQuery({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => (await ctx.db.get(userId))?.clerkUserId ?? null,
});

/**
 * Email the download link.
 *
 * The address comes from Clerk because **we never stored one** — a deliberate data-minimization choice
 * that costs exactly this one API call. A missing key or a Clerk failure logs and returns: the bundle is
 * already `ready` and listed in settings, so an unsendable email degrades to the in-app path rather
 * than losing the export.
 */
async function emailBundle(
  ctx: ActionCtx,
  exportId: Id<'dataExports'>,
  userId: Id<'profiles'>,
): Promise<void> {
  const url = (await ctx.runQuery(internal.dataExport.exportUrl, { exportId })) as string | null;
  if (url === null) return;

  const to = await clerkEmailFor(ctx, userId);
  if (to === null) {
    console.warn(
      `dataExport: no email address for ${userId} — the bundle is ready and listed in settings`,
    );
    return;
  }

  const sent = await sendEmail({
    to,
    subject: 'Your skating data export is ready',
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">Your data export is ready</h2>
      <p style="margin:0 0 8px">This link works for 7 days, after which the bundle is deleted from our storage.</p>
      <p style="margin:16px 0 0"><a href="${escapeHtml(url)}" style="color:#0b69ff">Download your data →</a></p>
    </div>`,
    text: `Your data export is ready. This link works for 7 days, after which the bundle is deleted.\n\n${url}`,
    context: 'data export',
  });
  if (sent) await ctx.runMutation(internal.dataExport.markEmailed, { exportId });
}

/** Ask Clerk for a user's primary email address. Returns `null` rather than throwing. */
async function clerkEmailFor(ctx: ActionCtx, userId: Id<'profiles'>): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    console.warn('CLERK_SECRET_KEY not set — cannot look up an export recipient address');
    return null;
  }
  const subject = (await ctx.runQuery(internal.dataExport.clerkSubjectFor, { userId })) as
    | string
    | null;
  if (subject === null) return null;

  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${subject}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`Clerk user lookup failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as {
      primary_email_address_id?: string;
      email_addresses?: { id: string; email_address: string }[];
    };
    const addresses = body.email_addresses ?? [];
    const primary = addresses.find((a) => a.id === body.primary_email_address_id) ?? addresses[0];
    return primary?.email_address ?? null;
  } catch (err) {
    console.warn('Clerk user lookup threw', err);
    return null;
  }
}

/**
 * Base64 without Node's Buffer — Convex's default runtime doesn't have it, and pulling in a
 * `"use node"` bundle for one encoder would be a large dependency for a small job. Chunked because
 * `String.fromCharCode(...bytes)` blows the argument limit on anything bigger than a thumbnail.
 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
