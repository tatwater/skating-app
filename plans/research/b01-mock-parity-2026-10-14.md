# B01 — mock parity with today's `/admin`, 2026-10-14

Every capability in [`admin-surface-inventory-2026-10-12.md`](./admin-surface-inventory-2026-10-12.md)
checked against the V5 mocks in `skating-mockups/admin-variants/` (seventeen pages, also in Paper).
The phase doc's §1 table says *where* each capability lands; this says whether the look and the
interaction for it have been drawn yet.

- **Drawn**: a mock shows it.
- **Pattern**: not drawn, but it is the same shape as something drawn (a lane, a table + inspector,
  a constant card), so the build can follow the pattern without a mock.
- **Needs a mock**: a shape no mock has shown yet, where guessing would be expensive.
- **New**: not in today's `/admin`; the phase adds it.

## Overview (today: `/admin`)

| Capability | Status |
| --- | --- |
| Queue depths (today 4 tiles; the plan counts every lane) | Drawn |
| Audit feed with actor, verb, target | Drawn (rows link; filters not drawn — Pattern) |
| App-health trends (reports, signups, active contributors) | Moved to Instruments — Pattern (trend chart drawn there) |
| Catalog coverage (elevation-derived hydrography tiles + chart) | Moved to Machinery — **Needs a mock** (four tiles + a two-series chart; small) |

## Inbox (today: `/admin/flags`, `/admin/water/requests`, `/admin/support`, pending bodies, place asks)

| Capability | Status |
| --- | --- |
| Safety flag handler (claim, weather that night, flagger, person) | Drawn |
| Drawn-body handler (approve, reject, merge into) | Drawn |
| Support ticket (assign, resolve; note and reply are New) | Drawn |
| Place ask with a lookalike (same place, draw, decline) | Drawn |
| Inbox zero | Drawn |
| **Access-report lane**: one row per body, every reporter's note, "disputes a prior ruling", Mark none / Confirm open / Clear | **Needs a mock** — one ruling over many reports; the dispute state |
| **Requests**: activate, admit (3DHP candidate outline, "look up again", resolve error), restore and takedown (admin), contest_access | **Needs a mock** for admit (an outline from a catalog, not ours); the rest Pattern |
| Content-flag handler: hide, remove, **restore** (New), access-alert retract and pin (and unpin — not in the plan), photo takedown (New, D222), occurrences and prior resolution | Pattern for report/comment/post; **Needs a mock** for access alerts and photos |
| Flag on a user → the person's levers inline | Pattern (People levers drawn) |
| Decided record; reopening | Pattern |
| Colleague lock (`useReviewWatch`, "a colleague decided this") | **Needs a mock** — a state, not a page |
| Edit history of a report (`RevisionHistory`, today only on public pages) | **No home in the plan** — see the questions |

## Corpus (today: `/admin/water` duplicates and curated, `/review`, `/standing`, `/place-names`, `/features`, `/recurrence`)

| Capability | Status |
| --- | --- |
| Duplicates (keep A / B, not duplicates, outline overlay, fields that differ) | Drawn |
| Name conflicts (pick a catalog name, community name, clear override) | **Needs a mock** — the name picker is the body console's Names tab |
| Class conflicts and dissent (class editing is New) | **Needs a mock** with Names |
| Orphan bays (assign a parent is New, or demote to landmark) | **Needs a mock** — the parent picker |
| Chord re-fits across bodies (New, D215) | **Needs a mock** — a lane whose handler is the Body console in bay mode |
| Place names from the emails (set lake from candidates, BodyPicker, dismiss with reason, reopen, mentions filter) | **Needs a mock** — the candidate-lake chips are a unique control |
| Pre-ice pass: recurrence queue (min winters, show suppressed, suppress, unsuppress, promote), promotion candidates, known features (demote; reactivate is not in the plan), recent automatic merges (unmerge) | **Needs a mock** — the dated pass and its "done for this season" |
| Standing lanes, recently activated, curated list | Drawn as Bodies lanes; "awaiting enrichment" Pattern |

## Body console (today: `/admin/water/$id`, 19 cards)

