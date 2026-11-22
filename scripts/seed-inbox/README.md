# `@skating/seed-inbox`

Fills **dev's** Inbox with realistic work, and clears it again — B01-5's seed (D287, the
*Inbox* design's *The seed*). Eight fake people, every one with a **"Test-"** last name and no Clerk
account, file flags, access reports, asks, drawn bodies and tickets through the **same public
mutations a skater's app calls**, signed as themselves; the moderator acts a seeded history needs
(a hide, a removal, a ruling, a suspension, a ban, a lift, a pin, a decline) go out as you. Every
row goes through the real writers, audit rows and Inbox hooks.

**Nothing real is decided, closed or changed.** Every moderator act lands on something the seed
itself filed. The bodies an ask or a ruling needs in a particular state are the seed's own drawings,
approved and put in that state by the operator: *Town Beach Pond* ruled accessible (then disputed),
*Posted Farm Pond* ruled to have no public access (then contested), *Quiet Hollow Pond* shelved by
hand (then asked back), and *Beaver Flowage* removed by an approved takedown (then asked to be
restored) — so the plan never depends on dev holding a real body in any state. Real
bodies are only the *subject* of fake people's filings (a report, an access report, an ask), which
store nothing on the body itself; the derived figures those filings move — a body's card, its Bodies
library row and counts, its geometry neighbors — are re-derived by dev's crons after the clear.

The plan lives on the server, in `packages/convex/convex/inboxSeed.ts`: `inboxSeed:state` says
which steps are done (each found by a stable seed key — never by counting), which are ready, and
which can't be filed on this deployment. This script files what is ready and asks again.

## Never contacted, never on prod

- A fake person is never emailed, pushed, synced to Clerk or mailed about: `lib/seedPeople`'s
  `isSeedProfile` is asked by every sender (D287), and nothing a fake person does pages an operator.
- Dev only: the script refuses any target but a `dev:` deployment, and every `inboxSeed` function
  refuses any deployment but dev's own URL.

## Running it

**Node 26** (the repo's `.node-version`). On another major the script says so and stops — pnpm prints
an *Unsupported engine* warning on every `convex run`, and the seed refuses to guess past it.

```bash
# 1. The plan, against dev. Writes nothing.
pnpm --filter @skating/seed-inbox seed

# 2. File it, as yourself: your own Clerk user id, and you must be an **admin** on dev — the seed
#    approves a takedown ask, which removes a body. The script checks this before it writes anything.
CONVEX_RUN_AS=<your Clerk user id> pnpm --filter @skating/seed-inbox seed --apply

# Again: files nothing new (`filed 0`).

# 3. What the clear would remove, then remove it.
pnpm --filter @skating/seed-inbox seed --clear
pnpm --filter @skating/seed-inbox seed --clear --apply
```

Each writing run leaves a run log in `runs/` (gitignored): what it filed, each step's result (or the
server's own sentence when a step was refused), and the plan as it ended.

**What a full apply leaves** (90 steps, `unavailable 0`): 23 open Inbox items — Safety 2, Access
reports 2, Requests 6, Places asked 3, Drawn bodies 1, Content flags 5, Support 4 — and 12 decided,
every decision word among them (hidden, removed, dismissed, unpinned, restored; an ask approved and one
declined; four drawings approved and one rejected).

**Reading the dry run.** `body <role>` lines name the five real bodies the seed files *about* — Mascoma
Lake, Caspian Lake, Lake Morey, Tomhannock Reservoir, Newfound Lake — found by name in the Bodies
library. A blank name means this deployment holds no listed, active body by that name; the steps
filed about it show as `unavailable`, and nothing else is affected. Every other body the plan needs is
its own.

**Checking the lanes from the CLI** (after an apply): `inbox:lanes` takes the console's local
midnight, so pass one — `pnpm --filter @skating/convex exec convex run inbox:lanes
'{"now":<ms>,"dayStart":<ms>}' --identity '{"subject":"<your Clerk user id>"}'`, with `dayStart`
within the 36 hours before `now`.

**What the clear deletes that a real person wrote:** anything on seeded content — a comment on a fake
report, a flag on one, a thumb, a hazard vote — goes with that content, by design, as the author's own
delete would take it (the comment count it added comes off their profile; the points it earned move
back). Nothing else of a real person's is touched.

The clear leaves three anonymous counters as they are (`textLengthEvents`, `externalApiCalls`,
`metricSnapshots`): counts only, no row of which names a person or holds a word.

## What it costs in metered calls

- **A full apply:** 3 calls to USGS 3DHP (`hydro.nationalmap.gov`, the catalog lookup each of the three
  `admit` asks schedules) — no quota of ours, a public service. **No Open-Meteo call:** every seeded
  report carries the skater's own conditions, so none schedules the weather auto-fill, and the
  contradiction settle reads stored weather only. While the seed is loaded, its one approved body that
  stays (*Town Beach Pond*) is an active body, so dev's weather crons may fetch its cell like any
  other's — at most one cell against dev's Open-Meteo allowance (the meter on Machinery's cost ledger).
- **A second apply, a dry run, and the clear:** none.
