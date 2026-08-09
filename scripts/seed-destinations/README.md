# `@skating/seed-destinations`

Matches a curated shortlist of regional skating destinations to corpus bodies and applies
`curatedBoost` — N6c Workstream **B3a** (the proving run) and **D** (the boosts). One script, because
the plan specifies them together: the matching is the hard part and both outputs need it.

> **Renamed from `seed-satellite`** (founder call, 2026-08-09). That name was chosen to name the
> *job* — provision and prove the imagery path — rather than the input list. With B3's Copernicus
> deep link deferred to [N6e](../../plans/phase-N6e-satellite-imagery.md) so the whole imagery story
> ships together, the job this script does today is the other half. N6e adds the URL verification
> back on top when it needs it; the input file is what changes, not the name.

## Running it

```bash
# 1. Dry run. Writes .report.json and touches nothing.
pnpm --filter @skating/seed-destinations seed

# 2. Read the report. Then:
pnpm --filter @skating/seed-destinations seed --apply --campaign=<campaign-id>
```

**Two commands, never one.** Founder call: *"I'm happy to look over the seed list first."* Same shape
as the other `scripts/` tools' guard — a human between the computation and the write.

## What the review is actually for

Not verifying that "Lake Willoughby" matched a row called Lake Willoughby. The two cases the script
cannot judge:

- **An ambiguous match.** OSM's Northeast water layer holds many bodies named `Mill Pond` and
  `Beaver Pond`, several within a few miles of each other. The script reports every candidate rather
  than picking the largest — because picking the largest is exactly how the Phase-2.5 seed put five
  curated boosts on same-named lakes in the wrong towns, invisible until N2 built a screen.
- **No match at all**, which is the interesting one. A well-known skating lake absent from a
  24,948-body corpus means either a naming mismatch or a genuine gap. Every unmatched entry is named
  individually on stderr, not just counted; the list is short and it is a to-do.

## The shortlist

`destinations.json` — 40 bodies across VT/NH/ME/NY/MA, each tagged with where it came from:

- `community` — the most-discussed bodies in the scraped community corpus.
- `atlas` — the well-known regional destinations from the atlas survey.

**The disagreement between the two lists is the signal** (Workstream D). Where they agree, confidence
is high. Where only the community talks about a spot, that is a discovery signal; where only an atlas
lists it, it may be listed for scenery rather than for ice.

`near` is a rough coordinate used only to disambiguate same-named bodies, within
`MATCH_RADIUS_KM` (25 km). A name match in the right state but nowhere near the coordinate is
reported as ambiguous rather than accepted — the coordinate says the author meant a different lake.

## Why the boost is 0.3

`displayScore` is `normalize(log area) ∈ [0,1] + curatedBoost`, and `minVisibleZoom` clamps the
total. The usable range is small: N6c-1 found the D2 table's proposed weights were ~13× the whole
dynamic range, which would have pushed every named body to the widest zoom bucket with all tests
still green. 0.3 matches every existing curated boost on dev.

A seed is a **cold-start hack with a retirement path** (D49), not a permanent registry. Profile
richness (D2) is the durable mechanism meant to take over, and `curatedBoostIsRedundant` is the
advisory signal that says when a given seed has been earned organically.

**A boost a human already set is never overwritten.** A hand-set value is a judgement about a
specific lake; this list is a seed, and a seed that silently overrides curation is the opposite of
what D49 wants from it. Those are recorded as itemized failures on the run row.

## Where the run shows up

`/admin/imports`, as kind `seed_destinations`, with counts, coverage and the itemized declines.
Boosts are applied through `waterBodies:setCuratedBoost` — the existing Phase 7 admin path — so a
seeded boost is indistinguishable from a hand-set one and lands in the same audit log the F1
per-lake timeline renders.
