# Legal & feasibility checklist

A single register of everything we've **deferred behind a legal, ToS, consent, privacy, or
feasibility question** — so nothing legal-gated gets silently built, and nothing gets forgotten.
Each item cross-references its decision (`D#`) / open question (`Q#`) elsewhere in `/plans`.

> **This is not legal advice, and this doc is not the legal review.** The actual review is **Q10**
> (a real lawyer, before broad launch). This is the *engineering-side* tracker: what's gated, why,
> what question must be answered before it can ship, and what interim guardrail (if any) is already
> in place. When an item clears, note the resolution here and move the decision to `01-decisions.md`.

## When the gates apply

- **Friends alpha (now):** interim guardrails only (age gate, risk ack, temporary privacy notice).
  Everything in this doc is either deferred entirely or shipped in a form that doesn't need the
  full review yet.
- **Broad / public launch:** the **Q10 legal review** must clear first, and every ⛔ item below
  must be resolved or explicitly accepted.

## Status legend
- ⛔ **Blocked** — do not build/enable until the question is answered.
- 🟡 **Shipped with interim guardrail** — live in a limited/safe form; full review still required.
- 🔬 **Feasibility-gated** — needs a research/feasibility pass before it's even a legal question.

---

## Summary register

| # | Item | Refs | Status | Gate before it can ship |
|---|---|---|---|---|
| L1 | Full ToS / assumption-of-risk / disclaimers / privacy policy | Q10, D3, D45 | 🟡 | Lawyer review |
| L2 | Minor (16–17) data collection — DOB as sensitive PII | D41, Q10 | 🟡 | Lawyer confirms minor-data posture |
| L3 | Account deletion / retention / export policy wording | D33, Q10 | 🟡 | Lawyer confirms policy text |
| L4 | AGPL App Store / Play distribution exception wording | D43, Q10 | 🟡 | Lawyer confirms §7 exception text |
| L5 | Forum / Facebook / Google Group **ingestion** (republish) | Q8, D21 | 🔬⛔ | Feasibility + consent + ToS pass |
| L5a | One-time **private corpus extraction** (design input only) | Q8 | 🟡 | Access legitimately; keep private; PII care |
| L6 | AI summarization beyond weather facts | Q9, D21 | ⛔ | Liability review + source-ToS pass |
| L7 | Strava 2024 API terms — cross-user path display, AI, branding | D24 | 🔬⛔ | Read current Agreement before building |
| L8 | Other GPS provider ToS / brand / health-data review | D24 | ⛔ | Per-provider terms at integration time |
| L9 | Strava-path hazard **deduction** | Q11 | 🔬 | Volume + privacy pass (future bet) |
| L10 | OSM **ODbL share-alike** if we publish the derived DB | D5 | 🟡 | Only bites if we redistribute the extract |
| L11 | Landowner takedown wording / obligation | D48, Q10 | 🟡 | Lawyer confirms takedown policy |
| L12 | PostHog session replay (minors + location) | D29 | ⛔ | Masking + minor-exclusion + PRIVACY update |
| L13 | Weather (Open-Meteo) attribution | 04-integrations | 🟢 | Minor — attribution appreciated |

---

## L1 — Full ToS / assumption-of-risk / disclaimers / privacy policy (Q10) 🟡
The umbrella legal review. This is a **safety app**, so how reports are framed in-UI (never
"safe/good to go," D3), the assumption-of-risk language (D45), data retention, and disclaimers all
need real legal sign-off before broad launch.
- **Interim guardrails already live:** temporary `PRIVACY.md`, interim `TERMS.md`, signup **age
  gate (16+, D41)**, blocking **assumption-of-risk acknowledgment** (D45, versioned + timestamped
  server-side).
- **Before broad launch:** lawyer confirms ToS + privacy policy + the enforceability of the
  assumption-of-risk framing; confirm the "peer observation, never a guarantee" framing holds up.
- [ ] Lawyer engaged for the Q10 review.
- [ ] ToS + privacy policy finalized (supersede the interim `TERMS.md`/`PRIVACY.md`).
- [ ] Assumption-of-risk wording reviewed for enforceability; bump `RISK_ACK_VERSION` if it changes.

