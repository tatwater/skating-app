# Open questions

Product-level decisions we're deliberately deferring, with current leanings. This is the **active**
list: a question that gets answered becomes a `D#` in [`01-decisions.md`](./01-decisions.md) and
moves to the pointer list at the bottom. Questions that belong to one phase stay in that phase's
doc (`A07c` § *Open questions*, `A06e` § *Open questions*); ideas that aren't questions go to
[`backlog/`](./backlog/); anything gated on a lawyer or a third party's terms has an `L#` in
[`08-legal-feasibility-checklist.md`](./08-legal-feasibility-checklist.md), which this list points
at rather than repeats.

---

## Still open

### Q8 — Forum / Facebook ingestion (L5)
Auto-ingesting the community's Google Group and Facebook posts into in-app reports would crush
cold-start, and it's the most heavily gated thing in the plan: Google Groups has no clean API and the
groups are members-only, Facebook's Graph API doesn't reach groups and scraping violates its terms,
and turning a person's post into an attributed in-app report is a **consent** question before it's
an access one. The data model has the hooks (`reports.source` / `comments.source` include
`imported`) and the comment-vs-report classifier is spec'd in `04-integrations.md`; nothing is built.
**Direction:** do it legally or not at all.
**What's been done around it:** the one-time *private* corpus extraction (L5a, 🟡) happened —
1,197 posts, stored outside the repo, used only as design input (vocabulary, the `curatedBoost`
seed, and the S1/S2 signals that became D72/D73 and D60). And A06c ships a pre-canned search link
into the regional community for the water body you're looking at (D71): we store nothing and the
skater lands on the community's own site. That's a bridge, not ingestion.
**Still open:** the thing the link can't do — posts becoming in-app reports that feed search, decay
and the feed. **And the other direction (founder, 2026-09-17):** posting a skater's in-app report *to*
their email group on their behalf, opt-in, under their name — so they keep contributing to the
skaters who haven't switched, and the best-organized reports on the list carry Gli's name. Far less
gated (their words, their consent, their list) and mostly mechanical; designed together with the
inbound half so it's one bridge (`04-integrations.md` § Forum / Facebook bridging). **Status:**
inbound desired and unscheduled behind L5; outbound unscheduled, no gate beyond each group's
posting rules.

