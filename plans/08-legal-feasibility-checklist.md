# Legal & feasibility checklist

The register of everything deferred or constrained by a **legal, terms-of-service, consent,
privacy, license, or feasibility** question — so nothing gated gets built by accident, and nothing
gets forgotten. One row per gate (`L#`), each with its status, the guardrail already live, and what
clears it.

> **Not legal advice, and not the review.** The review is **Q10** — one lawyer engagement before
> any launch past the friends alpha, which clears most of the 🟡 rows at once. This is the
> engineering-side tracker.

**What lives elsewhere, on purpose:** the *attribution obligations* per data source are the
register in [`04-integrations.md`](./04-integrations.md) § Attribution (this doc holds only the
gates among them); the *policy narratives* are [`docs/minors-and-age-policy.md`](../docs/minors-and-age-policy.md)
and [`docs/account-deletion.md`](../docs/account-deletion.md); the *accounts* not set up for legal
reasons are in [`05-accounts-and-credentials.md`](./05-accounts-and-credentials.md) § *Not set up,
on purpose*. A row here says *what's gated and why*; the mechanics stay where they're built.

**How to use it.** A change touches a gated area → check the row: ⛔ doesn't ship until the gate
clears; 🟡 ships only if the interim guardrail still holds. A gate clears → flip the status, record
the resolution in one line, and put the decision in `01-decisions.md`. **When the gates apply:**
the friends alpha runs on the interim guardrails; a broad launch needs Q10 done and every ⛔ resolved
or explicitly accepted.

Legend: ⛔ blocked · 🟡 shipped behind an interim guardrail, review still required · 🔬 needs a
feasibility pass before it's even a legal question · 🟢 cleared · ⏸ dormant by design

---

## The register

| # | Gate | Refs | Status | What clears it |
|---|---|---|---|---|
| L1 | ToS, privacy policy, assumption-of-risk enforceability, disclaimers | Q10, D3, D45 | 🟡 | the lawyer |
| L2 | Minor (16–17) data collection and the read-only posture | D41, Q10 | 🟡 | the lawyer confirms the posture; decide whether minors may ever post |
| L3 | Deletion, retention, export — the policy wording | D62, Q10 | 🟡 | the lawyer confirms the wording matches what's built |
| L4 | AGPL §7 App Store / Play distribution exception | D43, Q10 | 🟡 | the lawyer confirms the exception text before any store listing |
| L5 | Forum / Facebook / Google Group **ingestion** — republishing others' posts | Q8, D21 | 🔬⛔ | feasibility → consent model → ToS pass |
| L5a | The one-time private corpus extraction for design | Q8 | 🟢 | done; guardrails held |
| L6 | Machine summaries of human reports | Q9, D160, D151 | ⛔ | a liability review of any sentence a skater could read as a safety judgment |
| L7 | Strava API terms | D24, D58 | 🟢 | read 2026-07-24; push-only, brand kit met |
| L8 | Watch / health-platform provider terms, brand, health-data review | D24 | ⛔ | per provider, at integration; none applied for |
| L9 | Path-cluster hazard deduction over our own tracks | Q11, L14 | 🔬 | volume + calibration + the L14 pass |
| L10 | OSM ODbL share-alike | D5 | 🟡 | bites only if we *publish* the derived database |
| L11 | Landowner takedown — the wording and any obligation | D48, D179, Q10 | 🟡 | the lawyer |
| L12 | PostHog session replay with minors and location | D29 | ⛔ | masking + minor exclusion + `PRIVACY.md` update, before enabling |
| L13 | Data-source license conditions — Open-Meteo non-commercial; radar sources' size-dependent terms | D158, Q14 | 🟡 | stays plainly non-commercial; re-read at scale |
| L14 | Aggregate / heatmap privacy for our own tracks | D41, D42, D58 | 🟡 | built (Phase 08); device verification owed; derivations need their own pass |
| L15 | AGPL §13 network-service obligation | D157 | 🟢⏸ | dormant unless we run AGPL code as a service |
| L16 | Datasets with no published terms — ALSC, NYSDEC CSLAP | D130 | 🟡 | credited, never assumed permissive; ask if it ever matters |
| L17 | Privacy law outside the US — Québec Law 25, PIPEDA | Q16 | 🔬 | a separate pass before the first non-US region |
| L18 | Donations vs. app-store billing rules | Q14 | ⛔ | choose the vehicle; a link-out avoids the store's cut and review |
| L19 | Email compliance — unsubscribe, sender identity, postal address | D174, Q10 | 🟡 | one-click unsubscribe built; the lawyer confirms the rest |

