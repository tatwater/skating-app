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

Two files, `weather-timeline-{dark,light}.svg`, 416 px wide — the real sidebar width (`md:w-[26rem]`)
with the app's own 20 px padding, so what you open in Figma is the size it ships at.

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
  lane is hidden entirely and the across-the-lake clause stays silent, which is the correct answer for
  ~95% of the corpus and a useless one for a design mock. Mascoma is big enough to draw everything.
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

`--start N --days N` slices the cached 30-day window; no re-fetch. To move to a different lake or
winter, edit `LAKE` and the dates at the top of `fetch-archive.ts` and re-run both scripts. A body's
real `fetchProfileM` comes off its `waterBodies` document — the dev deployment has one for every body.
