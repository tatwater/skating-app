/**
 * The past-weather panel as a layered SVG, for Figma.
 *
 * **A port, not a redraw** — the same principle as `exports/mascoma/build_svg.py`. Every coordinate
 * comes from `weatherTimelineModel` in `@skating/core` and every colour from `@skating/design`'s
 * validated scale, exactly as the two apps do. Nothing here draws a chart; it walks the same model
 * and writes SVG elements instead of React ones. If the app's geometry changes, re-run this and the
 * export changes with it.
 *
 * ⚠ **The one thing that is deliberately not the app: the data source.** These are real hours for
 * Mascoma Lake in January 2025, pulled from Open-Meteo's ERA5 archive by `fetch-archive.ts`, because
 * the production endpoint only reaches back 92 days and cannot see last winter. Real temperatures,
 * real snow, real bearings — the app's own reducer, on weather that actually happened.
 *
 * ```bash
 * pnpm exec tsx exports/weather-timeline/fetch-archive.ts   # once; writes src/*.json
 * pnpm exec tsx exports/weather-timeline/build-svg.ts       # both themes
 * pnpm exec tsx exports/weather-timeline/build-svg.ts --start 12 --days 7
 * ```
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildPastWeatherPanel,
  COMPASS_LABELS,
  cmToInches,
  DEFAULT_TIMELINE_HEIGHT,
  EMPHASIS_RAIL_HEIGHT,
  fetchAlong,
  formatLocalHour,
  formatTemperatureF,
  hourAtX,
  kphToMph,
  localDateToDayMs,
  mmToInches,
  type PanelDay,
  precipitationKind,
  roundTo,
  shortDayLabel,
  summarizeWeatherDays,
  type TimelineDayInput,
  type TimelineHour,
  timelineScrollbar,
  weatherTimelineModel,
  windSectorOf,
} from '../../packages/core/src/index';
import {
  type WeatherChartPalette,
  WIND_FETCH_OPACITY,
  weatherChartPalette,
} from '../../packages/design/src/index';

// ── Layout ───────────────────────────────────────────────────────────────────────────────────────
// The real sidebar is `md:w-[26rem]` = 416px; 20px of padding either side leaves this plot width.
const PLOT_WIDTH = 376;
const PAD = 20;
const CANVAS_WIDTH = PLOT_WIDTH + PAD * 2;
const SURFACE = { dark: '#151d26', light: '#ffffff' } as const;
const INK = { dark: '#f4f7fa', light: '#0b1016' } as const;
const FONT = 'Inter, system-ui, -apple-system, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

interface Archive {
  lake: { name: string; town: string; fetchProfileM: number[] };
  hourly: Record<string, (number | string | null)[]>;
}

const archive = JSON.parse(
  readFileSync(new URL('./src/mascoma-weather-2025.json', import.meta.url), 'utf8'),
) as Archive;

/** Split `2025-01-18T13:00` without constructing a `Date` — the app's own rule, for the same reason. */
function parseStamp(stamp: string): { localDate: string; localHour: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(stamp);
  return m?.[1] ? { localDate: m[1], localHour: Number(m[2]) } : null;
}

