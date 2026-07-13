# Planning docs

This directory is the design record for the app: the vision, the decisions (with their
*why*), the open questions, and the build sequence. It's meant to be read top-to-bottom
the first time, then used as a reference (decisions are numbered `D#`, open questions
`Q#`, and cross-referenced throughout).

## Read in this order

| # | Doc | What it covers |
|---|---|---|
| 00 | [Vision](./00-vision.md) | The problem, the product, the principles, app structure. **Start here.** |
| 01 | [Decisions log](./01-decisions.md) | ADR-style log of every decision (`D#`) and its rationale. |
| 02 | [Open questions](./02-open-questions.md) | What we're deliberately deferring (`Q#`), with current leanings. |
| 03 | [Tech stack options](./03-tech-stack-options.md) | Service/tooling menu with pros/cons; the locked default stack. |
| 04 | [Integrations](./04-integrations.md) | GPS providers, weather, email — setup + ToS watch-outs. |
| 05 | [Accounts & credentials](./05-accounts-and-credentials.md) | External accounts to register, ordered by lead time. |
| 06 | [Data model](./06-data-model.md) | Conceptual schema for every entity + vocabulary. |
| 07 | [Roadmap](./07-roadmap.md) | Phased build sequence; each phase is independently useful. |
| 08 | [Legal & feasibility checklist](./08-legal-feasibility-checklist.md) | Register of everything deferred behind a legal / ToS / consent / feasibility gate. |

**Phase build plans** (the *how* for a phase, linked from the roadmap):
- [Phase 1 — Water-body data](./phase-1-water-bodies.md) — OSM ETL, import, `listed`
  refactor, read-only map (Vermont pilot).
- [Phase 2 — Map + reports (the MVP)](./phase-2-map-and-reports.md) — interactive map,
  tap-to-detail, report create/read, photos, D49 display scoring. Web first, then mobile
  (two PRs). *(User-created bodies + dedup moved to Phase 7 — GPS-backed.)*

## How these fit together

- **Vision (00)** sets the principles. Everything else must serve them — especially
  the **safety-first, non-authoritative** principle (D3).
- **Decisions (01)** is the source of truth. When something is "decided," it lives here
  with a `D#` and a rationale. Other docs *reference* decisions; they don't re-argue them.
- **Open questions (02)** holds what's not yet decided. When a `Q#` is resolved, it
  becomes a `D#` and moves to 01 (02 keeps a pointer).
- **03–06** are the "how": stack, integrations, accounts, and schema.
- **Roadmap (07)** sequences the work into shippable phases.

## Conventions

- **`D#`** = a decision (see 01). **`Q#`** = an open question (see 02).
- These are living documents. If a decision changes, update its `D#` entry (and note
  what changed) rather than deleting the history — the *why* is the point.
- Nothing here is final Convex code; the data model is schema-flavored pseudocode meant
  to be reacted to.
