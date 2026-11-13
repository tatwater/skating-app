# The admin surface as built — inventory, 2026-10-12

The raw inventory that fed Phase B01 (`phases/B01-admin-console.md`): every `/admin` page as it stood on `main` at `d55318c9`, every moderator control embedded in the skater-facing pages, every role-gated Convex function and its caller, every submission type a person can file, every cron. Four read-only passes over the code, lightly edited; the phase doc carries the diagnosis and the plan, this carries the evidence. Line numbers are as of that commit.

Dev data on the same day: `importRuns` 217 (190 succeeded, 27 failed), `moderationActions` 2,000+, `metricSnapshots` 1,864, `profiles` 4, `reports` 2, `hazards` 3, `bounties` 1; `contentFlags`, `supportTickets`, `waterBodyRequests` and `corpusPlaceNames` (the open queue, after `#88`) all 0. Every person-filed queue is empty on dev.

---

# Part 1 — The non-water pages, the shared frame, and the moderator controls outside `/admin`

The admin area is a set of pages under `/admin`, gated by role in the web app. Every page below is a single long scrolling column made of cards, apart from a few tables. Nothing uses a map. Only the Dashboard (`/admin`) and Tuning (`/admin/tuning`) have charts, and the Ice calibration page has none.

## 0. Shared frame

### Shell: `apps/web/src/routes/admin.tsx` → `apps/web/src/components/admin/AdminLayout.tsx`
- Header comment: "The operator surface's shell (D37) — a role-gated `/admin` tree inside the web app (not a second app). It gates the whole tree at **moderator**, redirects a moderator off the **admin-only** children… renders the sidebar (hiding links the caller can't use), and hosts the child pages via `<Outlet/>`." The client gate is described as "a **UX** boundary, not a security one".
- Who gets in:
  - Anyone who isn't a moderator is redirected to `/`.
  - A moderator on any path starting with `/admin/support`, `/admin/tuning`, `/admin/imports` or `/admin/seasons` is redirected to `/admin`.
  - While the role is loading or a redirect is happening, a `<Splash/>` screen shows.
- Sidebar: vertical on desktop, a horizontal scrolling strip on mobile. Items in order:

| Label | Route | Gate |
|---|---|---|
| Dashboard | `/admin` (exact) | moderator |
| Flags | `/admin/flags` | moderator |
| Users | `/admin/users` | moderator |
| Water bodies | `/admin/water` | moderator |
| Intake review | `/admin/water/review` | moderator |
| Standing | `/admin/water/standing` | moderator (A07b) |
| Requests | `/admin/water/requests` | moderator (A07b PR 2) |
| Place names | `/admin/water/place-names` | moderator (D202) |
| Body features | `/admin/features` | moderator |
| Hazard identity | `/admin/recurrence` | moderator |
| Ice calibration | `/admin/ice-calibration` | moderator ("D160's dark instrument. It has to be *reachable*…") |
| Seasons | `/admin/seasons` | **admin** |
| Support | `/admin/support` | **admin** |
| Tuning | `/admin/tuning` | **admin** |
| Imports | `/admin/imports` | **admin** |

- The `/admin/users/$id` detail page has no sidebar entry. You reach it from Users search or from the "Full detail →" link on a public profile.
- Entry point from the main app: `apps/web/src/components/AppShell.tsx:108` shows an "Admin" link in the top nav when `profile.role` is moderator or admin. It checks the role directly rather than through `useRole`.

### `apps/web/src/lib/useRole.ts`
- `Role = 'member' | 'moderator' | 'admin'`. There are only three roles.
- `useRole()` reads `api.profiles.current` and returns:
  - `role`
  - `userId`: the caller's own profile id, used to hide controls that would act on yourself
  - `isModerator`: moderator or admin. "gates navigation and read-only operator chrome"
  - `isAdmin`
  - `canModerate`: `isModerator && !leaving`. "gates every operator action"
  - `leaving`: the account is partway through deletion (`isLeaving(profile)`)
  - `isLoading`
- Header comment (D37): "`isModerator` and `canModerate` are not the same question… mirrors a seam the server draws (`requireRole` vs `requireContributorRole`). A departing operator keeps their *reads*… What they lose is every privileged **write**."
- The server side is `packages/convex/convex/lib/auth.ts`. `requireRole` is for reads. `requireContributorRole` is for writes and also refuses accounts that are leaving.

### `apps/web/src/components/admin/adminUi.tsx` (primitives, no data)
- `AdminPageHeader({title, subtitle, actions})`: an h1 with a subtitle, and an optional actions slot on the right.
- `AdminEmpty`: a centered muted card for empty or loading states.
- `StatTile({label, value, hint, tone})`: one KPI card with a big number. Tone can be default, warning or danger.
- `Table` / `Th` / `Td`: thin wrappers around a plain HTML table. The UI kit has no table component.
- `errorText(err)`: turns a ConvexError into the message line the server wrote. It is used by lake-editor pages, not by the 9 pages here.
- `ToolCard({title})`: a titled card for the lake editor's tool column. Not used by the 9 pages here.

### `apps/web/src/components/admin/ReasonDialog.tsx`
- Header comment: "A reusable 'collect a reason, then confirm' dialog for audited operator actions (D37). Every lifecycle/moderation mutation requires a non-empty reason for the `moderationActions` log…"
- Props: `trigger`, `title`, `description`, `confirmLabel`, `confirmVariant` (default `destructive`), `reasonPlaceholder` (default "Why?"), `requireReason` (default true), `extraFields` (rendered above the reason box), `onOpenChange`, `confirmDisabled`, `onConfirm(reason) => Promise`.
- Behavior:
  - A Reason textarea. Confirm stays disabled while the reason is empty, if one is required.
  - Errors are shown inline.
  - On success the dialog closes and the reason is cleared.
  - Cancel and Confirm buttons.

### `apps/web/src/components/admin/ConstantCard.tsx`
- Header comment: "A single tuning constant, rendered **read-only** (Phase 07-2 settled decision #1). The founder tunes by editing the constant in `@skating/core` and redeploying… `appConfig` — a runtime override table — is the documented future seam… Not built speculatively."
- `ConstantCard({name, value, file, children})`: a card showing the constant name in monospace, a value pill, an explanation, and a footer "Defined in `packages/core/src/<file>` · changing this requires a redeploy."
- `TuningSection({title, blurb})`: an h2 with a blurb, wrapping a group of constant cards and charts.

### Chart helpers (used by Dashboard and Tuning)
- `components/admin/MetricCharts.tsx`. Every query here is admin-only on the server.
  - `useCatalog()` → `api.analytics.catalog`: the metric catalog (label, description, bucket labels).
  - `ScalarTrend` → `api.analytics.series({metrics, days:30})`: a time-series line chart.
  - `MetricHistogram` → `api.analytics.latest({metrics:[key]})`: the latest bucketed snapshot as a histogram, with optional marker lines.
  - `MetricComposition` → `api.analytics.latest`: the latest `meta` breakdown as a horizontal composition bar.
  - `GateScatterCard` → `api.analytics.bountyGateScatter({days:30})`: a scatter of report age against the freshness window applied.
  - Every chart card has a "table" alternative view (`MiniTable`).
- `components/admin/CatalogCoverage.tsx` → `api.analytics.catalogHistory({metric:'catalog_edh_coverage'})` (admin-only). It shows 4 stat tiles and a line chart with 2 series.
- `components/admin/ContributorTrend.tsx` → `api.analytics.contributorTrend({userId})` (moderator). Monthly good-vs-bad bars, with the account age written out beside them and a "View as table" disclosure.

---

## 1. `/admin`: `routes/admin.index.tsx`
- **Nav label:** Dashboard. **Gate:** moderator, with two admin-only sections.
- **Purpose:** "Operator dashboard (D37) — queue depths at a glance, the app-health strip, and the recent-actions audit feed. Queue depths are computed live off bounded indexes; the app-health trends read the daily `metricSnapshots` rollups (admin-only, so a moderator sees everything else but not the strip)."

**Data shown**

Queries:
- `api.moderation.listFlags({})` (moderator) returns `{priority, standard, accessReports}`:
  - It reads open and "reviewing" flags, up to 100 per status, oldest first.
  - `priority` is the `unsafe_false_report` flags.
  - `standard` is every other reason.
  - `accessReports` is `no_public_access` flags on water bodies, grouped per lake.
- `api.waterBodies.listPendingReview({})` (moderator) returns the **full documents** of user-drawn bodies with `reviewStatus: 'pending'`, capped.
- `api.waterBodies.listDedupCandidates({})` (moderator) returns `{groups, total, flaggedRows}`: suspected-duplicate groups, with near-certain ones first.
- `api.moderation.listActions({limit:20})` (moderator) returns the newest 20 entries from the audit log. Each has `{id, action, targetType, targetId, reason, metadata, createdAt, actor}`.

Layout, top to bottom:
1. **Four stat tiles in a 2×2 / 4-column grid:**
   - "Safety flags" = `priority.length`, hint "unsafe_false_report — priority lane", turns red when above 0.
   - "Other flags" = `standard.length`, hint "spam / harassment / etc.".
   - "Bodies to review" = number of pending bodies, hint "pending user-drawn bodies".
   - "Dedup candidates" = `dedup.total` (decisions), hint "N flagged rows".
2. **Two text links:** "Go to flag queue →" goes to `/admin/flags`. "Review water bodies →" goes to `/admin/water`.
3. **Admin only: "App health · last 30 days".** Three `ScalarTrend` charts, 160px tall:
   - Reports (`reports_created`)
   - New accounts (`signups`)
   - Active contributors (`active_contributors`, trailing 7 days)
4. **Admin only: "Base map · elevation-derived hydrography".** This is `CatalogCoverage` (A07a):
   - Tiles: Re-surveyed share, Published upstream share, Still from NHD count, Measured date/release.
   - A line chart, "Elevation-derived hydrography over time" (In our corpus vs Published upstream). The chart only draws once at least 2 measurements exist.
5. **"Recent actions" table** with columns When (relative time), Actor (@username), Action (raw enum in monospace), Reason.

**Actions:** none.

**Links out:** `/admin/flags`, `/admin/water`.

**Visual shape:** KPI tiles, then charts, then a table, all on one scrolling page.

**Confusing, duplicated or dead:**
- The "Safety flags" and "Other flags" tiles ignore the access lane (`accessReports`), so per-lake access reports have no tile.
- There are no tiles for the other queues: intake review, standing, requests, place names, recurrence, support.
- "Bodies to review" and "Dedup candidates" fire the same two queries that `/admin/water` also fires. `listPendingReview` sends whole water-body documents (polygons included) just so the dashboard can count them.
- The Recent actions table drops `targetType` and `targetId`, so you can't tell what an action was taken on, and no row links anywhere. Action names show as raw enums such as `set_posting_permission`.
- The 20-row limit is fixed and there is no filter, even though `listActions` supports filtering by `targetType`/`targetId`, `actorId` and `action`.

---

## 2. `/admin/flags`: `routes/admin.flags.tsx`
- **Nav label:** Flags. **Gate:** moderator.
- **Purpose:** "Flag queue (D37/D3) — the `unsafe_false_report` **priority lane** first (a dangerously false 'ice is great' claim is a safety incident, not FIFO spam), then everything else. Each row resolves its subject so a moderator can triage in place: dismiss/action the flag, and (for content that carries a moderation axis) hide/remove it — two separately-audited decisions."
- **Header:** "Flag queue", subtitle "Safety flags first, then everything else."

### Data shown

`api.moderation.listFlags({})`. Each flat row (`FlagView`) contains:
- `id`, `targetType`, `targetId`, `reason`, `note`, `status`, `createdAt`
- `flagger` (`{userId, username, displayName}` or null)
- `target`, resolved per type: `{exists, author, summary, moderationStatus?}`:
  - report: a snippet of its notes
  - post: its title or body
  - comment: its body
  - hazard: "Hazard: type"
  - photo: its caption
  - accessAlert: the note, or "Access alert: reason"
  - waterbody: "Lake: name", with no author
  - user: "User: @handle", where the author slot holds the person being reported
  - if the target is gone: "(deleted)"
- `occurrences`: the number of times this problem was recorded. Bundled in A02.
- `lastOccurrenceAt`, `priorResolvedAt`, `priorResolution`: taken from the earlier, superseded flag on the same thing.

The page has three sections, and each appears only when it has rows. If all three are empty it shows "The queue is clear. 🎉".

1. **"Priority · safety"** (red heading): one `FlagRow` card per `unsafe_false_report` flag.
2. **"Access · most corroborated first"**: one `AccessReportRow` card per lake (A06f), sorted by report count with age breaking ties.
3. **"Standard"**: `FlagRow` cards for every other reason: spam, harassment, inappropriate, auto_low_quality, other.

There is no sort control, filter, search or pagination. The server caps each status at 100.

**What a `FlagRow` card shows:**
- Badges:
  - the reason (red for `unsafe_false_report`)
  - the target type
  - the target's moderation status, if it isn't "visible"
  - "Nth occurrence", if occurrences > 1
- "flagged by @x" (or "system" when there is no flagger)
- A recurrence line when there's an earlier resolution: "Last {dismissed|actioned} Nd ago — this is a recurrence…"
- The target summary, then "by Display · @handle"
- The flagger's note, quoted in italics

**What an `AccessReportRow` card shows:**
- Badges: "no public access", "N reports", and a red "disputes a prior review" when the reports came after an earlier "open" ruling
- The lake name
- A dispute explainer ("You ruled this open Nd ago…")
- Every reporter's note, quoted

### Actions (all through `ReasonDialog`, which requires a reason unless noted)

**On a `FlagRow`:**
- **Hide content** and **Remove content**: only for report, post, comment and hazard targets that still exist.
  - Calls `api.moderation.setModerationStatus({targetType, targetId, status:'hidden'|'removed', reason})`.
  - Server gate: `requireContributorRole('moderator')`.
  - Hiding or removing a Post cascades to its Reports (A10/D186). Hiding a hazard recomputes the lake's summary card.
  - Writes a `hide` or `remove` audit row.
  - Dialog descriptions: "Hides it from the app and writes an audit record." / "Removes it and writes an audit record."
- **Retract alert**: only for existing `accessAlert` targets.
  - Calls `api.accessAlerts.retract({accessAlertId, reason})`. The alert's status becomes `retracted` and it writes a `retract_access_alert` audit row.
  - Description: "Marks the claim as never having been true…"
- **Pin as official**: only for existing `accessAlert` targets.
  - Calls `api.accessAlerts.setOfficial({accessAlertId, official:true, reason})`. The alert's status becomes `official`, so it never expires, and it writes a `pin_access_alert` audit row.
  - The comment cites the founder's 2026-08-10 exemption.
- **Action flag**: calls `api.moderation.resolveFlag({flagId, resolution:'actioned', reason})`.
- **Dismiss**: calls `api.moderation.resolveFlag({…'dismissed'})`.
  - `resolveFlag` closes the flag, which also sends the A08 verdict notification to the flagger and records the disposition metric. It writes a `resolve_flag` or `dismiss_flag` audit row.
  - It throws if the flag is already resolved.