/** The archive response → one `TimelineDayInput` per local calendar day, in the app's shape. */
function readDays(): TimelineDayInput[] {
  const h = archive.hourly;
  const time = h.time as string[];
  const col = (k: string) => h[k] as (number | null)[] | undefined;
  const num = (v: number | null | undefined) => (typeof v === 'number' ? v : undefined);

  const byDate = new Map<string, TimelineHour[]>();
  for (let i = 0; i < time.length; i++) {
    const stamp = time[i];
    if (typeof stamp !== 'string') continue;
    const parsed = parseStamp(stamp);
    const t = col('temperature_2m')?.[i];
    if (!parsed || typeof t !== 'number') continue;
    const hour: TimelineHour = {
      localDate: parsed.localDate,
      localHour: parsed.localHour,
      temperatureC: t,
    };
    const put = <K extends keyof TimelineHour>(k: K, v: number | undefined) => {
      if (v !== undefined) (hour as Record<string, unknown>)[k as string] = v;
    };
    put('precipitationMm', num(col('precipitation')?.[i]));
    put('rainMm', num(col('rain')?.[i]));
    put('snowfallCm', num(col('snowfall')?.[i]));
    put('snowDepthM', num(col('snow_depth')?.[i]));
    put('windSpeedKph', num(col('wind_speed_10m')?.[i]));
    put('windDirectionDeg', num(col('wind_direction_10m')?.[i]));
    put('shortwaveWm2', num(col('shortwave_radiation')?.[i]));
    put('weatherCode', num(col('weather_code')?.[i]));
    const list = byDate.get(parsed.localDate) ?? [];
    list.push(hour);
    byDate.set(parsed.localDate, list);
  }

  return [...byDate.entries()]
    .map(([localDate, hours]) => ({ dayMs: localDateToDayMs(localDate) ?? 0, localDate, hours }))
    .sort((a, b) => a.dayMs - b.dayMs);
}

/**
 * The panel's real sentences, from the real reducer.
 *
 * Runs the archive's hours through `summarizeWeatherDays` — the same function the Convex ingest
 * calls — so the prose in the mock is the prose the app would print for this week, not filler.
 */
function headlineFor(days: TimelineDayInput[]): string[] {
  const hours = days.flatMap((d) =>
    (d.hours ?? []).map((h) => ({
      ...h,
      localDate: d.localDate,
      precipitationMm: h.precipitationMm ?? 0,
      windSpeedKph: h.windSpeedKph ?? 0,
    })),
  );
  const summaries = summarizeWeatherDays(hours);
  return buildPastWeatherPanel(summaries as unknown as PanelDay[]).headline;
}

// ── SVG helpers ──────────────────────────────────────────────────────────────────────────────────
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(
  s: string,
  x: number,
  y: number,
  opts: { fill: string; size?: number; anchor?: string; family?: string; style?: string } = {
    fill: '#fff',
  },
) {
  const a = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  const st = opts.style ? ` font-style="${opts.style}"` : '';
  return (
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" fill="${opts.fill}" ` +
    `font-family="${opts.family ?? FONT}" font-size="${opts.size ?? 11}"${a}${st}>${esc(s)}</text>`
  );
}

/** A named group — Figma turns `id` into the layer name, which is the whole point of this export. */
const group = (id: string, body: string[]) =>
  body.filter(Boolean).length === 0
    ? ''
    : `<g id="${esc(id)}">\n${body.filter(Boolean).join('\n')}\n</g>`;

