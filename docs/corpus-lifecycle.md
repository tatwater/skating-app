# Corpus lifecycle

What happens to a lake over years — how it gets onto the active map, how it leaves it, and what it
means when the app says a lake is **inactive**. The short version: **we know about ~25,000 bodies of
water and we push a few hundred.** Every lake we know about stays on the map when you zoom right in;
the ones we recommend, notify about and show first are the ones people actually skate and can
actually reach.

> **Who this is for.** A skater who found a lake marked *Inactive* and wants to know why (and what
> to do about it); a moderator deciding whether to shelve or restore one; a developer meeting the
> `standing` field for the first time. The decision record is
> [`plans/01-decisions.md`](../plans/01-decisions.md) (**D176–D179**) and the engineering record is
> [`plans/phases/A07b-corpus-by-request.md`](../plans/phases/A07b-corpus-by-request.md).

---

## The mental model: knowing a lake and pushing a lake are different things

The catalogues we merge ([where the lakes come from](./water-body-data.md)) give us every named pond
and most unnamed ones over an acre. That is the right corpus to *know* — the pond you skated as a
kid is in there, findable by zooming in or typing its name — and the wrong corpus to *push*: a
"lakes near you" notification, a weather-discovery card, a recommended strip drawn from 25,000 bodies
of which 24,500 have never had a skate on them is noise.

So every body has a **standing**, and only one of them is pushed:

| Standing | What you see | On push surfaces? | How it gets there |
| --- | --- | --- | --- |
| **Active** | on the map at its normal zoom, in search, in notifications, in discovery | yes | the seed, or evidence of use |
| **Dormant** | on the map only when zoomed right in, dimmed; in search, badged *Inactive*; the drawer says why | no | three seasons with nobody on it · the admission rules changed · a moderator · a no-public-access ruling |
| **Removed** | on the map only when zoomed right in, dimmed; the drawer says why; **not in search** | no | a landowner's request, junk data, a duplicate — always a person, with a reason |
| Unlisted | nowhere — a rejected drawing, or a duplicate folded into its survivor (you land on the survivor) | no | moderation |

"Push surfaces" means everything that recommends a lake to someone who did not ask about it: the
drive-time notifications and the 8 pm digest, weather discovery, the recommended strip, bounties
(which ask other people to go somewhere), the weather archive we pay to keep for each lake, and the
enrichment passes that fetch elevation, wind and depth. "Reference surfaces" — the map when you are
looking at that spot, the lake's own page, its reports and hazards, your favourites — are never
filtered: if you went looking, you find it.

---

## Why a lake goes dormant

**Nobody has been on it in three seasons.** Each July, every active lake with no report, no recorded
skate and no hazard since the start of the season three back — and no curated boost, and nobody's
favourite — is set dormant. Three is the number because a lake can miss a warm winter and a lazy one
and still be somewhere people skate. This is the only transition a machine makes on its own, and it
is the cheapest one to undo (below).

**The admission rules changed under it.** When we raise the acreage floor or stop importing a class
of water, the bodies the new rules refuse are set dormant rather than deleted. The drawer says *"no
longer meets the size and type rules for the active map"*. (Before September 2026 these were deleted;
the 102,000 bodies removed by the first floor are gone from the database and live only in the
archives — the request path is how one comes back.)

**A moderator said so.** With a note you read — *"Drained for dam work through 2027"*. Only a
moderator brings these back.

**A moderator found no public access.** Every approach crosses private land. This is the strongest
reason and the one the drawer shows first if several apply; the lake's access section carries the
date and the note. See [no public access](../plans/phases/A06f-no-public-access.md).

A lake can also be **removed** outright — a landowner's request, junk data, a duplicate. That is not
a dormancy: it is a human act with a reason, it never expires, and only a restore reverses it. The
drawer names the reason plainly, including *"Removed from the map at the landowner's request."*

---

## What brings a lake back