**On an `AccessReportRow`:**
- **Mark no public access**: calls `api.waterBodies.setPublicAccess({waterBodyId, verdict:'none', reason})`. The lake is dimmed and demoted (made dormant), and every open `no_public_access` flag on it is closed as actioned.
- **Confirm public access**: calls `setPublicAccess({…verdict:'open', reason})`. Nothing changes on the map, the reports are dismissed, and the lake is reactivated if it was dormant.

### Links out
None. Rows do not link to the reported content, the lake, the author or the flagger.

### Visual shape
A long stack of cards with badge rows and button rows. There are no tables.

### Confusing, duplicated or dead
- Flags on photos and users only get Action and Dismiss. There's no takedown here and no link to `/admin/users/$id` to act on the user.
- There's no **restore** (un-hide) control anywhere in the web app. `setModerationStatus` accepts `'visible'`, but no client ever sends it. `ModeratorActions` even says "the full queue + restore-of-hidden-content lives in the Phase 07 `/admin` surface", and it doesn't.
- "Unpin" (`setOfficial(official:false)`) is not exposed in the UI.
- `listFlags` also reads flags with status `reviewing`, but nothing ever sets that status, so it's dead.
- Access-lane ruling happens in two places:
  - here, with a reason dialog
  - inline on the public lake drawer (`PublicAccessSection`, §11), with no reason or confirmation, plus a "Clear" verdict that this page doesn't offer.
- Takedown here is the same mutation as the inline `ModeratorActions` on public pages.
- "flagged by system" appears only when `flaggerId` is empty. Automatic flags often name a real person (see `FLAG_ORIGINS`), so they'll show "flagged by @someone".

---

## 3. `/admin/users`: `routes/admin.users.index.tsx`
- **Nav label:** Users. **Gate:** moderator.
- **Purpose:** "User admin search (D37) — find **any** account (private, suspended, banned) by name or @handle, then open the detail page to act. Unlike the member-facing search, this drops the public-only filter (server-gated to moderators)."
- **Data shown:**
  - Calls `api.admin.userSearch({query})` (moderator) on every keystroke, and skips the call when the box is empty.
  - Server: an exact `by_username` match first (a leading @ is stripped), then a display-name full-text search. Capped at 20 hits.
  - Returns `{userId, username, displayName, profileImageUrl, role, status, trustClass}`.
  - States: "Start typing to find a user." / "Searching…" / "No users match …".
- **Each result card:**
  - Avatar, display name and @handle
  - A role badge if not a member
  - A status badge if not active (banned and suspended in red, deleted and deleting muted)
- **Actions:** none.
- **Links out:** each card goes to `/admin/users/$id`.
- **Visual shape:** a search input with a list of clickable cards.
- **Confusing or dead:**
  - `trustClass` is returned but never shown.
  - You can't list or browse users at all: no "recently banned", "has open flags" or "moderators" lists. The only way in is to search by text.

---

## 4. `/admin/users/$id`: `routes/admin.users.$id.tsx`
- **Nav label:** none (detail page). **Gate:** moderator. The role section and the raw trust number are **admin only**.
- **Purpose:** "Operator user detail (D37/D50/D57). The **contributor-trust panel** (contradiction count + tenure) feeds the D57 posting-permission decision; the **raw trust number** is admin-only (D50, gated server-side). Lifecycle + posting-permission levers come from the shared `UserModerationControls` (also used in-context on a profile); role grant/revoke is admin-only and lives here. The tenure-aware good-vs-bad trend chart arrives with the analytics commit." That last sentence is stale: the chart is already rendered.

### Data shown
- `api.profiles.getAdmin({userId})` (moderator) returns:
  - `userId`, `username`, `displayName`, `profileImageUrl`, `role`, `status`, `statusReason`, `suspendedUntil`, `trustClass`
  - `canPostReports`, `canPostHazards`, `canPostComments`, `activeBountyPostLimit`
  - `contradictionCount`, `reportCount`, `commentCount`, `createdAt`
  - **admin viewers only:** `reputationPoints`, `bountyPoints`
  - `recentActions`: up to 50 audit rows about this user
  - `openFlagCount`: open flags whose target is this user
- `api.analytics.contributorTrend({userId})`, via `ContributorTrend`.

### Layout
1. **Header:** the display name as title, subtitle "@handle · Nd/mo/y old". On the right: avatar, a role badge (if not a member), and a status badge (red if not active).
2. **"Reason on file: …"**, if there's a `statusReason`.
3. **"Contributor trust"** section:
   - Four tiles:
     - Contradictions: amber at 3 or more, hint "weather-unexplained (private)"
     - Open flags
     - Reports
     - Admins see "Trust points" (raw score, hint "raw score — admin only"). Moderators see "Trust class" instead.
   - Below the tiles, the `ContributorTrend` chart. Its explainer reads "Good = reports corroborated or thumbed net-helpful; bad = settled contradictions + upheld safety flags…"
4. **"Moderation"** section: `UserModerationControls` (see §10).
5. **"Role"** section: admins only, and hidden when you're looking at yourself. Each button opens a `ReasonDialog` with a reason required:
   - **Make moderator**: shown when the role isn't moderator. Calls `api.admin.grantRole({userId, role:'moderator', reason})`.
   - **Make admin**: shown when the role isn't admin. Calls `grantRole({…role:'admin'})`. Description: "Admins hold the keys — role-granting, PII, and the tuning surface."
   - **Revoke role**: shown when the role isn't member. Calls `api.admin.revokeRole({userId, reason})`.
   - The server requires an admin who isn't leaving, refuses self-targeting, and writes a `grant_role` or `revoke_role` audit row with the previous role.

### Links out
None. There's no link to the public profile `/u/$username`, to the user's content, or to flags.

### Visual shape
Header, tiles, a bar chart, then cards of controls.

