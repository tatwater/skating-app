# Minors & age policy

Every choice we've made about users under 18 — what they can do, what they can't, why we're
conservative right now, and what it would take to open participation up. This is a **product +
policy** doc, not legal advice: where it touches law it flags questions *for counsel*, it doesn't
answer them.

> **Who this is for.** Anyone building a feature that a minor could touch, anyone weighing the
> "let 16+ do more" question, and anyone expanding to a new region who needs to know the age rules
> aren't as portable as they look. The enforcement lives in `packages/core/src/age.ts` (the pure
> math) and the Convex mutations that call it (D41).

---

## The stance in one paragraph

We let **16- and 17-year-olds in, but read-only for anything they'd author into the public
commons.** They can browse every bit of safety information — reports, hazards, bounties — because
that's exactly the value that might keep a teenager off bad ice. What they *can't* do is post
content that other people rely on for their safety, or expose themselves publicly. This is a
deliberately cautious default we intend to relax once we've done the legal and design work to do
it responsibly — not a permanent verdict.

---

## Two age lines, both derived from date of birth

We store a single `dateOfBirth` (UTC-midnight epoch ms) and **derive** everything from it (D41).
Nothing is stored as "isMinor" and nothing runs on a birthday — age is computed at read time, so
the transitions happen automatically:

| Line | Constant | Meaning |
|---|---|---|
| **16** | `MINIMUM_SIGNUP_AGE` | Hard floor. Under-16 accounts are not permitted at all. |
| **18** | `ADULT_AGE` | Age of majority. Below it, the protective defaults below apply. |

Two subtleties worth knowing, both about *which direction we err*:

- **The 16 signup gate errs toward admitting.** It's evaluated at `now + MAX_UTC_OFFSET_AHEAD_MS`
  (14 h, the widest real timezone offset east of UTC), so someone who is already 16 on their
  *local* calendar isn't rejected while UTC still lags a day behind. The 16 gate is about service
  obligations, not physical safety, and a sub-day boundary on a self-attested date is immaterial —
  so we admit rather than wrongly turn away.
- **The 18 minor-status check errs toward protecting.** It runs on plain UTC with *no* cushion,
  because the protective defaults it drives persist past 18 anyway (a birthday never *widens*
  anything already set), so a sub-day skew removes no protection early.

Because age is derived, **the 18th-birthday transition is automatic** — no re-attestation, no
scheduled job. But see [the one-way rule](#the-18th-birthday-nothing-widens-silently) below: the
transition *lifts* restrictions, it never silently *exposes* anything.

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

## Why read-only, now

Three reasons, in order of weight:

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
setting on their behalf.

---

## The future we're aiming at: 16+ participating more

We *want* to let 16- and 17-year-olds do more — possibly to author, with appropriate guardrails —
rather than keeping them read-only forever. What stands between here and there is **work, not
reluctance**, and most of it is legal/compliance rather than engineering:

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
intent is on record: read-only is a *starting* posture chosen because it's the safe one to expand
*from*.

---

## Regional compliance: one global policy, for now

Right now there is exactly one age policy, applied globally: **16 to sign up, 18 to author,
minors forced private.** That's appropriate for a US-Northeast alpha, but it is **not
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
- **No region-aware age rules** — the 16/18 lines are global.
- **No age-appropriate authoring path for 16+** — the thing this doc most wants to eventually
  enable.
