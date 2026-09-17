# Finish the `centroid` → `representativePoint` rename (stage 2)

> **Feat — scoped, measured, not started.** Moved out of `07-roadmap.md` verbatim in the 2026-09-16 rewrite, where it had been filed as "N8b" — a code sweep that borrowed a phase number. Stage 1 (the data half) is done; this is the ~100-read-site code sweep, and its own text says it should not linger.

**N8b — Finish the `centroid` → `representativePoint` rename (stage 2).** ⏰ **Deferred 2026-08-10, and
it should not sit long.** The data half is **done** — `backfillRepresentativePoint` ran across all
three tables (`waterBodies` 24,961 · `adminAreas` 2,546 · `waterBodySubAreas` 126, nine filled), so
every row now carries the field and nothing is blocked on a pass.

What is left is purely a code sweep: **migrate ~100 read sites** to `representativePoint`, make the
field required, drop `centroid`, and remove the double-write. Readers were deliberately left alone in
stage 1, because migrating them to `representativePoint ?? centroid` then would have been a hundred
edits immediately undone here — where no fallback is needed at all.

**Why it should not linger.** Three fields currently describe two points, and one pair is a rename:
`representativePoint` *is* `centroid` (byte-identical — 126 of 126 sub-areas match exactly), while
`interiorPoint` is the genuinely different, strictly-interior one. That is a live trap rather than
cosmetic debt: **A06c's Workstream 2 was written against `centroid` and would have opened Windy 30 km
off Lake Champlain**, because a shoreline coordinate is a perfectly valid coordinate and nothing
downstream can tell. Every extra week the three names coexist is another chance to reach for the wrong
one — and the fallback chains A06c-2 wrote (`interiorPoint ?? representativePoint ?? centroid`) exist
only to be deleted by this.

⚠️ **Never make it a true centroid.** The name was the bug, not the maths — the area centroid of a
crescent water body is on land, and drive-time bands plus the pin-less report's town stamp deliberately want
a shoreline-ish point. See [`phase-A06c`](../phases/A06c-expanded-body-profiles.md) *§The three point
fields*.
