# The deferred register as it stood on 2026-09-16 — archived verbatim

> **Archive.** This is the long-form "Later / deferred" half of `07-roadmap.md` (~1,200 lines: the register intro, *Waiting on a blocker*, and *Design sketches for deferred items*) as it stood before the 2026-09-16 rewrite, kept verbatim. The roadmap now carries a table with one row per item; the items that are still live also have their own `backlog/` docs. Struck-through entries here were already shipped when this was archived.

*Rebuilt 2026-07-25, after a full read of `plans/` against the code with every phase built. Everything
below is deliberately-deferred work, split by **whether we could start it tomorrow**. Two rules for
keeping it honest: when an item ships, strike it here with a pointer (two entries had gone stale and
were silently claiming to be deferred — hazard-footprint clipping and `canPostComments` — so **verify
against code before trusting an entry**); and when a blocker clears, move the item up rather than
leaving it to be rediscovered.*

## Waiting on a blocker

Grouped by *what* is blocking, because that's what determines when it moves.

- **A lawyer (Q10 / L1 — one engagement clears most of this).** Full ToS + privacy policy +
  assumption-of-risk enforceability; the minor-data posture (L2); deletion/retention wording (L3 — the
  A03 *mechanism* is unblocked, only the copy waits); the AGPL App Store / Play exception text (L4); the
  landowner-takedown wording and any obligation to honor requests (L11). Separately legal-gated:
  **forum / Facebook / Google-Group ingestion + republication** (Q8 / L5 — feasibility *and* consent
  *and* ToS); **AI summarization beyond weather facts** (Q9 / L6 — liability review); **PostHog session
  replay** (L12 — masking + minor-exclusion + a `PRIVACY.md` update must land first); **ODbL
  share-alike** (L10 — only bites if we ever publish the derived `waterBodies` extract).
- **External approval queues (weeks).** Garmin / COROS / Polar capture adapters + the watch-wins ingest
  path (L8) — **the roadmap has said "apply now" since Phase 00; confirm whether the applications are
  actually in, because this is the longest pole in the whole register.** Google Health Connect
  additionally needs a Play health-data access review (and a Play account). Additional push targets
  (Whoop) need their own API access.
- **Device access.** Phase 08 verification (Android-emulator GPX playback + a friend's iPhone for iOS
  background/battery parity); the **Layer-3 offline basemap tile-pack**, built flag-off in Phase 09b and
  needing exactly **one** on-device confirmation; real cold-weather battery draw and real
  compass/course-noise behavior (Phase 09b QA). No owned iPhone is the standing constraint — budget for
  a QA gap and stay conservative in the iOS background-mode copy.
- **Push credentials + store credentials.** ~~Remote push delivery — no token registration, no
  APNs/FCM credentials, no server sender.~~ **Built in A08 PR 3 (D174):** token registration, an Expo
  push sender with receipt handling, and email. What remains is the founder's: the FCM key +
  `google-services.json` (Android, now) and the APNs key (iOS, `eas credentials`). **Silent
  background-refresh push to a closed app** (D54) is still deferred: it needs a privacy decision (the
  biggest departure from D12) *plus* accepting that iOS throttles silent pushes at its discretion — a
  shaky base for safety content.
- **The prod cutover.** Convex **prod has never been initialized**, and `convex deploy` stays blocked
  until the **Clerk prod** env vars exist. Then: the multi-state import into prod, the prod tile URL,
  Vercel/EAS env vars, `SENTRY_AUTH_TOKEN` for build-time source maps, and the Resend key + verified
  sending domain (until which operator alerts log-and-skip). TestFlight / Play internal-testing
  distribution to the alpha crew rides on the same accounts. *First step is a founder task, not an
  external wait.*
