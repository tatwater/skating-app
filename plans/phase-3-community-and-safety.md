# Phase 3 — Comments + profiles + user-facing safety tools

> **Roadmap:** [`07-roadmap.md`](./07-roadmap.md) → Phase 3. This is the detailed build plan,
> in the style of the Phase 1/2/2.5 docs.
>
> **What this phase is.** The community-interaction + safety layer, kept **ahead of the feeds**
> (Phase 5) so **blocks** are enforced before the Newsfeed filters on them. The social graph was
> removed 2026-07-15 (D13) — no follows/friends. What remains: threaded **comments**, viewable/
> searchable **profiles** (privacy respected), user-facing **block + flag** tools, and a minimal
> founder **takedown** path.
>
> **Status:** planning (design settled 2026-07-16). Not started.
>
> **Build order:** **web first, then mobile** (mirrors Phase 2) — web front-loads the shared Convex
> backend (comments/blocks/flags/moderation/profile reads) and the profile + comment surfaces are
> faster to build and verify on web. Mobile mirrors once the backend + web prove the model.

Decisions referenced as D#; see [`01-decisions.md`](./01-decisions.md).

---

## Decisions locked this session (2026-07-16)

These refine the roadmap bullets; they are the "don't code into a corner" calls.

1. **A block does NOT hide the blocked user's *reports*** (safety-first, D3). A block hides the
   person's **profile, comments, and interaction** — but their **ice reports stay on the map and
   feed**, because an interpersonal block must never remove safety information from the commons.
   On a blocked author's report the author line is **de-emphasized and carries a "Blocked" chip**
   (so the user can see the block *is* working; the report content is unaffected).
   - ⚠️ **This reverses the Phase-2 stub design.** `lib/reportVisibility.ts` was written so a block
     *hid* reports (`canViewReport(..., { blocked })` → false). Phase 3 changes the report gate to
     **moderation-visible only**; the block set is repurposed to (a) hide **comments** by blocked
     authors, (b) hide **profiles** both ways, and (c) annotate report/comment author lines for
     de-emphasis. See "Corrected visibility model" below.
2. **Avatar = Clerk-managed** for v1. Mirror Clerk's `imageUrl` into an optional
   `profiles.profileImageUrl` at `upsertFromClerk` (no upload pipeline). Users manage the avatar
   via Clerk's own UI for now; a first-class in-app avatar upload is a **later** add (logged below).
3. **"Block/mute" is one feature, not two.** Ship a single **bidirectional `blocks`** row (matches
   the schema). No separate mute concept in v1.
4. **Trust score shows as `0` on every profile now** (D50 computation lands in Phase 6). We render
   the widget in Phase 3 (fed by `profiles.reputationPoints`, currently 0 for all) so the layout is
   designed around it and we don't forget it — but no score *accrues* until Phase 6.

**Confirmed scope:**
- **Profile editing is in scope** (bio, town/state label, public↔private toggle).
- **Minors are read-only for comments too** (not just reports) — `comments.create` rejects a minor
  author, same as `reports.create` (D41).
- **Moderation is minimal:** role-gated inline hide/remove + one `moderationActions` audit row per
  action. **No `/admin` queue and no operator email alerts** (those are Phase 7 / D37 / D38). Flags
  accumulate as `contentFlags` rows the founder reads via the Convex dashboard for now.
- **Comment nesting caps at 2 levels** in the UI (top-level + one reply tier; deeper replies flatten
  to the reply tier). A moderation-hidden or blocked-author parent renders as a `[hidden]`
  placeholder so its visible child replies don't disappear (D25).
- **No notification delivery in this phase.** The `report_commented` type is *documented* now
  (see below) so it isn't forgotten; delivery infra lands with the broader notifications work.

---

## Corrected visibility model (the load-bearing change)

Report reads become **moderation-only**; blocks move to comments/profiles + author de-emphasis.

| Surface | Gate |
|---|---|
| **Report** (map, detail, feed, photos) | `moderationStatus === 'visible'` **only**. Blocks never hide a report (D3). |
| **Report author line** | If the author is in the viewer's block set → **de-emphasize + "Blocked" chip**. Content unchanged. |
| **Comment** | `moderationStatus === 'visible'` **AND** author not in the viewer's block set. A hidden/blocked comment with visible children → `[hidden]` placeholder. |
| **Profile** | If viewer blocked the target **or** is blocked by the target → treat as **not found / minimal** (bidirectional hide). Else: public → full; private → name + avatar only. |

**Implementation consequence:**
- `lib/reportVisibility.ts`: `getViewableReport` drops the block check → returns a report iff
  `moderationStatus === 'visible'`. Photo-URL access follows (photos serve iff the report is
  visible — unchanged wording, block no longer part of it).
- `loadBlockedAuthorIds(ctx, viewerId)` gets its **real implementation** here (query `blocks` by
  `by_blocker` **and** `by_blocked` for `viewerId`, union both directions) — but it now feeds
  **comment** filtering, **profile** access, and **author annotation**, not report hiding.