**Evidence that someone was there.** Post a report, record a skate that resolves to it, mark a
hazard on it, or place a put-in — any of these re-activates a lake the machine shelved, immediately.
If the lake had been shelved because the rules changed, it also becomes *kept by request*, so the
next import campaign leaves it alone. Every activation is audited and listed on the moderators'
standing page, so a report quietly un-shelving a pond is seen by a person.

**A decision.** A moderator can bring a shelved lake back, confirm public access (which clears a
no-access dormancy *and* any inactivity dormancy — someone who has just established the public may
go there has answered the retention question too), give it a curated boost, restore a removed one,
or admit a request.

**What does not bring it back on its own:** evidence on a lake a *person* shelved. A moderator's
dormancy, a no-public-access ruling and a removal stand until a person reverses them. The resident of
a private lake recording a skate there is not evidence the public may go — their skate attaches to
that lake, the ruling stays.

**Favouriting** a dormant lake does not activate it, but it does *retain* it: a favourite is a person
saying the lake matters, and the July pass leaves a favourited lake alone.

---

## Asking for a lake

Every lake's page offers the asks its standing allows: **Ask for this lake back** (dormant), **There
is public access** (a no-access ruling), **Ask to restore this lake** (removed), and on any lake
**I own this — take it off the map**. One sentence to the moderators; the page reads your ask back
and, later, their answer. You can see how many other people have asked for the same thing.

For water we don't have at all, **long-press it** on the phone or **right-click it** on the web. If
we already hold a lake there — shelved or removed — you land on its page; otherwise you say what it
is and a moderator looks it up in the public hydrography catalogue and adds it with its real
outline. You never draw the shape. A recorded skate over unknown water offers the same path from
the You tab, with the track as evidence.

## What a returning lake gets

Coming back is not just a flag flip. The lake is re-scored with everything it has earned (its
reports, put-ins, depth, contours), its map index rows move back to the browsable zoom, its bays
reappear, it re-enters the weather archive, and it is stamped with the moment it returned. The
enrichment passes — elevation, wind, depth — use that stamp to find lakes that came back since their
last run, so a lake that went dormant before a source was added catches up. Until then the standing
page lists it under *recently activated* with what it is still missing.

---

## How the corpus was partitioned

The first pass (September 2026) kept every body with **evidence of access or use**: a put-in, a
curated boost, any report, hazard, track, favourite, bounty, body feature or hand-drawn bay, an
admission by request, a user-drawn origin, or a mention in the design corpus of community
discussions. Everything else went dormant as *inactive*. A fresh import campaign lands its bodies
active, and the same pass is re-run afterwards to put a new region's unskated ponds to sleep.

The counts are public: the About page shows each state's **known** and **active** bodies.

---

## For moderators

- **Set dormant / bring back**: the lake editor's *Standing* card, with a note skaters read.
- **See what the machines did**: `/admin/water/standing` — five lanes (inactive, rules changed,
  moderator, no public access, removed), newest first, and the list of recent activations with what
  brought each back.
- **Remove / restore** stay on the same card (admin only). Restoring is an activation.
- **Answer requests**: `/admin/water/requests` — approve performs the act (activate, restore,
  remove, confirm access, admit from the catalogue) and closes every sibling ask; decline takes a
  note the skater reads.
- **The July pass** records a run on `/admin/imports` (`standing_rollover`); if it failed, it retries
  daily through July 14.

## For developers

One function decides standing — `standingOf` in `@skating/core` (`standing.ts`) — and one module
moves everything that depends on it — `lib/standing.ts` in the Convex package (`transitionStanding`,
`activateBody`, `demoteBody`, `activateOnEvidence`). Never write `dormant` or `activatedAt` directly.
The constant is `INACTIVE_SEASONS`; the rung is `DORMANT_MIN_VISIBLE_ZOOM`. The regression net is
`standing.test.ts`'s *campaign walk*: one body per standing, through a re-import and both prunes,
asserted to land exactly where the table above says.

## Related

[Where the lakes come from](./water-body-data.md) · [Report lifecycle](./report-lifecycle.md) ·
[Hazard decay](./hazard-decay-and-lifecycle.md)