- ~~**Hazard memory → automated `bodyFeatures` promotion + "potential hazard" surfacing (founder ask,
  2026-07-27).**~~ **→ SCOPED AS A05c (2026-07-30), and the blocker was answered rather than waited out.**
  The gate said *three seasons of in-app hazard rows*; dev holds **one**, so the gate couldn't fire
  before ~2029. The founder call was to **build the engine now with thin patterns admin-only** (D78) —
  which avoids the D3 trap by the gate rather than by the delay, since the trap is showing a *skater* a
  one-winter coincidence, and nothing does that. Deferring would instead have meant three winters of rows
  nobody looked at as a series, and a matching radius tuned from scratch in 2029. See
  [`phases/A05c-hazard-memory.md`](../phases/A05c-hazard-memory.md).
  - **The D62 constraint is closed, and it's worth keeping the record of why it mattered.** Under the
    first amendment a departed user's hazards were *deleted*, so recurrence would have been computed over
    a corpus silently missing rows — a count that looks complete and isn't. Under redact-don't-erase,
    **hazards are kept and anonymized**; only their descriptions go, and the multi-season record survives
    a departure intact. That is the main reason the second amendment matters to the roadmap and not only
    to the deletion flow.
  - **The D3 constraint stands and became D78's copy discipline**: any recurrence claim is **history,
    never a prediction** — "ridges usually form here" and "there is a ridge here" are different sentences
    and only one of them is ours to say. Every public advisory carries both numbers, is past-tense with a
    reporter, and never enters the on-ice payload.