- `@skating/core` `visibility.ts` `canViewReport` is simplified/renamed for the report case
  (moderation-only) and a separate `isAuthorBlocked(viewerId, authorId, blockedSet)` helper covers
  the de-emphasis annotation + comment/profile hiding. Keep property tests: **blocks never hide a
  report** becomes an explicit invariant test.

---

## Schema changes (all additive / migration-aware)

Applied in `packages/convex/convex/schema.ts` + `lib/enums.ts`. Optional fields are migration-free;
the notification-pref addition needs a **backfill** (called out).

1. **`profiles.profileImageUrl?: string`** — mirrored from Clerk `imageUrl` at `upsertFromClerk`
   (decision #2). Optional ⇒ migration-free. Included in the D33 export; scrubbed on deletion.
2. **`profiles` search index** — `searchIndex('search_profile', { searchField: 'displayName',
   filterFields: ['profileVisibility'] })` so public profiles are searchable by name (D13) and the
   query filters `profileVisibility === 'public'` in-index. (Exact `@handle` lookups keep using
   `by_username`.) Revisit a normalized combined name/handle field only if search quality needs it.
3. **`comments.by_author` index** — `.index('by_author', ['authorId'])`. Needed for the profile
   **#comments** count and to enumerate a user's comments; today `comments` is `by_report` only.
4. **Notification type `report_commented` + pref key `reportCommented`** (D21) — add to
   `NOTIFICATION_TYPES` and `NOTIFICATION_PREF_KEYS` in `lib/enums.ts`; already documented in
   `06-data-model.md`. **⚠️ Not migration-free:** `notificationPrefs` is `boolFlags(NOTIFICATION_PREF_KEYS)`
   (every key required), so existing `profiles` rows lacking the new key would fail validation.
   Ship a one-time `internalMutation` backfill that patches every profile's `notificationPrefs`
   with `reportCommented: true` (default-on, D16). Cheap — prod is uninitialized and dev has a
   handful of test users. **Delivery stays deferred**; adding the key now just means the toggle
   exists and we never forget the type.

No new tables — `comments`, `blocks`, `contentFlags`, `moderationActions` all already exist.

---

## `@skating/core` (pure logic first, 100% coverage — D40)

- **`profile.ts` (extend):** `isValidBio` / `normalizeBio` (length cap, trim), `isValidTownLabel` /
  `normalizeTownLabel`, and a `canSetProfilePublic(dateOfBirth, now)` guard (minors forced private,
  D41). Username/displayName validators already live here.
- **`comment.ts` (new):** `isValidCommentBody` / `normalizeCommentBody` (non-empty, length cap),
  and `resolveCommentDepth` / a thread-flattening helper enforcing the **2-level** UI cap (D25).
- **`visibility.ts` (revise):** report gate → moderation-only; add `isAuthorBlocked(viewerId,
  authorId, blockedSet)`. Property test the **"blocks never hide a report"** invariant.
- **`block.ts` (new, optional):** tiny helpers (`canBlock` self-guard). May fold into `profile.ts`.
- Re-export new modules from `packages/core/src/index.ts`.

---

## Convex backend

Every mutation gates at the trust boundary (D37): `requireProfile` for active-account actions,
`requireRole('moderator')` for takedowns. New modules:

- **`blocks.ts`** — `block({ targetUserId })`, `unblock({ targetUserId })` (idempotent; reject
  self-block), `myBlocks` (list for the settings screen). Implement `loadBlockedAuthorIds` in
  `lib/reportVisibility.ts` to union `by_blocker` + `by_blocked` for the viewer.
- **`comments.ts`** — `create({ reportId, parentCommentId?, body })`: `requireProfile`, reject
  minors (D41), require the target report to exist + be `moderationStatus: visible`, validate body,
  enforce depth ≤ 2 (a reply's parent must be top-level). `listByReport({ reportId })`: load
  `by_report`, apply moderation + block filtering, return a **2-level threaded** shape with
  `[hidden]` placeholders preserving structure, and per-comment author attribution + `blocked` flag.
  `update({ commentId, body })`: author-only, LWW, stamp `editedAt` (D25). `remove`: author
  soft-removes their own (sets `moderationStatus: removed`) — distinct from moderator removal.
- **`contentFlags.ts`** — `flag({ targetType, targetId, reason, note? })`: `requireProfile`,
  validate the target exists, dedupe to one **open** flag per (flagger, target). `unsafe_false_report`
  is a first-class reason (D3). No queue UI here — rows accrue for Phase 7.
- **`moderation.ts`** — `setModerationStatus({ targetType, targetId, status, reason })` gated
  `requireRole('moderator')`, patches the target's `moderationStatus` and writes exactly one
  `moderationActions` row (`hide`/`remove`/`restore`). `resolveFlag({ flagId, resolution, reason })`
  sets the flag `status` + writes an audit row. Hiding a report should also hide its dependent
  comments' visibility at read time (they hang off a hidden report) — decide: cascade vs. read-time
  short-circuit (lean read-time: a comment on a hidden report is unreachable anyway).
- **`profiles.ts` (extend):**
  - `upsertFromClerk`: also mirror `identity` picture → `profileImageUrl` (decision #2).
  - `updateProfile({ bio?, homeTownLabel?, profileVisibility? })`: `requireProfile`; reject a minor
    setting `public` (D41); normalize/validate via `@skating/core`.
  - `getPublicProfile({ username })`: resolve by `by_username`; apply bidirectional block hide; then
    public → full payload (name, avatar, town, bio, #reports, #comments, `reputationPoints` [=0],
    report history via `reports.by_author` filtered to `moderationStatus: visible`); private →
    name + avatar only. Never leak home coord / DOB / tokens.
  - `searchProfiles({ query })`: `search_profile` index filtered to `profileVisibility === 'public'`.
  - Count helpers: #reports via `reports.by_author`, #comments via new `comments.by_author`.
- **Migration:** `backfillNotificationPrefs` internalMutation (adds `reportCommented: true`).

---

## Web UI (`apps/web`)

- **Profile page `/u/$username`** (replace placeholder): full public profile (avatar, name, town,
  bio, #reports/#comments, trust-score widget showing 0, report history list) or private
  (name + avatar). Own profile shows an **Edit** affordance. Report history reuses the existing
  report card/detail components.
- **Profile edit** (in `settings` and/or the profile page): bio, town label, public↔private toggle
  (disabled with explanatory copy for minors). Avatar → link out to Clerk's UI for now.
- **Comments on `ReportDetail`**: 2-level thread, compose box, edit-own, reply, `[hidden]`
  placeholders, blocked-author comment hidden. Depth cap in the UI.
- **Block / unblock** control on profiles + an author overflow menu on reports/comments. A
  **"Blocked" chip** + de-emphasis on a blocked author's report line (report content unaffected).
- **Flag** control (report/comment/photo/user) → reason picker (incl. `unsafe_false_report`) + note.
- **Moderator inline actions** (role-gated): hide/remove/restore on reports + comments, with a
  required reason. Rendered only when `profiles.current.role` ≥ moderator.
- **Profile search** box (reuse the `LakeSearch` pattern) → public profiles only.
- **Blocked-users list** in settings (view + unblock).

## Mobile UI (`apps/mobile`)

Mirror web once the backend + web are proven:
- **You tab**: own profile + edit (bio, town, visibility) + blocked-users list.
- **Profile view** (route for `/u/[username]` equivalent) with the same public/private split.
- **Comments** on the mobile `ReportDetail` (2-level, compose, edit-own, `[hidden]` placeholder).
- **Block / flag** actions + "Blocked" chip on report author lines.
- **Moderator inline actions** (role-gated).
- **Profile search** (reuse mobile `LakeSearch` pattern).

---

## Testing (lands with the feature — D40)

- **`@skating/core`:** example + `fast-check` property tests for bio/town/comment-body validation,
  comment depth flattening, and the **"a block never hides a report"** invariant + `isAuthorBlocked`.
- **`convex-test`:** comments CRUD + depth gate + **minor-author rejection**; blocks bidirectional +
  self-block rejection + `loadBlockedAuthorIds` union; comment list hides blocked authors but the
  **report stays visible**; flags dedupe + target validation; moderation role-gate + **exactly one
  `moderationActions` row per action**; `getPublicProfile` public/private/blocked payloads (no PII
  leak); `searchProfiles` excludes private; `updateProfile` minor-can't-go-public.
- **Web:** component tests for the comment thread (depth, `[hidden]` placeholder), the profile page
  public/private rendering, the "Blocked" chip, and role-gated moderator buttons.
- **Mobile:** logic/hook tests (most logic is in `@skating/core`); component tests for the thread +
  profile.

---

## PR / commit breakdown (one PR per phase — memory: bundle-prs-by-phase)

One Phase 3 PR; sub-workstreams as separate commits (Greptile reviews are metered):

- **A — `@skating/core`**: profile/comment/block logic + revised visibility + tests.
- **B — Convex**: schema additions + `backfillNotificationPrefs` + blocks/comments/flags/moderation
  functions + `loadBlockedAuthorIds` + profile reads/edit/search + `convex-test`.
- **C — Web UI**: profiles, editing, comments, block/flag, moderator actions, search.
- **D — Mobile UI**: the mirror.

Push to the dev deployment (`convex dev --once`) before app verification — tests/commits don't
deploy (memory: convex-test-is-not-deploy).

---

## Out of scope / deferred (logged so it isn't lost)

- **Notification *delivery*** (comment/flag/rating). Type `report_commented` is documented +
  (optionally) added to enums now; the delivery pipeline + in-app notification center land later.
- **Operator `/admin` queue + email alerts** (Resend/React Email) → **Phase 7** (D37/D38).
- **Trust-score computation** (corroboration + helpful marks) → **Phase 6** (D50). Phase 3 shows 0.
- **First-class in-app avatar upload** (custom crop, our storage) — Clerk manages it for now
  (decision #2). Revisit if Clerk's avatar UX proves insufficient.
- **Account deletion / data export** (D33) — matures on its own track; profile anonymization must
  render gracefully wherever authors are shown (design for it, don't build it here).
- **Forum/email comment-vs-report ingestion** (Q8) — `comments.source: imported` exists for it later.
