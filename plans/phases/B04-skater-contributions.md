# Phase B04 — Your contributions: find them, correct them, take them back

> **Status:** scoped 2026-11-13, not started. The server rules this phase puts buttons on (D248) are on
> the unpushed branch `b01-1b-retention`, not on main; B04-1 cuts from main after that branch merges.
> No boards exist yet; §5 lists what to draw. The ⚪ roadmap entry is `07-roadmap.md`, Phase B04.

Sources read: `CLAUDE.md`, `plans/README.md`, [`B03-skater-web.md`](./B03-skater-web.md) (route grammar
§1, state §2, analytics §4.1), `skating-mockups/skater-web/README.md` (Reviews 2–4 and the calls after),
[`B01-admin-console.md`](./B01-admin-console.md) §7 as it stands on `b01-1b-retention` (the founder's calls
of 2026-11-13), and on that branch, read with git only: D248 in `01-decisions.md`,
`convex/hazardWithdrawal.ts`, `corpusRequests.ts`, `contentFlags.ts`, `accessAlerts.ts`, `erasure.ts`,
`lib/eraseClock.ts`, `lib/authorDeletion.ts`, `schema.ts`, `@skating/core`'s `withdrawal.ts` and
`accessAlert.ts`. On main: every skater component on web (`apps/web/src/components/skater/**`, the old
`components/RequestLake.tsx` it still mounts) and phone (`apps/mobile/src/**`, `app/(tabs)/you.tsx`),
`hazards.ts`, `hazardConfirmations.ts`, `lib/hazardMerge.ts`, core's `hazardLifecycle.ts`,
`hazardDecay.ts`, `hazardCluster.ts`, `hazardDraft.ts`, and `apps/web/src/lib/analytics.ts`.

---

## §0 — The brief, and what the interrogation found

### §0.1 — The founder's words (2026-11-13)

D248 gave the server rules for what a person can take back. Almost none of them has a button. The
founder asked for this scope so the work is not forgotten, and these are the calls it is built on:

- **Finding your own hazards.** "Is there a place on a user's profile where they can view all of their
  authored hazards so they can issue a retraction? Or would they have to remember where they reported it
  and go to that body first? The second seems a bit hostile."
- **What can be withdrawn** (D248 ruling 7): "any hazard that has confirmations from other users
  shouldn't be able to be deleted, only hazards that are either disputed or have no interactions at all."
  A pin joined to other people's records (merged, in a cross-season pattern, a permanent feature) stays up
  too (ruling 9).
- **Moving and retyping.** "can users *move* hazards? I'd imagine a user is more likely to drop a hazard
  in a less-than-accurate position vs get the hazards boolean presence wrong. Therefore a likely deletion
  reason might be to change type or move its pin to a more accurate spot. If we make those modifications
  relatively easy, maybe deletion intents will reduce?"
- **Requests and reports to moderators** — an access issue, a request to include a body, a report that a
  body is not publicly accessible — can be retracted "at any time (up until the action is
  determined/taken)."