- **Volume + calibration (buildable, but building now is speculative).** ~~Per-body map summary cards~~
  **→ moved into A06c as Workstream 5 (2026-07-30, founder call)**; the density gate that held them here
  is retired by a design rule rather than by waiting — *a body with nothing to say gets no card at all,
  not an empty one* — so they're safe to ship into a sparse corpus. **GPS-path hazard
  deduction** (Q11 / L9 — the *legal* half cleared with the Phase 08 pivot, so what's left is path volume
  plus an L14 privacy pass); pressure-ridge / clearest-side crowd intelligence; ~~non-destructive
  **consensus rendering** of clustered same-type hazards~~ and ~~**auto-merge** of very-high-confidence
  dedup pairs~~ — **both folded into A05c (2026-07-30, D80)**, since the clustering primitive A05c needs
  across seasons is the same one they need within a season; community "same place?" confirmations and the
  re-ETL overlap scan (D36's staged half) stay here;
  **in-app satellite imagery** (moved here from "needs design" by A06c — the licence is settled, what's
  left is whether reads concentrate enough for server-side tile caching to fit the free quota, plus the
  standing Planet cost question); a
  **decay-magnitude refit** of `HAZARD_DECAY` + the `decayMultiplier` magnitudes against a real in-app
  corpus (signs are locked, numbers are tunable defaults); a dedicated bounties **geospatial** instance
  (only past the 200-scan cap); and **self-hosted ORS** for a true 90-min band (a ~$15–50/mo warm
  container — a cost/ops decision, not a technical one).
- **Needs design before it's buildable.** ~~The **satellite imagery layer**~~ **→ resolved by A06c
  (2026-07-30, D75): the licence question is answered** (Copernicus Sentinel data is free/full/open with
  attribution), the deep link ships in A06c, and what's left — imagery rendered *in* the app — moved to
  **Volume + calibration** below, since it's now a cost/traffic call rather than a design one. Still
  here: **in-app guides**;
  **group-skate organizing**; **rivers as named reaches** (the D4 model, deferred since Phase 01 —
  validate still-water with users first). Deliberately *not* doing: **Fitbit** as a provider, the
  **`appConfig`** runtime-tuning seam (edit-and-redeploy is the settled posture), **encoded-polyline**
  transport, and **k-anonymity** contributor gating (dropped by D58).

## Design sketches for deferred items (kept in full)

The long-form write-ups the entries above point at — preserved verbatim, since the *why* is the point.

- **Per-body summary cards on the map at appropriate zoom (founder ask, 2026-07-21).**
  **✅ PROMOTED INTO A06c AS WORKSTREAM E (2026-07-30, founder call — *"it's about time we took care of
  that"*).** Kept in full because the sketch is what A06c's workstream was written from, with three
  changes made at that scoping: **(1)** the card carries **active report counts and types only** — no
  recurrence / "potential hazard" line from A05c, since this surface sits closest to the map where D3
  pressure is highest (asked and answered at A05c scoping, and recorded there as worth revisiting
  deliberately later); **(2)** the **consensus quality** signal below is deferred to that same later
  pass, as the other D3-sensitive half — it is A06c's open question 5; **(3)** the "do this when" density
  trigger is **retired by a design rule instead of by waiting** — a body with nothing to say gets **no
  card at all**, not an empty one, so the feature is harmless in a sparse corpus and simply appears on
  the water bodies people are actually using. The original text follows.

  Today the map
  shows water-body polygons and you must open a water body to learn anything about it. The ask: at suitable
  zoom levels, surface a compact card/label over *unselected* bodies with the at-a-glance basics — water body
  name, recent report count, a general quality consensus, and the most important active hazard types.
  **Deliberately not in Phase 09a** (decided at kickoff): it is a map-browse feature, not a hazard feature,
  and doing it properly would roughly double Phase 09a's backend surface.
  - **Why it's its own piece of work:** it needs *cross-viewport* aggregation over both reports and
    hazards. When this was written that meant the read-cap-fragile geospatial path Phase 09a avoided by
    scoping hazards to the selected body (PR #10/#11). **A01 changed the calculus**: a viewport read is
    now bounded, so the objection is no longer "this reproduces a crash" but the plain cost of
    aggregating per read at viewport scale — which the denormalized-on-write shape below still answers
    better. The per-body scoping decision stands on its own merits.
  - **Likely shape:** a denormalized per-body summary maintained **on write** — the Phase 04
    contribution-counter pattern (`lib/contributionCounts.ts`) generalized. Something like
    `waterBodies.summary { recentReportCount, consensusQuality, topHazardTypes[], updatedAt }`, bumped by
    `reports.create` / moderation transitions / hazard create+confirm, and swept by a cron for time
    decay (the counts are inherently time-windowed, so they go stale without a tick).
  - **Open sub-questions:** what "recent" window; how to derive a consensus quality that never reads as
    an authoritative safety claim (D3 — the same trap as hazard decay); whether the card renders as a
    MapLibre `symbol` layer with data-driven zoom filters or as HTML overlays; and how it interacts with
    `minVisibleZoom`/`displayScore` (D49) so cards don't fight the existing prominence scoring.
  - **Do this when** there's enough report density that a water body summary is non-empty for most bodies in a
    viewport — before that it's mostly blank cards.
- ~~**Harden `waterBodies.listInViewport` against the read-cap crash — multi-cell / bbox-coverage
  geospatial indexing**~~ **✅ SHIPPED as A01 (2026-07-26).** Kept as a pointer because the *root cause*
  is worth remembering: `@convex-dev/geospatial` reads roughly **∝ `maxResults`** (S2 read-ahead over
  the query rectangle's covering), **not** ∝ results returned, so a wide sparse viewport exhausted a
  covering and hit Convex's hard **4,096-reads/query** cap — a crash, not slow paging. Every mitigation
  around it (`MAX_VIEWPORT_LIMIT = 256`, keeping the `listed` filter out of the query, the `isLarge`
  outlier scan) was a workaround for that one property.
  - The fix this entry proposed — "index each body under every S2 cell its bbox covers" — turned out
    **not to be expressible in that component at all**: its write API is one point per unique key. So
    A01 replaced it with a plain-table ladder grid, where reads cost only the rows returned. See
    [`phases/A01-read-path-durability.md`](../phases/A01-read-path-durability.md).
  - Its "do this when" trigger — *the 256 clamp visibly drops bodies at normal zoom* — had **already
    fired and gone unnoticed**: dense eastern Maine holds 513 bodies at z12. That's the lesson worth
    carrying forward more than the mechanism.
- ~~**Clip hazard footprints to the water-body boundary**~~ **✅ SHIPPED in Phase 09b (2026-07-22)** —
  this entry was stale (caught 2026-07-24). `core/hazardGeometry.clipFootprintToBody` precomputes the
  clipped polygon at create time and `hazardLayer` render, bbox and `distanceToHazard` all read the
  *same* stored footprint — which is what the "what's drawn IS what the proximity alert measures"
  invariant required. Kept here only as a pointer; see [`phases/09b-on-ice-alerting.md`](../phases/09b-on-ice-alerting.md).
- **Self-hosted OpenRouteService (true 90-min+ isochrone band).** Phase 04 ships drive-time on the
  **hosted ORS**, whose isochrone API is hardcoded to a **60-min max range** for `driving-car` — so the
  90-min band is a uniform crow-flies radius fallback there. Self-hosting ORS (a memory-hungry JVM/Docker
  service loading an OSM routing graph — **cannot** run on Convex or Vercel; needs a persistent container
  with ~4–8 GB RAM on a small VM: Hetzner/Fly.io/Railway/Render, ~$15–50/mo; Cloudflare **not** required)
  lets us (a) raise the isochrone range for a **real 90-min (and beyond) band**, (b) drop the hosted
  free-tier daily quota + rate limits, and (c) tune the routing profile. Our actual load is trivial
  (isochrones computed only on home-address change, cached per user), so it's a single small **warm**
  instance, not a fleet — the graph build takes minutes, so it stays warm rather than cold-starting per
  request. **Do this when** the 90-min band's accuracy matters or hosted quota bites; until then the
  radius fallback is fine for the outer, aspirational ring. *(Context: Phase 04 discussion 2026-07-17.)*
- *(The one-line entries that used to sit here — forum/Facebook ingestion + comment-vs-report
  classification (Q8), GPS-path hazard deduction (Q11), auto-merge dedup + community confirmations
  (D36), AI summarization beyond weather facts (Q9), the full legal review (Q10), in-app guides,
  group-skate organizing, and Fitbit — now live in **Waiting on a blocker** above, filed under what's
  actually blocking each. Not dropped; sorted.)*
- ~~Satellite imagery layer toggleable in water body detail view. **NOTE: This plan still needs to be explored**
  — and it needs an imagery source whose terms permit the use, which is its own question.~~
  **✅ EXPLORED — and the blocking question is answered (A06c, 2026-07-30, D75).** Kept as a pointer
  because the shape of the answer is worth carrying: *"an imagery source whose terms permit the use"* had
  been treated as an open search, and **Copernicus Sentinel data already satisfied it** — free, full and
  open licence, reproduce/distribute/adapt with attribution. The blocker was never a missing source; it
  was that nobody had checked the one obvious one.
  - **What ships in A06c:** a Copernicus Browser **deep link** per body — zero cost, zero quota, no
    account. Sentinel-2 is 10 m on a ~5-day revisit, which is enough that open water vs. black ice vs.
    snow-covered ice is visually obvious; cloud cover is the limiter, so the link opens a ~14-day window.
  - **The toggle this entry asked for exists, derived** (D70): `satelliteImagery: 'auto' | 'on' | 'off'`,
    where `auto` resolves off surface area, because 10 m pixels cannot resolve a 2-hectare pond. Per-row
    data ⇒ **the admin control needs no redeploy**; only the threshold behind `auto` is a code constant.
  - **What's left, and where it went → [A06e](../phases/A06e-satellite-imagery.md), scoped 2026-07-31** at the
    founder's ask (*"I want to do it ASAP"*). And the scoping pass found that **the quota binds only half
    of it (D84)**: the 10,000-requests/month ceiling is a *Sentinel-2* constraint and says nothing about
    **USGS/NAIP aerial imagery**, which is **public domain, no key, no quota, 0.6 m**. The
    highest-frequency use of a satellite view — read the landscape, find the pull-off, check the
    put-in — is served *better* by 0.6 m summer aerial than by 10 m winter Sentinel-2, **and** it's the
    unconstrained tier. So the toggle ships on Tier 1 now; Tier 2 (dated Sentinel-2 ice imagery, with
    server-side tile caching the open licence permits) keeps the traffic trigger under **Volume +
    calibration**.
  - **The toggle's semantics are settled (D81):** satellite is the map's **only** layer switch, it
    replaces the *base map* rather than the content, and hazards, skate paths and access points stay drawn
    in both modes. Bathymetric contours go with the base map — they're cartographic furniture, and they
    have no toggle of their own.
  - **Planet** stays deferred as a *cost* decision (D75): their public catalogue is the same free data,
    and only PlanetScope (~3 m, near-daily) is new. Full numbers in `05-accounts-and-credentials.md`.
- ~~**Photo-orphan GC cron (cleanup/polish).**~~ **→ folded into A03 (2026-07-27).** The Phase 02a photo
  pipeline uploads before `reports.create`, so failed/abandoned/partial submits can strand storage. The
  client reclaims best-effort (`photos.remove`/`removeBlob`, incl. uploads that resolve after the form
  unmounts), but a killed app or a failed reclaim call can still leave orphans. See
  `phases/02a-map-and-reports.md` → "Settled during review" (2026-07-15).
  - This entry said "low urgency until storage quotas bite", and **the trigger it was waiting for is not
    the one that fired**: A03's account deletion strands a departing user's unattached blobs and emits
    export bundles that need a TTL, so the cron became that phase's own cleanup path rather than a
    quota-driven chore. Worth remembering that a deferred item can be pulled in by a *sibling feature*
    and not by its own stated trigger.
  - Worth remembering too: Phase 07-2 built the `photo_orphans` metric **and** the `photos.by_created_at`
    index expressly to decide whether this cron was worth building — and neither this sketch nor the
    A03 entry knew it existed. It reads 0 on dev because dev holds **0 photos**, so the gate never had
    data to decide with. An evidence gate nobody points at is not a gate.
