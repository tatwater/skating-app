# Account deletion

What happens when someone asks to be deleted — what goes immediately, what survives, for how
long, and how to stop it. The short version, and the thing that surprises people: **"delete my
account" does not mean "delete everything I wrote."** Your reports, comments and hazards stay on
the ice record with your name replaced. Your home address, your saved lakes, your OAuth tokens and
any recording you never published are erased outright.

> **Who this is for.** Anyone reasoning about deletion, retention, or why a departed skater's
> hazard is still on the map. If you're looking for how *content* ages, that's a different
> mechanism entirely — see [report lifecycle](./report-lifecycle.md) and
> [hazard decay](./hazard-decay-and-lifecycle.md). Aging and deletion are deliberately not the
> same thing, and the section on [the two rules that look alike](#the-two-rules-that-look-alike)
> exists because confusing them is the easy mistake.

**And your reports don't go anywhere.** What you *saw* stays — the coordinate, the ice type, the
thickness, the date — under "Deleted skater", with nothing behind the name. What you *wrote* goes:
your notes, your comments, your photo captions, permanently, once they're 30 days old.

> **Who this is for.** Anyone reasoning about deletion, retention, or why a departed skater's hazard
> is still on the map. If you're looking for how *content* ages, that's a different mechanism —
> see [report lifecycle](./report-lifecycle.md) and
> [hazard decay](./hazard-decay-and-lifecycle.md). Aging and deletion are deliberately not the same
> thing, and the section on [the two rules that look alike](#the-two-rules-that-look-alike) exists
> because confusing them is the easy mistake.

Decisions behind this: **D33** (deletion, export, anonymize-don't-erase), **D62** (the 30-day window
and the three buckets), the **D62 amendment** (read-only, and the immediate wipe), the **D62 second
amendment** (redact-don't-erase — what a person typed goes, what they observed stays), **D58**
(publish-is-consent), **D13** (all reports public), **D3** (never assert safety).

---

## The mental model: leaving is a request, not a switch

Three ideas carry the whole design.

**1. A request is not a deletion.** Pressing "Delete my account" stamps a date and changes nothing
else. For 30 days the account is completely normal — you can sign in, post reports, comment, and
change your mind. Nothing is hidden, nothing is locked, and your Clerk login is untouched.

**2. Three buckets, not two.** The original rule was "anonymize everything, since it's all public
anyway." That premise expired: Phase 4 added a home coordinate and the drive-time polygons derived
from it, and Phase 8 added raw GPS traces and live OAuth tokens. A home address is not a public
observation about ice. So private artifacts are **erased**, the public ice record is
**anonymized**, and published GPS tracks are a third thing — **kept but severed from identity**.

**3. Published means published.** A GPS track is kept if and only if it's attached to a visible
report. That isn't a rule invented for deletion — it's the first privacy gate of the aggregate
tracks layer, *publish-is-consent* (D58), reused. A recording you never published was never
anyone's business; one you did publish is already drawn on the lake.

---

## The 30 days, and how to stop it

| Step | What happens | When |
|---|---|---|
| **Request** | `deletionRequestedAt` is stamped. Status stays `active`. Clerk untouched. Nothing else changes. | immediately |
| **Grace** | The account works normally. Every client shows a banner naming the finalize date and a **Cancel deletion** button. | 30 days |
| **Finalize** | An hourly cron picks up accounts whose window has run out and hands each to its own staged job. | day 30 |
| **Clerk delete** | The login itself is deleted, last, after everything else has landed. | seconds later |

### Signing back in

**Nothing locks you out during the 30 days**, and that's the point. The first draft of this design
said "ban the Clerk user during the grace window, delete them at finalize" — which would have
shipped a trap: banning the login locks someone out of the very sign-in they need in order to
undo. So Clerk isn't touched until the last step.

So the recovery path is exactly the ordinary one: **sign in as normal, then press "Cancel
deletion"** in Settings → Your data.

**Signing in alone does not cancel.** Cancelling is an explicit button, never an implicit side
effect of authenticating. Someone who logs in once to save a photo before leaving must not quietly
un-delete themselves — the intent to stay has to be stated, not inferred from a session.

Asking twice is idempotent: a second request keeps the *original* date rather than restarting the
clock, so a double tap doesn't silently buy another 30 days.

### The point of no return

Once the finalize job actually starts, the account is locked and **cancellation is no longer
possible**. The first stage flips status to `deleting`, which every authenticated write path
rejects.

That lock closes a real hole rather than opening one. Finalization is a chain of separately
scheduled steps, and until the lock existed the account stayed fully writable across the whole
chain — so a favorite, a support ticket or a Strava connection created *between* two stages went
into a table an earlier stage had already drained, and nothing rescans. A private row that
outlives a completed deletion, with nothing in the system aware of it.

Losing mid-chain cancellation is the correct trade, because the old behavior was worse than it
looked: cancelling halfway left a live account whose blocks and support tickets had already been
erased. Notifications regenerate. Blocks don't.

---

## The three buckets

### Erased — private artifacts with no community value

Deleted outright, row and blob:

- **OAuth tokens** (`activityConnections`) — live credentials for Strava and any future watch
  provider
- **Home location and drive-time bands** — `homeCoord`, `homeTownLabel`, `cachedIsochrones`,
  `outerRadiusMeters`
- **Saved lakes** (`waterBodyFavorites`), **feed filter preferences**, **risk acknowledgements**
- **Notifications** and the pending notification queue — flushing a queued digest to a tombstone
  is a push nobody can read
- **Blocks, in both directions** — a block they made, *and* a block someone made against them. The
  second matters more than it looks: leaving it would go on filtering a tombstone's content
  forever, over a person who no longer exists
- **Support tickets** — private correspondence between one person and the operator, free text
  likely to carry a name or an email. Not community record. (The `moderationActions` audit trail
  is a separate table and survives regardless.)
- **Client signal events**, **export bundles** and their stored blobs
- **Unpublished GPS recordings** — see below
- **Unattached photos** — an upload never referenced by a report or hazard

### Anonymized — the public ice record

Untouched in content; the author pointer simply stops identifying anyone. This is **one write**,
not a sweep: every `profiles` reference in the app keeps pointing at the same row, and that row
becomes a tombstone.

Reports, comments, hazards, hazard confirmations, report ratings, bounties, point events, content
flags, moderation actions, put-ins, body features, and any water body or sub-area the person drew
— all stay exactly as they were.

The tombstone reads as **"Deleted skater"** everywhere an author is rendered, with no avatar and
**no trust class**. A trust class is a claim about whether to weigh someone's *future* reports, and
there aren't going to be any. (A tombstone is distinct from an unresolvable author, which renders
as "Unknown" — "Deleted skater" means we know exactly what happened.)

Everything identifying comes off the profile row: display name, username, Clerk subject, date of
birth, bio, avatar, home location, isochrones, filter prefs. The username and Clerk subject become
per-row-unique synthetic values rather than a shared `"deleted"` constant — both are looked up with
`.unique()`, so a shared sentinel would work perfectly for the first deleted account and break
authentication for the entire app on the second.

One field is deliberately **not** touched: `excludeTracksFromAggregate`. Flipping it on at finalize
would look like the cautious privacy choice and would silently pull every track the person
contributed off the map — the exact opposite of what keeping published tracks is for.

### Kept, severed from identity — published GPS tracks

> A recorded activity is kept **iff** it is linked to a **visible** report. Otherwise it's erased.

A kept track keeps its path, its times and its lake — that's the contribution to the community map.
What it loses is the handles that point back at a person: the provider activity id (a key into a
possibly-public Strava activity) and any provider-CDN photo URLs. Both are re-identification
vectors that say nothing about ice.

The aggregate map needs **no changes** to keep honoring privacy after a deletion, and that's a
property of D58's design rather than luck. All four of its gates read data that survives:

| Gate | Reads | After deletion |
|---|---|---|
| Publish-is-consent | the linked report is visible | report survives, anonymized → passes |
| Minors excluded | falls out of "minors can't post" | unchanged |
| Put-in clipping | the report's `showPutIn` | unchanged — the 150 m clip at both ends is preserved exactly |
| Global opt-out | the profile's `excludeTracksFromAggregate` | tombstone survives → honors their last choice |

---

## Why safety information outlives its author

This is the part worth arguing about, so here's the argument.

**A report is a fact about ice, not a fact about a person.** "I skated here on the 14th and the ice
was 4 inches with a pressure ridge across the north bay" doesn't become less true because the
person who wrote it left the app. It's a dated observation, and it stays exactly as accurate as it
was — which is the same reasoning that means reports never decay
([report lifecycle](./report-lifecycle.md)).

**Erasing it deletes someone else's safety input, not just the author's data.** A hazard pin is
read by the next skater standing on that shore. A track shows where the ice held. A put-in is,
per the corpus of real skater conversation, the single most-discussed piece of information about a
lake. Removing all of it because its author closed an account transfers a cost from the person
leaving to people who never had a say — and the person leaving isn't harmed by an observation that
no longer carries their name.

**Anonymizing is what makes that fair.** The tension isn't "privacy vs. safety" in the abstract; it
resolves once you separate the *observation* from the *identity*. Everything that says who someone
is goes. Everything that says what the ice was doing stays. That seam is why the block set is
erased in both directions (a block is about a person, and the person is gone) while the flag they
filed survives (a flag is about content, and the content is still there).

**It's also the honest posture for the app's one promise.** This app never asserts that ice is
safe (D3) — decay is confidence, not safety, and an empty map is never "all clear." Silently
thinning the record because of an account action would make the map quietly emptier in a way no
skater could see or reason about.

**And it's bounded.** "Forever" was the original answer, and it's the wrong one — which is what the
seasonal work fixes.

---

## What changes when seasons ship (N5a)

> **Not built yet.** Designed 2026-07-27 as part of [N5a](../plans/phase-N5a-seasons.md); the code
> described here doesn't exist. This section is the intended behavior, recorded so the current
> "kept indefinitely" answer isn't mistaken for the final one.

### The two rules that look alike

The governing principle, stated because two N5a rules resemble each other and are opposites:

> **Aging never erases anything. An intentional account deletion erases everything that isn't of
> immediate value to the community.**

Seasons and staleness only ever **hide** — for everyone, reversibly, with a labelled way back. A
season is July 1 → June 30 (labelled `'24/'25`), derived from the skate time rather than stored,
so the reset isn't an event: it's a derived value changing and the queries following. Last season's
reports and hazards leave the default view; they're still reachable by permalink, labelled *"from
the '24/'25 season"*, and browsable via a per-lake season selector.

Erasure has exactly one trigger, and it's a person deciding to leave.

### A departed skater's content is erased at 30 days

For an author whose profile is a tombstone:

| | |
|---|---|
| **Erased at 30 days past `skateEndTime`** | the report and its cascade, its GPS activity and path, hazards they created, their photos |
| **Erased immediately at finalize** | **all** their bounties, including open ones — a request from someone who left can't be fulfilled *for* them |
| **Kept** | put-ins, and anything still inside the 30-day window |

So **anything from a previous season is erased for certain**, and the purge is retroactive: someone
deleting in July 2027 with content from '25/'26 has all of it swept at once. That's the most
destructive case the design allows and it's intended — the alternative leaves a departed person's
older rows sitting invisibly forever, which is the retention this rule exists to prevent.

**Why 30 days, flat, rather than the freshness curve.** A corroborated report earning a longer life
is more principled, but the consequence here is irreversible deletion, and a rule you can verify by
reading one field beats one that depends on other people's later votes. (The finalize sweep already
shipped one bug of exactly that shape — see [below](#known-gaps).)

**Why 30 days is the right number:** by then anything still true has fresh reporting behind it, and
holding a departed person's data past its usefulness is the least respectful option available.

### Deleting a report is the expensive part

Seven tables point at one report, and each answers differently:

| Referrer | What happens |
|---|---|
| Comments on it | deleted — a reply to a thread that no longer exists is unreachable. Each commenter's denormalized count decrements. |
| Its GPS activity | the activity and its path are deleted |
| Bounties citing it as fulfilling | the id is pulled from the array — someone *else's* bounty may cite it |
| Content flags targeting it | deleted; nothing left to moderate |
| Hazards derived from it | deleted too |
| Put-ins derived from it | **the put-in survives**, with the pointer cleared |
| Point events referencing it | **left alone** — a `report_corroborated` row belongs to the *corroborated* author, whose count must not move because someone else left |

That last row is the one to argue with in review: deleting a departed user's point events looks
tidy and would silently change other people's corroboration counts, which feed report freshness and
the recommended feed.

### One consequence worth knowing

Seasonal scoping is what turns hazards into a per-season historical record, and that record is the
substrate for future recurrence detection ("ridges have formed in this spot in 3 of the last 4
winters"). A departed user's hazards *do* get deleted, which means recurrence is computed over what
remains. That's honest and it's decided — but it's a real narrowing of the evidence base, so it's
stated rather than discovered later.

---

## Export: taking your data with you

The companion control, and the one the delete copy points at, because anyone deleting an account is
the person most likely to want their record — and the moment after confirming is too late to say so.

- **One JSON bundle**: profile, reports, comments, hazards, hazard confirmations, GPS activities
  and paths, saved lakes, ratings, point events, and photos.
- **Photo bytes are embedded, not linked.** Linking would have been far easier and fails at the one
  moment the feature exists for: a URL into our storage dies when the account is deleted, so a
  link-based export is worthless to anyone who exports *then* deletes.
- **Budgets are stated, never silent.** Photos fit a 25 MB budget; anything beyond it is counted
  and named in the bundle and in the settings row, not quietly dropped.
- **Secrets and join keys are stripped.** OAuth tokens are reduced to provider/scope/date, and the
  Clerk subject is excluded — it's the join key an attacker would most want out of a leaked bundle.
- **Emailed and listed in settings.** The address comes from Clerk at send time, because we
  deliberately never stored one. The in-app listing exists so a spam-filtered email isn't a dead
  end.
- **The link works for 7 days**, measured from when the bundle actually exists rather than when it
  was requested — a slow build shouldn't quietly sell seven days and deliver rather less. After
  that an hourly sweep deletes both the row and the blob. An export is the densest concentration of
  one person's data anywhere in the system, so it's deliberately short-lived.

---

## Retention at a glance

| Thing | Kept for | Swept by |
|---|---|---|
| A deletion request, before it takes effect | 30 days | hourly finalize cron |
| An export bundle | 7 days from ready | hourly export sweep |
| An unattached (orphan) photo | 30-day grace, then GC'd | daily photo sweep |
| Weather cache rows | 24 hours (addressable only within their own hour) | 6-hourly prune |
| Anonymized reports, comments, hazards | indefinitely, today — **30 days past the skate once N5a ships** | (N5a purge) |
| A departed user's put-ins | indefinitely, deliberately | — |
| Bounty gate analytics referencing them | 180 days, self-expiring | existing prune |

---

## Known gaps

Stated plainly because they're live, not hypothetical.

- **No real account has been through this end to end.** The staged job has 19 tests including the
  multi-page continuation, and all four crons have been run against dev — but dev holds only the
  two founder accounts and there was no throwaway to delete. Worth doing against a disposable
  account before the alpha.
- **Email delivery is unprovisioned.** Resend keys and a verified sending domain are prod-cutover
  work, so today an export lands in the settings list and no mail goes out. That's the designed
  degradation, not a failure path.
- **The sweep that would have deleted everyone.** The first real tick against dev reported
  `due: 2, started: 2` on a deployment where nobody had requested anything: a Convex index on an
  optional field is *not* sparse, and `undefined` sorts before every number, so a bare upper bound
  matched every profile in the table. Nothing was lost — a second, independent guard inside the job
  re-reads the stamp and stops. Two independent guards is now the deliberate posture for a job whose
  failure mode is deleting everyone, and the same predicate shape is exactly why N5a's purge is
  bounded on both sides.
- **A still-valid session between the tombstone and the Clerk delete** can create a fresh, empty
  profile. Not a leak — it's the same thing signing up again gives you, and the Clerk delete closes
  the window seconds later — so it's logged rather than guarded.

---

## What's deliberately absent

- **No immediate deletion**, and no way to skip the window from the client. (An operator escape
  hatch exists for the support case, and it runs the *same* staged job rather than a second,
  less-tested path.)
- **No Clerk ban during the grace window** — it would lock someone out of the sign-in they need to
  cancel with.
- **No implicit cancel on sign-in** — the intent to stay is stated, never inferred.
- **No selective content deletion.** There's no "delete my reports but keep my account." Reports are
  the community's ice record (D13/D33); the lever for leaving is leaving.
- **No merged tombstones.** Each deleted account keeps its own, so their surviving tracks remain
  linkable to each other under a pseudonym. That's inherent to anonymize-don't-erase and already
  true of their reports; what stops it pointing at a house is the put-in clip.
- **No hiding by age, score or author status.** Seasons hide, reversibly and for everyone. Nothing
  else does.
