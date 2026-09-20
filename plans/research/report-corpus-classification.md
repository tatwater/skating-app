# Report corpus classification — what skaters actually put in a report

*Research note — 2026-09-18. Feeds [`phases/A10-reporting-flow.md`](../phases/A10-reporting-flow.md).
Extends the vocabulary pass recorded in [`06-data-model.md`](../06-data-model.md) § Corpus
validation. Design input only (L5a in [`08-legal-feasibility-checklist.md`](../08-legal-feasibility-checklist.md)):
derived counts are recorded here; no post text is quoted.*

## Why this exists

The reporting flow has to accept reports the way people already write them. Before designing it we
asked the corpus three questions: how much of the email traffic *is* reports, what shape those
reports take, and which facts people volunteer without being asked. The answers moved several
design calls — most sharply on end time, on location-within-body, and on multi-body posts.

## The corpus, corrected

The private Google Group export (`training_data/google_group/`, gitignored) is a 3.35 GB `.mbox`
that is mostly base64 photo attachments; it holds **2,472 messages** across the VT, NH, ADK and ME
lists from **Dec 2023 to Jun 2026** — 57 / 587 / 1,085 / 743 by calendar year. Every prior analysis
(the D49 seed, the vocabulary tally, the hazard-research "80% of mentions" figure) ran on
`messages.jsonl`, which the parser's *default* window (Jul 2025–Jul 2026) had cut to 1,197
messages — one season. The full corpus is `messages_all.jsonl`. Cross-posting explains the group
tallies summing to 3,385: 654 messages went to two lists and 133 to all three. 2,469 unique
message-ids of 2,472; nothing was lost in the export.

The three analysis scripts were re-run on the full corpus (old CSVs kept in `prev/`). Rankings
reshuffled hard — Lake Morey leads over three seasons (136 mentions), then Lake George (91),
Champlain (81), Pleasant (76), Newfound (49) — and the VT curatedBoost seed grew from 33 to 65
bodies. Two bodies *dropped* from the VT seed because the region tag is "which list discusses it
most" and Lake Willoughby (NH 12 / VT 11) and Moore Reservoir flipped on the fuller data; the seed
must be intersected with geometry before it is reloaded, as the tooling README already warns.
Vocabulary ratios between existing enum terms held steady; the terms the enums lack are
thickness- and snow-shaped: *poke ice* (34), *supportable* (13), *exposed ice* (15, snow blown
off), *skim ice* (11), *resurfaced* (13). Skaters say *safe ice* (17) — a phrase the app may not.

## Method

Every non-empty message (2,449) was labeled against `classify/RUBRIC.md` by Sonnet sub-agents in
ten batches of 250, one JSON line per message, validated for shape and order. Labels: `has_report`,
`report_kinds` (body_writeup · multi_body · same_day_change · multi_day_journal ·
scouting_from_shore · relay · quick_hazard), `also_contains` (question · planning ·
safety_discussion · gear · social · event · other), bodies named, and per-message signal
booleans (end time precision, thickness method, snow facets, access, suitability, go/don't-go,
quality word, photo referenced, sub-area named, hazard type and whether it was located). A
firsthand observation of a named body counts; a question, a forecast, or a plan does not.
Observing from shore, a car, a webcam or a satellite counts as a report (founder call).

Spot-check: 25 lake-named negatives were all genuinely questions or plans; 29 of 30 random
positives were real reports (one gear promotion slipped through). Precision ~95%, a small
under-count. The ten "unsure" lists converge on the same boundaries: Facebook relays, "looks nice"
from shore, planning emails with a conditions line inside, and subject-line-only reports.

## Findings

**53% of all messages contain a report** — 831 of 1,139 thread roots (73%) and 478 of 1,310
replies (36%); 53 / 55 / 53% across the three seasons. **70% of report emails contain nothing
else.** The remaining traffic is social 27%, questions 23%, planning 21%, gear 14%, safety 12%.
An earlier regex pass (`skated` + a measurement) had found 71 reports in one season; the true
count for that season alone is over 600.

### Shape (n = 1,309 report messages)