### Confusing, duplicated or dead
- Fetched but never rendered: `recentActions` (the user's moderation history), `suspendedUntil` (when the suspension ends), `commentCount`, and `bountyPoints` for admins.
- "Open flags" only counts flags filed against the **user**, not flags on their content.
- For a user who is already an admin, the "Make moderator" button is shown. That's really a demotion with a "Grant" label.
- `UserModerationControls` still renders when an admin looks at their own row, and when a moderator looks at an admin. The server refuses both.
- The page never checks `canModerate`, so a leaving moderator still sees action buttons the server will refuse.
- The amber threshold of 3 for contradictions is hard-coded. It currently matches `CONTRADICTION_FLAG_THRESHOLD = 3`.
- Duplicated with `ProfileModeratorPanel` on `/u/$username`: same controls, same query.

---

## 5. `/admin/support`: `routes/admin.support.tsx`
- **Nav label:** Support. **Gate:** **admin** (redirect in the layout, and `requireRole('admin')` on the server).
- **Purpose:** "Support inbox (D35/D37) — **admin-only** (PII). Tickets, bug reports, and account appeals (`category: account`), filterable by status, with assign/resolve. Server-gated to admins."
- **Data shown:**
  - Calls `api.support.list({status?})`, newest first, capped at 100.
  - Each ticket: `{id, category (bug|account|safety|other), body, status (open|in_progress|resolved), createdAt, resolvedAt, submitter, assignedTo, context{platform, appVersion, deviceModel, sentryEventId}}`.
  - A status dropdown sits in the header: All / open / in progress / resolved. It defaults to open.
- **Each ticket card:**
  - A category badge (red for safety) and a status badge
  - "@submitter" or "anonymous", and "→ @assignee"
  - The body, with line breaks kept
  - A monospace context line: "platform · version · device · sentry:id"
- **Actions:** only on tickets that aren't resolved. Plain buttons with **no confirmation, no reason and no audit row**:
  - **Assign to me**: calls `api.support.assign({ticketId})`. It assigns to the caller and moves an open ticket to in_progress.
  - **Resolve**: calls `api.support.resolve({ticketId})`. It sets status resolved and stamps `resolvedBy`/`resolvedAt`.
- **Links out:** none. The submitter isn't linked to `/admin/users/$id`, even though account appeals are about lifecycle actions on that page.
- **Visual shape:** a list of cards with a dropdown in the header.
- **Confusing or dead:**
  - `createdAt` and `resolvedAt` are fetched but not shown, so you can't see how old a ticket is.
  - The server accepts a `category` filter, but the UI doesn't offer one.
  - You can't reply, add a note, reopen a ticket, or assign it to someone else (the server's `assigneeId` argument isn't used).
  - The operator alert email deep-links here (`support.ts:178`).

---

## 6. `/admin/features`: `routes/admin.features.tsx`
- **Nav label:** Body features. **Gate:** moderator.
- **Purpose:** "Known seasonal body features (D53) — the persistent, non-decaying attributes (springs, ridges, bridge-narrows) a moderator has graduated from recurring hazards. This page lists the active ones and demotes them; **promotion happens in-context** from a hazard pin on the map (a feature needs a source hazard to graduate)."
- **Data shown:**
  - Calls `api.bodyFeatures.listRecent({})` (moderator).
  - The server takes the **100 newest** feature rows and then filters to the active ones.
  - Returns `{id, type, note, waterBodyId, waterBodyName, promotedFromHazardId, createdAt}`.
  - No filter, sort or pagination.
- **Each card:** a type badge (raw enum such as `spring_current`, not the label), the lake name, and the note.
- **Actions:** **Demote**, a `ReasonDialog` with a required reason.
  - Calls `api.bodyFeatures.demote({bodyFeatureId, reason})`.
  - Sets `active:false`, clears the source hazard's backlink and every cluster member's backlink, sends the cluster back to the recurrence queue, and writes an audit row.
  - Description: "Reversible — flips it inactive and un-supersedes the source hazard if any."
- **Links out:** none. `waterBodyId` and `promotedFromHazardId` are returned, but neither the lake editor nor the hazard is linked.
- **Visual shape:** a short list of cards.
- **Confusing, duplicated or dead:**
  - The header comment and subtitle ("Promote a recurring hazard from its pin on the map") are out of date. Promotion now also happens in the lake editor `/admin/water/$id`:
    - `PromotionTool`, which uses `hazards.listPromotionCandidates` and `bodyFeatures.promote`
    - `RecurrenceTool`, which uses `recurrence.promoteFromRecurrence`
    - the D79 hand-authoring form, which uses `bodyFeatures.create`
  - The lake editor also lists and demotes features for one lake (`bodyFeatures.listForBody` / `demote`).
  - Because of "take 100, then filter active", this isn't a complete list once there are many inactive rows.
  - There's no way to re-activate a demoted feature.

---

## 7. `/admin/recurrence`: `routes/admin.recurrence.tsx`
- **Nav label:** Hazard identity. **Gate:** moderator.
- **Purpose:** "Hazard identity, from the operator's side (A05c) — two lists that answer the same question at two time scales. **The recurrence queue** is where an operator spends an hour in October and covers the whole corpus… **The merges panel** is why auto-merge could ship at all… every merge writes a row, they are listed newest first, and Unmerge is one click. A rising unmerge rate means the bar is too low, and the chart on `/admin/tuning` is where that shows up as a number."
- **Header:** "Hazard identity", subtitle "What came back across winters, and what the app folded together within one. Neither list is a prediction…"

### Section A: "Before first ice" (recurrence queue)
- **Query:** `usePaginatedQuery(api.recurrence.listQueue, {minSeasons, includeSuppressed}, {initialNumItems:50})`.
  - Server gate: `requireContributorRole('moderator')`.
  - Reads precomputed `hazardRecurrence` rows for the current season, highest priority first. Filters run per page.
- **Filters:**
  - "Seen in at least" dropdown: 1, 2, 3 or 4 winters (D78 note).
  - "Show suppressed" checkbox.
  - A "Load more" button adds 50 more.
- **Each card:**
  - The family badge
  - The **lake name, linking to `/admin/water/$id`**
  - The sub-area name
  - A "Suppressed" badge
  - "Seen in X of the last N winters · {timing window, e.g. P25–P75 day} · N reporter(s)"
  - "Suppressed — reason"
- **Actions** (`ReasonDialog`, reason required):
  - **Suppress**: calls `api.recurrence.suppress({recurrenceId, reason})`. "It stops being suggested and stops being publicly advisable, across every recompute. Reversible, and nothing is deleted." Audit: `suppress_recurrence`.
  - **Unsuppress**: calls `api.recurrence.unsuppress(...)`. "It returns to the queue and regains the public bar. The original suppression and its reason stay in the audit log." Audit: `unsuppress_recurrence`.
- **Empty state:** "Nothing at that bar…the corpus being young…"

### Section B: "Recent automatic merges"
- **Query:** `api.hazards.listRecentMerges({})`.
  - Server gate: `requireContributorRole('moderator')`.
  - Reads `merge_hazards` and `unmerge_hazards` audit rows from the last 120 days, up to 50.
  - Returns `{actionId, action, automatic, at, loserId, survivorId, stillMerged, type, waterBodyId, waterBodyName}`.
- **Each card:**
  - An "Automatic" or "By a moderator" badge, and "Undone" for unmerge rows
  - The hazard type label
  - The **lake name, linking to `/admin/water/$id`**
  - Relative time, and "· folded into the earlier sighting"
- **Action:** **Unmerge**, only when `stillMerged`. A `ReasonDialog` with a required reason.
  - Calls `api.hazards.unmerge({hazardId: loserId, reason})`.
  - "Both pins return to the map intact… They will not be merged again automatically."

### Links out, shape, and issues
- **Links out:** `/admin/water/$id` only. Nothing links to the hazard pins (`/hazard/$id`), so you can't look at the two merged pins before unmerging.
- **Visual shape:** two stacked card lists. The first is paginated.
- **Confusing, duplicated or dead:**
  - The server also accepts `family`, `includePromoted` and `season` filters, but the UI doesn't expose them.
  - There's no **Promote** button here. Promoting a cluster only happens in the lake editor's `RecurrenceTool`, which also duplicates suppress and unsuppress per lake.
  - Both queries use `requireContributorRole` (the write gate), so a leaving moderator **can't read** this page, unlike every other read page. That doesn't match the `useRole` doc.
  - The nav label "Hazard identity" doesn't match the route name `recurrence`.

---

## 8. `/admin/ice-calibration`: `routes/admin.ice-calibration.tsx`
- **Nav label:** Ice calibration. **Gate:** moderator (not admin-only; the server uses `requireRole('moderator')`).
- **Purpose** (header comment, condensed): "**Does the growth model work?** — the ice-thickness calibration instrument (A06h / **D160**)… The Stefan model produces a number in inches… exactly what D3 forbids publishing. D160 permits it as an **operator instrument that ships dark**… the job of this page is not to display thicknesses. It is to answer *how wrong are we*… ⚠ **Nothing here writes anything.** The fitted α is reported and never applied… ⚠ **Do not add a link to this from any skater surface.**"

### Data shown
- `api.iceCalibration.calibrationPairs({})` returns `{pairs[], excludedEstimates, windowDays, alpha}`.
  - Each pair: `{reportId, waterBodyId, waterBodyName, skateEndTime, observedCm, readingCount, predictedCm|null, freezingDegreeHours, thawDegreeHours, daysObserved, declined}`.
- `api.iceCalibration.calibrationFit({})` returns `{fitted:{alpha, n, rmseCm}|null, defaultAlpha, declined}`.
- `api.iceCalibration.apiCallBudget({})` returns `{days[{dayMs, calls, weightedCalls}], peakWeighted, todayWeighted}` for Open-Meteo over 30 days (D158).

### Layout
1. **Card "The fit":**
   - Stats: Fitted α, Shipped α, RMSE (inches), Pairs.
   - Warnings: "curiosity, not a calibration" when there are fewer than 12 pairs; "outside 1.4–3.0" when α is out of range; and a count of pairs declined for thaw.
   - A count of reports skipped because they only had estimated readings.
2. **Card "Open-Meteo calls":** Today (weighted), Peak day 30d, Days counted, Plan trigger "7000/day". Includes the explanation of weighting (D158).
3. **Card "Pairs (N)":** a table with columns Lake (with ×count when there are several readings), Measured ″, Predicted ″ (or a "declined" badge), Error ″ (amber when more than 2″ off), FDD, Days.
4. **Card "What this cannot tell you":** explanatory prose.

### Actions, links, shape, issues
- **Actions:** none (read-only by design).
- **Links out:** none.
- **Visual shape:** four stacked cards: two stat rows, one table, one prose card.
- **Confusing or dead:**
  - The Open-Meteo budget meter is an operations and cost number that has nothing to do with ice calibration. It sits here because "it answers the same operator question".
  - Lake names in the table don't link anywhere.
  - Both `calibrationPairs` and `calibrationFit` run `collectCalibrationPairs` on the server, so the work is done twice.

---

## 9. `/admin/tuning`: `routes/admin.tuning.tsx`
- **Nav label:** Tuning. **Gate:** **admin** (layout redirect, and every analytics query is `requireRole('admin')`).
- **Purpose:** "Tuning control-room (D37/D49, Phase 07-2) — **admin-only**. Every tunable constant, rendered read-only beside the chart that tells you whether it's set right (settled decision #1: the founder tunes by editing the constant and redeploying, so the dashboard's job is to make the effect legible, not to offer an edit field). Constants come straight from `@skating/core`, so the value shown is the value running; charts come from the metric rollups."
- **Data:**
  - Constants are imported directly from `@skating/core` at build time.
  - Charts call `analytics.catalog` once, then one `analytics.latest`, `analytics.series` or `analytics.bountyGateScatter` call per card.
- **Actions:** none. **Links out:** none.
- **Visual shape:** a very long page of 10 `TuningSection`s, each a grid of `ConstantCard`s plus chart cards.

The `file` named in each heading is under `packages/core/src/`.

| Section | Constants (file) | Charts (metric key → type) |
|---|---|---|
| **Bounties** | FRESH_REPORT_HOURS, BOUNTY_REOPEN_FREEZING_DEGREE_HOURS, BOUNTY_REOPEN_THAW_DEGREE_HOURS, MAX_OPEN_BOUNTIES_PER_DAY, DEFAULT_BOUNTY_LIFETIME_MS (shown in days), DEFAULT_BOUNTY_REWARD_POINTS, BOUNTY_ELIGIBILITY_WINDOW_HOURS (reputationConfig.ts) | GateScatterCard (bounty suppression scatter); `bounty_outcomes` composition (semantic colors); `bounty_weather_reopen_rate` trend (%); `bounty_cap_hit_rate` trend (%); `bounty_time_to_fulfillment_h` histogram |
| **Trust & points** | TRUST_CLASS_THRESHOLDS (trusted/expert/leader), NEW_ACCOUNT_WINDOW_MS, POINT_WEIGHTS.report_submitted, .helpful_thumb, .report_corroborated | `reputation_points_hist` histogram with markers at the **hard-coded** buckets '15–29' trusted, '60–99' expert, '150–249' leader; `point_source_composition` |
| **Enforcement** | CONTRADICTION_FLAG_THRESHOLD, AUTO_LOW_QUALITY_NET_UNHELPFUL, CORROBORATION_MAX_PER_REPORT, HAZARD_CORROBORATION_MIN_CONFIRMS | "Contradiction gate" trend (`contradiction_detected`, `contradiction_weather_explained`, `contradiction_escalated`); `contradiction_count_hist` with a hard-coded '3–4' flag marker; `flag_dispositions` composition |
| **Hazards** | SHALLOW_MEAN_DEPTH_M, SHALLOW_MAX_DEPTH_M (lakeDepth.ts), shallowThawK = SHALLOW_THAW_K (hazardWeatherDecay.ts) (D69) | `hazard_confirm_outcomes` composition; `hazard_age_at_confirm_h` histogram |
| **Hazard memory** (A05c/D77, D80) | DUPLICATE_MATCH_METERS, DUPLICATE_MAX_CLUSTER_SPREAD_M (hazardCluster.ts), AUTOMERGE_MIN_FOOTPRINT_IOU, AUTOMERGE_REQUIRE_OVERLAP (hazardMerge.ts) | `hazard_merges` composition (the unmerge-rate signal that `/admin/recurrence` points to) |
| **Cross-season recurrence** (A05c/D78) | RECURRENCE_ADVISORIES_PUBLIC (the "master switch"), RECURRENCE_PUBLIC_MIN_SEASONS "x of N", RECURRENCE_WINDOW_SEASONS, VOLATILE_MIN_SEASONS (hazardRecurrence.ts), RECURRENCE_MATCH_METERS, RECURRENCE_MAX_CLUSTER_SPREAD_M (hazardCluster.ts) | `recurrence_clusters_by_seasons` composition |
| **Display & map** | RICHNESS_ACTIVITY, RICHNESS_STATIC_CAP, RICHNESS_TOTAL_CAP (D184), DISPLAY_AREA_MIN_SQM, DISPLAY_AREA_MAX_SQM, MIN_VISIBLE_ZOOM_WIDEST, MIN_VISIBLE_ZOOM_FLOOR (display.ts), FETCH_BEARING_COUNT (lakeGeometry.ts) | `zoom_band_distribution` composition |
| **Winter wind** (D90) | STRONG_WIND_MIN_MPS (m/s and mph), WIND_ROSE_MONTHS, WIND_ARCHIVE_MIN_FETCH_M (windRose.ts) | none. The blurb covers the NREL archive's year range and sampling choices |
| **Report freshness & path decay** (D59) | REPORT_FRESHNESS_HALF_LIFE_HOURS, REPORT_FRESHNESS_PER_THUMB / _PER_CORROBORATION (with the MAX_EXTENSION cap), NET_THUMBS_MIN / NET_THUMBS_MAX, REPORT_FRESHNESS_WEATHER_MULTIPLIER, PATH_MIN_OPACITY (D3/D58) | none |
| **Operational health** | none | `flag_time_to_resolution_h` histogram, `support_time_to_resolution_h` histogram, `support_volume` composition, `weather_strip_coverage` composition, `state_coverage` composition |

- **Confusing or dead:**
  - "Operational health" is about how well the operator is keeping up with queues. It isn't tuning, and it overlaps with the Dashboard's admin health strip.
  - The histogram marker labels are hard-coded strings rather than being derived from the constants they illustrate.
  - Per-type hazard decay values (in `hazardDecay.ts`) are deliberately not listed.
  - The `/admin/seasons` comment says its values are editable there "unlike `/admin/tuning`". That's a related admin-only page outside this list.

---

## 10. Shared moderation components

### `components/admin/UserModerationControls.tsx`
- **Comment:** "The shared user-moderation controls (D37/D57) — posting-permission levers + account lifecycle (ban / suspend / unban). Used by both the full `/admin/users/$id` detail page and the in-context moderator panel on a public profile… Role grant/revoke stays out (admin-only, on the detail page only)."
- **Input:** `ModeratableUser {userId, username, status, canPostReports, canPostHazards, canPostComments, activeBountyPostLimit?}`. It runs no query of its own.

**Card 1: posting permissions (D57).** One row each for **Reports**, **Hazards** and **Comments**:
- A restricted row shows a red "restricted" badge.
- **Restrict** (`ReasonDialog`, "A lever finer than a ban — their other contributions stand.") or **Restore** calls `api.moderation.setPostingPermission({userId, permission, allowed, reason})`.
- Audit: `set_posting_permission`.

**Card 1, last row: "Open bounties"** (A02/D57, "a **number**, not a switch"):
- A badge reads "blocked" when the limit is 0, otherwise "limit N".
- A number input; empty means the global cap applies.
- The button reads **Set limit** or **Clear limit**, and opens a `ReasonDialog`: "Blank restores the global cap. Zero blocks bounties while leaving reports and hazards alone."
- Calls `api.moderation.setBountyPostLimit({userId, limit?, reason})`. Audit: `set_posting_permission` with `permission:'bounties'`.

**Card 2: account lifecycle**
- When status is `active`:
  - **Suspend**: a `ReasonDialog` with an extra Duration dropdown (1, 3, 7 or 30 days, default 3). Calls `api.moderation.suspendUser({userId, reason, suspendedUntil})`. "A temporary hold; the account reactivates automatically when it lapses." Clerk is not touched.
  - **Ban**: calls `api.moderation.banUser({userId, reason})`. "Indefinite. Preserves the account for appeal; also locks their sign-in." Clerk is locked.
- When status is anything else: **Lift ban / suspension** calls `api.moderation.unbanUser({userId, reason})`. It sets status active and unlocks Clerk.

**Server rules for all of these:** `requireContributorRole('moderator')`, no acting on yourself, and only an admin can act on an admin.

**Issues:**
- The component never checks `canModerate`. Only its host `ProfileModeratorPanel` does; `/admin/users/$id` doesn't.
- **"Lift ban / suspension" also appears for `deleting` and `deleted` accounts**, because the check is just `!isActive`. `unbanUser` has no status guard, so pressing it would set `status:'active'` on an account that's being deleted, or already a tombstone. This looks like a real bug.
- A suspension that has run out still shows as "suspended", with only the Lift button. The status field isn't reset when the time passes.

### `components/admin/ProfileModeratorPanel.tsx`
- **Comment:** "In-context moderator panel on a public profile (D37) — act from where you are rather than hunting for the user in a queue… Null for non-moderators and for your own profile. The raw trust number stays on the detail page (admin-only, D50)."
- **Gate:** `canModerate && !isSelf`.
- **Query:** `api.profiles.getAdmin({userId})`.
- **Renders:** a "Moderator tools" heading, a "Full detail →" link to `/admin/users/$id`, and `<UserModerationControls/>`.
- **Rendered at:** `routes/u.$username.tsx:95`, below `ProfileView`, for every profile except your own, including private ones.

### `components/admin/HazardModeratorControls.tsx`
- **Comment:** "In-context moderator affordances for a hazard pin (D37/D53) — take the pin down (hide/remove, the same server-gated mutation the flag queue uses) and **promote a recurring hazard into a persistent body feature** right from where it is… The feature-type list comes from `@skating/core` (A05c)…"
- **Gate:** `canModerate`.
- **Renders:**
  - `<ModeratorActions targetType="hazard"/>`
  - **Promote to known feature**: a `ReasonDialog` with an extra "Feature type" dropdown. The 9 `BODY_FEATURE_TYPES` are Spring / current (default), Constriction, Bridge narrows, Recurring pressure ridge, Gas hole, Reef hole, Delta, Shallow water (early thaw), Other.
  - Promote calls `api.bodyFeatures.promote({hazardId, type, reason})`. It throws if the hazard was already promoted.
- **Rendered at:** `components/HazardDetail.tsx:527`, inside `flagControl` under the `FlagDialog`. That puts it on the `/hazard/$id` route (`routes/_map.hazard.$id.tsx`).

### `components/admin/WaterBodyModeratorControls.tsx`
- **Comment:** "In-context moderator affordances on a water-body detail (D37/D49). **The curated-boost field used to live here and is now a link to the lake editor**… **Approve/reject stayed**… they appear only on a pending user-drawn body (a rare, transient state)… Editing prominence is curation you sit down to do; approving a body is something you do in passing."
- **Gate:** `canModerate`.
- **Renders a "Moderator tools" card with:**
  - A link "Open in the lake editor" to `/admin/water/$id`, with the caption "Prominence, depth, names, sub-areas, access points, posted rules and the moderation history…"
  - Only when `source==='user' && reviewStatus==='pending'`:
    - **Approve body**: a plain button with **no dialog**. Calls `api.waterBodies.approve({waterBodyId})`; the audit reason is fixed text.
    - **Reject body**: a `ReasonDialog` with `requireReason={false}` and placeholder "Optional note for the audit log". Calls `api.waterBodies.reject({waterBodyId, reason?})`.
- **Rendered at:** `components/WaterBodyDetail.tsx:385`, on `/water/$id` (`routes/_map.water.$id.tsx`).
- **Duplicates** the approve/reject queue on `/admin/water`.

### `components/ModeratorActions.tsx`
- **Comment:** "Role-gated inline moderator takedown (D32/D37) — hide or remove a **visible** report/comment, each requiring a reason… This is the minimal founder takedown path; the full queue + restore-of-hidden-content lives in the Phase 07 `/admin` surface. Renders nothing for non-moderators…"
- **Props:** `targetType: 'report'|'post'|'comment'|'hazard'`, `targetId`, `label` (default "Moderate").
- **Gate:** `canModerate`.
- **What it renders:** a ghost button with a shield icon. It opens its **own** dialog rather than `ReasonDialog`:
  - Title "Moderate this {type}", a reason textarea, then **Cancel**, **Hide** and **Remove**.
  - Hide and Remove call `api.moderation.setModerationStatus({targetType, targetId, status, reason})`.
- **Also exports** `useIsModerator()`, an older hook that reads `profiles.current` directly and duplicates `useRole().isModerator`.
- **Issues:**
  - It reimplements `ReasonDialog`.
  - The dialog isn't controlled, so **it doesn't close or clear the reason after a successful action**.
  - It doesn't check the target's current status, so it offers Hide on content that's already hidden.
  - It has no Restore, despite what its comment says.
- **Rendered at:**
  - `components/ReportDetail.tsx:493`: `targetType="report"`, plus `:496` `targetType="post"` with label "Moderate post" when the report belongs to a Post. Both only when the viewer is signed in and not the author.
  - `components/CommentThread.tsx:316`, in `Comments`: `targetType="comment"` on every comment that isn't your own, beside `FlagDialog`.
  - `components/admin/HazardModeratorControls.tsx:37`: `targetType="hazard"`.
  - `ReportDetail` is used by `routes/_map.report.$id.tsx` **and** `routes/feed.tsx:196`, so report, post and comment takedown also appear on `/feed`.

---

## 11. Moderator controls embedded on public pages

| Public route | Component chain | Moderator controls |
|---|---|---|
| `/water/$id` (`_map.water.$id.tsx`) | `WaterBodyDetail` → `WaterBodyModeratorControls` (line 385) | "Open in the lake editor" link; Approve body / Reject body (pending user bodies only) |
| `/water/$id` | `WaterBodyDetail` → `PublicAccessSection` (line 358) | When `canModerate`, the member's "Report no public access" button is replaced by **Mark no public access** / **Confirm public access** / **Clear** (Clear appears once a verdict exists). These call `api.waterBodies.setPublicAccess({waterBodyId, verdict})` **immediately, with no reason or confirmation**; the audit reason is generated automatically. The access-lane queue on `/admin/flags` does the same with a reason dialog. Comment: "One control, role-dependent effect: a member's tap files a report, a moderator's rules directly." |
| `/hazard/$id` (`_map.hazard.$id.tsx`) | `HazardDetail` → `HazardModeratorControls` (line 527) | Moderate (hide/remove hazard); Promote to known feature |
| `/report/$id` (`_map.report.$id.tsx`) and `/feed` | `ReportDetail` | Moderate (report), Moderate post; **Edit history · N** (`RevisionHistory`, gated on `isModerator`). That button opens a dialog listing each edit field by field, before and after, with changed ice "claims" marked (D205, A10-5). Queries: `api.contentRevisions.countForTarget` and `listForTarget`, for both the report and its post. |
| same | `ReportDetail` → `Comments` (`CommentThread.tsx`) | Moderate (comment) on every comment that isn't your own |
| `/u/$username` (`u.$username.tsx`) | `ProfileModeratorPanel` | All of `UserModerationControls` (posting permissions, bounty limit, suspend, ban, lift), plus "Full detail →" to `/admin/users/$id` |
| `/u/$username` | `ProfileView` via `useIsModerator()` | Shows "**trust score: N (admin)**" (raw `reputationPoints`) to **moderators as well as admins**. The server's `profiles.getPublicProfile` returns it for any viewer who is a moderator or admin. **This contradicts D50** and the admin detail page, where `getAdmin` withholds the raw number from moderators and `/admin/users/$id` shows them "Trust class" instead. |

So a moderator can do all of the following outside `/admin`:
- take down content
- promote hazards
- rule on public access (with no reason)
- approve or reject bodies
- the full set of user lifecycle and permission actions
- review edit history

Edit history (`RevisionHistory`) exists **only** on public pages. There's no admin page for it.

---

## 12. Cross-cutting issues

1. **No restore path.** Content that's hidden or removed can't be brought back from the UI. Unpinning an access alert and reactivating a demoted feature have no UI either.
2. **Two different reason-dialog implementations:** `ReasonDialog` and the one inside `ModeratorActions`. Several actions have no confirmation at all: support assign and resolve, Approve body, and the inline public-access ruling.
3. **Queue pages don't link to the thing they're about.** Flags, features, support and dashboard actions don't link to the target or the user. Only recurrence links to `/admin/water/$id`.
4. **The same action lives in several places:**
   - takedown: flags page and `ModeratorActions`
   - public-access ruling: flags page and the lake drawer
   - user moderation: `/admin/users/$id` and the profile panel
   - approve/reject: `/admin/water` and the lake drawer
   - feature promote/demote and recurrence suppress: `/admin/features`, `/admin/recurrence`, the lake editor and the hazard drawer
   - pending and dedup queries: dashboard and `/admin/water`
5. **Role-gate mismatches:**
   - `recurrence.listQueue` and `hazards.listRecentMerges` use the write gate for reads.
   - Admin pages render action buttons without checking `canModerate`.
   - The raw trust score is visible to moderators on public profiles.
6. **Dead or unused data:**
   - Flag status `reviewing` is never set.
   - `getAdmin` returns `recentActions`, `suspendedUntil`, `commentCount` and `bountyPoints`, and none are rendered.
   - `userSearch` returns `trustClass`, which isn't shown.
   - Support `createdAt` and `resolvedAt` aren't shown.
   - Server filters that the UI doesn't expose: `listActions` filters, `support.list` category, `recurrence.listQueue` family, includePromoted and season.
7. **Stale comments:**
   - `admin.users.$id.tsx` says the trend chart "arrives with the analytics commit", but it's already there.
   - `admin.features.tsx` says promotion happens only from the hazard pin.
   - `ModeratorActions` says restore exists in `/admin`.
   - The `AdminLayout` header comment lists only support and tuning as admin-only, while the code also includes imports and seasons.

---

# Part 2 — The water-body pages and the lake editor

All paths are under `/Users/teagan/Code/skating`. The admin shell is `apps/web/src/components/admin/AdminLayout.tsx`.

## 0. Shell, nav and role gates

- **Client gate:** the whole `/admin` tree requires **moderator**. A non-moderator is sent to `/`. These prefixes are admin-only, and a moderator is sent back to `/admin`: `/admin/support`, `/admin/tuning`, `/admin/imports`, `/admin/seasons`. The comment says the client gate is "a UX boundary, not a security one" because every Convex function also checks the role on the server.
- **Sidebar order:** Dashboard, Flags, Users, **Water bodies** (`/admin/water`), **Intake review**, **Standing**, **Requests**, **Place names**, Body features, Hazard identity, Ice calibration, then the admin-only Seasons, Support, Tuning, **Imports**. The comments explain why each water queue has its own entry: "burying it one click deep is how 2,010 stored rows went unseen", "Beside Standing because the two are one story", "both are skaters' words waiting on a moderator".
- **Probable nav bug:** the `Water bodies` link has no `exact` option, so TanStack's default prefix matching should mark it active on `/admin/water/review`, `/standing`, `/requests`, `/place-names` and `/$id` too. Two items would be highlighted at once.
- **Dashboard** (`routes/admin.index.tsx`): it shows tiles only for "Bodies to review" (`listPendingReview.length`) and "Dedup candidates" (`listDedupCandidates.total` / `flaggedRows`), plus a link to `/admin/water`. It shows **no counts** for Intake review, Standing, Requests or Place names.

---

## 1. `/admin/water/` — `routes/admin.water.index.tsx`

- **Nav label:** "Water bodies". **Gate:** moderator (client and server).
- **Header comment:** *"Water-body review (D37) + dedup merge (D36) + the **curation list** (A02), and a search that routes into the per-lake editor."* The third section exists because "`curatedBoost` was editable per body with no index and no list, so the five Phase-02b seed mis-matches — four Champlain bays whose boost landed on same-named lakes elsewhere — were invisible."
- **Page title:** "Water bodies". Subtitle: "Review user-drawn bodies, merge duplicates, and open a lake's editor."

**Visual shape:** one long scrolling column with no map, in four sections:

1. **"Open a lake"**
   - A text input, "Search by name to open its editor…".
   - Calls `api.waterBodies.searchByName({ query, limit: 8, bodiesOnly: true })`. This is public, typo-tolerant full-text search, prefix-matched on the last term. Queries under 2 characters return nothing.
   - **Removed bodies are excluded** and unlisted (rejected/merged) bodies are excluded. Dormant bodies are included; the server sets `inactive`, but this page doesn't show it.
   - Results are a plain list of links (name · states) to `/admin/water/$id`. There are no filters and no browse or pagination.
2. **"Curated bodies (N)"**
   - `api.waterBodies.listCurated` returns every listed body with `curatedBoost > 0`, sorted by boost descending, capped at 300.
   - The table has columns Name (link to the editor), States, Area km², Boost, "Draws from" (z`minVisibleZoom`). It is read-only.
3. **"Pending review (N)"**
   - `api.waterBodies.listPendingReview` returns `reviewStatus === 'pending'` bodies, capped at 500. These are user-drawn bodies created from a recorded skate (`waterBodies.create`, D14/D37).
   - Each card shows the name and "type · user-drawn".
   - **Approve** calls `waterBodies.approve` immediately, with no confirmation.
   - **Reject** opens a `ReasonDialog` (reason optional): "Removes it from the map (reversible-in-spirit; not a hard delete)", then calls `waterBodies.reject`.
   - **These cards have no link to the body or the editor.**
4. **"Suspected duplicates (N)"**
   - `api.waterBodies.listDedupCandidates` returns rows with `dedupStatus` in {`near_certain`, `suspected_duplicate`}, folded into connected-component groups. Near-certain groups come first, then the largest. It reads 250 flagged rows and at most 6 bodies per group.
   - The summary text reads "X decisions across Y flagged rows", plus "More are flagged than this page reads" when truncated.
   - Each group renders a `DuplicateGroupCard` (§7.4). Merge runs `waterBodies.merge` **sequentially** once per loser. "Not duplicates" calls `waterBodies.dismissDuplicates`.

**Links out:** `/admin/water/$id` (from search, the curated table, and the duplicate cards' "Open … →").

**Confusing or duplicated:**
- The comment says "The two queues are unchanged… the third section", but search was added too, and the page shows the queues *after* the curated list.
- Pending-review approve/reject is duplicated in `WaterBodyModeratorControls` (the skater drawer).
- "Suspected duplicates" (`dedupStatus`) is a different flag from Intake review's "Duplicate candidates" (`reviewReason`). See §8.
- This is the **only way to find a body by name** in admin. Removed bodies can't be searched; they're reachable only through Standing → Removed. Rejected bodies can't be reached from admin at all.

---

## 2. `/admin/water/$id`: the lake editor (`routes/admin.water.$id.tsx`, 2,876 lines)

- **Nav:** none (deep link only). **Gate:** moderator. Some actions are admin-only on the server, but their buttons still show to moderators (see the end of this section).
- **Header comment:** *"The per-lake editor (A02 / D61) — **one lake, one canvas, every per-body lever**… The camera is locked to the body (Decision 5)… Everything else here is a tool panel beside it. Three of the seven tools needed no new backend at all."* The "seven tools" count is stale: there are now about 19 cards.

**Page-level reads:**

| Query | Returns |
|---|---|
| `waterBodies.get` | The body; follows `mergedIntoId` to the survivor |
| `subAreas.listForBody` | The body's sub-areas |
| `putIns.listForBody` | The body's put-ins |
| `accessPoints.accessForBody` | Parking lots plus stored put-ins with access |
| `hazards.listForBody` | The body's hazards |
| `bodyFeatures.listForBody` | The body's known features |
| `landmarks.listForEditor` | All landmarks, including removed ones |
| `gpsActivities.listTracksForBody` | This season's aggregate tracks |

**Load states:**
- Loading shows "Loading…".
- `null` shows "No such water body".
- `available:false` renders **`RestoreGate`** instead of the editor (§2.20).

**Layout (desktop, `lg`):**
- The header shows the title (the body's name) and subtitle "`type · states` — every per-body lever, on one canvas.", then a "← Back to the water queues" link to `/admin/water`, then a one-line result banner (ok or error).
- Below that is a two-column grid, `[map | 380px tool column]`.
  - **Map:** `h-[70vh] min-h-96`. It is **not sticky**. The tool column has `overflow-y-auto` but no height limit, so it never scrolls on its own. The whole page scrolls, and **the map scrolls off-screen** while you work the lower cards. That includes Put-ins, Parking and Known features, whose "Click the map…" step needs the map.
  - On smaller screens the map stacks above the tools.
- An **"Aerial"** checkbox at the top right of the map turns on unmasked 0.3 m imagery (A06e Workstream 5).

**Map** (`LakeEditorMap`, §7.1): locked to the body's bbox, with no navigation control. Layers drawn:
- the body fill and outline
- sub-area fills, dashed outlines and labels
- chord "mouth" lines
- the yellow draft polygon
- landmark dots and labels
- put-ins (cyan for official)
- parking (amber)
- sample points (purple; solid when saved, hollow when suggested)
- review markers for landmark proposals

All placement tools share one `placing` slot (`'feature' | 'put_in' | 'parking' | 'landmark'`), so only one can be armed at a time. A put-in click is snapped to the shoreline in the preview (`snapToEdge`).

### Tool column, top to bottom

1. **Name** (`NameTool`, A07a). This card is **hidden when fewer than 2 distinct catalog names exist**.
   - It's a picker over `nameClaims` (value plus sources) with a "Use this" button, which calls `waterBodies.setWaterBodyName({name})`.
   - The current name is marked "ranked" or "chosen". "Clear the override" calls `setWaterBodyName({name:null})`.
   - Caption: every name stays searchable, and the choice survives the next import.
   - **Variant `CommunityNameTool`:** shown when no catalog claim exists, or only a user claim does. It offers a free-text "Community name" with "Name it"/"Rename" and "Clear the name".
   - There is **no editing of body aliases, class/type or states** anywhere.
2. **Prominence** (D49). A "Curated boost" number field with Save, which calls `waterBodies.setCuratedBoost`. It shows a live preview: "Currently draws from zX → zY after saving".
3. **Sub-areas** (D60, D201, D215, A09)
   - **List of bays:** each shows its name and aliases. Removed bays are struck through. Warning lines appear for `systemDelistReason`, `mouthStale`, and `mouthReview.note` (D215, "a re-fit a moved shoreline asked a person to check"). An A09 stats line comes from `subAreas.adminStatsForBody`, e.g. "3 of 12 skates this season ran past the mouth line · depth derived Sep 2 · geometry changed … — re-run export-bay-depths · fetch measured".
   - **Per-bay buttons:**
     - "Edit mouth" or "Redraw by chord" arms the chord tool and calls `subAreas.updateChord`.
     - "Redraw freehand" or "Redraw" uses terra-draw and calls `subAreas.redraw`.
     - "Rename" uses `window.prompt` and calls `subAreas.rename({name})`. The mutation also accepts `aliases`, but **the UI never sends them**, so aliases can't be edited after creation.
     - "Delist"/"Restore" calls `subAreas.remove`/`restore` with **no confirmation and no success banner**.
   - **Create form:** Name, Aliases (comma-separated), and buttons "Draw by chord" (the default, D201), "Draw freehand", "Save sub-area"/"Save mouth"/"Replace outline", and "Discard".
     - Chord instructions and refusal text appear inline. The caption reads "The yellow shape is what will be stored… bowed N m out/in".
     - A collapsed `<details>` "Paste GeoJSON instead" offers "Load as draft".
     - Creating calls `subAreas.createFromChord` (optionally with `requestId` or `promoteLandmarkId`) or `subAreas.create` (freehand or paste).
   - **Bay ask queue** (`BayRequestQueue`, §7.8): from `corpusRequests.openBayRequestsForBody`. Each row offers "Draw" (prefills the name and aliases, flies to the point, and attaches the request so saving the bay approves it), "Approve" (`corpusRequests.approve`, when a bay of that name already exists), and "Not a bay" (`corpusRequests.decline`, note required).
4. **Landmarks** (`LandmarkTool`, D202, §7.2): a filtered list of landmarks; edit, move, "Draw as bay" (promotion), remove and restore; community email names; skater proposals; and a drop-a-landmark form.
5. **Depth** (A06a/D68/D69)
   - Mean and Max inputs in metres, holding **operator values only**, with a live feet echo. Save calls `waterBodies.setDepth`.
   - "Source (shown publicly)" note, up to 160 characters.
   - One line per stored measurement with its source rung. An imported value has **Reject**, which calls `setDepth` with `null` and leaves a tombstone. A rejected value has **Restore**, which calls `waterBodies.clearDepthOverride`.
   - A readout says whether decay treats the lake as shallow or not.
6. **Weather sample points** (D56 §5)
   - The status reads "Sampling at the centroid" or "N points saved".
   - Spacing in km with "Suggest a grid" (computed on the client with `suggestSamplePoints`, drawn hollow), then "Save N" or "Discard". "Clear saved points" is also offered.
   - Saving calls `waterBodies.setWeatherSamplePoints`.
7. **Put-ins** (Phase 04, decision #7)
   - Counts: official / OSM / derived.
   - The list has a **Hide** button per row, behind a ReasonDialog with a required reason. It calls `putIns.hide`.
   - "Place an official put-in" arms map placement (snapped), then an optional name and "Save put-in", which calls `putIns.setOfficial`.
8. **Parking & approach** (A06d/D72/D144, "rung 1 of the access ladder")
   - The lot list is read-only. There is **no edit or remove for lots**.
   - "Place a parking area" arms map placement, then a name and "Save at the operator rung", which calls `accessPoints.setOfficialParking`.
   - A link form with three selects: put-in, lot (or "No parking (clears the approach)"), and approach kind (derive, drive_up, short_walk, hike_in). "Save access" calls `accessPoints.setPutInAccess`.
   - The copy explains there is no distance limit, and that hike-in must be chosen explicitly beyond a mile.
9. **Known features** (D79)
   - The list has **Remove** per row (ReasonDialog, reason required), which calls `bodyFeatures.demote`.
   - To add: choose a type (all `BODY_FEATURE_TYPES`), then "Place a point" (with a radius in metres), "Draw an outline", or paste GeoJSON. Add an optional note, then "Add feature", which calls `bodyFeatures.create`.
10. **Hazards & crossings**: read-only links to the public `/hazard/$id` page, listed by type. There are no moderation actions here.
11. **"Before first ice — what came back"** (`RecurrenceTool`, A05c/§7.1)
    - Reads `recurrence.listForBodyAdmin`. Each cross-season pattern shows "Seen in N of last M winters", seasons, timing window, reporter count and pin count, plus caveats.
    - Actions:
      - Promote to a suggested feature type: `recurrence.promoteFromRecurrence`, reason required.
      - Suppress / Unsuppress: `recurrence.suppress` / `unsuppress`, reason required.
      - "Recompute now": `recurrence.recomputeForBody`.
12. **"Before first ice — last season, single sighting"** (`PromotionTool`, A05a/D63/D53)
    - Reads `hazards.listPromotionCandidates`. Each row has a link to `/hazard/$id`, the confirmation count and the target type.
    - **Promote** calls `bodyFeatures.promote` with an automatic reason and **no dialog**.
13. **Aggregate tracks**: view-only count, "N contributing tracks" (Decision 8 / D58).
14. **Posted rules** (`PostedAccessTool`, A06e, §7.3)
    - A target selector: the lake, any launch, or any lot.
    - Fields: seasonal date range, daily hours (none / daylight ± offset / clock), permit required, public source note, and a "Reads as:" preview.
    - Save or Clear calls `postedAccess.setPostedAccess`.
15. **Satellite link** (A06c WS4, D70/D75). A three-way segmented control, `Auto (offer/withhold)` / Always offer / Never offer, which calls `waterBodies.setSatelliteImagery`. It shows hectares and pixel count against the floor. This controls the Copernicus link only, not the Aerial toggle.
16. **Reference links** (A06c §2.7). An editable list of label/URL rows (Add, Remove, Save), validated on the client, which calls `waterBodies.setReferenceLinks`.
17. **Standing** (`RemovalTool`, A07b plus D48)
    - Shows the state label (Active / Dormant — reason / Removed — reason / Not on the map), the public `describeStanding` sentence, and "Activated <date>".
    - **Removed:** "Restore to the map" calls `waterBodies.restore` (admin).
    - **Dormant because of `no_public_access`:** text only, "change or clear the ruling in the Access section".
    - **Any other dormant reason:** "Bring back to the active map" calls `standing.setStanding({standing:'active'})` with no dialog.
    - **Active:** a "Note for skaters" field, then "Set dormant" (ReasonDialog with optional audit reason), which calls `standing.setStanding({standing:'dormant', note})`.
    - **Not removed and not unlisted:** a removal-reason select (landowner request / not skateable / junk / duplicate / other), then "Take off the map" (ReasonDialog), which calls `waterBodies.remove` (admin).
    - **Bug:** the ReasonDialog's free-text reason is **discarded**. Only the select value is sent; `onConfirm={async () => …}` ignores its argument.
18. **History** (`WaterBodyTimeline`, A06c §6.1). Reads `moderation.listActions({targetType:'waterbody', targetId, limit:50})`. It lists human writes newest first: action, actor, time, reason, and a "was X: …" line where `metadata.prev` exists. There is no undo. **The heading is doubled:** the ToolCard title is "History" and the component renders its own "History" h2.

**Not in the editor at all:**
- editing the **body's own polygon** (there is no mutation for it, even though the Aerial comment speaks of "correcting the polygon that decides where the lake is")
- class/type, states, or body aliases
- merge/join, or showing `dedupStatus` / `reviewReasons`
- approve/reject of a pending user-drawn body
- the **no-public-access ruling**, even though the Standing card, the Standing page and `corpusRequests.approve`'s error all say to change it "in the lake editor's Access section". The real control is `PublicAccessSection` in the skater drawer (`components/WaterBodyDetail.tsx`) and the `AccessReportRow` on `/admin/flags`. Both call `waterBodies.setPublicAccess`.
- a list of this body's open requests of kinds other than bay and landmark (activate, restore, contest_access, takedown)

**Other oddities:**
- `waterBodies.get` follows the merge chain, so opening a merged loser's id silently shows the **survivor's** editor.
- **`RestoreGate` is close to dead.** Since A07b, removed and dormant bodies return `available:true`, so the gate only shows for *rejected* bodies (or a merge chain into an unlisted body). For those, its "Restore to the map" fails with "not removed". Its copy ("removed, rejected or merged") is stale.
- **Admin-only buttons shown to moderators:** Remove and Restore. The server refuses them for moderators.
- There are orphaned doc comments ("Hazards and crossings…" at about line 2084; the "pre-first-ice pass" block at about lines 2375–2386 isn't attached to any function).
- The comment that the shared draft slot is cleared because "arming either clears the other" doesn't hold in code: the map shows `draft ?? featureDraft`.

---

## 3. `/admin/water/review` — `routes/admin.water.review.tsx`

- **Nav label:** "Intake review". **Gate:** moderator.
- **Header:** *"The intake review queue — **rows that were computed, stored, and shown to nobody** (A07a)."* The tabs separate **repair** from **curation**. Rows are "Ordered by prominence, inside each reason" (`by_review_reason` = `['reviewReason','displayScore']`, read descending).
- **Title:** "Intake review". Subtitle: "What the merge could not settle by itself, worst first."

**Data:**
- `waterBodies.reviewQueueCounts` returns per-reason counts capped at 200 (shown as "200+").
- `waterBodies.listReviewQueue({reason, cursor})` returns pages of 40 bodies whose primary `reviewReason` equals the chosen tab.

**Tabs** (buttons with counts), in two groups:
- "Needs a decision": Duplicate candidates, One catalog twice, Bays with no parent, Contested as water at all (`class-dissent`), Class conflicts.
- "Could be improved": Name conflicts.

**Shape:** the tab groups, then one card containing a blurb for the reason, a table (Lake link plus states, Acres, "What is disputed", Catalogs osm/nhd), and a **"Next page"** button. The cursor is forward-only; there is no "previous".
- "What is disputed" shows the competing name claims inline for name conflicts, and the raw `reviewReasons` otherwise.

**Actions:** **none**. The page lists only; every row links to `/admin/water/$id`.

**Confusing:**
- **Nothing a moderator does removes a row.** `reviewReason` is written only by the ETL (`mergeFields` in `importCanonical`). Picking a name, merging, dismissing a duplicate or removing a body doesn't clear it; only a later import that re-derives reasons does.
- The query doesn't filter `isListed`, so merged losers and rejected bodies can still appear (and open the survivor or the RestoreGate).
- The editor shows **no indication of which review reason brought you there**. For example, a "Bays with no parent" row lands in an editor that has no tool to assign a parent.
- The comment calls name-conflict "the work list the `/admin/water/$id` name picker reads". The picker doesn't read it; it reads `nameClaims` directly.

---

## 4. `/admin/water/standing` — `routes/admin.water.standing.tsx`

- **Nav label:** "Standing". **Gate:** moderator.
- **Header:** *"Corpus standing — **what is off the active map, and why; and what just came back** (A07b)… Five lanes… plus the list of bodies that recently became active again… This page lists; it does not act — a lane with buttons on every row is how a fat thumb un-shelves a pond."*

**Shape**, top to bottom:

1. **"Recently activated"** card: `standing.listRecentActivations` returns 50 bodies by `activatedAt` descending. The table has Lake (link), When, Via (the audit `via`), and Awaiting (missing elevation, wind or depth).
2. **"Off the active map"**:
   - Lane buttons: Inactive, Not in campaign, Moderator, No public access, Removed.
   - One card holds the lane blurb and a table from `standing.listLane({lane})`, capped at 200, newest first: Lake (link), Acres, Since, Last activity, Flags ("by request", "boost N").
   - When truncated it shows "Showing the newest N; the lane holds more."
   - There's no pagination, search or sort.

**Actions:** none. Links go to `/admin/water/$id`.

**Confusing:** the No-public-access blurb says the ruling "is changed in the lake editor's Access section". **That section doesn't exist in the editor** (see §2).

---

## 5. `/admin/water/requests` — `routes/admin.water.requests.tsx`

- **Nav label:** "Requests". **Gate:** moderator. Approving `restore` or `takedown` needs **admin** on the server, but the Approve button isn't hidden from moderators.
- **Header:** *"The request queue (A07b PR 2 / D107) — **a skater asked; a moderator answers.** One card per open request, **oldest first, whatever the kind**… Approving performs the act through the verb the lake editor uses — activate, restore, remove, confirm access, admit — and closes every sibling ask with it… the map beside the list follows the row the moderator picks… *Show both* draws the pair (D202)."*
- **Title:** "Requests". Subtitle: "Skaters asking for lakes — N open" (from `corpusRequests.queueCount`, capped at 200).

**Data:** `corpusRequests.listQueue({status})`. Open rows are oldest first; approved and declined rows are newest first; the cap is 200. Each row carries:
- kind, name, askers (with `askersCapped`), created date, requester, coord
- the body (class, states, acres, standing) **or**, for `admit`, the 3DHP candidate (name, class or feature type, acres, external id, an "outline ↗" service URL), or the resolve error / "Waiting for the catalog lookup…"
- note, `activityId` ("Backed by a recorded skate"), and for landmarks the lookalikes, `existingLandmarkId` or `drawnSubAreaId`
- decision fields

**Status tabs:** Open / Approved / Declined. There are no kind filter, search or sort options.

**Layout:**
- A two-column grid: a card list on the left, and a **sticky map** on the right (`lg:sticky lg:top-4`, `h-[32rem]`; `h-72` stacked on mobile).
- The map is `RequestPreviewMap`. It isn't fenced to a lake and follows the picked row, or the first row by default.
- Map overlays: "Clear", and a `ReviewClosedNotice` ("Back to queue") when a colleague decides the picked row. That uses `useReviewWatch`, which calls `corpusRequests.reviewState`.

**Per-card actions:**
- **Show on map**, and a Google Maps coordinate link.
- **Approve**: a ReasonDialog with an optional note the skater reads. Its description depends on the kind. It calls `corpusRequests.approve`.
  - It's disabled when the row is locked, for an `admit` with no candidate, for a `name_bay` with no drawn sub-area, and for a `name_landmark` with no existing landmark.
  - What approval does per kind: activate → `activateBody`; admit → inserts the catalog outline; restore → `waterBodies.restore`; contest_access → `setPublicAccess('open')`; takedown → `waterBodies.remove('landowner_request')`. For name_bay and name_landmark it records the answer.
  - It refuses if the body doesn't end up active (or removed, for takedown).
- **Decline**: a ReasonDialog with a **required** note. It calls `corpusRequests.decline`.
- **"Look up again"** (admit only): calls `corpusRequests.reresolve`.
- **"Draw it in the lake editor"** (name_bay with no bay yet) and **"Add it in the lake editor"** (name_landmark with no landmark yet): links to `/admin/water/$id`. The actual answering happens in the editor's Sub-areas or Landmarks card.
- **PossibleDuplicate badge** (name_landmark only, §7.5): "Show both", and "Same place" (confirm dialog), which calls `approve({sameAs})`.
- Decided rows show "Approved/Declined <date> — note · the admitted body" (link).

**Links out:** `/admin/water/$id` (body, draw/add, admitted body); the 3DHP service URL; Google Maps.

**Confusing:**
- name_bay and name_landmark asks are **duplicated**: they appear here and also in the editor's Sub-areas queue and Landmarks "Named by skaters" list, which are the same `waterBodyRequests` rows.
- The module comment says "Six kinds", but there are seven (`name_landmark` was added).
- The `contest_access` approve error says to clear the ruling "in the lake editor", which can't be done there.

---

## 6. `/admin/water/place-names` — `routes/admin.water.place-names.tsx` and `components/admin/PlaceNameQueue.tsx`

- **Nav label:** "Place names". **Gate:** moderator.
- **The route file** is 5 lines: *"The corpus's unplaced names (D202) — see `PlaceNameQueue`."*
- **Component header:** *"Place names (D202) — **the places the community's emails name that no landmark took**, most mentioned first… Loaded from the landmark pass's leftovers (`load-landmark-names`). This page triages; the lake editor places."*

**Data:** `corpusPlaceNames.listQueue({status, minMessages?})` returns rows by status, sorted by message count descending, capped at 400. Each row carries name, aliases, messages and `skatedMessages`, states, `parentName` ("The emails said X"), lake (id plus stored label), up to 8 candidate lakes, `alreadyNamed`, and the dismiss reason and note.

**Controls:**
- Tabs: Open / Placed / Dismissed.
- A checkbox, "Only names mentioned more than once" (on by default, `minMessages: 2`).
- No search.

**Shape:** header, tabs, banner, then one table: Name, Mentions, Lake, actions. Below it, "more wait behind these" when capped. A `BodyPicker` modal (the skater sheet's lake picker) chooses a lake.

**Actions:**
- **Lake cell**, open rows only:
  - Clicking a candidate-lake button calls `corpusPlaceNames.setLake`.
  - "Pick a lake…" / "Another lake…" opens the BodyPicker, then calls `setLake`.
  - If a lake is already set: a link to the editor plus "Another lake".
- **"Place it"** or **"Choose which"** (if `alreadyNamed`): a link to `/admin/water/$id` for that lake. Placing actually happens in that editor's Landmarks card.
- **Dismiss**: `DismissPlaceNameDialog` with a reason select and optional note. It calls `corpusPlaceNames.dismiss`.
- **Reopen** (Dismissed tab): calls `corpusPlaceNames.reopen`.
- The Placed tab has no actions.

**Duplicated:** the same open rows with a lake set also appear in the editor's Landmarks card under "Named in the community's emails" (`corpusPlaceNames.openForBody`), with Place it, Already here, and Dismiss.

---

## 7. Components

1. **LakeEditorMap** (A02/D61, Decision 5/12): the camera is locked (`maxBounds` = body bbox, no nav control). It draws the layers listed in §2. The Aerial reveal is unmasked and cached on the polygon's `shapeSignature`. Every click is forwarded to `onMapClick`. Used only by the editor.
2. **LandmarkTool** (D202), the editor's Landmarks card, in order:
   - **Header and list:**
     - a "N on the map" count
     - a filter box ("Find by name, alias or kind") and a "Removed" checkbox
     - a list of at most 40 rows ("N more — narrow the filter"). Each row shows kind, source, mentions, and markers for edited / dropped from catalogs / merged.
   - **Row actions:**
     - Name click: fly to the landmark.
     - Edit: name, kind, aliases → `landmarks.update`.
     - Move: arms a map click → `landmarks.update({point})`.
     - "Draw as bay": only for kinds bay, narrows and other. It hands the landmark to the chord tool, and saving retires the landmark.
     - Remove: ReasonDialog → `landmarks.remove`.
     - Restore → `landmarks.restore`.
     - "Keep off" for catalog-dropped rows → `landmarks.remove`.
   - **"Named in the community's emails"** (`corpusPlaceNames.openForBody`):
     - "Place it" arms a drop with the name prefilled; saving calls `landmarks.create({corpusNameId})`.
     - "Already here" / "Which one?" opens a select → `corpusPlaceNames.fileAsSpelling`.
     - Dismiss.
   - **"Named by skaters"** (`corpusRequests.openLandmarkRequestsForBody`, oldest 200):
     - Name click: show the spot on the map.
     - "Approve" (if the landmark exists) or "Add as landmark" (prefills and places the point; saving attaches `requestId`).
     - Decline (note) → `corpusRequests.decline`.
     - Google Maps link, and the PossibleDuplicate badge.
     - Review-watch locking and a `ReviewClosedNotice`.
   - **"Drop a landmark"** form: point, name, kind, aliases → `landmarks.create`. It shows "Save anyway" if the linked proposal was closed by a colleague.
3. **PostedAccessEditor** (`PostedAccessTool`, A06e): see §2 item 14. The header comment explains why it's one card with a target selector ("Champlain carries 160 parking areas") and that it's moderator-only.
4. **DuplicateGroupCard** (the D36 queue, rebuilt for A07a). It shows:
   - a tier badge (near certain / suspected), member names with color dots, review-reason badges, and "N fields differ"
   - `describeAgreement` lines
   - truncation and single-member warnings
   - a field comparison table (differing fields only, or all fields)
   - "Outlines & what's attached", which lazily calls `waterBodies.getDedupGroup` and shows an SVG overlay plus attachment counts
   - "Open X →" links to the editor
   - one **"Keep X"** ReasonDialog per member (merge the others into it)
   - **"Not duplicates"** ReasonDialog
5. **PossibleDuplicate** (D202): a badge showing the "already a landmark, N mi away" or "another proposal" lookalike, with "Show both" and "Same place". "Same place" is a confirm dialog with an optional note, it freezes the landmark it names, and it's disabled if that landmark changed. `GoogleMapsLink` is also exported here. Used on Requests and in LandmarkTool.
6. **WaterBodyTimeline**: see §2 item 18.
7. **DismissPlaceNameDialog**: a reason select (`CORPUS_NAME_DISMISS_REASONS`) plus an optional note. It calls `corpusPlaceNames.dismiss`. Shared by the Place names page and LandmarkTool.
8. **BayRequestQueue** (D201): a Convex-free list of a lake's open `name_bay` asks, rendered inside the editor's Sub-areas card.
9. **RequestPreviewMap**: a single unfenced map for the Requests page. It draws the review pair at zoom 13.
10. **ReviewClosedNotice**: the "colleague changed this" sentence plus a Back button.
11. **useReviewWatch**: subscribes to `corpusRequests.reviewState` for the picked request(s) and landmark.
12. **WaterBodyModeratorControls** (D37/D49): **not used in admin**. It renders in the skater drawer (`components/WaterBodyDetail.tsx`) for moderators. It offers an "Open in the lake editor" link, and Approve/Reject for a pending user-drawn body, which duplicates the index page's Pending review.

---

## 8. How the queues differ

| | What fills it | Unit | What "done" means | Acts on the page? |
|---|---|---|---|---|
| **Water bodies: Pending review** | A skater creates a body from a recorded skate (`waterBodies.create`, `reviewStatus:'pending'`) | body | `approve` sets `reviewStatus` to `approved`; `reject` sets `rejected` (unlisted) | Yes |
| **Water bodies: Suspected duplicates** | `dedupStatus` set by D36 match-on-create (user draws over a known lake) and by A07a `importReconciliation` (two of our bodies matching one NHD feature are marked `near_certain`) | connected group of bodies | `merge` tombstones the loser (`dedupStatus:'merged'`, `mergedIntoId`); `dismissDuplicates` sets `clean` | Yes |
| **Intake review** (`/review`) | The ETL merge's `reviewReasons`, stored on import by `importCanonical` / `mergeFields`; the primary reason is indexed | body, filed under one primary reason | **Nothing in the UI clears it.** It changes only when a later import re-derives the reasons | No (links to the editor) |
| **Standing** | Derived body state: `dormant.reason` (inactive from the July rollover or seed, not_in_campaign from prunes, moderator), `publicAccess.verdict:'none'`, `removedAt`. "Recently activated" uses `activatedAt` | body | Not a queue. A body leaves a lane when its standing changes (a report reactivates it, a moderator brings it back, a restore, the ruling is cleared) | No (the editor's Standing card acts; the access ruling is in the drawer or on Flags) |
| **Requests** | `waterBodyRequests` created by skaters (`components/RequestLake.tsx`, `corpusRequests.create`) plus `seedBayRequests`; seven kinds | one skater's ask (siblings grouped by count) | `status` goes from `open` to `approved` or `declined`; approving closes sibling asks. Bay and landmark asks are approved by drawing or adding in the editor | Yes, except bay and landmark asks, which hand off to the editor |
| **Place names** | `corpusPlaceNames` loaded by ETL `load-landmark-names` (names in the community emails that no landmark took) | name | `open` becomes `placed` (via `landmarks.create({corpusNameId})` or `fileAsSpelling`, both in the editor) or `dismissed` (can be reopened). Setting a lake is only triage | Partly (set lake, dismiss, reopen; placing is in the editor) |
| **Imports** (`/admin/imports`, admin-only) | `importRuns` rows written by ETL loaders under `scripts/` | ETL run, or a campaign of runs | Not a queue; it's a read-only history ("Every ETL run, with what it wrote and what it declined") with a run detail view (`?run=`), a campaign filter (`?campaign=`), and a "Latest campaign" tile row | No |

**Can one item appear in more than one place?** Yes, often:
- **Duplicates have two independent flags.** One body can be under Intake review "Duplicate candidates" or "One catalog, twice" (`reviewReason`) *and* under Water bodies "Suspected duplicates" (`dedupStatus`). Merging from the index page leaves the Intake row in place.
- **One body can sit in several queues at once.** It can be in a Standing lane (e.g. Inactive), have an open `activate` Request, carry an Intake reason, and have open Place names and landmark/bay asks.
- **The same rows appear on two pages.** `name_bay` and `name_landmark` requests show on the Requests page *and* in the editor's Sub-areas and Landmarks cards. Corpus place names with a lake show on the Place names page *and* in the editor's Landmarks card.
- **Pending user-drawn bodies** show on the index page *and* in the drawer's `WaterBodyModeratorControls`. They are also counted on the Dashboard.
- **A skater's landmark proposal and a corpus place name for the same place** are separate tables, but both show in one Landmarks card.

## 9. Finding a body to edit

There is no browse list, filter or pagination of the corpus. The ways in are:
1. The "Open a lake" search on `/admin/water`: name only, 8 results, active and dormant bodies only (**removed bodies excluded**).
2. Links from the queue rows: Curated, Intake review, Standing lanes (the **only** route to a removed body), Requests, Place names, and Duplicate cards.
3. "Open in the lake editor" from the skater drawer (moderators only).

Pending-review cards have no link. Rejected bodies can't be reached from admin at all, and if a URL is typed in, `RestoreGate` offers a restore that fails.

---

# Part 3 — Import runs, the machinery, and seasons

Two things you should know before the detail:

- **`MetricCharts.tsx`, `CatalogCoverage.tsx` and `ContributorTrend.tsx` are not on the Seasons page.** `admin.seasons.tsx` imports only from `SeasonWatch.tsx`. The other three are used on `/admin` (dashboard), `/admin/tuning` and `/admin/users/$id`.
- **There is no `seasons` table.** A season is computed from the date and never stored. What is stored is the season watch (an ice-watch record per season) and its satellite imagery tables.

All paths below are relative to `/Users/teagan/Code/skating`.

---

## PART 1: Imports

### Role gate
- Client side: `apps/web/src/components/admin/AdminLayout.tsx:61`. `ADMIN_ONLY_PREFIXES` includes `/admin/imports` and `/admin/seasons`.
- Server side: `importRuns.list` and `importRuns.get` both call `requireRole(ctx, 'admin')` (`packages/convex/convex/importRuns.ts:262`, `:300`). Every write function is an `internalMutation`, so no client can call it.

### Purpose (header comments)
- `admin.imports.tsx:10-19`: "ETL run history (A06c Workstream §6.2) — **admin-only**, because a run row names deployment targets, source URLs and file checksums. Every loader under `scripts/` used to compute a genuinely useful summary and print it to a terminal that scrolls … This page is that answer, and the per-run view carries the **whole path** — extract, filter, transform, load — so a body on the map traces back to a file with a checksum."
- `ImportRunDetail.tsx:10-27`: "The full path of one ETL run (A06c §6.2), read top-down as **outcome → funnel → detail → evidence**." The A07a merge reports about 45 counts, so the page now shows a headline row of numbers, a ledger that has to balance, and the remaining counts grouped by prefix.
- The `?campaign=` search param exists because "`run-corpus.sh` prints this URL when it finishes" (`admin.imports.tsx:24-26`).

### Convex calls
| Call | Where | What it does |
|---|---|---|
| `api.importRuns.list({ limit: 50 })` | `admin.imports.tsx:33` | Newest 50 runs, as whole rows. The server also accepts `kind` and `campaignId`, but the page uses neither. It **filters by campaign on the client, within those 50 rows**. |
| `api.importRuns.get({ runId })` | `admin.imports.tsx:35-38` | One full row for the detail view. |

There are **no mutations** on this page. Nothing can be started, retried, canceled or annotated from it.

### The list page
- **Latest campaign** (`admin.imports.tsx:126-168`). Takes the first run in the list that has a `campaignId` and totals that campaign's runs: Inserted and Updated, Failures, Runs not clean, Run count, and either total duration or "in progress". A campaign containing even one failed or still-`running` run is never shown as clean.
- **One row per run** (`RunRow`, 170-216): status badge (succeeded / failed / running), `label` and `kind` badge, a red **production** badge when `isProd`, a clickable `campaignId` badge, `startedAt`, then the duration or "no finish recorded", the `inserted`, `updated` and `failed` counts, "no path recorded" when `stages` is empty, a "View path" link.
- **Missing from the row:** deployment URL, error text, coverage %, and any per-source breakdown.

### The detail page (`ImportRunDetail.tsx`), six sections in order
1. **RunSummary**: status, label, kind, campaign, production badge, the `deployment` string, Started, Finished (or "no finish recorded"), failure count, the `error` text in a red box, and each line of `notes`.
2. **Outcome**: up to 4 headline numbers, taken from the **last stage's counts**, with a fallback list when there are no stages.
3. **Coverage**: only when `run.coverage` exists. % covered, a meter bar, `omissions` sorted by size, and an **"unexplained"** row computed in the browser.
4. **Tallies**: every entry in `counts`, grouped by the prefix before the first dot. Known groups: `refused`, `floor`, `queue`, `osm`, `nhd`, `3dhp`, `nhdId`. **This is the only per-source breakdown.**
5. **Path**: the stages. Consecutive stages named `family · x` are grouped into one card (families `osm`, `nhd`, `3dhp`, `gnis`, `mask`). Each family card shows file count, total bytes, checksum state. Each stage card shows `detail`, a link to `sourceUrl`, `sourceAt`, `input`, `output`, size, `sha256`, published `md5`, the exact `command` in a `<pre>`, and the stage's own counts. If there are no stages, `NoPath` points to `run-corpus.sh` / `run-canonical.sh`.
6. **Failures**: the stored sample (max 200), each showing `stage` badge, `key` and `reason`, followed by "…and N more not stored".

**Not on the detail page:** links to water bodies (a failure's `key` is plain `<code>`); a sample of loaded rows; timing per stage (stages have no timestamps; only `sourceAt`, the publisher's build date).

### Data model: `importRuns` (`schema.ts:3979-4088`)
- `kind` (from `IMPORT_RUN_KINDS`), `label`, `campaignId?`, `deployment`, `isProd`, `status`: `running | succeeded | failed`, `startedAt`, `finishedAt?`, `counts[] {name, value}`, `stages[] {name, detail?, command?, input?, output?, sourceUrl?, bytes?, sha256?, md5?, checksumVerified?, sourceAt?, counts?}`, `failures[] {stage, key?, reason}` (max 200 stored), `failuresTotal`, `coverage? {unit, eligible, covered, omissions[]}`, `error?`, `notes?[]`.
- Indexes: `by_started`, `by_kind_started`, `by_campaign`.
- **`IMPORT_RUN_KINDS`** (`lib/enums.ts:566-614`): `canonical_water`, `corpus_merge`, `sub_area_seed`, `dedup_resolve`, `osm_depths`, `admin_areas`, `lake_depth`, `elevation`, `wind_climate`, `bathymetry_coverage`, `seed_destinations`, `region_stats`, `raw_archive`, `r2_mirror`, `bathymetry_join`, `standing_seed`, `standing_rollover`, `bathymetry_build`, `bathymetry_tiles`, `access_parking`, `access_put_ins`, `landmark_seed`.
- **Side effect of finishing:** a run with a kind in `WEATHER_CELL_INVALIDATING_KINDS` that succeeds schedules `weatherArchive.maybeSyncWeatherCells` after a debounce.

### Who writes runs, and how runs are started
**Nothing starts an import from the admin UI.** Four ways:

1. **ETL CLIs (operator shell)** through `@skating/run-log` (`scripts/run-log/`): `RunLogger` calls `importRuns:start`, `progress`, `finish` using `pnpm exec convex run` with admin credentials. It swallows its own errors ("Bookkeeping never breaks the thing it books"), and opens the row **before** the first batch, so a killed process leaves a row stuck in `running`.
2. **The `record` CLI** (`scripts/run-log/src/cli.ts`): writes an already-finished run in one call; can `restamp` timestamps. Used by `mirror-r2.sh` (`r2_mirror`) and `backfill-archives` (`raw_archive`).
3. **Convex actions that write their own rows:** `regionStats.recompute` (`region_stats`), `standing.runStandingRollover` (`standing_rollover`, campaign `standing-rollover-<season>`).
4. **Cron:** only the standing rollover (`crons.ts:253-258`), July 1-14 UTC; uses the `importRuns` row as its "already done" check; treats a `running` row older than 6 hours as dead.

### ETL CLI commands (`scripts/etl/package.json`)
| Command | Does | Writes an `importRuns` row? |
|---|---|---|
| `./run-corpus.sh <campaign> [--refresh] [--apply-sub-areas --actor=] [--mentions=\|--without-corpus] [--skip-landmarks]` | **Full corpus rebuild (A07a).** region masks → `merge` → `load` bodies → `load-sub-areas` → `landmarks` → `load-landmarks` → `load-landmark-names`. Logs to `.scratch/merge/run-<campaign>.log`. Prints three manual follow-ups: `prune-floor`, `seed-standing`, `retire-absorbed`. | Yes, one per pass, all under one campaign |
| `./run-canonical.sh <campaign> [state…]` | **OSM-only canonical re-import, per state.** osmium filter → `transform` → `load`. | One `canonical_water` row per state |
| `archive [state…] [--refresh]` | Geofabrik extract into `.raw/<state>/` | **No** |
| `archive-nhd` / `archive-3dhp` / `measure-3dhp` / `audit-archives` | Archive passes | `raw_archive` |
| `archive-gnis` | GNIS gazetteer | **No** |
| `merge [--refresh] [--campaign=]` | Three catalogs → master list. Writes nothing to Convex. | `corpus_merge` |
| `transform` | geojsonseq → bodies NDJSON | No |
| `load <ndjson> [...]` | Upserts through `waterBodies.importCanonical`. Pushes progress every 25 batches. | `canonical_water` |
| `load-sub-areas` / `load-depths` | | `sub_area_seed` / `osm_depths` |
| `access-transform` / `load-access parking\|put-ins` | Access pass; ORS routing in transform | `access_parking`, `access_put_ins` |
| `landmarks` / `load-landmarks` / `load-landmark-names` | D202 landmark pass | Transform: no. Loads: `landmark_seed` |
| `reconcile` / `load-reconciliation` | Corpus vs NHD | `raw_archive` |
| `resolve-merge-duplicates` | | `dedup_resolve` |
| `retire-absorbed [--apply]` | | `canonical_water` (!) |
| `prune-floor [--apply]` | Demotes bodies below the floor to dormant | **No** |
| `classify-dry-run`, `bake-off`, `referee-duplicates`, `tidal-band` | Read-only analyses | No |

Other script packages that write runs: `lake-depth` (`lake_depth`, `elevation`, `raw_archive`), `bathymetry` (`raw_archive`, `bathymetry_*`, `lake_depth`), `wind-climate` (`wind_climate`), `admin-areas` (`admin_areas`), `seed-destinations` (`seed_destinations`, `standing_seed`).

### Live progress
- **Partial.** `progress` replaces counts by name, replaces stages by name, and appends failures. Loaders call `logger.flush()` periodically (etl `load` every 25 batches; `lake-depth`, `wind-climate`, `admin-areas`, `bathymetry exportBayDepths`). `useQuery` re-runs when data changes, so a running row's counts update on screen as each flush lands.
- **No per-run log or event stream.** No timestamped events, no timing per stage. The only "log" is the local file `run-corpus.sh` writes, plus stderr.
- The UI cannot tell a live run from a dead one; it says "no finish recorded" rather than "in progress". No heartbeat field.

### Full canonical re-import vs. filling a gap from one source
**No field marks a run as one or the other.** You can only infer it from `kind`, `label`, `campaignId` and `stages`. `retire-absorbed` also writes `kind: canonical_water`. The single-lake "gap fill" path is a corpus request with kind `admit` (`corpusRequests.resolveAdmit` fetches a 3DHP polygon live) and **writes no `importRuns` row**.

### Other machine pipelines an admin might want to watch
| Pipeline | Where its state lives | Admin UI today | Cost / quota tracking |
|---|---|---|---|
| **Weather fetch** (on-demand; Tier-B daily archive append; Tier-A bay append; gap sweep; cell registry) | `weatherDays`, `weatherHours`, `weatherCache`, `weatherForecastCache`, `weatherCells` (with `runId`), `weatherCellSyncs`, `bodyWeatherCells`, `weatherCellDigests`. No table of runs. | Only the call-budget tiles on `/admin/ice-calibration` | **Yes, for Open-Meteo.** `externalApiCalls` (`schema.ts:2125-2152`), one row per provider per UTC day with `calls` and `weightedCalls`. Written by `lib/apiMeter.ts`. Counts but never blocks. |
| **NWS alerts** (15-minute cron) | `weatherAlerts` | None | None |
| **Hazard weather refresh** (hourly) | hazard rows | None | Under Open-Meteo |
| **Satellite imagery, live (A06i)** (`poll` 6h, `pump` 3 min, `buildIndex` 10 min) | `imageryGranules`, `imageryCounts`, `imageryRuns` (one row per pass, written only when it finishes), `imageryFrames`, `imageryPump`, `imageryUnreadable`, `dailyThrottle` | **Yes, on `/admin/seasons`** | **No cost recorded.** "$1.50 of compute a season" is fixed text. Guards are constants `POLL_CAP=300`, `MAX_LIVE_MACHINES=25`. |
| **Satellite imagery, backfill (A06e)** (`scripts/imagery/*.sh`) | R2 bucket listings and Fly machines. **Nothing in Convex.** | None | None |
| **Season watch** (daily) | `imageryIngestSeasons`, `seasonWatchSeries`, the email queue on the season row | `/admin/seasons` | Open-Meteo metered; the tick itself is not logged |
| **Notifications (A08)** (1-min flush → `deliverBatch`) | `notificationQueue`, `notifications` (`pushedAt`/`emailedAt`), `pushTokens` | **None.** No delivery log, no failure table. | None for Expo or Resend |
| **Catalog / corpus refresh** | `importRuns`; `metricSnapshots` `catalog_edh_coverage` | `/admin/imports`; `CatalogCoverage`; `/admin/water/standing` | Storage budget only in the README |
| **Standing rollover** | `importRuns` `standing_rollover` | `/admin/imports` | — |
| **Hazard recurrence rollover** (daily, July 1-7) | `recurrenceQueue`, `hazardRecurrence.computedForSeason`. **No `importRuns` row.** | `/admin/recurrence` | — |
| **Analytics rollup** (6h; weekly sweep; daily prunes) | `metricSnapshots`. No run record. | Charts on `/admin` and `/admin/tuning` | — |
| **Region stats** | `regionStats` + `importRuns` | `/admin/imports` | — |
| **Extraction (`packages/extraction`)** | **Not wired into Convex.** Used only by `training_data/tools/eval`. | None | `ExtractionUsage {costUsd, inputTokens, outputTokens, requests, latencyMs}` priced from `CLAUDE_RATES`; in memory only. |
| **ORS** | ETL `.scratch/access/ors-cache.json` + a 403 circuit breaker; isochrones in `isochrones.ts` | None | **None.** `externalApiCalls.provider` mentions `'ors'` in a comment, nothing writes it. |

---

## PART 2: Seasons

### Role gate
- `/admin/seasons` is admin-only on client and server (`seasonWatch.*` queries `requireRole('admin')`, mutations `requireContributorRole('admin')`; `imageryLive.activity` admin).

### Purpose
- `admin.seasons.tsx:43-50`: "Seasons (A06i §6, D213, D214) — **admin-only**. The season watch made legible: why this season's ice watch opened and what it measured, the satellite imagery it started, the settings that decide it with a preview against every past winter, and the days people actually skated. Unlike `/admin/tuning`, these values are edited here: each save is a new version, and a season keeps the version that decided it…"
- Page subtitle: "Every number here is an overnight air low at a coordinate — never a reading of ice."

### Convex calls
**Queries:** `seasonWatch.overview` (current settings version, last 25 versions, resolved sites, all `imageryIngestSeasons` rows, superseded rows, `seasonFieldDates`, `defaultsInCode`, the history-fill plan), `seasonWatch.series({current})`, `seasonWatch.previewSites`, `imageryLive.activity` (last 40 `imageryRuns`, this season's `imageryCounts`, up to 10 failed granules, `backoffUntil`, `indexRetryAt`, credentials flag, `pollCap`, `maxLive`), `waterBodies.searchByName` (roster picker).

**Mutations:** `saveSettings` (new version, schedules `scheduleHistoryFill`), `resetSeason({season, confirm:'reset'})`, `startImagery` / `pauseImagery`, `addFieldDate` / `removeFieldDate`, `requestHistoryFill`, `imageryLive.retryFailed`, `imageryLive.tryAgainNow`.

### Page sections, in order
1. **"This season — Winter YYYY-YY"** → `WatchCard`: four tiles (Watch began, First imagery-line night, Winter region-wide, Watch ended); "What opened it" table of sentinel lows; "Staff emails" sent and queued; **"Reset this watch…"** dialog (type "reset"); superseded resets line.
2. **"Satellite imagery"** → `ImageryPanel`: status line, **Start imagery** / **Pause imagery**; backoff warning with **Try again now**; index-unreadable warning; missing-credentials warning; five tiles (queued, cutting, landed, empty, failed); table of recent passes (When, Pass, Outcome, Counts, Detail); "Last failures" with **Retry failed**; guard text.
3. **"Settings"** → `SettingsEditor`: nine thresholds in °F and % (earliest night, freezing line, sentinel nights in a row, % ordinary lakes to open, % for winter, imagery line, thaw line, thawed nights to end, sample size); two roster lists (Sentinels, Pinned ordinary lakes, max 10 each, with lake search); "What changed, and why" note; **Save as a new version**; **Discard edits**; merged/delisted roster warning; collapsed "Version history".
4. **"Every season, replayed"** → `PreviewTable` with **Fill history**: Season, Watch opens, By, Imagery line, Winter region-wide, Watch ends, First skated, Opened ahead by; draft edits show the saved value struck through. The replay runs in the browser (`lib/seasonPreview.ts`).
5. **"A season up close"** → `SeasonDetail`: season picker; Recharts line chart of each sentinel's overnight lows with freezing and imagery lines and Opens / Imagery / Winter / Ends markers; crossings table per sentinel.
6. **"Field dates"** → `FieldDates`: table plus add form (season, first_skated or last_skated, date, place, note), remove.
7. **"Where the defaults live"**: source file paths.

**Not available:** manual open/close of a season (only the daily cron decides; reset is the only override); pinning an image; imagery controls beyond start/pause/retry; a list of seasons beyond the replay table.

### How a season is defined
- `packages/core/src/season.ts`: July 1 → June 30 (UTC), represented by the starting year. **"Derived, never stored. There is no `season` column…"**
- The **ice watch** is the only season that is detected rather than computed. `imageryIngest.maybeCheckSeasonOpen` runs daily from the settings floor (Oct 1 default), fetches overnight lows for sentinels, pinned sites and a sample, runs `evaluateSeason`, records once each: opening, first imagery-line night, winter region-wide, close. Each queues a staff email.
- `closesOn` is "the only 'the season is over' signal in the system"; imagery and the weather sweep both read it.

### Season tables (`schema.ts`)
| Table | Records |
|---|---|
| `imageryIngestSeasons` | One row per season: `season`, `opensOn`, `openedBy[]`, `winterFrom`, `closesOn?`, `closedAt?`, `sitesSampled`, `detectedAt`, `settingsVersion` + copy of `settings` and `sentinels`, `opening`, `imageryNudgeOn`, `imageryNudgeSites`, `winter`, `emailQueue[]`, `emailsSent[]`, `lastEmailOn`, `imageryStartedAt`/`By`, `imageryPausedAt`, `imageryWindowTo` |
| `imageryIngestSeasonsSuperseded` | Reset rows |
| `seasonWatchSettings` | Versioned settings, sentinels, pinned, note, savedBy, savedAt |
| `seasonWatchSeries` | Per (season, body): lows[] in °C, source, firstDate, archiveFilledAt |
| `seasonFieldDates` | first_skated / last_skated, date, place, note, enteredBy |
| `imageryGranules`, `imageryFrames`, `imageryRuns`, `imageryCounts`, `imageryUnreadable` | Have a `season` field |

### Per-season stats: what exists and what does not
| Question | Answer |
|---|---|
| Reports filed per season | **Not stored.** Only daily `metricSnapshots.reports_created`. Season scoping at query time via `skateEndTime`. |
| Bodies added or removed per season | **Not stored per season.** `importRuns` rows are timestamped; the yearly `standing_rollover` row has counts scanned, demoted, retained. `prune-floor` writes no row. |
| POIs added per season | **Not stored.** Only `importRuns` `access_*` and `landmark_seed` rows. |
| Weather fetch counts per season | **Not stored.** `externalApiCalls` is per UTC day per provider; sum in a query. |
| Imagery per season | **Stored**: `imageryCounts`, `imageryFrames`, `imageryRuns.season` |
| Ice-watch dates and lows per season | **Stored**: `imageryIngestSeasons`, `seasonWatchSeries` |
| Other fields keyed by season | `hazardRecurrence.seasonsObserved` / `computedForSeason`, `recurrenceQueue.runForSeason`, `accessAlerts.season`, `profiles.photosExpiredForSeason` |

### The three chart components
- **`MetricCharts.tsx`**: `ScalarTrend` (`analytics.series`), `MetricHistogram` and `MetricComposition` (`analytics.latest`), `GateScatterCard` (`analytics.bountyGateScatter`). Used on `/admin` and `/admin/tuning`. The full metric list is in `packages/core/src/metrics.ts:146-386`.
- **`CatalogCoverage.tsx`**: share of water bodies whose 3DHP outline is elevation-derived; `analytics.catalogHistory`. On `/admin`, admin-only.
- **`ContributorTrend.tsx`**: one user's good-vs-bad bars per month; `analytics.contributorTrend`. On `/admin/users/$id`, moderator.

---

# Part 4 — The backend: gated functions, the inbox tables, discipline, crons

**Summary.** 117 role-gated public functions; 116 have a caller in `apps/web`. Only one is dead: `subAreas.setCuratedBoost`. What's missing is cross-cutting work queues and a few takedown verbs:
- **Photos** can be flagged but can't be taken down.
- **Flagged users** can't be acted on from the flag queue.
- **Support tickets** leave no audit trail.
- **`mouthReview` bays (D215)** are only visible one lake at a time.
- **Crons:** of the 30, only a handful can be seen or triggered by an admin.

## How gating works (`lib/auth.ts`)
- Roles `member < moderator < admin` (`ROLE_RANK`, D37). No `requireAdmin`/`requireModerator` helpers.
- `requireRole(ctx, min)`: reads. An operator who requested deletion can still read.
- `requireContributorRole(ctx, min)`: writes; rejects `deletionRequestedAt`.
- `requireProfile`: rejects `banned`, `deleting`, `deleted`, and `suspended` while `suspendedUntil > now`.
- Inline checks: `accessAlerts.retract` (author or mod), `accessPoints.detachPhoto`, `profiles.getPublicProfile` (viewer-is-moderator), `profiles.getAdmin` (raw trust admin-only), `gpsActivities.getForReport` / `lib/reportVisibility.ts` (mods see hidden reports), `moderation.ts:778` (a mod can't act on an admin).
- Dynamic: `corpusRequests.approve` requires admin for `restore` and `takedown`.
- **Inconsistency:** these queries use the write gate: `hazards.listPromotionCandidates`, `hazards.listRecentMerges`, `recurrence.listQueue`, `recurrence.listForBodyAdmin`, `subAreas.adminStatsForBody`, `waterBodies.listReviewQueue`, `waterBodies.reviewQueueCounts`.

## PART 1: Role-gated functions (caller in `apps/web/src/`; M = mobile too)
- **admin**: `userSearch` (mod; admin.users.index), `grantRole` / `revokeRole` (admin; admin.users.$id).
- **moderation**: `setModerationStatus` (mod; ModeratorActions, admin.flags, M), `resolveFlag` (admin.flags), `listFlags` (admin.flags, admin.index), `listActions` (admin.index, WaterBodyTimeline), `banUser` / `suspendUser` / `unbanUser` / `setBountyPostLimit` / `setPostingPermission` (UserModerationControls).
- **profiles.getAdmin** (mod; admin.users.$id, ProfileModeratorPanel). **contentRevisions.listForTarget / countForTarget** (mod; RevisionHistory). **analytics.series / latest / catalog / bountyGateScatter** (admin; MetricCharts), **catalogHistory** (admin; CatalogCoverage), **contributorTrend** (mod; ContributorTrend).
- **support.list / assign / resolve** (admin; admin.support).
- **corpusRequests**: `listQueue`, `queueCount`, `reresolve` (admin.water.requests); `approve` (mod, or admin for restore/takedown; requests, water.$id, LandmarkTool); `decline`; `openBayRequestsForBody` (water.$id); `openLandmarkRequestsForBody` (LandmarkTool, PossibleDuplicate); `reviewState` (useReviewWatch).
- **corpusPlaceNames**: `listQueue`, `setLake`, `reopen` (PlaceNameQueue); `dismiss` (DismissPlaceNameDialog); `openForBody`, `fileAsSpelling` (LandmarkTool). **landmarks**: `listForEditor`, `create`, `update`, `remove`, `restore` (LandmarkTool / water.$id).
- **waterBodies**: `approve`, `reject` (admin.water.index, WaterBodyModeratorControls); `remove`, `restore` (**admin**; water.$id); `setPublicAccess` (admin.flags, PublicAccessSection); `merge`, `dismissDuplicates`, `listCurated` (water.index); `listPendingReview`, `listDedupCandidates` (water.index, admin.index); `getDedupGroup` (DuplicateGroupCard); `listReviewQueue`, `reviewQueueCounts` (water.review); `setCuratedBoost`, `setReferenceLinks`, `setSatelliteImagery`, `setWeatherSamplePoints`, `setDepth`, `clearDepthOverride`, `setWaterBodyName` (water.$id).
- **standing.setStanding** (water.$id); **standing.listLane / listRecentActivations** (water.standing).
- **subAreas**: `create`, `redraw`, `createFromChord`, `updateChord`, `rename`, `remove`, `restore`, `adminStatsForBody` (water.$id). **`subAreas.setCuratedBoost`: NONE (dead).**
- **bodyFeatures**: `listRecent` (admin.features); `create` (water.$id); `promote` (water.$id, HazardModeratorControls); `demote` (admin.features, water.$id).
- **recurrence**: `listQueue` (admin.recurrence); `suppress`, `unsuppress` (admin.recurrence, water.$id); `listForBodyAdmin`, `promoteFromRecurrence`, `recomputeForBody` (water.$id).
- **hazards**: `listPromotionCandidates` (water.$id); `listRecentMerges`, `unmerge` (admin.recurrence).
- **Access**: `accessAlerts.setOfficial` (admin.flags); `accessPoints.setOfficialParking`, `setPutInAccess` (water.$id); `putIns.setOfficial`, `hide` (water.$id); `postedAccess.setPostedAccess` (PostedAccessEditor).
- **Ops**: `iceCalibration.calibrationPairs / calibrationFit / apiCallBudget` (mod; ice-calibration); `importRuns.list / get` (admin; imports); `imageryLive.activity / retryFailed / tryAgainNow` (admin; seasons); `seasonWatch.overview / previewSites / series / saveSettings / resetSeason / startImagery / pauseImagery / addFieldDate / removeFieldDate / requestHistoryFill` (admin; seasons).
- **Mobile:** only `moderation.setModerationStatus` via `apps/mobile/src/components/ModeratorActions.tsx`.

### Operator capabilities that only exist as `convex run` (internal, no UI)
`accountDeletion.finalizeNow` (support's "delete me immediately"), `standing.runStandingRollover`, `regionStats.recompute`, `analyticsRollup.backfill`, `analytics.recordCatalogSnapshot`, `reputation.backfillReputation`, `profiles.backfill*`, `corpusRequests.seedBayRequests`, many `subAreas` and `waterBodies` migrations.

## PART 2: The inbox (user-submitted items that need moderator action)

**Audit table `moderationActions`** (`schema.ts:3162`): `actorId` (empty when system), `action` (~50 verbs, `lib/enums.ts:273`), `targetType` (17 types), `targetId`, required `reason`, `metadata` (prior and new state), `createdAt`. Indexed by target, actor, creation time. Read through `moderation.listActions`.

### Flags (`contentFlags`, `schema.ts:3115`)
- **Targets** (`lib/enums.ts:226`): `report`, `comment`, `photo`, `user`, `hazard`, `accessAlert` (A06d), `waterbody` (A06f), `post` (A10). The UI can only flag report, comment, hazard and user (`SafetyControls.tsx` web and mobile), plus waterbody through `PublicAccessSection`. **Photo, accessAlert and post can be flagged by the backend, but no app UI does it.**
- **Reasons:** `unsafe_false_report`, `spam`, `harassment`, `inappropriate`, `auto_low_quality` (D50, system), `no_public_access` (A06f), `other`.
- **Status:** `open`, `reviewing`, `actioned`, `dismissed`. **Nothing ever writes `reviewing`.**
- **Origin:** `user` or `auto`. Auto flags bundled by `lib/autoFlag.ts` with `occurrences` and `supersedesFlagId`. Sources: `ratings.ts:124` (`auto_low_quality`), `hazardConfirmations.ts:371` (two "never existed" votes → `unsafe_false_report` on the hazard, D65), `contradictions.ts:158` (`unsafe_false_report` on a **user**, D56 §7b).
- **Resolve:** `moderation.resolveFlag` → `lib/flagResolution.ts closeFlag`: sets `resolvedByUserId`, `resolvedAt`, bumps `flag_dispositions`, notifies the flagger if user-filed; writes `resolve_flag` / `dismiss_flag`. Takedown is a separate, separately audited `setModerationStatus`. `waterBodies.setPublicAccess` closes access flags in bulk with one `set_public_access` row.
- **Gaps:** takedown only for report, post, comment, hazard (`TAKEDOWNABLE`). **Photo flags have no takedown path** (`photos` has no moderation field; `photos.remove` is owner-only). **User flags have no action and no link to `/admin/users/$id`.**

### "Safety flag"
A `contentFlags` row with `reason: 'unsafe_false_report'`: a dangerously false "the ice is great" claim, a safety incident not spam. Decisions D3 and D32. Priority lane in `listFlags`; dashboard tile "Safety flags". Alert email (D38): `operatorAlerts.send` "Safety flag: …" from `contentFlags.ts:97` and `contradictions.ts:166`; contradiction alerts throttled by `shouldAlertAt` (occurrences 1, 3, then every 10th).

### Other submission types
- **Water-body requests, A07b** (`waterBodyRequests`, `schema.ts:3030`): kinds `activate`, `admit`, `restore`, `contest_access`, `takedown`, `name_bay`, `name_landmark`; status `open` → `approved` / `declined`; mod (admin for restore/takedown); `/admin/water/requests` (+ water.$id for bays, LandmarkTool for landmarks); recorded as `decidedBy`, `decidedAt`, `decisionNote` (required on decline), every sibling closed with its own `approve_request` / `decline_request` row (`lib/requestDecisions.ts:184`).
- **No-public-access reports, A06f** (`contentFlags` waterbody + `no_public_access`): ruling stored on `waterBodies.publicAccess` as `none` / `open`; access lane of `/admin/flags`; `set_public_access` audit row. Re-disputing an "open" ruling needs a note or a `contest_access` request.
- **Posted access, A06e**: moderator-written, not user-submitted; `set_posted_access` audit row.
- **Body corrections, A07c:** **Not built.** No table.
- **Landmark proposals, D202** (`waterBodyRequests` kind `name_landmark`): filed automatically when a report's "where" names an unknown spot (`lib/landmarkProposals.ts` from `lib/reportWrite.ts`); `approve_request` + `create_landmark`.
- **Corpus place names, D202** (`corpusPlaceNames`, `schema.ts:2951`): **ETL-loaded, not user-submitted**; `open` / `placed` / `dismissed` (+ `dismissReason`); audit target `corpusPlaceName`.
- **Access point proposals, A06d:** **no table**; "derived" put-ins are clusters of report points computed on the fly by `putIns.listForBody`; `set_put_in`, `set_parking_area` audit rows; `plans/features/access-point-authoring.md` scoped, not built.
- **Chord bays needing review, D215** (`waterBodySubAreas.mouthReview` `kept` / `refitted`, `mouthStale`, `systemDelistReason`): system-flagged; resolved by saving the chord; **only on `/admin/water/$id`, one body at a time; no list across lakes**.
- **Bay requests, D201** (`name_bay`): `createFromChord` with the request attached approves it.
- **Support tickets** (`supportTickets`, `schema.ts:3191`): categories `bug`, `account` (appeals), `safety`, `other`; status `open`, `in_progress`, `resolved`; **admin only**; recorded as `assignedTo`, `resolvedBy`, `resolvedAt` only. **No resolution note, no reply, no audit row, no `supportTicket` audit target.** Creating a ticket emails the operator.
- **User-drawn water bodies** (`source: 'user'`, `reviewStatus` `pending` / `approved` / `rejected`): mod; `/admin/water` and dashboard; `approve_waterbody` / `reject_waterbody`. Only mobile calls `waterBodies.create`.
- **Intake review, A07a** (`waterBodies.reviewReason`): system; `class-conflict`, `name-conflict`, `bay-without-parent`, `same-source-duplicate`, `duplicate-candidate`, `class-dissent`; `/admin/water/review` is read-only.
- **Hazard disputes** (`hazardConfirmations`, `healingState`): **no moderator queue**; the community vote archives a hazard. `merge_hazards` / `unmerge_hazards` audit rows.
- **Hazard recurrence** (`hazardRecurrence`): system clusters; `suppressedAt`, `promotedToFeatureId`; `/admin/recurrence`; `suppress_recurrence` / `promote_recurrence`.
- **Access alerts, A06d** (`accessAlerts`): `active`, `official`, `expired`, `resolved`, `retracted`; author or mod retracts, mod pins, cron expires; only reachable through a flag no UI can file; `retract_access_alert` / `pin_access_alert`.
- **Bounties, Phase 06**: `open`, `fulfilled`, `expired`, `canceled`; requester cancels, cron expires; **no admin page**; not a flag target; only lever is `setBountyPostLimit`.

## PART 3: User discipline
- **Roles** (`core/src/types.ts:15`): `member`, `moderator`, `admin`. **Statuses** (`types.ts:28`): `active`, `suspended`, `banned`, `deleting`, `deleted`; plus `statusReason`, `suspendedUntil`, `moderatedByUserId`. `deletionRequestedAt` marks a "ghost" (read-only for the 30-day window, D62).
- **No shadow-ban or mute state.** Finer levers (D57): `canPostReports`, `canPostHazards`, `canPostComments` (missing = allowed), `activeBountyPostLimit`. `contradictionCount` is a private input.
- **Trust (D50):** `reputationPoints` → class `new` / `trusted` / `expert` / `leader` (`core/src/reputationConfig.ts:34`); computed, cosmetic, boost-only; **no admin mutation adjusts it** (only `backfillReputation` CLI).
- **Mutations:** `moderation.banUser`, `suspendUser`, `unbanUser`, `setPostingPermission`, `setBountyPostLimit` (mod; not self, not an admin). `admin.grantRole` / `revokeRole` (admin) is the promote path, wired into `/admin/users/$id`. The first admin is bootstrapped by hand.
- **Audit:** every one writes `moderationActions` target `user`; `profiles.getAdmin` bundles the last 50 rows plus open flags on the user.
- **Suspension quirk:** lifts itself at read time, but **nothing sets status back to `active`**; a lapsed user keeps showing `suspended`.
- **Clerk:** `banUser` / `unbanUser` schedule `clerkAdmin.setBanned` (retries, then emails the operator). Suspensions don't touch Clerk. The webhook (`http.ts:109`) mirrors email and avatar on `user.created` / `user.updated`; logs `user.deleted` and does nothing. **A ban made in the Clerk dashboard is not mirrored into Convex.** Deletion: `requestDeletion` / `cancelDeletion`; hourly `finalizeDueDeletions` → `clerkAdmin.deleteUser`.

## PART 4: Crons (`crons.ts`, 30 jobs, all `crons.interval`)
| # | Job | Every | Handler | Admin can see or trigger |
|---|---|---|---|---|
| 1 | flush notification queue | 1 min | `notifications.flushNotificationQueue` | none |
| 2 | expire bounties | 6 h | `bounties.expireBounties` | none |
| 3 | refresh hazard weather | 1 h | `hazardWeather.refreshHazardWeather` | none |
| 4 | roll up operator metrics | 6 h | `analyticsRollup.runRollup` | dashboard charts; backfill CLI only |
| 5 | sweep water-body coverage | weekly | `analyticsRollup.sweepCorpus` | `CatalogCoverage` |
| 6–7 | prune bounty gate events / client signals | 24 h | `analyticsRollup.prune*` | none |
| 8 | prune oauth states | 6 h | `strava.pruneOAuthStates` | none |
| 9 | prune photo picker sessions | 1 h | `googlePhotos.pruneSessions` | none |
| 10 | finalize account deletions | 1 h | `accountDeletion.finalizeDueDeletions` | none; `finalizeNow` CLI only |
| 11 | purge last season notifications | 24 h | `storageHygiene.purgeLastSeasonNotifications` | none |
| 12 | prompt unreported skates | 1 h | `gpsActivities.sweepUnpromptedActivities` | none |
| 13–14 | prune weather / forecast cache | 6 h | `storageHygiene.prune*Cache` | none |
| 15 | reconcile weather cell registry | weekly | `weatherArchive.maybeSyncWeatherCells` | none |
| 16 | append daily weather archive | 24 h | `weatherArchive.maybeRefreshFilterTier` | indirect: `apiCallBudget` |
| 17 | append daily bay weather archive | 24 h | `weatherArchive.maybeRefreshBayTier` | indirect: `apiCallBudget` |
| 18 | repair weather archive gaps | 24 h | `weatherArchive.maybeSweepGaps` | none |
| 19 | sweep orphan photos | 24 h | `storageHygiene.sweepOrphanPhotos` | none |
| 20 | expire access alerts | 6 h | `accessAlerts.expireLapsedAlerts` | none |
| 21 | expire departed skaters' photos | 24 h | `storageHygiene.sweepDepartedPhotos` | none |
| 22 | sweep expired exports | 1 h | `storageHygiene.sweepExpiredExports` | none |
| 23 | hazard recurrence at rollover (July) | 24 h | `recurrence.maybeRunRollover` | `/admin/recurrence`; manual per lake only |
| 24 | demote inactive bodies at rollover (July) | 24 h | `standing.maybeRunStandingRollover` | **writes `importRuns`**; manual CLI only |
| 25 | watch for imagery season open | 24 h | `imageryIngest.maybeCheckSeasonOpen` | `/admin/seasons`; reset/start/pause |
| 26 | poll for new satellite imagery | 6 h | `imageryLive.poll` | `/admin/seasons` `imageryRuns`; `retryFailed`, `tryAgainNow` |
| 27 | pump live satellite imagery | 3 min | `imageryLive.pump` | same |
| 28 | rebuild the live imagery index | 10 min | `imageryLive.buildIndex` | same |
| 29 | refresh NWS alerts | 15 min | `weatherAlerts.refreshAlerts` | none |
| 30 | sweep body summaries | 6 h | `waterBodies.sweepAllBodySummaries` | none |

**Takeaway:** only the imagery jobs (25–28) have a real run log with manual triggers, and the standing rollover (24) is the only cron that writes an `importRuns` row. Everything else is invisible apart from Convex logs and operator emails (`operatorAlerts.send`: imagery failures, Clerk failures, safety flags, support tickets, export bundles).
