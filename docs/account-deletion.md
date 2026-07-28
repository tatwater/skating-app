# Account deletion

What happens when someone asks to be deleted. Two things surprise people, and they pull in opposite
directions.

**The request *is* the deletion.** You stop existing on the platform the moment you tap the button —
profile cleared, unfindable, nobody able to reach your page. What the 30 days that follow preserve is
your **login**, so you can change your mind.

**And your reports don't go anywhere.** What you *saw* stays — the coordinate, the ice type, the
thickness, the date — under "Deleted skater", with nothing behind the name. What you *wrote* goes:
your notes, your comments, your photo captions, permanently.

> **Who this is for.** Anyone reasoning about deletion, retention, or why a departed skater's hazard
> is still on the map. If you're looking for how *content* ages, that's a different mechanism —
> see [report lifecycle](./report-lifecycle.md) and
> [hazard decay](./hazard-decay-and-lifecycle.md). Aging and deletion are deliberately not the same
> thing, and the section on [the two rules that look alike](#the-two-rules-that-look-alike) exists
> because confusing them is the easy mistake.

Decisions behind this: **D33** and **D62** with its amendments (the window, the buckets, read-only,
redact-don't-erase), **D58** (publish-is-consent), **D13** (all reports public), **D3** (never assert
safety).

---

## The mental model: a ghost, not a countdown

Three ideas carry the design.

**1. Asking to leave makes you a ghost immediately.** The request scrubs the profile and closes
posting. Only the account itself waits out the 30 days, and it waits for exactly one reason: so the
decision can be reversed. Nothing about the window is "we haven't done anything yet."

**2. Your contributions and your identity have different owners.** A report is a fact about ice; a
name and a home address are facts about a person. So the ice record stays and the person goes. That
seam is why a departed skater's hazard still warns you, under "Deleted skater", with nothing behind
the name.

**2b. The seam runs through the content itself.** Look at what a report actually contains:

| Part of a report | Whose is it? | What happens |
|---|---|---|
| "4 inches, drilled, by the boat launch" | the lake's | kept, indefinitely |
| where it was, when, what the ice was doing | the lake's | kept, indefinitely |
| the author's name, handle, avatar | theirs | gone at the request |
| *"my usual spot — beautiful morning, saw three herons"* | theirs | gone |

Erasing the whole row would take the first two lines away from the next skater without giving the last
two back to the person who left. So the rule is **redact, don't erase**: the words come off, the
observation stays.

**3. Published means published.** A GPS track is kept if and only if it's attached to a visible
report — not a rule invented for deletion, but the first privacy gate of the aggregate tracks layer,
*publish-is-consent* (D58), reused. A recording you never published was never anyone's business.

---

## What happens the moment you ask

| | |
|---|---|
| **Your profile** | actually scrubbed — name, photo, bio, town, home location, drive-time bands. Not hidden: cleared. |
| **Your profile page** | not-found to everyone but you. You aren't "empty" in search, you're absent. |
| **Your surviving content** | reads as **"Deleted skater"** everywhere — feed, report detail, comments, hazards — with no handle to click and no trust ring. |
| **Everything you wrote, older than 30 days** | cleared, permanently: report notes (including the note on each thickness reading), hazard descriptions, photo captions, comment text, the notes on flags you filed. Anything newer goes at finalization instead. |
| **All your bounties** | erased, including open ones — a request from someone who left can't be fulfilled *for* them. |
| **Unpublished recordings and abandoned uploads** | erased. You never shared them. |
| **Posting** | closed. See [what read-only means](#what-read-only-means). |
| **Your login** | untouched, so you can sign back in and cancel. |

A sweep runs hourly for as long as the account is pending, so your words keep coming off as they age
past the line rather than freezing at day one. Finalization then clears whatever is still standing, at
any age — see [redacted](#redacted--the-words).

### What survives, and for how long

The **observations**, indefinitely, for the community's sake rather than yours:

- **Your reports**, minus their prose. The readings, the ice types, the location and the date are what
  keep somebody off bad ice, and none of that stops being true because you left.
- **Your hazards**, likewise. The pin, its type, its geometry and its dates all stay; multi-season
  hazard history is what recurrence detection and body-feature promotion are built on.
- **Your comments**, as marked shells — the text goes, the row stays, so you don't leave a hole in
  somebody else's conversation. See [comments](#comments-keep-their-shape).
- **Put-ins**, indefinitely, and **dated**. Access is the single most-discussed thing in the real
  skater corpus. Because your report survives, its access point derives from it exactly as anyone
  else's does — and each marker says when it was last used, because a pull-off from three winters ago
  can be posted or fenced by now.
- **Published GPS tracks**, severed from your identity — see [the four buckets](#the-four-buckets).

---

## Signing back in, and what cancelling can't do

**Nothing locks you out.** The login is the last thing touched, because banning it would lock someone
out of the very sign-in they need in order to undo.

Sign in as normal, then press **Cancel deletion** in Settings. Signing in alone does not cancel;
that's an explicit button, never inferred from a session, because someone who logs in once to save a
photo before leaving must not silently un-delete themselves.

**Cancelling keeps the account. It does not restore you.**

| Cancelling gets back | Cancelling cannot get back |
|---|---|
| The account and its login | Your name, photo, bio, town, home location |
| Your reserved @handle | The notes, comments and captions already cleared |
| Every report, hazard and track you filed | Your saved drive-time bands |

You're routed back through onboarding to introduce yourself again — the same screen as a new account.
That's the honest version of what happened: the data was deleted, and a cancel that pretended
otherwise would be the one dishonest thing in this flow.

The **handle is reserved, not released**. Invisibility comes from the read gates, not from mutating
the field, so releasing it would buy nothing and could cost you your name to a squatter in a window
you might well cancel in.

One field is deliberately *not* scrubbed at request, and it's worth knowing why: **date of birth**.
Scrubbing it means writing the tombstone's fixed 1900 sentinel, which derives to *adult* — so a minor
who cancelled would come back with an adult's posting rights. It's the one place a privacy scrub would
open a safety hole, so it waits for finalization, where there's no coming back.

---

## What read-only means

The line is **contributions to the public record**, not writes in general.

| Closed while pending | Still open |
|---|---|
| Reports, comments, hazards, hazard confirmations | **Flagging** content |
| Thumbs (helpful / not helpful), bounties | **Blocking** another user |
| Photo uploads, recorded-track ingest | Support tickets, data export |
| New Strava (or other provider) connections | The **aggregate-tracks opt-out** |
| Creating a water body from a track | **Saving a lake** (favorites) |
| **Every profile field** — name, bio, town, home location, notification and filter preferences | **Cancelling the deletion** |
| **Every moderator and admin *action*** — see below | Every moderator and admin **read** |

Each exemption has its own reason: a hazard is no less dangerous because the person who spotted it is
leaving, self-protection outlives the account, a favorite is a private bookmark rather than a
contribution (and is erased at finalization anyway), and the last one is the door back.

**Operators are not exempt, and that needed its own gate.** The member gate composes onto
`requireProfile`, and so did the role gate — they sat *beside* each other rather than one inside the
other, so a moderator or admin who had asked to be deleted kept every privileged write while ordinary
members were read-only. Drawing a sub-area, promoting a body feature, curating a put-in, resolving a
flag, banning someone: all still worked.

It matters for the content reason everyone else's gate exists for — a sub-area authored in the window
goes up attributed to an account about to become a tombstone — and for a sharper one:
`moderationActions` is an audit trail, and a ban recorded against a moderator who is deleted three days
later points at a row with no person behind it.

Privileged **reads** stay open — the admin tree, the moderation queues, the analytics — for the same
reason a ghost can still read the app at all. An operator reviewing the state of things on their way
out is a reasonable thing to be doing.

**Notifications stop, rather than the switch reopening.** A ghost's reports are kept, so people go on
commenting on them and rating them — and `setNotificationPrefs` closes with every other profile field,
so they cannot turn any of it off. Every notification path therefore asks whether the recipient is
leaving, and that is re-checked at *delivery* as well as at generation: queued rows outlive the state
they were queued against, so a debounced or 8pm-digest row enqueued before the request is dropped
rather than sent.

**Every profile field is closed, including the ones the request just cleared.** Leaving those editable
would let a ghost type their name, bio and town straight back in, and the wipe would read as a
suggestion rather than a deletion.

The one setting that survives that is the **aggregate-tracks opt-out**, which has its own mutation. It
governs the tracks that outlive your account, which makes a person on their way out exactly the person
who most needs it.

**The affordances go, not just the permissions.** Both apps hide every control this closes — the lake
sheet's compose buttons, the comment box, the thumbs, the hazard confirm control, the map's capture
and record buttons, the ＋ Report tab's capture entry, the Strava connect card. In their place is one
line saying why the app went quiet and where to undo it; a button that silently vanishes reads as a
broken build.

Two deliberate exceptions to that emptying-out:

- **The mobile draft queue stays** — your own unsent reports, and the only screen that can delete
  them. A draft that tries to flush fails at the server gate and says so on its row.
- **An existing Strava connection still renders** (only *connecting* is closed) — unlinking on the way
  out is exactly what this window is for.

**Why posting closes at all**, since it's the least obvious part: the person is gone from the moment
they ask, so a report filed after that would go up with nobody behind it — attributed to a tombstone
by an account still being used.

**The accepted cost:** a skater on bad ice during their window can't file the hazard. Cancelling is
one tap and the message says so, but it's a real trade rather than a free win.

### Your own profile

Your profile page stops showing a profile: no avatar, no name but *"Deleted skater"*, no town, bio,
badges, trust ring or counts — with a line explaining that your reports are still helping people, that
the words you wrote alongside them are going, and that cancelling means setting up from scratch.

This is not a preview. The row really is empty by the time it renders. And **nobody else can reach the
page at all** — a ghost is not-found to every other viewer — so the only person who ever sees it is
standing in the space where they used to be. That's the intended feeling.

---

## The point of no return

Once the finalize job starts, the account is locked and cancellation ends. The first stage flips
status to `deleting`, which every authenticated write path rejects.

That lock is what makes the staged job safe. Finalization is a chain of separately scheduled steps,
and each drains tables the next one never rescans — so without it, a favorite, a support ticket or a
Strava connection created *between* two stages would outlive the deletion with nothing in the system
aware of it. Read-only narrows that window but can't replace the lock: the tables still reachable
mid-chain are exactly the protective ones the window keeps open, and a block filed a second before the
sweep shouldn't be silently kept either.

Cancellation genuinely ends here rather than degrading. A cancel mid-chain would leave a live account
whose blocks and support tickets had already been erased — and notifications regenerate, but blocks
don't.

If the chain dies partway, the hourly sweep re-queues it: only `deleted` is skipped, every stage is
idempotent, and an account left in `deleting` restarts from the lock.

---

## The four buckets

**Erased**, **redacted**, **pseudonymized**, and **kept-but-severed**. The identity scrub happens at
the request; the private side-tables wait for finalization.

### Erased — private artifacts with no community value

- **OAuth tokens** (Strava and any future watch provider)
- **Home location and drive-time bands** *(at request, with the profile)*
- **Saved lakes** (still editable during the window — a private bookmark, not a contribution),
  **feed filter preferences**, **risk acknowledgements**
- **Notifications** and the pending queue — flushing a digest to a tombstone is a push nobody reads
- **Blocks, in both directions** — leaving the second kind would filter a tombstone's content for the
  blocker forever, over a person who no longer exists
- **Support tickets** — private correspondence, free text likely to carry a name or an email, not
  community record. (The `moderationActions` audit trail is separate and survives.)
- **Client signal events**, **export bundles** and their stored blobs
- **Unpublished GPS recordings**, **unattached photos**

The private side-tables survive the ghost window on purpose: they're invisible to everyone else either
way, and losing your block list during a window you might cancel in would be a safety regression for
no privacy gain.

### Redacted — the words

| Field | On |
|---|---|
| `notes` | reports |
| `note` on each thickness reading | reports — prose in a nested array, and the one a redaction pass forgets |
| `description` | hazards |
| `caption` | photos |
| `body` | comments |
| `note` | flags you filed — the row survives (it's about content), the words don't |
| `statusReason` | your profile — a moderator's written reason for a past suspension |

Everything else on those rows survives. A thickness *reading* is the most valuable thing a report
carries and is not free text; a photo's coordinate is where on the lake it was taken, which is ice
record and is what places the pin. A flag keeps its structured `reason`, target and status, which is
everything the moderation queue actually sorts on; the audit trail in `moderationActions` — the
operator's own words, not yours — is a separate table and survives regardless.

**Two clocks, and the difference is load-bearing.**

*While the account is pending*, the sweep works on age: 30 days past the skate, or past `createdAt`
for a comment or a flag (neither has a skate of its own), or past `lastConfirmedAt` for a hazard — so
a ridge other skaters are still confirming keeps its description for as long as people are maintaining
it. That's the promise the window makes, and it's re-run hourly so it stays true as content ages.

*At finalization there is no clock at all.* Everything goes, at any age. This is not an inconsistency
to tidy up: **the finalize pass is the last one that will ever run.** Writing the tombstone drops the
row out of the index the sweep reads, so nothing can come back for it afterwards, and anything an age
gate skipped there would be kept forever. A "keep it while it's still useful" rule needs a terminal
case, and this is it. That matters most for hazards, where `lastConfirmedAt` is a clock *other people*
push forward — a departed skater's description must not stay up indefinitely just because the
community is still confirming their pin.

### Pseudonymized — the public ice record

The author pointer stops identifying anyone *directly*. This is one write, not a sweep: every
`profiles` reference keeps pointing at the same row, and that row becomes a tombstone.

Reports, hazards, comments, ratings, confirmations, flags, moderation actions, put-ins, body features
and any water body or sub-area you drew all stay as they were, minus their prose.

The tombstone reads as **"Deleted skater"** with no avatar, **no handle** (a link to a page that
deliberately 404s is worse than no link) and **no trust class** — a trust class is a claim about
whether to weigh someone's *future* reports, and there aren't going to be any.

> **Why "pseudonymized" and not "anonymized".** The distinction is legally consequential, so the word
> is chosen rather than casual: genuinely anonymous data falls outside GDPR entirely, and this doesn't
> qualify. Each deleted account keeps its **own** tombstone, so everything that person contributed
> stays linkable *to itself* under a stable pseudonym, and a set of dated GPS traces, photo
> coordinates and put-in usage tied together by one identifier is re-identifiable by someone
> determined enough — which is the test Recital 26 actually applies.
>
> That doesn't make the posture wrong; it makes the defense a different one. This is retained
> **pseudonymized safety data**, kept because a dated observation about ice keeps somebody off it, and
> stripped of every direct identifier we hold. It is not a claim that the data is nobody's.

### Kept, severed from identity — published GPS tracks

> An activity is kept **iff** it's linked to a **visible** report — and only for as long as that
> report survives.

A kept track keeps its path, times and lake. It loses the handles that point back at a person: the
provider activity id (a key into a possibly-public Strava activity) and any provider-CDN photo URLs.

The aggregate map needs **no changes** to keep honoring privacy, and that's a property of D58's design
rather than luck. All four of its gates read data that survives:

| Gate | Reads | After deletion |
|---|---|---|
| Publish-is-consent | the linked report is visible | report survives, pseudonymized → passes |
| Minors excluded | falls out of "minors can't post" | unchanged |
| Put-in clipping | the report's `showPutIn` | unchanged — the 150 m clip at both ends preserved exactly |
| Global opt-out | `excludeTracksFromAggregate` | tombstone survives → honors their last choice |

---

## Why safety information outlives its author

**A report is a fact about ice, not a fact about a person.** "I skated here on the 14th, 4 inches with
a ridge across the north bay" doesn't become less true because its author left. It's a dated
observation, as accurate as it ever was — the same reasoning that means reports never decay
([report lifecycle](./report-lifecycle.md)).

**Erasing it takes away someone else's safety input.** A hazard pin is read by the next skater on that
shore. A track shows where the ice held. A put-in is the most-discussed thing about a lake. Deleting
all of it because its author closed an account moves a cost onto people who had no say — and the
person leaving isn't harmed by an observation that no longer carries their name.

**Pseudonymizing is what makes that fair**, and it's why the seam falls where it does. Everything that
says who you are goes immediately; everything you *wrote* goes on the redaction clock; everything that
says what the ice was doing stays. That's also why your block set is erased (a block is about a person,
and the person is gone) while a flag you filed survives (a flag is about content, and the content is
still there).

**And what's bounded is the writing, not the record.** A time limit is a fair rule for a *sentence
someone wrote* and a poor one for a *measurement*: fresher reporting arrives on popular lakes in a week
and on quiet ones never, and the second kind is exactly where a three-year-old thickness reading is the
only thing anybody has. So the bound applies to the prose, which is personal and replaceable, and not
to the observation, which is neither.

---

## The two rules that look alike

> **Aging never removes anything. An intentional account deletion erases what is private, redacts what
> is personal, and keeps the observation either way.**

Two mechanisms in this codebase both take something off the screen, and they are opposites:

|  | Staleness and seasons | Deletion |
|---|---|---|
| What it does | **hides** | **erases** (private) / **redacts** (personal) |
| What it reaches | whole reports and hazards | side-tables, and free-text fields |
| Who it applies to | everyone | only someone who chose to leave |
| Reversible | yes, with a labelled way back | no |

Seasonal scoping (N5a, designed but not built) will hide last season's reports and hazards from the
default view — reachable by permalink, browsable by a per-lake season selector. That is not this. The
30-day clock isn't "old content expires"; it's how long a departing skater's own words stay up, and it
reaches nobody who's still here.

---

## Comments keep their shape

A comment is the one thing a departed skater wrote that lives inside somebody else's conversation, and
that's what decides its handling. Deleting the row would be tidy and would break the thread: replies
are keyed to their parent, so a vanished parent takes its children with it or strands them.

So the row survives, marked, with its text cleared, and both apps render it as *"This comment was
deleted"* under the "Deleted skater" byline. That's honest about the *kind* of absence it is — worth
distinguishing from the two that already exist:

| What you see | What happened |
|---|---|
| `[comment hidden]` | a moderator judged it, or you and its author have blocked each other |
| *"This comment was deleted"* | its author left, and their words came off |

Collapsing those would make somebody's departure look like a moderation action.

---

## Export: taking your data with you

The companion control, and the one the delete copy points at, because anyone deleting an account is
most likely to want their record — and the moment after confirming is too late to say so.

- **One JSON bundle**: profile, reports, comments, hazards, confirmations, GPS activities and paths,
  saved lakes, ratings, point events, photos.
- **Photo bytes are embedded, not linked.** A URL into our storage dies with the account, so a
  link-based export is worthless to anyone who exports *then* deletes — the single most likely reason
  to ask for one.
- **Budgets are stated, never silent.** Photos fit a 25 MB budget; anything beyond it is counted and
  named rather than dropped.
- **Secrets and join keys stripped.** OAuth tokens reduce to provider/scope/date; the Clerk subject is
  excluded — it's the join key an attacker would most want from a leaked bundle.
- **Emailed and listed in settings.** The address comes from Clerk at send time, because we never
  stored one. The listing means a spam-filtered email isn't a dead end.
- **The link works for 30 days**, measured from when the bundle exists rather than when it was
  requested. Then an hourly sweep deletes the row and the blob: an export is the densest concentration
  of one person's data anywhere in the system.
- **An emailed bundle outlives the account.** Export-then-delete is the commonest reason to ask for
  one, and the settings list needs a sign-in there won't be after day 30 — so a bundle still inside its
  TTL survives finalization, and the ordinary hygiene sweep reclaims it when it expires. Only if it was
  actually emailed: with no mail sent there is no way left to reach it, and keeping the densest
  artifact in the system with nothing able to fetch it is pure cost.

**Export before you delete.** After the request, an export can only contain what's left.

---

## Retention at a glance

| Thing | Kept for | Swept by |
|---|---|---|
| Your profile, once you ask | not at all — cleared at the request | — |
| Your reports, hazards and published tracks | indefinitely, pseudonymized | — |
| The **words** on them | 30 days past the skate, and unconditionally at finalization | the ghost sweep (hourly while pending), then the finalize `redact` stage |
| Your comments | the row indefinitely, the text on the same clock | the same sweep |
| **Photo images attached to a report or hazard** | indefinitely — only the caption is cleared | — (see [known gaps](#known-gaps)) |
| An abandoned upload from a very prolific uploader | 30-day grace, like any other | daily photo sweep, via `photoReconcile` |
| Your bounties | not at all — erased at the request | the same sweep |
| Unpublished recordings, abandoned uploads | to the redaction clock, and at finalization at the latest | the same sweep |
| The account and login | 30 days | hourly finalize cron |
| An export bundle | 30 days from ready, surviving the account if emailed | hourly export sweep |
| An unattached (orphan) photo | 30-day grace, then GC'd | daily photo sweep |
| Weather cache rows | 24 hours | 6-hourly prune |
| A departed skater's put-ins | indefinitely, deliberately | — |
| Bounty gate analytics referencing them | 180 days, self-expiring | existing prune |

---

## Invariants a change here must not break

Each of these is load-bearing, and each has a failure mode that is silent — the tests stay green, the
rows look right, and something is quietly wrong for a person who can no longer complain about it.

- **Finalize must never set `excludeTracksFromAggregate`.** Flipping it on looks like the cautious
  privacy choice and would silently pull every track the person contributed off the map — the opposite
  of what keeping published tracks is for.
- **The finalize redaction takes no age cutoff.** See [redacted](#redacted--the-words). It's the last
  pass that will ever see those rows.
- **The finalize sweep's range is bounded on both sides, and each row is re-checked inside the job.** A
  Convex index on an optional field is *not* sparse and `undefined` sorts before every number, so a
  bare upper bound on `deletionRequestedAt` matches every profile that never asked to be deleted. Two
  independent guards is the deliberate posture for a job whose failure mode is deleting everyone.
- **The redaction queries must not inherit a season bound.** N5a adds season lower bounds to reads off
  the same indexes the sweep uses (`by_author_skate_end_time`, `by_author_and_water_body`,
  `by_author`). If one leaks in, a departed user's older content silently stops being redacted — and
  nothing visible would look wrong.
- **Every redaction category paginates, and exactly one runs per call.** Redaction *keeps* the row it
  touches, so the query doesn't shrink under a repeated first-page read the way a delete does; and
  Convex allows one `.paginate()` per function execution.
- **The tombstone's `username` and `clerkUserId` sentinels must be per-row unique.** Both indexes are
  read with `.unique()`, so a shared constant would break authentication app-wide on the *second*
  deleted account.
- **"Couldn't determine" is a method to escalate from, not an answer to retry.** The one-shot photo
  reference scan gives up past `REFERENCE_SCAN_CAP`, and callers correctly keep the photo — but the cap
  is a property of the *uploader*, not of the moment, so re-running it tomorrow fails identically. The
  orphan cron therefore hands that uploader to `photoReconcile`, which answers the same question
  completely by spreading it across transactions: mark every candidate, page through every possible
  referrer clearing marks, delete what is still marked. Anything that ever *skips* on indeterminacy
  needs a path that terminates, or the skip is permanent.
- **The UI hides exactly what the server blocks, no more and no less.** Hiding something still allowed
  strips a safety tool for nothing; leaving a blocked one visible invites someone to write a report and
  only then refuses it. This has two sides for operators: the clients gate navigation and read-only
  operator chrome on holding the role, and every control that *submits* on holding the role **and** not
  leaving — mirroring `requireRole` vs `requireContributorRole` exactly.
- **A gate that asks about `status` is asking the wrong question about a ghost.** `status` stays
  `active` for the whole window on purpose, because it is what `requireProfile` reads and a departing
  person has to keep being able to sign in and cancel. Anything that means "is this account really
  here?" — notification eligibility, for one — must ask about `deletionRequestedAt`.

---

## Known gaps

- **No real account has been through this end to end.** The staged job and the sweep have thorough test
  coverage and all crons have run against dev, but dev holds only the two founder accounts and there
  was no throwaway to delete. Worth doing against a disposable account before the alpha.
- **Deleting is one click behind a live session, and the irreversible part happens first.** The classic
  job of a grace window is protecting against a misclick or a stolen session — and here the profile
  scrub and the redaction land *before* the window, where cancelling can't reach them. The decided fix
  is an emailed confirmation whose link forces a Clerk re-authentication even with a live session:
  three factors instead of one, and a message in the victim's inbox saying it's happening. Blocked on
  Resend provisioning, with a reverification-only fallback so a mail outage can never strand somebody's
  right to erasure. In the N5a deferred register.
- **Banned and suspended users have no self-service path.** Both gates reject them, and erasure and
  access rights don't depend on good standing. Suspended users need only a gate change; a *banned* user
  is Clerk-banned and can't sign in at all, so that half has to be an operator-run export and deletion
  from `/admin/users` plus a documented contact address. In the N5a deferred register.
- **Photo *images* survive indefinitely, and only the caption comes off.** The largest unresolved
  question in the design — a *policy* one, now that the mechanical hole underneath it is closed (see
  the note on reclaiming below). A photo attached to a surviving report or hazard is kept whole: the
  bytes, the timestamp and the coordinate. The coordinate is defensible — it's where on the lake the picture
  was taken, and it's what places the pin — but the *image* can carry faces, a licence plate, a house
  behind the put-in, or the departed skater themselves. It's a far larger identifiability surface than
  any text field on this page, and nothing currently removes it.

  It isn't simply "erase them" because photos are also the most *evidential* thing in a hazard report:
  a picture of an open lead is worth more than any sentence describing one. The shape under
  consideration splits on that — **hazard-documenting photos kept, the rest expiring at the season
  boundary** — which trades the beautiful-morning shots and some put-in documentation for keeping the
  danger evidence. Not decided, not built; in the N5a deferred register with the alternatives.
- **Email delivery is unprovisioned.** Resend keys and a verified sending domain are prod-cutover work,
  so an export lands in the settings list and no mail goes out. Designed degradation, not a failure
  path — but note it also means the "an emailed bundle outlives the account" carve-out never fires
  today, since nothing is ever marked emailed.
- **A still-valid session between the tombstone and the Clerk delete** can create a fresh, empty
  profile. Not a leak — the same thing signing up again gives you — so it's logged rather than guarded.
- **A redacted comment's moderator view is unaudited**, as is whether `commentCount` should follow a
  redaction (it currently doesn't — the comment still exists, which is arguably correct). In the N5a
  deferred register.

---

## What's deliberately absent

- **No immediate account deletion**, and no way to skip the window from the client. (An operator escape
  hatch exists for the support case, and it runs the *same* staged job.)
- **No Clerk ban during the window** — it would lock someone out of the sign-in they need to cancel
  with.
- **No implicit cancel on sign-in** — the intent to stay is stated, never inferred. Which is also why
  posting doesn't cancel it: the app refuses the post rather than reading it as a change of heart.
- **No restore.** Cancelling stops the deletion; it doesn't undo one. Nothing in the system keeps a
  shadow copy of a scrubbed profile so that it could.
- **No selective content deletion.** There's no "delete my reports but keep my account". The lever for
  leaving is leaving.
- **No merged tombstones.** Each deleted account keeps its own, so surviving tracks remain linkable to
  each other under a pseudonym — inherent to redact-don't-erase, and what stops it pointing at a house
  is the put-in clip.
- **No hiding by age, score or author status.** Seasons will hide, reversibly and for everyone. Nothing
  else does.