---

## L1 — ToS, privacy, assumption of risk (Q10) 🟡
The umbrella. A safety app's terms have to survive the *"peer observation, never a guarantee"*
framing (D3) and the assumption-of-risk acknowledgment (D45) being enforced as written.
- **Live:** interim [`TERMS.md`](../TERMS.md) and [`PRIVACY.md`](../PRIVACY.md); the 16+ gate;
  a versioned, server-stamped risk-ack (`RISK_ACK_VERSION`) that re-prompts on change.
- [ ] Lawyer engaged. [ ] Final ToS + privacy policy supersede the interim files. [ ] Risk-ack
      wording reviewed; bump the version if it changes.

## L2 — Minors, 16–17 (D41) 🟡
Under-13 is avoided by construction; 16–17 are still minors and we store DOB. The posture — minors
are read-only, profile forced private, DOB scrubbed on deletion, minor status derived at read time —
and everything it would take to open participation up is
[`docs/minors-and-age-policy.md`](../docs/minors-and-age-policy.md).
- [ ] Lawyer confirms collection + retention for our regions (US state law, GDPR ages, the UK code).
- [ ] Decide whether minors may ever post public reports (a one-line flip if cleared).
- [ ] Confirm no parental-consent flow is needed at 16+.

## L3 — Deletion, retention, export (D62) 🟡
Built and decided: the request *is* the deletion; three buckets (erased / redacted at 30 days /
anonymized); a 30-day login grace; a JSON export. [`docs/account-deletion.md`](../docs/account-deletion.md).
The **wording** in the terms and privacy policy waits on Q10.
- [ ] Lawyer confirms the three-bucket model and windows. [ ] Export contents meet portability
      obligations (no tokens, nothing of other users').

## L4 — AGPL §7 store exception (D43) 🟡
Drafted in [`LICENSE-EXCEPTIONS.md`](../LICENSE-EXCEPTIONS.md); sole-copyright-holder keeps it
clean. ⚠ Distinct from L15 — this is *distributing our client* through stores whose terms conflict
with AGPL; L15 is *running someone else's* AGPL code.
- [ ] Lawyer confirms the text before any store listing (which also waits on the name, Q15).

## L5 — Ingesting the community's posts (Q8) 🔬⛔
Turning Google Group / Facebook posts into in-app reports: no clean API, members-only groups, and
a **consent** question before an access one. The data model holds `imported` as a source; nothing is
built. Direction and status: [`02-open-questions.md`](./02-open-questions.md) § Q8.
- [ ] Feasibility: authorized access to the specific groups. [ ] A consent model a lawyer blesses.
      [ ] ToS pass on the access method. [ ] Only then a phase.
- **Not gated:** the *outbound* bridge — posting a skater's own report to a list they belong to,
  opt-in, under their name ([`backlog/email-group-bridge.md`](./backlog/email-group-bridge.md)).
  Their words, their consent, their list; each group's posting rules are the only constraint.
- **Not gated:** the D71 search link into the community's own archive — we store nothing.

## L5a — The private corpus extraction 🟢 done
Learning from the group's history as design input is not republishing it. Done: 2,472 messages
(three seasons, re-parsed 2026-09-19), in `training_data/` (gitignored), used only for derived
findings — vocabulary, the boost seed, the access / sub-area signals that became D72/D73 and D60,
and A10's report-corpus classification. Stays private and PII-aware; re-runnable by the founder's
own membership. **What "private" means since 2026-09-18:** every message went through Claude
(Sonnet for the field labels, Haiku for the mention inventory) under Anthropic's API terms; only
the derived labels and counts are kept in the tree, no message text leaves `training_data/`, and
nothing is republished. D200's replay of the corpus happens only on a private, disposable Convex
deployment — testing, not publishing (a third *Not gated* case for L5 above).

## L6 — Machine summaries of human reports (Q9) ⛔
"Weather since" is facts, not AI (D19). Two derived estimates exist and ship **dark, operator-only**
— the ice-thickness instrument (D160) and imagery-derived freeze-up dates (D151) — which is the
boundary holding. Anything that summarizes *reports* for a skater waits. **Outside this gate by
its shape (D196, A10):** the author-side extraction that reads a skater's *own* prose into fields
they review and claim before posting — the author is the claimant, nothing is summarized *for* a
reader. Recorded here so the lawyer sees the line the decision drew.
- [ ] Liability review of any generated sentence that could read as a safety judgment (D3).

## L7 — Strava API terms 🟢 (read 2026-07-24)
Cross-user display of Strava data is forbidden even when public; AI/ML use is banned. So: **no
pull, ever**; tracks are recorded here (or imported by the skater) and **pushed** with
`activity:write`. The binding privacy constraint moved to us (L14). Full read:
[`research/native-track-capture-and-strava-push.md`](./research/native-track-capture-and-strava-push.md).
- [~] Brand kit on the connect / push surface (mobile-only today; `@skating/core/strava.ts`) — the wording and color, yes; the official button asset is still owed (register).
- [x] The consent explainer says we upload on the skater's behalf and never read back.
- [ ] Re-check the brand kit if a web connect surface is added.

## L8 — Watch and health-platform providers (D24) ⛔
Garmin / COROS / Polar partner terms and brand; HealthKit entitlement; Health Connect's Play
health-data review. No applications submitted (2026-09-17) — [`backlog/partnerships.md`](./backlog/partnerships.md).
- [ ] Per-provider ToS + brand checklist when each adapter lands. [ ] Play health-data review.
- **Not gated:** GPX import — a skater's own export file is not a provider integration.

## L9 — Hazard deduction from clustered paths (Q11) 🔬
Runs over our own tracks, so no provider's terms reach it; what's left is volume, calibration, and
the L14 privacy pass on *inferring* anything from clustered paths. Not before real paths exist.

## L10 — OSM ODbL share-alike (D5) 🟡
Attribution is met on every map view. Share-alike bites only on *redistributing* the derived
`waterBodies` database; in-app display is a Produced Work. The public region `.pmtiles` on R2 is
Protomaps' own ODbL build, clipped by tile and served unmodified — a copy on a public bucket, under
the license it already carries; one sentence for the lawyer, not a gate.
- [ ] If the extract is ever published, publish it under ODbL (wording with Q10).

## L11 — Landowner takedown (D48, D179) 🟡
Built: the reversible soft-delist (Phase 01), the `takedown` request kind and moderator queue
(A07b), and the no-public-access ruling (A06f). The **wording** and whether there's an *obligation*
to honor a request wait on Q10.
- [ ] Lawyer confirms the policy and the intake wording.
- [ ] Hardening: a suppression list so a removed body can't be re-created from a track (D48 edge).

## L12 — PostHog session replay (D29) ⛔
Ships off, never for `isMinor`, starts only after the profile resolves. Not wired at all today
([`backlog/posthog.md`](./backlog/posthog.md)).
- [ ] Input masking on (coordinates, PII); minor exclusion verified; `PRIVACY.md` updated — before
      enabling in prod.

## L13 — Data-source license conditions 🟡
The full attribution table is `04-integrations.md` § Attribution; the rows that are *gates*:
- **Open-Meteo's free tier is non-commercial.** A condition, not a courtesy, since A06h runs a
  corpus-wide cron on it. It's one of D158's three triggers for the paid plan, and the only legal one.
  ⚠ **Q14's donations must not turn the project "commercial"** in Open-Meteo's sense — check their
  definition before the donation vehicle goes live; a $319/yr plan is the fallback.
- **Radar (A06h §6, unbuilt):** RainViewer's free tier is *"personal, educational, small-scale
  community use"* with mandatory credit — a size-dependent license to re-read past ~1,000 users;
  the Iowa Environmental Mesonet is academic courtesy (cache and proxy, never point clients at
  it); NWS/MRMS is public domain. Applies when the workstream lands.
- **Copernicus** attribution is required and rendered (`copernicusCredit`, both clients) 🟢 —
  ESA's form is "Contains modified Copernicus Sentinel data"; the rendered string drops "Contains
  modified" (register: *Data credits the apps don't render*).
- **Synoptic / MesoWest** (the station-bias study, `backlog/weather-stations.md`): read the free
  tier's terms before registering — an AGPL non-university app may not fit them.
- **Lake Stewards of Maine** ice-in / ice-out data (A06e PR 4): "©", no license — validate our
  phenology against it freely; ask before republishing any of it.

## L14 — Privacy of our own aggregate tracks (D58) 🟡
The L7 pivot made *our* privacy model the only one protecting skaters. Decided and built
(Phase 08, `gpsActivities.listTracksForBody`, each gate convex-tested): **publish-is-consent** (no
k-anonymity), minors out by construction, put-in-gated endpoint clipping, a person-level opt-out on
both surfaces, decay with the report and never to zero. Still 🟡 for two reasons:
- [ ] Device verification of the aggregate layer (the roadmap's *Owed*).
- [ ] The derivations over it (L9) need their own pass; the substrate rules still govern them.

## L15 — AGPL §13 for a service we run (D157) 🟢⏸
Running a *modified* AGPL program as a network service obliges us to offer its source to the
service's users. D157 borrows LibreWXR's approach and deploys none of its code, so nothing applies.
Flips to 🟡 if we deploy LibreWXR, vendor AGPL code into the cutter, or adopt any AGPL component in
a server role. Cheap to satisfy if it ever bites — our own code is AGPL — the trap is deploying
without noticing. For our *own* §13 obligation the About screens' link to the public repository is
the source offer.

## L16 — Datasets with no published terms 🟡
- **Adirondack Lakes Survey** (D130): no terms anywhere on the site, a blanket `robots.txt`
  disallow, an invalid certificate. Founder call 2026-08-08: scraped **once**, serially, with an
  identifying User-Agent, archived so it never repeats; credited as the source; depth only (the
  coordinates are pre-GPS and unused).
- **NYSDEC CSLAP:** the hosting item's `licenseInfo` and `accessInformation` are both empty.
  Credited, never assumed permissive.
- **LAGOS-US DEPTH** is *not* in this row — its rights are recorded as CC BY 4.0 in
  `depthSources.ts`, and the fetcher refuses to run if the served statement differs.
- [ ] If either source ever objects, or before a broad launch if the lawyer wants it: ask.

## L17 — Privacy law beyond the US (Q16) 🔬
Québec's Law 25 and PIPEDA are a separate consent and privacy pass from Q10's US one, and the
first thing a Québec expansion needs after data sources. Not started; triggers with the demand
signal ([`02-open-questions.md`](./02-open-questions.md) § Q16).

## L18 — Donations vs. store billing (Q14) ⛔
An in-app "support the developer" payment can be read by Apple and Google as a digital purchase
that must run through store billing at their cut, and can draw review; a link out to a web page
generally isn't. This is why Q14 leans to a link-out (buymeacoffee). Nothing ships in-app until the
vehicle is chosen with this in mind — and see L13 for the Open-Meteo side of the same decision.

## L19 — Email compliance (D174) 🟡
Built: one-click unsubscribe (`List-Unsubscribe` + `-Post` headers, a per-person secret, honored
before the next send); mail only for the types a person opted into; the sending domain is
CNAME-verified. For the lawyer with Q10:
- [ ] Whether the digest counts as commercial mail under CAN-SPAM (which would require a physical
      postal address in every footer) or as transactional/relationship mail.
- [ ] Sender identity wording in the footer once the name is final (Q15).
