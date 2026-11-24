# Minors & age policy

Every choice we've made about users under 18 — that for now there are none, what the app does
with an under-18 account if one exists, and what it would take to let younger skaters in. This is
a **product + policy** doc, not legal advice: where it touches law it flags questions *for
counsel*, it doesn't answer them.

> **Who this is for.** Anyone building a feature that a minor could touch, anyone weighing the
> "let 16+ in" question, and anyone expanding to a new region who needs to know the age rules
> aren't as portable as they look. The enforcement lives in `packages/core/src/age.ts` (the pure
> math) and the Convex mutations that call it — at sign-up, `consent.acceptTerms`, where *Record
> acceptance* creates the profile (D41, D294, D298).

---

## The stance in one paragraph

**Gli is 18 and over (D294).** Nobody under 18 can create an account, so everyone who accepts the
terms and the assumption of risk is of age to accept them. That is the whole reason for the line:
an agreement a minor makes is the weakest part of a posture that rests on the skater taking
responsibility for their own choices. Until 2026-11-22 the minimum was 16, with 16- and
17-year-olds let in **read-only** (D41). That design is described below and is **still in the
code**, applied to any under-18 account that exists, because bringing the minimum back down
should be a constant and a policy decision, never a rebuild. Whether it comes down is a question
for counsel, not a plan.

---

## Two age lines, both derived from date of birth

We store a single `dateOfBirth` (UTC-midnight epoch ms) and **derive** everything from it (D41).
Nothing is stored as "isMinor" and nothing runs on a birthday — age is computed at read time, so
the transitions happen automatically:

| Line | Constant | Meaning |
|---|---|---|
| **18** | `MINIMUM_SIGNUP_AGE` | Hard floor (D294; 16 under D41). Under-18 accounts are not permitted at all. |
| **18** | `ADULT_AGE` | Age of majority. Below it, the protective defaults below apply. |

The two lines are the same number today, so **no new account is ever a minor**. They stay two
constants because they answer different questions (who may sign up; who is protected), and a
lower minimum would move only the first.

Two subtleties worth knowing, both about *which direction we err*:

- **The signup gate errs toward refusing.** It's evaluated at `now − MAX_UTC_OFFSET_BEHIND_MS`
  (12 h, the widest real timezone offset west of UTC), so someone is admitted only once they are
  18 on *every* calendar, whatever timezone their device reports. The gate is what lets the terms
  be accepted by an adult, so a self-attested birthday is never read generously; the cost is a
  wait of at most half a day into an 18th birthday. (At 16 the gate erred the other way, toward
  admitting, because that line was about service obligations.)
- **The 18 minor-status check runs on plain UTC**, with no cushion. Anyone the gate admits is
  already an adult by this clock, which runs ahead of the gate's; `age.test.ts` holds that as a
  property. For a row that is a minor, the protective defaults persist past 18 anyway (a birthday
  never *widens* anything already set), so a sub-day skew removes no protection early.