## L2 — Minor (16–17) data collection (D41) 🟡
Min age is **16**, so under-13 COPPA is avoided by construction — but **16–17-year-olds are still
minors**, and we now **store DOB** (sensitive PII, D41). Various regimes may still apply (this is a
question *for the lawyer*, not an assertion): US state privacy laws, GDPR's digital-consent age
(16 default, varies 13–16 by member state), the UK Age Appropriate Design Code, etc.
- **Interim posture:** minors are **read-only** — since all reports are public (D13), a minor
  **cannot post reports** (server + client enforced), so we never broadcast a known minor's
  location; their profile is forced private (D41). DOB is treated as sensitive PII (**scrubbed on
  deletion**, D33); minor status is derived at read time (self-corrects at 18). **This read-only
  stance is an interim guardrail, revisitable here:** if the review clears public minor posting, it's
  a one-line flip.
- [ ] Lawyer confirms the minor-data collection + retention posture for our target regions.
- [ ] **Decide whether minors may post public reports at all** (currently no — read-only until 18).
- [ ] Confirm whether we need parental-consent flows anywhere we operate (likely not at 16+, but ask).
- [ ] Confirm DOB storage vs. minimization trade-off (D41's deliberate relaxation of D11) is defensible.

## L3 — Account deletion / retention / export (D33) 🟡
Product behavior is **decided** (anonymize-don't-erase past reports — all public, D13; scrub PII;
JSON export bundle). The **policy wording** waits on Q10.
- [ ] Lawyer confirms the anonymize-don't-erase approach + retention windows.
- [ ] Confirm export contents (no secrets/tokens) meet any data-portability obligations.

## L4 — AGPL App Store / Play distribution exception (D43) 🟡
The GPLv3 §7 "additional permission" (App Store exception) is drafted in `LICENSE-EXCEPTIONS.md`.
Sole-copyright-holder makes it clean, but the **wording is legal-gated**.
- [ ] Lawyer confirms the §7 exception text before any public/store distribution.

## L5 — Forum / Facebook / Google Group ingestion — *republish* (Q8) 🔬⛔
Auto-ingesting Google Group + Facebook posts into **in-app reports/comments** would crush
cold-start — but it's the most heavily gated thing in the whole plan. **Deferred indefinitely; not
in any numbered phase** (roadmap "Later / deferred"). The data model has the hooks
(`reports.source`/`comments.source` include `imported`) and the D21 comment-vs-report AI classifier
is spec'd, but the pipeline isn't built.
- **Feasibility blockers (research first):**
  - **Google Groups:** *no clean API*; consumer groups can't be exported programmatically; many are
    members-only (auth). Scraping the web UI is a ToS gray area.
  - **Facebook:** Graph API access to groups is heavily restricted; scraping violates ToS.
- **Consent / attribution:** turning a person's forum post into an attributed in-app report raises
  real consent questions — this is the crux, separate from access mechanics.
- **AI terms:** if an LLM summarizes/classifies ingested content, clear the *source's* ToS (this AI
  runs on forum/email content, **not** Strava data, so it's outside Strava's AI terms — but still
  gated).
- [ ] Feasibility pass: can we get *authorized* access to the specific groups the community uses?
- [ ] Consent model: opt-in from post authors, or an attribution+opt-out approach a lawyer blesses?
- [ ] ToS pass on the chosen access method (Google Groups + each Facebook group).
- [ ] Only then: promote to a numbered phase, building on `imported` source + the D21 classifier.
- **Do NOT set up** a Meta/Facebook dev app yet (`05-accounts-and-credentials.md` "Deferred").

## L5a — One-time *private corpus extraction* for design (Q8, distinct from L5) 🟡
**Materially different, and much lower-risk than L5.** Using last year's group emails as a
**private, internal design input** — to learn the real report vocabulary, conversation shapes, and
a ranked list of popularly-reported water bodies — is *learning from* the data, **not
republishing** it. This is a reasonable, valuable step; L5's consent gate is about *publishing*
others' words in-app, which this doesn't do.
- **Guardrails that keep it clean:**
  - **Access it legitimately** — prefer exporting **your own received email** via **Google Takeout**
    (Mail → `.mbox`) if you're a member, over scraping the Groups UI. See the "how" note below.
  - **Keep it private** — the corpus has real names, emails, and location patterns (PII). Store it
    outside the repo (never commit it), secured; don't feed it wholesale into third-party services.
  - **Design input ≠ seed content.** Findings (vocab, a ranked water-body list for `curatedBoost`
    seeding, D49) are fine to act on. Turning actual posts into visible in-app reports is L5 (gated).