- **An alert's author saying it is no longer an issue wins at once**, even over a moderator's pin (built on
  the branch, with the author's "It's open" on both clients).
- **Content a person deletes is erased 30 days later** unless a moderator's verdict or an open flag holds
  it; the delete confirmations and the privacy policy owe people that statement.
- **Seen, not confirmed:** moving or retyping a hazard uses the same gate as withdrawing it — free until
  another skater has said it is there; after that others have vouched for that spot, so the author adds a
  new pin instead. Recorded as §9 Q1 with a recommendation.

### §0.2 — What the code says that the brief did not

1. **None of the take-back rules is on main.** `hazardWithdrawal.ts`, the three `retract` mutations, the
   erasure and the alert author's "It's open" all live on `b01-1b-retention`. B04 cannot start until it
   merges; its roadmap Owed row "Retraction screens" is this phase, and should point here when it lands.
2. **The withdrawal gate admits disputed pins, so "the same gate" for a move is not enough on its own.** A
   pin another skater called healed or never there is still withdrawable. Move it, and those votes would
   count against the *new* spot — a "gone" vote cast about the wrong place could archive a real hazard at
   the right one. That is the unsafe direction (D3); §3.1 says how the move sets them aside.
3. **An author cannot edit a hazard at all today** — no description, photo, type or place change; there is
   no `hazards.update`. Reports and comments have edits; hazards have only the moderators' `unmerge` and
   promotion.
4. **Refusals are learned by throwing.** Every take-back gate is decided inside its mutation and reaches
   the client only as an error string. A skater would see a button, press it, and be told no. The list the
   founder asked for needs the answer before the tap (§3.2).
5. **`myAccessFlags` hides a picked-up report from the person who filed it.** It returns lake ids for
   `open` flags only; once a moderator moves the flag to `reviewing`, the lake un-fades on the filer's map,
   the About tab offers the report button again, and `contentFlags.flag` dedupes on `open` only — so the
   same person can file a second flag. Retraction is allowed while `reviewing`, so the filer needs to see
   it. The read is also an unbounded `.collect()` over `by_flagger`.
6. **The withdrawal's vote probe was larger than it needed to be** — fixed on the branch. `hazardConfirmations`
   keeps one row per person per hazard (a re-vote patches it), so the `unknown` refusal ("too many
   confirmations to check") could never be reached. It is gone; the read is exact (the first row of a
   verdict that is someone else's).
7. **`corpusRequests.listMine` exists with no caller.** Its comment says it lists `admit` requests; it
   returns every kind, landmark proposals included, newest 50. It is most of the requests half of the list
   read already. A request made by clicking unlisted water (`admit`) has no lake page to show a "you
   asked" line on, so today nothing ever shows it to the asker again.
8. **Comment delete has no confirmation on either client, and a Post has no delete button.**
   `comments.remove` runs on one tap (web `panels/CommentThread.tsx`, phone `CommentThread.tsx`);
   `posts.remove` has no client. The report delete confirmation says "A moderator can still read it" on
   web and nothing about time on the phone.
9. **The phone shows no Retract on any alert** — not even to moderators; the web shows it to moderators
   only (`lake/AccessTab.tsx`, `onRetract={moderator ? … : null}`).
10. **A phone build in the field is a client this phase can break.** Changing the shape of
    `myAccessFlags` would crash installed builds that expect `string[]`; the new reads are new names (§3.4).

---

## §1 — What exists today

Server functions are on `b01-1b-retention` unless marked main. "Web" is `apps/web/src/components/skater/`
unless a path says otherwise; "phone" is `apps/mobile/src/components/`.

| Item | Taking it back on the server, and its gate | Web today | Phone today |
|---|---|---|---|
| **Hazard** | `hazardWithdrawal.withdraw`. Author only. Refused when a moderator made it a permanent feature, when it was merged with others' pins (either side of the merge) or counted in a cross-season pattern, or when another skater's current verdict is `still_there` or `healing_unsafe`. Others' `fully_healed` / `never_existed` and the author's own votes don't block; a moderator's hide doesn't either. Sets `moderationStatus: removed` and `authorDeletedAt`, leaves `status` alone, recomputes the lake's map card, writes `author_delete`, starts the erase clock. **No move, no retype, no edit of any kind.** | `panels/HazardPanel.tsx` computes `isOwn` only to hide rating your own; no withdraw. `lake/HazardList.tsx`, `HazardRow.tsx`: no mark for your own. The map: nothing. | `HazardDetail.tsx` computes `isOwn` the same way; nothing else. |
| **Access alert** | `accessAlerts.retract`: the author while the alert is `active` and no moderator ever pinned it (read from history, an undone pin excluded); a moderator any time. `accessAlerts.vote` with `open` by the author resolves it at once, pinned or not, and releases the pin with a history entry. Which alerts are the viewer's comes from its own query, `accessAlerts.myAlertIdsForBody` (live alerts, bounded by `by_author_status`) — never from `accessForBody` / `listForBody`, which stay viewer-free so the lake page shares one cached copy. | `lake/AccessTab.tsx` + `access/AccessViews.tsx`: votes for everyone; Retract for moderators only; the author's "It's open" on a pinned alert (branch). | `AccessSection.tsx`: votes; the author's "It's open" on a pin (branch); no Retract for anyone. |
| **Request to a moderator** (add, activate, restore, contest, take down, name a bay, name a landmark) | `corpusRequests.retract`: the asker while `open`; final; frees a slot under the open-ask cap; erased 30 days on. `approve` / `decline` refuse a retracted one. | `components/RequestLake.tsx` (`RequestButtonsView`, mounted by `lake/LakePage.tsx` in the standing notice): "You asked — … — and it's with the moderators." No Withdraw. An `admit` from `actions/RequestLakePane.tsx` is never shown again. | `RequestLake.tsx`: the same line, no Withdraw. |
| **Flag** (a report, comment, photo, person, hazard or alert; a lake with no public access) | `contentFlags.retract({ flagId })`: the filer while `open` or `reviewing`; refused for a system-filed flag and for one the system has since counted again for others (`occurrences > 1`). Leaves the queue at once, releases its erasure hold. | `lake/AboutTab.tsx` reads `myAccessFlags` (lake ids) for "already reported"; `panels/FlagDialog.tsx` ends at "Thanks". No Withdraw anywhere; no flag id on the client. | `PublicAccessSection.tsx`, `SafetyControls.tsx`: the same; `MapView.tsx` fades with `myAccessFlags`. |
| **Report** | `reports.remove` (main; final since D248 Part A). | `panels/ReportPanel.tsx`: Delete + confirm, "It comes off the lake and the feed. A moderator can still read it." | `ReportDetail.tsx`: Delete + `Alert`, no word about time. |
| **Post** | `posts.remove` (main): the Post and every member Report. | No client. | No client. |
| **Comment** | `comments.remove` (main; erase clock on the branch). | `panels/CommentThread.tsx`: Delete, no confirmation. | `CommentThread.tsx`: Delete, no confirmation. |
| **Bounty** | `bounties.cancel` (main). | `profile/YourBounties.tsx` on your own profile, with cancel. | The Bounties tab. Out of scope: already done. |

**The reads that could list a person's own items.**

| Table | By-author indexes | A query that lists them today |
|---|---|---|
| `hazards` | `by_author_and_water_body` (main; ordered by lake, not time), `by_author_deleted` (branch; for the withdrawn list) | none |
| `accessAlerts` | `by_author` (newest last within the author); `by_author_status` (branch) | `myAlertIdsForBody` (branch: the viewer's live alerts on one lake, ids only) |
| `waterBodyRequests` | `by_requester_created`, `by_requester_status`, `by_requester_body` | `listMineForBody` (one lake, landmark proposals filtered out); `listMine` (every kind, newest 50, no caller) |
| `contentFlags` | `by_flagger` | `myAccessFlags` (lake ids, `open` only, unbounded) |
| `reports`, `posts`, `comments` | `by_author` and friends | the public profile's reports |

---

## §2 — The feature

### §2.1 — What you've shared, on your own profile

Your own profile (`/u/$username`, boards 6.1/6.2) gains one section under *Your bounties*: **What you've
shared**, in four groups — **Hazards**, **Access alerts**, **Requests**, **Sent to moderators** (flags; a
flag is not called a report anywhere here, because *report* means an ice report in this app). Only you
see it; another person's profile never shows it, and the read takes no username (§3.3).

- **This season only** (the Review 2 rule). Each row: what it is (the hazard type, the alert's reason, the
  request's kind, what the flag was about), the lake (and bay), when, a state in plain words, and the
  actions open to it — or, when none is, one line saying why.
- **Order:** what can still be acted on first, newest first; then a folded *Off the map and answered*
  group for this season's closed items (marked healed by others, taken down by a moderator, a decided
  request or flag, a resolved alert), so an outcome is findable after its notification is gone. Withdrawn
  items aren't listed (§9 Q2).
- **URL** (D242): views are search params, so `?shared=hazards|alerts|requests|flags` scrolls to and opens
  a group, validated with a `.catch()` default and honored on your own profile only. A delete
  confirmation's "withdraw them from your profile" links here.
- **States in words, never a verdict on the ice:** *On the map · No one else has confirmed it yet*; *On
  the map · Confirmed by 2 skaters*; *Combined with another skater's report*; *A permanent feature of the
  lake*; *Taken down by a moderator*; *Marked healed by other skaters*; *With the moderators*; *A moderator
  is looking at it*; *Answered*; *Pinned by a moderator*; *Closed*.

### §2.2 — The same actions where the item lives

- **A hazard:** on its inset card (web 2.1, `/hazard/$id`; phone `HazardDetail`) — a *You reported this*
  block with the actions or the reason. The lake's *Known hazards* rows mark yours with a small "Yours";
  the actions stay on the card, so the list stays a list. On the map a pin is a pin; tapping it opens the
  card, and **Move** happens on the map (§2.3).
- **An access alert:** in the Getting there tab (web `AccessAlertBox`, phone `AccessSection`), your own
  alert gets *Retract* beside the votes.
- **A no-public-access report:** in the About tab (web `PublicAccessView`, phone `PublicAccessSection`),
  "You reported this" gets *Withdraw*.
- **A request:** the standing notice's "You asked — … — and it's with the moderators" line (web
  `RequestButtonsView`, phone `RequestLake`) gets *Withdraw*.
- **A flag on content** has no natural place to return to (the comment may be gone), so it lives in the
  list only.

### §2.3 — The actions: when each is offered, and what the person reads when it isn't

The refusal lines marked *(server)* are the branch's own strings (`HAZARD_WITHDRAW_REFUSALS`,
`RETRACT_REFUSALS`), shown before the tap instead of after it (§3.2). The rest is proposed copy for the
founder's review; no copy anywhere names a decision, a section or a phase.

**Withdraw a hazard.** Offered while it is yours and no other skater has said it's there, it isn't
combined with others' reports, and it isn't a permanent feature — on the map, taken down by a moderator, or
marked healed by others alike (the server allows all three; off the map, withdrawing only starts the
30 days).

> **Withdraw this hazard?** It comes off the map for everyone, as if you never posted it. Do this only if it
> was never there. If it's in the wrong spot or it's the wrong kind, move it or change its type instead. If
> it was there and has healed, leave it: it fades as the days pass, and other skaters can mark it healed. We
> erase it after 30 days, unless a moderator is looking into it.
> [Keep it] [Withdraw]

| Not offered when | The person reads |
|---|---|
| another skater said it's there | Another skater has reported this hazard is there, so it stays up. You can still say what you see now. *(server)* |
| it's combined with others' pins or counted in a pattern | This hazard has been combined with other reports of the same spot, so it is a shared record now and stays up. *(server)* |
| a moderator made it a permanent feature | A moderator made this hazard a permanent feature of the lake, so it is a shared record now and stays up. *(server)* |
| the phone is offline | You're offline. Try again when you're connected. |

**Move it, and change its type** (§9 Q1 decides the gate; the recommendation is drawn here). Offered when
withdrawing would be, and also: it's on the map (not taken down, not marked healed, not an expired
crossing), you may post hazards (not restricted by a moderator), and your account isn't closing.