Because age is derived, **the 18th-birthday transition is automatic** — no re-attestation, no
scheduled job. But see [the one-way rule](#the-18th-birthday-nothing-widens-silently) below: the
transition *lifts* restrictions, it never silently *exposes* anything.

> **Everything from here to "Regional compliance" describes the under-18 rules as built.** With
> the minimum at 18 they apply to no account that onboarding can create: dev held no under-18
> account when the minimum was raised, and production has never been initialized. They are kept,
> and kept under test (`profilesMinorSignup.test.ts` runs onboarding with the gate held open), as
> the starting point for a lower minimum.

> **Caveat: age is self-attested.** We take the user's word for their date of birth. There is no
> identity/age verification, and this doc doesn't claim otherwise — see
> [open questions](#open-questions--not-yet-built).

---

## What a minor cannot do (the read-only boundary)

Every one of these is a hard server-side gate that throws for an under-18 account — re-enforced at
the mutation, not just hidden in the UI (D37):

| Surface | Gate |
|---|---|
| Create a **report** | `reports.create` rejects minors (all reports are public, D13 — a minor can't post one) |
| Create a **hazard** | `hazards.create` rejects minors (public safety content) |
| **Confirm** a hazard | `hazardConfirmations` rejects minors (a confirmation moves a hazard's lifecycle) |
| Post a **comment** | `comments` rejects minors |
| Upload a **photo** | `photos` won't even mint an upload URL for a minor (photos only back a report they can't post) |
| Open a **bounty** | `bounties.createChecked` rejects minors |
| A **public profile** | minors are **forced private** — `canSetProfilePublic` is false for a minor, so they can't be searched or broadcast a town + report history |

The through-line: **a minor cannot author anything the public commons depends on, and cannot make
themselves publicly discoverable.**

---

## What a minor *can* do (and an honesty note)

- **Read everything.** All reports, hazards, and bounties are public (D13) and fully visible to a
  minor. The safety value of the app is entirely available to them.
- **Thumb content** (`ratings.rate`) and **block/mute** users
  ([blocking](./user-reputation.md#blocking-mute) is self-protection) — neither is currently
  minor-gated.

> **Honesty note — "read-only" is the intent, not the literal state.** The enforced boundary is
> *"no authoring public content, no public profile."* Thumbs and blocks are *not* minor-gated
> today. A thumb is a lightweight aggregate signal (and blocking is self-protective, so allowing
> it is reasonable), but a minor's thumb *does* nudge another user's reputation and can route
> content to the mod queue — so whether thumbs should be minor-gated is a **real open decision, not
> a settled one.** Documented here rather than quietly assumed. See
> [open questions](#open-questions--not-yet-built).

---

## Why read-only (the reasoning behind the 16–17 design)

Three reasons, in order of weight. The first is also why the minimum went to 18: read-only kept a
minor from *authoring* safety content, but a minor still had to accept the terms to get in.

1. **Safety-liability caution.** Reports and hazards are content *other people act on* near open
   water. Accepting that kind of contribution *from a minor* — and the assumption-of-risk posture
   it implies (D45) — carries legal weight we haven't cleared. Read-only lets a 16-year-old get
   the protective value without us taking on "safety content authored by a minor" obligations.
2. **We can't yet do age-appropriate design or regional compliance properly.** Letting minors
   participate more isn't a toggle — it implies consent flows, data-handling rules, and
   surface-by-surface age-appropriateness that vary by jurisdiction (below). Until that exists, the
   safe default is the narrow one.
3. **Privacy by default.** A public profile broadcasts a town and a skating history. For a known
   minor we simply never do that — forced-private is the floor, not a preference.

None of this is a judgment that 16- and 17-year-olds *shouldn't* contribute. It's that we'd rather
under-permit and expand deliberately than over-permit and retract.

---

## The 18th birthday: nothing widens silently

The transition is automatic (derived from DOB), but it is **strictly one-directional — it lifts
protections, it never auto-exposes.** The load-bearing example: a minor's profile is forced
`private`. On their 18th birthday `isMinor` flips to false, but their profile **stays private**
until *they* choose to change it. We "force private for minors" but "never silently widen an
adult's existing choice." A birthday should hand someone *new options*, never flip a privacy
setting on their behalf. The same rule holds when a canceled deletion's account is set up again:
it keeps the visibility it has (private, after the request), and only its own switch widens it
(D298).

---

## The future we're aiming at: 16+ back in, and participating more

We'd like to let 16- and 17-year-olds in again, and to do more than read — possibly to author,
with appropriate guardrails. What stands between here and there is **work, not reluctance**, and
most of it is legal/compliance rather than engineering. The first question is new with D294:
**can a minor's acceptance of the terms and the assumption of risk be relied on at all**, and if
not, what stands in for it (a guardian's acceptance, most likely). Then:

- **Region-aware age rules.** Today the 16/18 lines are a single global policy. Real participation
  by minors is governed by *where the user is*: US state-level minor-data and consent statutes; the
  EU "age of digital consent" (13–16, set per member state); the UK Age-Appropriate Design Code;
  and the enforceability of an assumption-of-risk acknowledgment against a minor. A future policy
  would likely need to key off **location**, not just a global age — which ties into the
  [region-expansion runbook](./adding-a-region.md).
- **Parental/guardian consent flow.** None exists today. Meaningful minor participation probably
  requires one, region-dependent.
- **Age-appropriate surfacing.** Which surfaces a 16-year-old may author into, and under what
  framing, is a design question per jurisdiction — not an all-or-nothing switch.

These are **questions for counsel + design, explicitly not built.** This section exists so the
intent is on record: 18+ is the posture for this release, and read-only at 16–17 is the built
step to expand *to*, then *from*.

---

## Regional compliance: one global policy, for now

Right now there is exactly one age policy, applied globally: **18 to sign up** (and, for any
under-18 account, 18 to author, with the profile forced private). That's appropriate for a US-Northeast alpha, but it is **not
region-portable** — the moment coverage expands to a jurisdiction with a different age of digital
consent or a minor-design code, the single global rule stops being sufficient. When you follow
[adding a new region](./adding-a-region.md), treat "does this region change the age rules?" as an
open compliance question, not an assumption that the current constants travel.

---

## Open questions — not yet built

Stated plainly so none of these read as settled:

- **Age is self-attested** — no verification beyond a DOB the user types.
- **Thumbs and blocks are not minor-gated** — consistent with "self-protective / lightweight," but
  whether a minor's thumb should count is an unmade decision (see the honesty note above).
- **No parental-consent flow.**
- **No region-aware age rules** — the 18 line is global.
- **Whether a minor can accept the terms** — unanswered; it is why the minimum is 18 (D294).
- **No age-appropriate authoring path for 16+** — the thing this doc most wants to eventually
  enable.