- [ ] Extraction done via a legitimate export path (Takeout of own mail / Workspace admin export).
- [ ] Corpus stored privately, PII-aware, out of version control.
- [ ] Outputs used are *derived insights*, not verbatim republished posts.

## L6 — AI summarization beyond weather facts (Q9) ⛔
Baseline "weather since report" is plain facts (D19, no AI). Anything further (LLM summarizing
multiple human reports) is deferred: **never predict actionable go/no-go** (liability, D3), and
constrained by Strava AI terms if Strava-sourced data is involved.
- [ ] Liability review of any AI-generated summary that could be read as a safety judgment.
- [ ] Source-ToS pass (esp. Strava) if the input includes provider data.

## L7 — Strava 2024 API terms (D24) 🔬⛔
The **biggest ToS risk to a core mechanic.** Strava's 2024 Agreement restricts **displaying one
user's Strava data to other users** — which is exactly showing a Strava-sourced GPS *path* on the
shared public map. Also restricts **AI use** and mandates **"Powered by Strava"** branding +
storage/retention limits.
- **Our stance (D24):** show a Strava path cross-user *only if terms allow*; if not, source the
  same path from a provider whose terms permit it (Garmin/on-device) and nudge users to connect it.
  **Native reports never require a GPS path**, so we're never blocked from shipping.
- [ ] Read the *current* Strava API Agreement + brand guidelines before building path ingestion.
- [ ] Decide cross-user path display per the then-current terms.
- [ ] "Powered by Strava" UI checklist (see `04-integrations.md`) met wherever Strava data appears.

## L8 — Other GPS provider ToS / brand / health-data review (D24) ⛔
Garmin / COROS / Polar (partner-program terms + brand) and Apple HealthKit / Google Health Connect
(on-device; Google Play **health-data access review** for sensitive permissions). Each has its own
brand terms and data-use limits.
- [ ] Per-provider ToS + brand checklist at the point each integration lands (Phase 8).
- [ ] Google Play health-data access review for Health Connect permissions.

## L9 — Strava-path hazard deduction (Q11) 🔬
Future bet: many skaters detouring around the same stretch = a possible unreported hazard. Noisy +
needs volume + privacy care. Logged, not committed.
- [ ] Revisit once there's path volume; privacy pass on inferring hazards from clustered paths.

## L10 — OSM ODbL share-alike (D5) 🟡
Attribution ("© OpenStreetMap contributors") is a build-time criterion **already met** on the map.
The share-alike bite is only on **redistributing the derived `waterBodies` database** — displaying
it in-app is a "Produced Work" (attribution suffices).
- [ ] If we ever *publish* the derived extract, do so under ODbL (full wording legal-gated w/ Q10).

## L11 — Landowner takedown wording / obligation (D48) 🟡
The takedown **mechanism** shipped in Phase 1 (reversible soft-delist + audit). The **request
intake** rides with Phase 7. The exact **wording/obligation** is legal-gated (Q10).
- [ ] Lawyer confirms takedown policy + any obligation to honor requests + the intake wording.
- [ ] (Future hardening) teach dedup to honor a suppression list so a removed pond can't be
      re-created as a user body (D48 deferred edge).

## L12 — PostHog session replay: minors + location (D29) ⛔
Session replay ships **OFF** and is **never recorded for minors** by construction. Before enabling
for adults: input/text **masking** on (mask location UI so coords/PII don't leak), start recording
only **after auth resolves AND `isMinor === false`**, and **update PRIVACY.md** first.
- [ ] Masking configured; minor-exclusion verified; PRIVACY.md updated *before* enabling in prod.

## L13 — Weather attribution (Open-Meteo) 🟢
Open-Meteo is free with no key; attribution is appreciated. Minor, but note it wherever the
weather-since strip appears (Phase 10).
- [x] Open-Meteo attribution shown on the weather-since strip. *(Done — Phase 10, PR #23; `WeatherStrip` on web + mobile.)*

---

## How this doc is used
- **New feature touches a gated area?** Check here first; if it's ⛔, it doesn't ship until the gate
  clears. If 🟡, confirm the interim guardrail still holds.
- **A gate clears?** Record the resolution here, promote the decision to `01-decisions.md`, and flip
  the status. This doc stays the running "what's still legally open" view.
- **Q10 legal review** is the event that clears most 🟡 items at once — schedule it before broad
  launch, after the friends POC.