| kind | share | note |
| --- | --- | --- |
| body_writeup | 71% | |
| multi_body | 15% | with same_day_change 3% and multi_day 2%: ~20% span more than one report |
| scouting_from_shore | 15% | peaks in the dying weeks of a season (43 of 133 in Feb 2025) |
| relay (secondhand) | 9% | |
| quick_hazard | 8% | |
| bodies named 1 / 2 / 3 / 4+ | 77 / 10 / 3 / 4% | |

Length: median 526 chars, p25 272, p90 2,007; **28% are under 300 chars** — five chips and an
access note. Subject lines carry data: 55% of report roots name the body in the subject, 36% put a
date there, and a handful are subject-only with an empty body.

### What people volunteer

| signal | share of reports |
| --- | --- |
| a quality word | 65% (14% give quality and nothing structured) |
| **a sub-area or directional location** | **50%** |
| a hazard mentioned → located | 56% → 41% |
| any thickness | 40%: estimate 14 · measured 10 · qualitative 7 · **poke 6 · lower bound 5 · supportability 4** · others' holes 2 |
| access info | 32% |
| any snow | 30%: coverage 21 · depth 6 · impediment 5 · texture 5 · drifts 3 · lanes 1 |
| photo / track referenced | 26% |
| go / don't-go | 4% / 7% |
| skill suitability | 3% |
| start time or duration | 7% |
| **end time** | **clock 2% · part of day 2% · none 96%** |

Hazards by type: open water 25%, thin ice 13%, pressure ridge 12% (the D51 preset trio holds),
wet crack 5%, wind hole 3%, overflow 3%, shell 3%, ridge *crossing* 2%.

### Access, specifically

A third of reports carry access prose, and it is two different things. One is the road: gate
closed, not plowed, lot full — A06d's access alerts (D73). The other is the shoreline at the moment of
launch: *plank needed*, *mud at the launch*, *pull-off is sheer ice, park on the road*, *ten-minute
walk in*, *plowed trail*, *snowed in*. Those are per-visit observations on a put-in or lot.

## What it changed

1. **End time is a 96% gap.** Nobody volunteers it, so the picker has to be nearly free and must
   not offer a vaguer answer than the one we want (D192).
2. **Location-within-body is half of all reports**, and it is mostly compass language ("north
   end", "west of the Broads"), not bay names. The `where` union with sectors (D193) is how half
   the corpus already talks; A09's named bays cover the rest.
3. **Multi-body is a fifth** of reports once same-day and multi-day are counted — the Post/Report
   split (D186) is load-bearing.
4. **Scouting is a first-class kind**; relay is a provenance, not a kind (D191).
5. **Poke, lower-bound and supportability together (15%) exceed measured (10%)** — the thickness
   vocabulary was the thin part of the model, not the ice-type list (D195).
6. **Snow needs coverage, impediment and drifts before it needs a depth** (D194).
7. **Suitability is real but small (3%)** — a row, not a headline (D190).
8. **The chip sheet is native format for a quarter of reporters**, not a compromise.

## Files

All under `training_data/google_group/` (gitignored): `messages_all.jsonl` (the full corpus),
`classify/RUBRIC.md`, `classify/batch_NN.jsonl` + `classify/labels_NN.jsonl`,
`classify/labels_all.jsonl` (merged, with `_date` / `_is_reply` / `_subject` / `_len` joined in),
`analyze_all.txt` / `gazetteer_all.txt` / `missing_vocab_all.txt` (script stdout), `prev/` (the
one-season CSVs). The labels are the recall tier of the A10 §1 extraction eval; a field-level
value tier is still to be labeled.

**Where corpus tooling lives (founder call, 2026-09-19):** tooling that only makes sense with the
corpus lives *with* the corpus — `training_data/tools/<name>/` as a standalone package with its own
lockfile, outside `pnpm-workspace.yaml`, gitignored with the data — so nothing corpus-shaped ever
reaches the tree (a test fixture, a README example, an evidence string). Only code that ships
product behavior lives in `packages/` or `scripts/`; `scripts/seed-destinations` stays there
because it is an operator tool against the catalog, and its corpus-derived input file is kept under
`training_data/google_group/seed/` and passed with `--input=`. The LLM mention inventory
(`training_data/tools/corpus-mentions/`, Haiku 4.5, structured outputs) replaced the regex
gazetteer as the seed's source: the regex both over-found (subject lines running into bodies) and
under-found (lowercase "memphremagog", "Caspian caught", "Lake Damariscotta" word-flipped).