### Q9 — Machine summaries beyond weather facts (L6)
"Weather since report" is plain facts, no AI (D19), and that boundary has held: the ice-thickness
*estimate* (D160) and the freeze-up dates derived from imagery (D151) both exist, and both ship
**dark, operator-only** — no skater surface, no decision reads them. What stays deferred is
anything that summarizes *human reports* for a skater (an LLM digest of "what people said about
this lake this week") — never predicting or grading, and gated on a liability review of any
sentence that could be read as a safety judgment (L6). **Leaning:** make reports themselves richer
first; a summary of thin reports is a worse product than the reports. **Status:** deferred, no
trigger set.

### Q10 — The legal engagement (L1–L4, L11)
One lawyer engagement clears most of the legal register, and it hasn't started. In scope: the ToS
and privacy policy that supersede the interim [`TERMS.md`](../TERMS.md) / [`PRIVACY.md`](../PRIVACY.md);
whether the assumption-of-risk acknowledgment (D45) is enforceable as written, and the "peer
observation, never a guarantee" framing with it; the minor-data posture (D41, L2); the deletion and
retention wording (D62, L3); the AGPL store exception (D43, L4); and landowner takedown wording
(D48, L11). **Interim guardrails are live** — 16+ gate, versioned server-stamped risk-ack, interim
terms and privacy notice — and cover the friends alpha. **Status:** required before any launch past
the friends alpha; a founder task, not a build.

### Q11 — GPS-path hazard deduction (L9, L14)
If many skaters' paths on the same day detour around the same stretch, that's a signal of an
unreported hazard — a pressure ridge, open water. The legal half was settled 2026-07-24: it runs
over **our own** recorded tracks (Phase 08, D58), so no provider's terms reach it. What's left is
not a legal gate — it's **volume, calibration, and the L14 privacy pass** on inferring anything from
clustered paths. Same for the sibling crowd-intelligence derivations (pressure-ridge and
clearest-side). **Leaning:** don't build until real paths exist to calibrate against; a noisy
hazard inference is worse than none (D3). **Status:** future bet; trigger is path volume.

### Q14 — Donations: the vehicle
*(Opened 2026-09-17, from the vision rewrite.)* The app is not a business and never paywalls a
feature (D35's "later" line; `00-vision` § What this app is not), but skaters who want to should be
able to chip in toward running costs. Settled: optional, one-off or recurring, never tied to
features, never a badge that reads as status (D50's asymmetry applies — money must not buy trust).
**Open: the vehicle.** Leading contender is **buymeacoffee.com** — a link out, nothing to build,
nothing in-app to review against store rules. Alternatives: an in-app one-off or subscription form
on **Polar**, **Stripe**, or similar, if their cut is smaller and the flow is worth owning.
**Two things to check before choosing:** (1) the platforms' cut and payout terms at our scale (tens
of donors, not thousands); (2) **App Store / Play rules on donations** — an in-app payment flow for
"support the developer" can be read as a digital purchase that must go through the store's own
billing at its 15–30% cut, whereas a link out to a web page generally isn't; this is the reason the
link-out is the default. Nonprofit-only exemptions don't apply (L18). (3) **Open-Meteo's free tier
is non-commercial** (L13) — confirm donations don't cross their definition before the vehicle goes
live. **Status:** open; leaning link-out (buymeacoffee) for the alpha, revisit if donor volume ever
makes the cut matter.

### Q15 — The name
*(Opened 2026-09-17.)* The working title is **Gli** — on every user-visible surface since
2026-08-26 (display name, wordmark, permission strings, bundle id `com.teaganatwater.gli`). What's
open is whether Gli is the *final* name: the store listing, a trademark check, a domain, and the
email sender address all wait on that call. **Deliberately not waiting on it:** the infrastructure
identifiers — Convex project `skating-app`, the Expo slug and URL scheme, the `@skating/*` package
scope, the `skating.teaganatwater.com` sending domain — stay generic on purpose, so they're right
under any name and change once, together, if a name is ever registered (founder call, 2026-09-17;
the list is [`backlog/gli-identifiers.md`](./backlog/gli-identifiers.md)). **Trigger:** before the
first store listing — a name change after that is a new listing. **Status:** open, founder's call.

### Q16 — What Québec needs
*(Opened 2026-09-17, from the vision rewrite.)* The vision commits to southern Québec "as soon as
there's a real signal," and the trigger is a demand signal mid-season, not a date. Nothing is
prepped, and the corpus and its pipelines are built on US-only sources in several places, so the
question is *what the first non-US region actually needs* — recorded now so the signal, when it
comes, doesn't start from zero:
- **Weather alerts.** NWS (`api.weather.gov`) is US-only (D74); Québec needs Environment Canada — a
  different API on different terms (`04-integrations.md` § NWS). Open-Meteo itself is global.
- **Hydrography.** NHD, 3DHP, GNIS and 3DEP are US federal and stop at the border. OSM covers Québec;
  what the Canadian equivalents are (national hydrographic and gazetteer datasets, provincial
  bathymetry, a LiDAR-grade DEM) and whether the merge's "one vote per catalog" model gets a second
  vote north of the line is unknown.
- **The region and the basemap.** The region polygon and mask are cut from US Census TIGER
  (`scripts/admin-areas`); a Canadian boundary source is needed for the same cut, and the ETL's
  "New York south of I-84" style refusal needs a Québec equivalent.
- **Language.** Place names, the community's own posts, and the app's copy — whether the app ships
  French, and when.
- **Legal.** Québec's privacy law (Law 25) and consent rules are a separate pass from Q10's US one
  (L17).
**Leaning:** OSM-first for the corpus (it's already how the outline is chosen), Environment Canada
for alerts, and no French copy for the first signal-driven release; the point of this entry is the
checklist. **Status:** open; waits on the demand signal. Alaska (2027-28) is US and needs none of
this — its questions are corpus size and the absence of bathymetry, not sources.

### Q17 — The location anchor: how it looks
*(Opened 2026-09-17, founder ask.)* Every "near" in the app is measured from the device or from the
private home coordinate. A skater planning a weekend somewhere else wants *"within an hour of the
cabin"* — a radius from an address (home, an Airbnb, a friend's), picked on Explore or Latest,
saved for reuse. The idea and what it touches (D11, D18, D20, D159, a geocoder) are in
[`backlog/location-anchor.md`](./backlog/location-anchor.md); the geocoder options are
`04-integrations.md` § Geocoding. **Open — the UX:** where the anchor lives on the two front pages
(the search box? a chip by the filter row?); whether picking one is a session posture or a saved
setting; whether saved anchors sync across devices; and whether notifications ever follow an anchor
or stay on Home (leaning: they stay). **Status:** open; explore with the design pass.

---

## Resolved — pointers

Kept so a `Q#` cited anywhere still resolves. The decision is the record; nothing here re-argues it.

- **Q1 → D12** — No live GPS; opportunistic location on app-open + post-hoc path check. *(D12's
  text still says "after a Strava activity uploads"; since Phase 08 the path is the native
  recorder's — see the D24 amendment.)*
- **Q2 → D13** — Social graph removed 2026-07-15: no follows/friends; reports always public; the
  only privacy switch is profile public/private; minors read-only until 18 (D41). "Whose reports
  do I trust" is answered by the boost-only trust score (D50), not a follow graph.
- **Q3 → D14** — User-created water bodies allowed; the GPS path is the evidence (Phase 08).
- **Q4 → D15** — Waze-style hazard lifecycle (decay + confirmation); weather-driven since D56.
- **Q5 → D16** — Per-type notification toggles (built out in A08, D167–D174).
- **Q6 → D17** — Reward points cosmetic/reputational only.
- **Q7 → D18** — Real drive-time via cached per-user isochrone, radius fallback (Phase 04).
- **Q9 (baseline) → D19** — "Weather since report" = descriptive facts, no AI.
- **Q11 (legal half) → D58 / L7** — deduction runs over our own tracks; the rest of Q11 stays open.
- **Q12 → D36** — User-location dedup: match-on-create (bbox + IoU + name) + soft-tombstone merge.
- **Q13 → D24** — GPS providers, provider-agnostic. **Amended 2026-07-24 (Phase 08 / L7):** the pull
  model is dead; first capture source is the native recorder, Strava is push-only, watch providers
  are deferred adapters.
- **S1 → D72 / D73** — Access is two questions, not one: parking modeled apart from put-ins,
  directions route to the car, access blockers decay like hazards (A06d). *(S1/S2 were the two
  signals from the L5a corpus analysis; both are answered and the section that held them is gone.)*
- **S2 → D60** — Sub-areas with `aliases`, for the ten spellings of Malletts Bay (A02); bays became
  places in their own right in A09.
- **Data model (06) → D21–D25** — comments v1, structured ice thickness, dual rating, GPS-only
  skated extent, units/edits/comment-depth.
- **Auth / hosting / nav → D26 / D27 / D28** — Clerk, Vercel, Map + Newsfeed co-primary (now
  *Explore* + *Latest* in the design; D47 folds Report and Bounties into both on web).
- **Tooling → D39 / D40** — Turborepo monorepo; Vitest + GitHub Actions CI.
- **Privacy / safety → D41 / D42 / D45** — 16+ age gate and derived visibility defaults; EXIF strip +
  geotag opt-in; signup assumption-of-risk ack.
- **License → D43** — AGPL-3.0 + App Store / Play distribution exception.
- **Skate → water body → D44** — GPS activities resolve to a `waterBodyId`.
- **Water-body profile content → D70 / D71** — derived or third-party, never hand-maintained;
  reference links generated at render time, so every body in the corpus has them.
- **Weather providers → D74** — Open-Meteo computes, NWS informs; never blended.
- **Satellite imagery → D75, then D81 / D84** — the blocker was a license question and Copernicus
  answered it; in-app imagery is A06e, where public-domain USGS/NAIP turned out to serve the most
  common use with no quota at all.
- **External links on mobile → D76** — in-app browser (`expo-web-browser`), never a WebView.