// ── The build ────────────────────────────────────────────────────────────────────────────────────
function build(mode: 'dark' | 'light', all: TimelineDayInput[], start: number, span: number) {
  const p: WeatherChartPalette = weatherChartPalette(mode);
  const visible = all.slice(start, start + span);
  const model = weatherTimelineModel({
    days: visible,
    width: PLOT_WIDTH,
    height: DEFAULT_TIMELINE_HEIGHT,
    fetchProfileM: archive.lake.fetchProfileM,
  });
  if (!model) throw new Error('no model — check the window');

  const headline = headlineFor(visible);
  const ink = INK[mode];
  const muted = p.aux.trace;

  // Vertical rhythm, top down. Mirrors the panel's own `flex flex-col gap-2`.
  let y = PAD + 4;
  const head: string[] = [];
  head.push(
    text("WHAT IT'S BEEN THROUGH", PAD, y + 8, {
      fill: muted,
      size: 11,
      family: MONO,
    }),
  );
  y += 22;
  const lines: string[] = [];
  for (const line of headline) {
    lines.push(text(line, PAD, y + 10, { fill: ink, size: 13 }));
    y += 18;
  }
  y += 6;

  const chartTop = y;
  const gradId = `temp-${mode}`;
  const hatchId = `hatch-${mode}`;
  const sunId = `sun-${mode}`;

  const defs: string[] = [];
  if (model.temperature) {
    const g = model.temperature.gradient;
    defs.push(
      `<linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">` +
        g.stops
          .map((s) => `<stop offset="${s.offset}" stop-color="${p.temperature[s.band]}"/>`)
          .join('') +
        `</linearGradient>`,
    );
  }
  if (model.sun) {
    defs.push(
      `<linearGradient id="${sunId}" gradientUnits="userSpaceOnUse" x1="0" y1="${model.sun.box.top}" x2="0" y2="${model.sun.box.bottom}">` +
        `<stop offset="0" stop-color="${p.sunRamp.lit}"/><stop offset="1" stop-color="${p.sunRamp.dim}"/></linearGradient>`,
    );
  }
  defs.push(
    `<pattern id="${hatchId}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<line x1="0" y1="0" x2="0" y2="4" stroke="${p.precipitation.rain}" stroke-width="2"/></pattern>`,
  );

  // Grid + labels
  const grid = model.dividers.map(
    (x) =>
      `<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${model.boxes.temperature.top}" y2="${model.boxes.snowDepth.bottom.toFixed(2)}" stroke="${p.aux.fill}" stroke-width="1"/>`,
  );
  const holes = model.days
    .filter((d) => d.missing)
    .map(
      (d) =>
        `<rect x="${d.x.toFixed(2)}" y="${model.boxes.temperature.top}" width="${d.width.toFixed(2)}" height="${(model.boxes.snowDepth.bottom - model.boxes.temperature.top).toFixed(2)}" fill="${p.aux.fill}" opacity="0.25"/>`,
    );
  const dayLabels = model.days
    .filter((d) => d.showLabel)
    .map((d) =>
      text(shortDayLabel(d.localDate), d.labelX, 9, { fill: muted, size: 9, anchor: 'middle' }),
    );

  // Temperature
  const temp: string[] = [];
  if (model.temperature) {
    const t = model.temperature;
    temp.push(
      `<line x1="0" x2="${PLOT_WIDTH}" y1="${t.freezeY.toFixed(2)}" y2="${t.freezeY.toFixed(2)}" stroke="${muted}" stroke-width="1"/>`,
      // Below the rule when the rule is near the top, or the label lands in the day-label band. A
      // cold week pins the freeze line high, which is exactly when this matters.
      text('32°F', 2, t.freezeY < 14 ? t.freezeY + 9 : t.freezeY - 3, { fill: muted, size: 8 }),
      ...t.segments.map(
        (d) =>
          `<path d="${d}" fill="none" stroke="url(#${gradId})" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      ),
      ...t.partialSegments.map(
        (d) =>
          `<path d="${d}" fill="none" stroke="url(#${gradId})" stroke-width="2" stroke-dasharray="3 2" opacity="0.55" stroke-linecap="round"/>`,
      ),
    );
  }

  // Precipitation
  const precip: string[] = [
    `<rect x="0" y="${model.precipitation.box.top.toFixed(2)}" width="${PLOT_WIDTH}" height="${model.precipitation.box.height.toFixed(2)}" fill="${p.aux.fill}" opacity="0.3"/>`,
    ...model.precipitation.blocks.map(
      (b) =>
        `<rect x="${b.x.toFixed(2)}" y="${model.precipitation.box.top.toFixed(2)}" width="${b.width.toFixed(2)}" height="${model.precipitation.box.height.toFixed(2)}" fill="${b.hatched ? `url(#${hatchId})` : p.precipitation[b.fill]}"/>`,
    ),
  ];

  // The three auxiliary lanes, each its own Figma group.
  const auxGroups: string[] = [];
  for (const [name, lane, side, lit] of [
    ['Wind', model.wind, 'cold', null],
    ['Sun', model.sun, 'warm', `url(#${sunId})`],
    ['Snow depth', model.snowDepth, 'cold', null],
  ] as const) {
    if (!lane) continue;
    const body: string[] = [];
    if (lane.areaSegments.length === 0) {
      body.push(`<path d="${lane.area}" fill="${p.aux.fill}" opacity="0.55"/>`);
    } else {
      for (const seg of lane.areaSegments) {
        const o =
          WIND_FETCH_OPACITY.min +
          seg.intensity * (WIND_FETCH_OPACITY.max - WIND_FETCH_OPACITY.min);
        body.push(`<path d="${seg.d}" fill="${p.aux.trace}" opacity="${o.toFixed(3)}"/>`);
      }
    }
    for (const seg of lane.segments) {
      const stroke = seg.active && lit ? lit : muted;
      body.push(
        `<path d="${seg.d}" fill="none" stroke="${stroke}" stroke-width="${seg.active && lit ? 1.5 : 1}" stroke-linejoin="round"/>`,
      );
    }
    body.push(
      `<line x1="0" x2="${PLOT_WIDTH}" y1="${lane.box.bottom.toFixed(2)}" y2="${lane.box.bottom.toFixed(2)}" stroke="${p.aux.fill}" stroke-width="1"/>`,
    );
    for (const span_ of lane.emphasis) {
      body.push(
        `<rect x="${span_.x.toFixed(2)}" y="${(lane.box.bottom - EMPHASIS_RAIL_HEIGHT).toFixed(2)}" width="${span_.width.toFixed(2)}" height="${EMPHASIS_RAIL_HEIGHT}" fill="${p.emphasis[side]}"/>`,
      );
    }
    auxGroups.push(group(name, body));
  }

  const chart = group('Chart', [
    group('Grid', [...grid, ...holes]),
    group('Day labels', dayLabels),
    group('Temperature', temp),
    group('Precipitation', precip),
    ...auxGroups,
  ]);

  y = chartTop + DEFAULT_TIMELINE_HEIGHT + 8;

  // Scroll track, at the position the app would show for this window.
  const bar = timelineScrollbar({
    offset: all.length - span - start,
    maxOffset: Math.max(0, all.length - span),
    windowDays: span,
    totalDays: all.length,
    trackWidth: PLOT_WIDTH,
  });
  const scrubber = group('Scrubber', [
    `<rect x="0" y="${(y + 4).toFixed(2)}" width="${PLOT_WIDTH}" height="4" rx="2" fill="${p.aux.fill}"/>`,
    bar
      ? `<rect x="${bar.x.toFixed(2)}" y="${(y + 1).toFixed(2)}" width="${bar.width.toFixed(2)}" height="10" rx="5" fill="${p.aux.control}"/>`
      : '',
  ]);
  y += 22;

  // The readout, for a real hour — the one the crosshair would be sitting on.
  const focus = hourAtX(model, PLOT_WIDTH * 0.62);
  const readoutParts: string[] = [];
  if (focus) {
    const h = focus.hour;
    readoutParts.push(formatLocalHour(h.localHour), formatTemperatureF(h.temperatureC));
    const kind = precipitationKind(h);
    if (kind) {
      const amount =
        typeof h.snowfallCm === 'number' && h.snowfallCm > 0
          ? `${roundTo(cmToInches(h.snowfallCm), 1)}″`
          : `${roundTo(mmToInches(h.precipitationMm ?? h.rainMm ?? 0), 2)}″`;
      readoutParts.push(`${kind.label} ${amount}`);
    }
    if (typeof h.windSpeedKph === 'number') {
      const from =
        typeof h.windDirectionDeg === 'number'
          ? ` ${COMPASS_LABELS[windSectorOf(h.windDirectionDeg)] ?? ''}`
          : '';
      readoutParts.push(`${Math.round(kphToMph(h.windSpeedKph))} mph${from}`);
      const across = fetchAlong(archive.lake.fetchProfileM, h.windDirectionDeg);
      if (across !== null) readoutParts.push(`${roundTo(across / 1000, 1)} km across the lake`);
    }
    if (typeof h.snowDepthM === 'number' && h.snowDepthM > 0) {
      readoutParts.push(`${roundTo(cmToInches(h.snowDepthM * 100), 1)}″ down`);
    }
  }
  const crosshair = focus
    ? `<line x1="${focus.x.toFixed(2)}" x2="${focus.x.toFixed(2)}" y1="${model.boxes.temperature.top}" y2="${model.boxes.snowDepth.bottom.toFixed(2)}" stroke="${p.aux.control}" stroke-width="1"/>`
    : '';

  // ⚠ Wrapped, not truncated. The readout reached six fields once the across-the-lake clause landed
  // and ran clean off the canvas — in the apps it is HTML and wraps by itself, but SVG will happily
  // draw text into nowhere. ~58 characters is what 10px mono fits in the plot width.
  const readoutLines = wrap(readoutParts.join(' · '), 58);
  const readout = group(
    'Readout',
    readoutLines.map((l, i) => text(l, PAD, y + 8 + i * 13, { fill: ink, size: 10, family: MONO })),
  );
  y += readoutLines.length * 13 + 8;

  const legendText = [
    'Top to bottom: Temperature · Precipitation',
    model.wind ? ' · Wind, marked when calm and freezing' : '',
    model.sun ? ' · Sun, marked when sunlit above freezing' : '',
    model.snowDepth ? ' · Snow on the ground' : '',
  ].join('');
  // Wrapped by hand: SVG has no flow layout, and one 380px line would run off the canvas.
  const legendLines = wrap(legendText, 62);
  const legend = group(
    'Legend',
    legendLines.map((l, i) => text(l, PAD, y + 8 + i * 12, { fill: muted, size: 10 })),
  );
  y += legendLines.length * 12 + 10;

  const footer = group('Attribution', [
    text('Past weather: Open-Meteo', PAD, y + 8, { fill: muted, size: 10 }),
  ]);
  y += 20;

  const canvasHeight = Math.ceil(y + PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${canvasHeight}" viewBox="0 0 ${CANVAS_WIDTH} ${canvasHeight}">
<defs>
${defs.join('\n')}
</defs>
<g id="Past weather — ${esc(archive.lake.name)} (${mode})">
<rect id="Surface" x="0" y="0" width="${CANVAS_WIDTH}" height="${canvasHeight}" fill="${SURFACE[mode]}"/>
${group('Heading', head)}
${group('Observations', lines)}
<g id="Plot" transform="translate(${PAD}, ${chartTop})">
${chart}
${group('Crosshair', [crosshair])}
</g>
<g id="Controls" transform="translate(${PAD}, 0)">
${scrubber}
</g>
${readout}
${legend}
${footer}
</g>
</svg>
`;
}

/** Greedy word wrap — SVG has no flow layout, so long copy has to be broken before it is written. */
function wrap(s: string, cols: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (line.length + word.length + 1 > cols && line.length > 0) {
      out.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  const all = readDays();
  const span = flag('days', 7);
  const start = flag('start', Math.max(0, all.length - span));

  for (const mode of ['dark', 'light'] as const) {
    const svg = build(mode, all, start, span);
    const path = new URL(`./weather-timeline-${mode}.svg`, import.meta.url);
    writeFileSync(path, svg);
    console.log(`${mode.padEnd(5)} → ${path.pathname.split('/').pop()} (${svg.length} bytes)`);
  }
  const shown = all.slice(start, start + span);
  console.log(
    `window: ${shown[0]?.localDate} → ${shown[shown.length - 1]?.localDate} of ${all.length} days`,
  );
}

main();