| Tab or card | Status |
| --- | --- |
| Identity column: names, ids, standing, completeness, curated boost, asks, history | Drawn |
| Shape: sub-areas, chord bay mode (step 2 of 4), bays table, outline (read-only, D221) | Drawn; steps 1, 3, 4 and freehand/paste Pattern |
| Merge into (New) | **Needs a mock** — choosing a survivor from the console |
| Imagery tab and dock (D224) | Drawn |
| **Names**: catalog name picker, community name, aliases (New), class and states (New) | **Needs a mock** |
| **Places**: landmarks (filter, edit, move, draw as bay, remove, restore, keep off), email names (place it, already here, dismiss), skater proposals, drop a landmark | **Needs a mock** — the densest card today |
| **Access**: put-ins (official, hide), parking (place; edit and remove are New), approach links (put-in × lot × kind), posted rules (target selector, season, hours, permit, "reads as"), public-access ruling (New in the console) | **Needs a mock** |
| **Water**: depth with the source ladder (reject, restore), weather sample points (suggest a grid, save, clear), satellite link (auto / always / never) | **Needs a mock** |
| **Hazards**: hazards list, recurrence (promote, suppress, recompute), promotion candidates, known features (add by point, outline or paste) | **Needs a mock** |
| **Standing**: active / dormant with note / removed with reason / restore (admin); the RestoreGate for rejected bodies | **Needs a mock** — four states |
| **Links**: reference links | Pattern |
| Map modes other than bay: place a put-in, place parking, drop or move a landmark, feature point or outline, sample-point grid preview | **Needs a mock** — one sheet of mode bars and to-dos |
| Aggregate tracks layer | Pattern (a layer toggle) |

## Machinery (today: `/admin/imports`, the imagery panel, crons nobody can see)

| Capability | Status |
| --- | --- |
| A live campaign: passes, heartbeat, stalled, tail, mark failed, commands to copy | Drawn |
| Cost ledger and invoices (D219) | Drawn |
| Every pipeline's overview; all campaigns; run history with "latest campaign" totals | **Needs a mock** — the mode's landing page is not drawn |
| Run detail: coverage meter and omissions, tallies by prefix, the path with checksums, failures with "N more not stored" | Partly drawn (path, outcome); coverage and failures **Need a mock** |
| Cron registry: all 30 with schedule, last, outcome, next due; jobs you can trigger with dry-run | **Needs a mock** |
| Imagery pipeline: start, pause, try again now, retry failed, recent passes, guards | Pattern (Season shows the state); controls **Need a mock** in one of the two homes |
| Notifications and weather pipelines (no records today) | **Needs a mock** once the run vocabulary is settled |

## Season (today: `/admin/seasons`)

| Capability | Status |
| --- | --- |
| The watch, lows chart and matrix, circuit, statistics, most reported, change log, cost | Drawn |
| **Settings editor**: nine thresholds, sentinel and pinned rosters with body search, the note, save as a version, version history | **Needs a mock** |
| **Every season, replayed** with draft edits struck through, fill history | **Needs a mock** — it is the settings editor's preview |
| A past season up close | Pattern (the same page, another lane) |
| Field dates (add, remove) | **Needs a mock** (small form) |
| Reset this watch (typed confirmation) | Covered by the reason-dialog sheet below |

## People (today: `/admin/users`, `/admin/users/$id`, the profile panel)

| Capability | Status |
| --- | --- |
| Lists, a person's detail, trust row, levers, open items, history | Drawn |
| Search results; staff list; newest | Pattern |
| Suspend (duration), ban, lift (not for deleting or deleted accounts — the bug), restrict, bounty limit (a number), flagging switch (New), role grant and revoke | Levers drawn; their dialogs are in the reason-dialog sheet below |
| Hidden content by this person, with restore (New) | Pattern |
| Edit history of their content | **No home in the plan** |

## Instruments (today: `/admin/tuning`, `/admin/ice-calibration`)

| Capability | Status |
| --- | --- |
| A tuning section: constants beside charts (composition bar, trend) | Drawn |
| The other nine tuning sections | Pattern |
| Histogram with threshold markers; bounty gate scatter; "table" alternative view per chart | **Needs a mock** — two chart types not yet in the register |
| Ice calibration: the fit, the pairs table, "what this cannot tell you" | Pattern (cells drawn; the table is a plain table) |
| Operational health and app health | Pattern |

## Components and states no mock has shown

1. **The reason dialog family**: required and optional reason, extra fields (suspend duration,
   feature type, removal reason, bounty limit), destructive double-confirm, typed confirmation
   ("reset"), inline server error, success. Every audited action in the console goes through it.
2. **The task round trip as a sequence**: an inbox row → the Body console in task mode → save →
   back in the inbox with the next item selected and the decided one gone.
3. **Live and time-based states**: a run going running → quiet → stalled; a new audit row
   arriving; a colleague taking the item you are on; autosave saving / saved / failed.
4. **List states**: loading, empty, error, end of an infinite list, a filter with no results.
5. **The same page for a moderator** (D217): what disappears, what is read-only.
6. **The `?` keyboard sheet** and the palette's action pane (the palette is drawn).
7. **The map's hover, selection and mode states** beyond the one hover drawn.
8. **Light mode** — D223 says "the same ramp inverted"; not drawn.

## Not in the plan yet (from the inventory)

- Unpin an access alert (`setOfficial(false)` exists; no UI).
- Reactivate a demoted known feature (no mutation).
- A home for content edit history (`RevisionHistory`) inside the console.
- The inline controls on public pages (§11 of the inventory) keep working; the inline access
  ruling there takes no reason today, unlike every other audited action.