- **Move** opens the hazard flow's placing step (web 3.2–3.6 on `?action=move`; phone the capture adjust
  bar) with the current shape loaded and its old footprint ghosted. A spot can be re-placed or dragged; a
  line or area dragged whole or redrawn; size adjusted (3.7). The spot must stay on the same lake.
- **Change type** opens *What did you see* (3.1) with the current type marked. Size, photos and note stay.
- **The nearby check runs again** (3.8's nudge): if another skater's pin is where you moved yours, you're
  asked whether it's the same one, and *Yes* offers **Confirm theirs and withdraw mine** in one step. If it
  is joined by the automatic merge anyway, you're told: "Your hazard is now combined with another skater's
  report of the same spot."

| Not offered when | The person reads |
|---|---|
| another skater said it's there | Another skater has said this hazard is there, so it stays as it is. If you saw it somewhere else too, add a new hazard there. |
| combined / permanent feature | the withdrawal's lines above |
| the type would turn a hazard into a suggested crossing, or a crossing into a hazard (the crossing isn't offered in the picker) | A suggested crossing and a hazard say different things, so one can't become the other. Withdraw this one and add the other. |
| marked healed by others | Other skaters marked this healed, so it's off the map. If it's back, add a new hazard. |
| taken down by a moderator | A moderator took this hazard down, so it can't be changed. You can still withdraw it. |
| posting restricted | You can't post hazards right now, so you can't change this one. You can still withdraw it. |
| account closing | Your account is closing, so you can't change this hazard. You can still withdraw it. |
| the new spot is off the lake | That spot isn't on this lake. Withdraw this one and add it where you saw it. |

**Retract an alert / It's open now.** Two different statements, offered side by side and labeled so they
can't be confused: **It's open now** (it was blocked and has cleared — the author's vote that resolves it,
pinned or not, always offered while it's live) and **Retract** (it was never blocked), offered while it's
live and no moderator has ever pinned it.

> **Retract this alert?** Say this only if it was never blocked. If it was blocked and has cleared since,
> choose It's open now instead. [Keep it] [Retract]

| Retract not offered when | The person reads |
|---|---|
| pinned now, or ever pinned | A moderator confirmed this, so it can no longer be retracted. If it has cleared, mark it open. *(server)* |
| resolved or expired | This is already closed, so there is nothing to retract. *(server)* |

**Withdraw a request.** Offered while it's open (the add-a-lake ask from the map, a landmark proposal filed
by a report, and every lake ask alike).

> **Withdraw your request?** The moderators won't decide it, and you can ask again later. [Keep it] [Withdraw]

Not offered once decided: the line shows the outcome (`describeRequestOutcome`) and the list says "A
moderator has already acted on this, so it can no longer be retracted." *(server)*

**Withdraw a flag** (and the no-public-access report). Offered while it's open or being looked at, if you
filed it yourself and no one else's report has been counted into it.

> **Withdraw your report to the moderators?** They won't look at it anymore. [Keep it] [Withdraw]

| Not offered when | The person reads |
|---|---|
| decided | A moderator has already acted on this, so it can no longer be retracted. *(server)* |
| others' reports were counted into it | Others have reported the same thing since, so this stays with the moderators. It can no longer be retracted. *(server)* |

**Delete a report, a comment, a post** (existing actions; the copy D248 owes):

> **Delete this report?** It comes off the lake and the feed now, and it can't be brought back. We erase it
> for good after 30 days, unless someone has reported it to a moderator or a moderator has acted on it —
> then we keep it for their records. *(When it carried hazards:)* The hazards you marked stay on the map; you
> can withdraw any that no one else has confirmed from your profile.

The comment gets the same confirmation (it has none today). A Post's own delete stays out of scope unless
the founder wants it (the Report delete already empties a Post with its last member). `PRIVACY.md`'s
deletion section gains the same statement; the lawyer's read is the L3 row in the legal checklist.

---

## §3 — Server gaps

### §3.1 — Amend a hazard: move it, change its type

One mutation, `hazards.amend({ hazardId, type?, shape? })` (shape = `geometryKind`, `geometry`,
`radiusMeters?`, `bufferMeters?`, the create's own validators), at least one of the two. Online only.

- **Gate** (§9 Q1): `requireProfile`, the author, `assertCanPostHazards`, not leaving, the
  withdrawal's refusals (another skater vouched, joined, a feature), plus: `moderationStatus` visible,
  `status` active, not an expired crossing, neither the old nor the new type `ridge_crossing` unless both
  are, `isValidHazardShape`, and the new footprint touching the same (survivor) lake's polygon.
- **What stays:** `firstReportedAt` (the season clock nobody moves), `lastConfirmedAt` (a correction of
  where is not a new sighting; standing on the ice, the author's own "Still there" already refreshes the
  clock, as today), photos, description, `originReportId`, `dismissedDuplicateOf`, `createdByUserId`.
- **What is recomputed:** `bbox`, `clippedFootprint`, the bay stamp (`resolveSubAreaForPoint`); the
  weather inputs `decayMultiplier`, `snowHidden`, `weatherAdjustedAt` are cleared on any amend — they
  were computed for the old type and the old place, absent reads as ×1 (never less visible), and an unset
  `weatherAdjustedAt` sorts first in the decay sweep's index, so the next tick refreshes it.
- **Freshness under a new type** is the new type's decay table applied to the same `lastConfirmedAt`, so a
  three-day-old pressure ridge corrected to thin ice reads stale at once. That is the truth about
  three-day-old thin-ice news; stale pins still draw (faded), never dropped.
- **Earlier "gone" votes stop counting.** A new `amendedAt` on the row; `deriveHazardLifecycle` gains a
  `countFrom` option, and other skaters' votes older than it move no threshold and set no healing state
  (the author's are unaffected; they never count). The rows themselves are never edited (D65): each stays a
  named person's statement about where the pin was, visible to moderators. A voter who votes again after
  the move counts from then. Property-tested with `fast-check`: an amend never lowers `confirmCount`, never
  raises `goneCount`, never archives.
- **Then, in the same mutation:** the lifecycle recompute, `tryAutoMerge` (the moved pin may now be a
  duplicate — and if it merges it is joined, so the author's later withdraw is refused, which is the point),
  `recomputeBodySummary` (the lake's map card), and an `author_amend_hazard` history row whose metadata
  holds the prior type and shape, so a moderator reading a pin flagged "never existed" sees it moved after
  the flag. Returns the survivor id and whether it merged.
- **Registered where every action is:** `MODERATION_ACTIONS` gains `author_amend_hazard`; the undo
  registry (`lib/undoPolicy`) classifies it as not a moderator's to undo; `auditWriters.test.ts` already
  keeps `lib/audit.ts` the only writer.
- **The erasure scrubs it.** When a hazard is erased, its `author_amend_hazard` rows lose their metadata
  (the prior coordinates are the observation too); the row stays as history, empty like the `erase` row.
- **Notifications:** none. A move is a correction, and the author's own `hazard_confirmation` notices still
  hang off phase changes only.
- **Core:** `draftFromShape(shape, type)` in `hazardDraft.ts`, so both clients load a stored hazard into
  the drawing model they already have.

### §3.2 — One rule, answered before the tap

- **The hazard's refusals move to core** (`withdrawal.ts`), as the request, flag and alert rules already
  did: a pure `hazardAuthorActions(facts)` returns, for `withdraw` and `amend`, either `ok` or a refusal
  key, from facts the server loads once (`othersSayItIsThere`, `isJoined`, the feature, the two statuses,
  type, posting restriction, leaving). The mutations call the same function, so the list, the card and the
  mutation can't disagree.
- **`othersSayItIsThere` is already exact** on the branch (§0.2 item 6); the `unknown` branch is gone.
- **`hazards.get` adds `yours`** — only when the viewer is the author — with those two answers (`ok` or a
  key). Additive; the list path (`listForBody`, the offline cache) is untouched and stays viewer-free.
- **The author's `canRetract` rides the own-alerts read, never `AccessAlertView`.** The shared reads
  (`accessForBody`, `listForBody`) carry nothing about the viewer; the branch's
  `accessAlerts.myAlertIdsForBody` is the per-viewer half. B04 widens it (or adds a sibling under a new
  name, so installed phone builds keep working) to return each own alert's `canRetract`, with
  `everPinned` read for those only. Additive.

### §3.3 — The list's read

`contributions.mine` — a query, the caller's own rows only, `[]` signed out, no username argument. Every
group bounded in the index, this season only:

- **Hazards:** a new index `by_author_first_reported` (`createdByUserId`, `firstReportedAt`), every field
  required, so the season's lower bound is a range and nothing sorts as `undefined` into it;
  `.order('desc').take(50)`, withdrawn ones filtered out. The facts for §3.2 per row; the cross-season
  pattern read is per lake (up to `MAX_BODY_CLUSTERS` rows), so it is read once per lake in the page, not
  per pin.
- **Alerts:** `by_author`, `desc`, `take(50)`, this season.
- **Requests:** `by_requester_created`, `desc`, `take(50)` — `listMine`'s read, with the outcome line and
  the lake's name; `listMine` itself is left for a later cleanup (its comment is wrong, §0.2 item 7).
- **Flags:** `by_flagger`, `desc`, `take(50)`, `origin: 'user'` only, with what the target was (kind and
  lake; no excerpt of anyone's words).
- **Each row carries its actions** from the core rules (`hazardAuthorActions`, `requestRetraction`,
  `flagRetraction`, `alertRetractionByAuthor`, `accessAlertVoteControls`), so web and phone render one
  answer.

### §3.4 — Flag ids for the person who filed them

A new `contentFlags.myAccessReports` returns `{ waterBodyId, flagId, status }` for the caller's
no-public-access flags that are `open` **or `reviewing`**, bounded (`take`). Both clients move to it;
`myAccessFlags` stays, unchanged, until the phone builds in the field have updated, then goes. In the same
commit, `contentFlags.flag`'s one-open-flag dedupe also matches `reviewing` (§0.2 item 5).

### §3.5 — What a moved pin tells everyone else

`hazards.get` exposes `amendedAt` and what changed (`place`, `type`, or both, from the history row), so the
hazard card reads "Moved by the person who reported it, 2 hours ago" or "Changed from Thin ice by the person
who reported it". The card only — not the map, not the list rows. Erased with the row.

### §3.6 — The decision this mints

At build start (B04-1's first commit), one `D#` for §3.1–§3.5: the amend gate and semantics as the founder
answers §9 Q1, the earlier-votes rule, the crossing rule, the history scrub, and the owner-only list read.
No decision number is taken now.

---

## §4 — Safety (D3)

- **A withdrawal is "never here", and the map says nothing.** The pin stops drawing as if it had never
  been posted: no "cleared", "healed" or "removed" state, no toast to other skaters, no notification. The
  lake's map card drops the count. If it was the last pin, *Known hazards* shows its empty state, which
  keeps its full sentence (D237). A card left open on it, or an old link, gets the existing unavailable
  copy, which already refuses to say "gone": "This marker isn't available… it may have been removed from
  the map."
- **The gate is what makes this acceptable.** Nobody but the author has said the spot is dangerous, so the
  only warning that leaves is the author's own, and the author is saying it was never true. The withdraw
  confirmation steers a healed-but-real hazard away from withdrawal (it should fade, or be marked healed
  by others), because withdrawing is the one path where a real hazard leaves without anyone else's word.
- **A move removes a warning from the old spot.** Under the gate nobody else vouched for the old spot, so
  the move takes away only the author's claim about it; the spot is unsafe-unknown, as it was before the
  pin. During the move nothing changes for anyone else: the draft is local, and the commit is one
  transaction, so other skaters see the pin jump, never two pins and never none. After: the new spot
  draws at its stored freshness, the card says it moved (§3.5).
- **A move can never under-warn the new spot by borrowing the old spot's doubts:** others' earlier "gone"
  votes stop counting (§3.1), and nothing about a move can archive the pin.
- **A retype can't change what kind of claim the pin makes.** Hazard ↔ suggested crossing is refused
  both ways: a warning must never become "you can cross here". A retype to a faster-decaying type makes
  the pin read older, which is honest, and stale pins still draw.
- **Merges only widen.** If a moved pin merges, the survivor carries the union footprint (D80); a merge
  can't shrink warned area. A pooled neighbor (read-time clustering) keeps its own footprint when one
  member is withdrawn or moved, so the drawn union never shrinks below what another skater stood behind.
- **The phone's on-ice cache errs safe.** A cached lake keeps the old pin (and keeps alerting near it)
  until it refreshes; a moved pin's new spot reaches the cache on the next refresh, exactly as a newly
  posted hazard does today.
- **No copy predicts or reassures.** Every line in §2.3 says what a person or a moderator said, never what
  the ice is. "It's open now" is about a lot or a launch, never the ice.

---

## §5 — Design inventory

The boards are in Paper *Gli · Web app · Review 3* (`skating-mockups/skater-web/boards-all.tsv`). Names
follow the manifest's `<row>.<n> <Area> | <View> | <State>`; numbers are the designer's call.

**Boards that change:**

| Board | Change |
|---|---|
| 6.1, 6.2 Profile \| Yours (+ Light) | the *What you've shared* section under *Your bounties* |
| 6.7 Profile \| Yours \| Leaving | the section while the account closes: withdraw and retract offered, change not |
| 2.1, 2.2 Explore \| Hazard \| Open Water (+ Light) | unchanged for others; the "Moved by the person who reported it" line, as a variant |
| 2.9 Explore \| Panel \| Unavailable | check the hazard's wording (it's right today on the code) |
| 1.2 Explore \| Mascoma \| Reports | a "Yours" mark on one row of *Known hazards* |
| 1.8 Explore \| Mascoma \| Getting There \| Report an Access Problem | your own alert with *It's open now* and *Retract* |
| 1.9 Explore \| Mascoma \| About | "You reported this" with *Withdraw* on public access |
| 1.13 Explore \| George Pond \| Inactive | "You asked — … — with the moderators" with *Withdraw* |
| 2.4, 2.5 Explore \| Report (+ Light) | nothing on the card; the delete confirmation is new (below) |
| 9.2–9.4 Narrow \| Explore \| Mascoma | the lake drawer's own alert and the "Yours" mark at 390 |

**New boards:**

1. Profile \| Yours \| What You've Shared — the four groups populated: a free hazard, a confirmed one with its
   reason, a combined one, a live alert, a pinned alert, an open request, an open flag, a shared flag, and
   the folded *Off the map and answered* group
2. Profile \| Yours \| What You've Shared \| Empty
3. Profile \| Yours \| What You've Shared \| Light
4. Hazard \| Yours \| Free to Change — the *You reported this* block: Move · Change type · Withdraw
5. Hazard \| Yours \| Confirmed by Others — the reason line, the verdict buttons still there
6. Hazard \| Yours \| Withdraw — the confirmation
7. Move a Hazard \| Placing — the old footprint ghosted, the new one drawn, *Save the new spot*
8. Move a Hazard \| Same as Theirs? — the nearby check with *Confirm theirs and withdraw mine*
9. Move a Hazard \| Combined — the message after an automatic merge
10. Change Type \| What Did You See — the current type marked, no crossing
11. Getting There \| Your Alert \| Retract — the confirmation, with *It's open now* beside it
12. About \| Withdraw Your Report — the confirmation
13. Inactive \| Withdraw Your Request — the confirmation
14. Report \| Delete — the confirmation with the 30 days and the hazards line
15. Report \| Comment \| Delete — the new confirmation
16. Narrow \| Profile \| What You've Shared — at 390
17. A refusal after the tap — the list or card was stale (someone confirmed in between): the same line, in
    place, and the action gone

The native phone app has no boards in Paper; it follows its own components (§6) unless the founder wants
phone boards drawn too.

---

## §6 — The phone

- **Where:** the You tab (`app/(tabs)/you.tsx`) gains a *What you've shared* row opening a new screen
  (`app/shared.tsx`, deep link `skating://shared`) on `contributions.mine`; `HazardDetail` gets the *You
  reported this* block; `AccessSection` gets *Retract* for the author; `RequestLake` and
  `PublicAccessSection` get *Withdraw*; `ReportDetail` and `CommentThread` get the 30-day confirmations.
  `MapView` and `PublicAccessSection` move to `myAccessReports`.
- **Moving on the phone** reuses `HazardCapture`'s adjust bar and core's draft model (`applyDraftMapClick`,
  `switchDraftKind`, `resizeDraft`) seeded by `draftFromShape`, plus *Use where I'm standing* for a spot.
  Gloved hands are why capture is two taps; a move is not an on-ice emergency, so it may take more.
- **Online only.** Every take-back and amend reads live state (someone may have confirmed since), so none
  is queued in `flushService`; offline, the buttons show the offline line. A hazard still in the offline
  queue is not on the server at all: the existing Queue screen (`app/queue.tsx`) already deletes it.
- **Moderators' Retract on the phone** stays absent: moderation is the console's (§0.2 item 9).
- **No analytics on the phone** — PostHog isn't wired on mobile (D235).
- **Tests:** there is no React Native render harness, so the rules live in core with Vitest and the screens
  stay thin. **Device testing is an EAS `preview` build** (the standalone APK, env from EAS environments),
  on the founder's Pixel — not the dev client.

---

## §7 — Analytics

The web contract (`apps/web/src/lib/analytics.ts`, D235, D240) has no event for any take-back today, not
even `report_deleted`. Proposed, in its shape (`object_verb`, past tense, countable properties only — no
id, text, name, coordinate or anything about the ice; every enum value passes the D3 test's pattern):

| Event | Properties |
|---|---|
| `contributions_viewed` | `open_count_bucket`: `0`, `1-3`, `4-9`, `10+` |
| `contribution_withdrawn` | `item_kind`: `hazard`, `access_alert`, `request`, `flag`, `report`, `comment` · `surface`: `profile`, `in_place` |
| `hazard_amended` | `change`: `moved`, `retyped`, `both` · `merged`: boolean · `surface` |
| `contribution_action_refused` | `item_kind` · `refusal`: `vouched`, `joined`, `feature`, `decided`, `pinned`, `shared`, `closed` — only when the server refuses after the tap, which measures how stale the list gets |
| `access_alert_voted` | `verdict`: `still_blocked`, `open` · `own`: boolean — none of the alert votes has an event today |

Plus `data-attr` names on the controls (`hazard-withdraw`, `hazard-move`, `hazard-retype`,
`alert-retract`, `request-withdraw`, `flag-withdraw`). The founder's question these answer is his own: do
moves replace withdrawals? Compare `hazard_amended` with `contribution_withdrawn{item_kind: hazard}` over a
season.

---

## §8 — Size and order

Server first, then web, then the phone. Branch `phase-b04-skater-contributions`, cut from main once
`b01-1b-retention` has merged.

- §8.1 **B04-1 — the server** (≈1,800–2,600 lines with tests): §3.1–§3.5, the `D#`, the roadmap flip to 🟡.
  `convex-test` per mutation and read; `fast-check` on the amend's lifecycle rule and the gate. Ships
  without any mocks — nothing a skater sees changes. `convex dev --once` and codegen before the push.
- §8.2 **B04-2 — the small in-place controls** (≈700–1,100 lines, web and phone together): *Withdraw* on
  the request line and the no-public-access report, the author's *Retract* on an alert, the 30-day
  confirmations on report and comment delete, `myAccessReports`, `PRIVACY.md`. Each is one button and one
  confirmation on a line already drawn; it can ship before the boards if the founder agrees (§9 Q3) and
  reviews the copy in the PR.
- §8.3 **B04-3 — the list and the hazard's actions on web** (≈2,500–3,500 lines): the profile section, the
  hazard card's block, Move and Change type, the "moved" line, the events. **Needs the boards** (§5).
- §8.4 **B04-4 — the phone** (≈1,500–2,200 lines): §6. Needs B04-1; uses the web's boards for intent.
  Closes with the EAS preview pass, the roadmap close (🟢) and the build's findings here.

Four PRs, each well under the ~5,000-line bound. If the founder answers Q3 "wait", §8.2 folds into §8.3 and
§8.4 and it is three.

---

## §9 — Questions for the founder

1. **Moving and retyping use the withdrawal's gate?** *Recommended: yes* — free while no other skater has
   said it's there and it isn't combined or a permanent feature — **with two riders**: (a) other skaters'
   earlier "healed" or "never there" votes stop counting toward the moved pin (kept on the record, never
   edited), because a "not here" said about the wrong spot must not take down the right one; (b) a hazard
   can't become a suggested crossing or the reverse. *What it changes:* "no" to (a) means a disputed pin
   can be withdrawn but not moved, so the author re-posts and loses the photos and link; "no" to the gate
   itself needs a rule for confirmations about a spot the pin no longer marks, which is a new decision.
2. **What the list shows.** *Recommended:* this season's items that can still be acted on, each with its
   actions or the reason there are none, then a folded group of this season's closed ones with their
   outcome; withdrawn items not at all. *What it changes:* "only what can be acted on" makes it shorter but
   leaves a confirmed hazard's author wondering where theirs went (the hostility the founder named);
   listing withdrawn items would show content the person chose to remove.
3. **Can the small in-place controls ship before the boards?** *Recommended: yes* — §8.2 is a button and a
   confirmation on lines already drawn, the copy comes to you in the PR, and the 30-day statement is owed
   now. *What it changes:* "no" folds §8.2 into the board-bound PRs and the retraction rules stay
   unreachable until the boards are done.
4. **Others see that a hazard moved?** *Recommended: yes*, one line on the hazard card only ("Moved by the
   person who reported it, 2 hours ago"). *What it changes:* "no" drops §3.5; a skater who saw the pin in
   one place and finds it in another gets no explanation.
5. **Phase shape:** *recommended* B04, a phase (four PRs across server, web and phone, and a decision),
   not a feature doc. *What it changes:* as a feature it would be `features/skater-contributions.md`, a
   deferred-register row instead of a roadmap entry, deleted when it ships.

Not asked, because the docs or the code answer it: bounties (already listed and cancelable on the profile);
a moderator's controls (the console's); the retracted alert's erasure (still open under D248, and nothing
here depends on it); the clock on a move (unchanged — the author's own "Still there" already refreshes it).

---

## §10 — Phase mechanics

This doc is the phase doc; the ⚪ roadmap entry was written at scoping (2026-11-13), flips to 🟡 in B04-1
and 🟢 at the last merge. The build's findings go in a §11 here, not in the roadmap. Workstreams are §8.1–§8.4.
Each PR runs `/code-review xhigh --fix`, `pnpm check-types`, the suites (`packages/guards` uncached) and
lint before it opens.
