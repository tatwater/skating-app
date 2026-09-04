# Past-weather timeline — layered SVG for Figma

**A port, not a redraw.** Every coordinate comes from `weatherTimelineModel` in `@skating/core` and
every colour from `@skating/design`'s validated scale — the same two modules the web and native apps
render from. This builder walks the model and writes SVG elements instead of React ones, so if the
chart's geometry changes, re-running produces the new chart rather than a stale drawing of the old one.

```bash
pnpm exec tsx exports/weather-timeline/fetch-archive.ts   # once — caches src/mascoma-weather-2025.json
pnpm exec tsx exports/weather-timeline/build-svg.ts       # writes both themes
pnpm exec tsx exports/weather-timeline/build-svg.ts --start 12 --days 7
```

Two files, `weather-timeline-{dark,light}.svg`, **408 px wide** — a 376 px plot in the app's own 16 px
padding, matching the Figma frame.

## The scale is fixed: 2 px = 1 hour

An hour is always 2 px, so a day is 48 px and 376 px of plot holds **7 days and five sixths of an
eighth**. The cropped column is deliberate — it is the cheapest possible signal that the chart
scrolls, and it costs nothing to draw.

⚠ **The real web sidebar is 384 px** (416 − `px-4`), which divides by 48 exactly, so *there* the edge
lands flush and the scrollbar is the only scroll affordance. Design to the crop knowing it appears at
376 and not at 384.

Before 2026-09-04 the chart stretched N whole days to whatever width it was given, which made an hour
2.286 px in the sidebar, 2.131 px on an iPhone 15 Pro and 1.940 px on an SE — one design, three
shapes, and nothing to draw against. `PX_PER_HOUR` in `@skating/core` is the single knob; the zoom
levels sketched for later (1 px = 30 / 15 / 10 / 5 min → 2 / 4 / 6 / 12 px per hour) are a prop
change, not a rewrite.

## The weather is real

Mascoma Lake, Enfield NH — **5–11 February 2025**, from Open-Meteo's ERA5 archive.

| | |
| --- | --- |
| range | −9 °F to 40 °F across the 30-day window |
| snowfall | 31.9 cm total, 108 snowing hours |
| snow depth | peaks at 0.37 m |
| codes seen | 1, 2, 3 (clear→overcast), 51/53 (drizzle), 71/73/75 (snow) |
| fetch | the body's real 16-sector profile, max **2,901 m** NW |

⚠ **The archive endpoint is the one thing here that is not the app.** Production reads Open-Meteo's
*forecast* API with `past_days`, which reaches back 92 days and therefore cannot see last winter at
all. `fetch-archive.ts` calls the ERA5 archive instead — the same source `weatherArchive.ts` reserves
a `source: 'archive'` literal for (D153, step 3 of the recovery ladder) and has never wired up. It
writes a JSON file and never touches Convex. Every variable and unit matches `HOURLY_VARS`, so what
lands in `src/` is the shape the real ingest would have stored.

The headline sentences are real too: the hours go through `summarizeWeatherDays` — the function the
Convex ingest calls — and then `buildPastWeatherPanel`, so the prose in the mock is the prose the app
would print for that week.

## Why Mascoma, and why this week

Two reasons, and the first one is not sentiment:

- **Its max fetch is 2,901 m**, comfortably over `MIN_FETCH_CLAUSE_M`. Below a kilometre the wind
  lane still draws — speed and the calm-freezing rail are measured on every lake — but its fill goes
  flat and the across-the-lake clause stays silent, because a per-lake density ramp on a pond would
  paint a vivid contrast between a 60 m shore and a 90 m one. That is the right answer for ~95% of
  the corpus and a useless one for a design mock, so Mascoma draws every channel.
- **The week spans the whole temperature scale.** It sits mostly in `deepCold`/`cold` with one
  excursion over freezing on Feb 7, so the gradient's hard step at 32 °F is visible in a single frame
  rather than needing two mocks.

## Layer tree

Figma turns each `<g id>` into a layer name. Nothing is flattened, and no group is merged across
lanes — every lane is independently selectable and recolourable.

```
Past weather — Mascoma Lake (dark)
├── Surface
├── Heading
├── Observations           ← one <text> per sentence, editable
├── Plot
│   ├── Chart
│   │   ├── Grid           ← day dividers + missing-day blocks
│   │   ├── Day labels
│   │   ├── Temperature    ← 32°F rule, label, gradient-stroked path(s)
│   │   ├── Precipitation  ← track + one rect per precipitating hour
│   │   ├── Wind           ← fetch-banded fills, trace, baseline, emphasis rail
│   │   ├── Sun            ← area, gradient-stroked lit runs, emphasis rail
│   │   └── Snow depth
│   └── Crosshair
├── Controls › Scrubber
├── Readout
├── Legend
└── Attribution
```

## Things that will bite you in Figma

- **The temperature and sun strokes are gradient fills** (`url(#temp-dark)`, `url(#sun-dark)`), in
  *user space*. Figma imports them, but moving a path without its gradient re-anchoring is the usual
  SVG-gradient trap — if a line suddenly goes flat-coloured, that is why.
- **The precipitation hatch is a `<pattern>`.** Figma's pattern support is the weakest part of its SVG
  importer; if a hatched block arrives as a flat rectangle, redraw it as diagonal lines rather than
  fighting it. Hatch means *"arrived wet and froze"* — freezing rain, sleet, ice pellets.
- **The temperature line is one path per contiguous run**, not per day. Runs break at data holes, so a
  week with a missing day imports as two paths and that is deliberate.
- Text uses `Inter` with a system fallback. Figma will substitute if you have not got it.

## Regenerating with different weather

`--start N --days N` slices the cached 30-day window; no re-fetch. The export frames `days + 1` days
and lets the viewport crop the extra one — the app hands the model all thirty (scrolling has to be
instant), but off-canvas geometry in an SVG is just clutter in Figma's layer panel, and passing all
thirty quadrupled the file. To move to a different lake or
winter, edit `LAKE` and the dates at the top of `fetch-archive.ts` and re-run both scripts. A body's
real `fetchProfileM` comes off its `waterBodies` document — the dev deployment has one for every body.
