import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import * as tokens from '@skating/design/tokens';
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useReducedMotion } from '@/lib/useReducedMotion';
import { cn } from '@/lib/utils';

/**
 * The kit's trace drawings: the small data marks the boards draw by hand. Custom — inline SVG and
 * plain DOM, no chart library (the full charts are the kit `Chart`).
 *
 * - **`TraceChart`** — season traces in the sparkline register: hairline polylines, **gridless**,
 *   each ending in a **mono end label** in its own ink ("CLOUDS 31"), pushed apart so two never
 *   overlap; optional threshold rules (a dashed hairline) and a translucent band (the range other
 *   winters ran in). **Nothing clips at the viewBox edge**: the plot is inset by the widest stroke's
 *   half and the end labels' half height, and the labels get a measured gutter. A series **draws
 *   in** left to right on the slow motion token — never under reduced motion.
 * - **Paper's rule**: a translucent SVG mark carries its alpha *in its color*, as `rgba()` — Paper
 *   ignores `fill-opacity` and `opacity`. The band's fill is the token resolved for the drawing's
 *   own theme (its nearest `data-surface` × `data-mode`), written as `rgba()`.
 * - **`LedStrip`** — the segment strip (`.led`): a count of a fixed whole ("Complete · 9 / 10"),
 *   so a `meter` to a reader. On segments light in the bright ink with its glow.
 * - **`StageBar`** — a run's passes (`.stage`): done, running (ice: a live run is transient), late
 *   (amber), stalled (red), failed and waiting; a gap parts the campaign's passes from the by-hand
 *   ones.
 * - **`Sparkbars`** — a short run of daily counts (`.trend`, `.spark`): bottom-aligned bars, the
 *   latest lit, a zero a one-hair stub; a red part at a bar's foot (the safety lane), and an
 *   optional amber threshold rule.
 * - **`SparkbarSet`** — a stack of `Sparkbars` on one day axis read together (Metrics' *Each day*):
 *   hovering any strip, or stepping with ← → once the set has focus, draws **one** hairline through
 *   every strip at that day and **one** plate with each strip's value — never a plate per strip.
 *
 * Tones never carry a verdict: these draw temperatures, depths and counts.
 */

// ── The drawing's own theme ──────────────────────────────────────────────────────────────────

type Theme = { surface: tokens.Surface; mode: tokens.Mode };

const isOf = <T extends string>(list: readonly T[], value: string | null | undefined): value is T =>
  value != null && (list as readonly string[]).includes(value);

/** The surface × mode an element renders in: its nearest stated axes, else the page default. */
function themeOf(el: Element | null): Theme {
  const surface = el?.closest('[data-surface]')?.getAttribute('data-surface');
  const mode = el?.closest('[data-mode]')?.getAttribute('data-mode');
  return {
    surface: isOf(tokens.SURFACES, surface) ? surface : tokens.DEFAULT_SURFACE,
    mode: isOf(tokens.MODES, mode)
      ? mode
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : tokens.DEFAULT_MODE,
  };
}

/**
 * The theme an element sits in, kept current: re-read after every render and whenever any
 * element's `data-surface` / `data-mode` changes (a toolbar flip, a scoped preview).
 */
function useNearestTheme(ref: RefObject<Element | null>): Theme {
  const [theme, setTheme] = useState<Theme>({
    surface: tokens.DEFAULT_SURFACE,
    mode: tokens.DEFAULT_MODE,
  });
  // Every render, before paint: a no-op unless the answer changed.
  useLayoutEffect(() => {
    const next = themeOf(ref.current);
    if (next.surface !== theme.surface || next.mode !== theme.mode) setTheme(next);
  });
  useLayoutEffect(() => {
    const sync = () =>
      setTheme((prev) => {
        const next = themeOf(ref.current);
        return next.surface === prev.surface && next.mode === prev.mode ? prev : next;
      });
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-surface', 'data-mode'],
    });
    return () => observer.disconnect();
  }, [ref]);
  return theme;
}

/** A token as Paper reads a translucent mark: `rgba(r, g, b, a)` (or `#rrggbb` when opaque). */
function paperColor(theme: Theme, key: tokens.ColorKey): string {
  return tokens.toNativeColor(tokens.themeMaps[theme.surface][theme.mode].colors[key]);
}

// ── Season traces ────────────────────────────────────────────────────────────────────────────

/** The inks a trace can wear: the grayscale steps, then meaning. `water` is ice: water only. */
type TraceTone = 'lead' | 'muted' | 'faint' | 'warn' | 'bad' | 'water';

const TONE_INK: Record<TraceTone, string> = {
  lead: 'var(--fg)',
  muted: 'var(--fg2)',
  faint: 'var(--fg3)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  water: 'var(--acc)',
};

const DASH = { solid: undefined, dotted: '1.5 3', dashed: '3 4' } as const;
type Pattern = keyof typeof DASH;

/** A stroke weight from the stroke tokens: a hairline, or the 2 px note for an emphasized trace. */
type Weight = 'hair' | 'note';

type Trace = {
  key: string;
  /** The name its end label leads with ("Clouds"); set in caps. */
  label: string;
  /** One value a step (a night); `null` is a gap in the line. */
  values: ReadonlyArray<number | null>;
  tone?: TraceTone;
  pattern?: Pattern;
  weight?: Weight;
};

type TraceRule = {
  value: number;
  tone?: 'faint' | 'warn' | 'bad';
  pattern?: Pattern;
};

type TraceBand = {
  /** The band's floor and ceiling, a value a step. */
  lo: ReadonlyArray<number>;
  hi: ReadonlyArray<number>;
  /** The translucent token it fills with (`lift-08` by default). */
  color?: tokens.ColorKey;
};

type Point = { x: number; y: number };

type TraceGeometry = {
  /** Each trace's runs of points (a `null` splits a run). */
  runs: Point[][][];
  ruleYs: number[];
  band: string | null;
  /** Each trace's last value's point, or `null` when it ends in a gap. */
  ends: Array<Point | null>;
  x: (i: number) => number;
  y: (v: number) => number;
};

/**
 * Where everything lands in a `width` × `height` drawing whose plot is inset by `inset` on every
 * side and leaves `gutter` px on the right for the end labels. Pure, for the tests.
 */
function traceGeometry({
  traces,
  rules = [],
  band,
  domain,
  width,
  height,
  inset,
  gutter,
}: {
  traces: readonly Trace[];
  rules?: readonly TraceRule[];
  band?: TraceBand | undefined;
  domain?: readonly [number, number] | undefined;
  width: number;
  height: number;
  inset: number;
  gutter: number;
}): TraceGeometry {
  const steps = Math.max(1, ...traces.map((t) => t.values.length), band?.lo.length ?? 0);
  const all = [
    ...traces.flatMap((t) => t.values.filter((v): v is number => v !== null)),
    ...rules.map((r) => r.value),
    ...(band ? [...band.lo, ...band.hi] : []),
  ];
  let [lo, hi] = domain ?? [Math.min(...all), Math.max(...all)];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (hi === lo) [lo, hi] = [lo - 1, hi + 1];
  const left = inset;
  const right = Math.max(left, width - gutter - inset);
  const top = inset;
  const bottom = Math.max(top, height - inset);
  const x = (i: number) => (steps === 1 ? left : left + (i / (steps - 1)) * (right - left));
  // Clamped to the domain, so a value outside a fixed domain still lands inside the drawing.
  const y = (v: number) => {
    const t = (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo);
    return bottom - t * (bottom - top);
  };
  const runs = traces.map((t) => {
    const out: Point[][] = [];
    let run: Point[] = [];
    t.values.forEach((v, i) => {
      if (v === null) {
        if (run.length > 0) out.push(run);
        run = [];
      } else run.push({ x: x(i), y: y(v) });
    });
    if (run.length > 0) out.push(run);
    return out;
  });
  const ends = traces.map((t) => {
    const last = t.values.at(-1);
    return last == null ? null : { x: x(t.values.length - 1), y: y(last) };
  });
  const bandPath =
    band && band.lo.length > 0
      ? `M${band.hi.map((v, i) => `${f(x(i))} ${f(y(v))}`).join(' L')} L${[...band.lo]
          .map((v, i) => `${f(x(i))} ${f(y(v))}`)
          .reverse()
          .join(' L')} Z`
      : null;
  return { runs, ruleYs: rules.map((r) => y(r.value)), band: bandPath, ends, x, y };
}

const f = (n: number) => n.toFixed(2);
const pointsOf = (run: readonly Point[]) => run.map((p) => `${f(p.x)},${f(p.y)}`).join(' ');

/**
 * End labels pushed apart: sorted by height, each at least `gap` under the one above, then the
 * stack lifted back inside `[min, max]` if it ran past the floor. Pure, for the tests.
 */
function spreadLabels(ys: readonly number[], gap: number, min: number, max: number): number[] {
  const order = ys
    .map((y, i) => ({ y: Math.min(Math.max(y, min), max), i }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1] as { y: number };
    const cur = order[k] as { y: number };
    if (cur.y - prev.y < gap) cur.y = prev.y + gap;
  }
  const over = (order.at(-1)?.y ?? max) - max;
  if (over > 0) for (const o of order) o.y -= over;
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

/**
 * Each trace's end label height, spread by {@link spreadLabels} — over the labels that draw only:
 * a trace ending in a gap has no label (`undefined`), and holds no slot that would push the others
 * down. Pure, for the tests.
 */
function endLabelYs(
  ends: ReadonlyArray<Point | null>,
  gap: number,
  min: number,
  max: number,
): Array<number | undefined> {
  const drawn = ends.flatMap((e, k) => (e === null ? [] : [{ k, y: e.y }]));
  const spread = spreadLabels(
    drawn.map((d) => d.y),
    gap,
    min,
    max,
  );
  const out = new Array<number | undefined>(ends.length).fill(undefined);
  drawn.forEach((d, i) => {
    out[d.k] = spread[i];
  });
  return out;
}

type TraceChartProps = Omit<ComponentProps<'div'>, 'children'> & {
  traces: readonly Trace[];
  rules?: readonly TraceRule[];
  band?: TraceBand;
  /** A fixed value range; otherwise the data's own. */
  domain?: readonly [number, number];
  /** Formats an end label's value ("31", "31 °F"). */
  format?: (value: number) => string;
  /** End labels on (the default) or off (a bare sparkline in a table cell). */
  endLabels?: boolean;
  /** What the drawing shows, for a reader ("Overnight lows at the sentinels, 1–12 Oct"). */
  'aria-label': string;
};

/** The px gap between a trace's end and its label (the boards' 7 px). */
const LABEL_GAP = 7;

function TraceChart({
  traces,
  rules = [],
  band,
  domain,
  format = String,
  endLabels = true,
  className,
  style,
  ...props
}: TraceChartProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const series = useRef<SVGGElement | null>(null);
  const theme = useNearestTheme(box);
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0, font: 0 });
  const [label, setLabel] = useState({ width: 0, height: 0 });

  // The drawing's own size (and its label type's size), kept current.
  useLayoutEffect(() => {
    const el = box.current;
    /* v8 ignore next */
    if (el === null) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const font = parseFloat(getComputedStyle(el).fontSize);
      setSize((s) =>
        s.width === r.width && s.height === r.height && s.font === font
          ? s
          : { width: r.width, height: r.height, font },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A webfont that lands after the first measure changes the labels' box: measure again then.
  // (`ready` may settle before the face is even requested, so a finished load counts too.)
  const [, setFontLoads] = useState(0);
  useLayoutEffect(() => {
    let live = true;
    const bump = () => {
      if (live) setFontLoads((n) => n + 1);
    };
    document.fonts.ready.then(bump);
    document.fonts.addEventListener('loadingdone', bump);
    return () => {
      live = false;
      document.fonts.removeEventListener('loadingdone', bump);
    };
  }, []);

  // The end labels' box: the widest label and the tallest, measured once drawn.
  useLayoutEffect(() => {
    const el = box.current;
    /* v8 ignore next */
    if (el === null) return;
    const boxes = [...el.querySelectorAll<SVGTextElement>('[data-slot="trace-end-label"]')].map(
      (t) => t.getBBox(),
    );
    const next = {
      width: Math.ceil(Math.max(0, ...boxes.map((b) => b.width))),
      height: Math.ceil(Math.max(0, ...boxes.map((b) => b.height))),
    };
    if (next.width !== label.width || next.height !== label.height) setLabel(next);
  });

  // Draws in once, left to right; never under reduced motion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draw-in runs once, on the first sized frame
  useLayoutEffect(() => {
    const g = series.current;
    if (g === null || reduced || size.width === 0) return;
    const [x1, y1, x2, y2] = tokens.easing.enter;
    g.setAttribute('data-drawn-in', '');
    g.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], {
      duration: tokens.duration.slow,
      easing: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
    });
  }, [size.width === 0]);

  const strokes = traces.map((t) => tokens.border[t.weight ?? 'hair'].value);
  const widest = Math.max(tokens.border.hair.value, ...strokes);
  // A label is centered on its trace's end: the plot keeps half a label's box clear.
  const half = endLabels ? Math.max(label.height, size.font) / 2 : 0;
  const inset = Math.max(widest / 2, half);
  const gutter = endLabels && label.width > 0 ? LABEL_GAP + label.width : 0;
  const geo = traceGeometry({
    traces,
    rules,
    band,
    domain,
    width: size.width,
    height: size.height,
    inset,
    gutter,
  });
  const labelYs = endLabelYs(
    geo.ends,
    Math.max(label.height, size.font * 1.1),
    half,
    size.height - half,
  );

  return (
    <div
      ref={box}
      role="img"
      data-slot="trace-chart"
      className={cn(
        'relative h-(--space-14) w-full font-(family-name:--family-mono) text-kick leading-none',
        className,
      )}
      style={style}
      {...props}
    >
      {size.width > 0 && (
        <svg
          aria-hidden="true"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="absolute inset-0 block overflow-visible"
        >
          {geo.band !== null && (
            <path
              data-slot="trace-band"
              d={geo.band}
              fill={paperColor(theme, band?.color ?? 'lift-08')}
              stroke="none"
            />
          )}
          {rules.map((r, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
              key={i}
              data-slot="trace-rule"
              x1={inset}
              x2={size.width - gutter - inset}
              y1={geo.ruleYs[i]}
              y2={geo.ruleYs[i]}
              stroke={TONE_INK[r.tone ?? 'faint']}
              strokeWidth={tokens.border.hair.value}
              strokeDasharray={DASH[r.pattern ?? 'dashed']}
            />
          ))}
          <g ref={series} data-slot="trace-series">
            {traces.map((t, k) =>
              geo.runs[k]?.map((run, j) => (
                <polyline
                  // biome-ignore lint/suspicious/noArrayIndexKey: a trace's runs are positional
                  key={`${t.key}-${j}`}
                  data-slot="trace-line"
                  data-trace={t.key}
                  points={pointsOf(run)}
                  fill="none"
                  stroke={TONE_INK[t.tone ?? 'lead']}
                  strokeWidth={strokes[k]}
                  strokeDasharray={DASH[t.pattern ?? 'solid']}
                  strokeLinejoin="round"
                />
              )),
            )}
          </g>
          {endLabels &&
            traces.map((t, k) => {
              const end = geo.ends[k];
              const last = t.values.at(-1);
              if (end == null || last == null) return null;
              return (
                <text
                  key={t.key}
                  data-slot="trace-end-label"
                  data-trace={t.key}
                  x={end.x + LABEL_GAP}
                  y={labelYs[k]}
                  dominantBaseline="central"
                  fill={TONE_INK[t.tone ?? 'lead']}
                  className="font-medium tracking-value uppercase"
                >
                  {t.label} {format(last)}
                </text>
              );
            })}
        </svg>
      )}
    </div>
  );
}

// ── LED segments ─────────────────────────────────────────────────────────────────────────────

type LedStripProps = Omit<MeterPrimitive.Root.Props, 'children' | 'min'> & {
  /** How many segments are lit. */
  value: number;
  /** How many segments there are. */
  max: number;
  /** `lit` — the bright ink with its glow (completeness); `on` — the list-body gray (a count). */
  tone?: 'lit' | 'on';
  /** Spans its column, the segments sharing the width (the Body panel's strip). */
  full?: boolean;
};

function LedStrip({ value, max, tone = 'lit', full = false, className, ...props }: LedStripProps) {
  const lit = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <MeterPrimitive.Root
      data-slot="led-strip"
      data-tone={tone}
      min={0}
      max={max}
      value={lit}
      className={cn(
        full ? 'grid w-full gap-[0.1875rem]' : 'inline-flex items-end gap-(--space-0_5)',
        className,
      )}
      style={full ? { gridTemplateColumns: `repeat(${max}, minmax(0, 1fr))` } : undefined}
      {...props}
    >
      {Array.from({ length: max }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          key={i}
          aria-hidden="true"
          data-slot="led-segment"
          data-on={i < lit ? '' : undefined}
          className={cn(
            'block h-(--space-2) bg-line',
            !full && 'w-[0.4375rem]',
            i < lit && (tone === 'lit' ? 'bg-fg shadow-[0_0_4px_var(--glow)]' : 'bg-fg2'),
          )}
        />
      ))}
    </MeterPrimitive.Root>
  );
}

// ── Stage bar ────────────────────────────────────────────────────────────────────────────────

type StageState = 'done' | 'run' | 'late' | 'stalled' | 'failed' | 'waiting';

const STAGE_LOOK: Record<StageState, string> = {
  done: 'bg-fg2',
  run: 'bg-acc shadow-[0_0_6px_var(--acc-glow)]',
  late: 'bg-warn',
  stalled: 'bg-bad shadow-[0_0_6px_var(--bad-glow)]',
  failed: 'bg-line2',
  waiting: 'bg-line',
};

const STAGE_WORD: Record<StageState, string> = {
  done: 'done',
  run: 'running',
  late: 'late',
  stalled: 'stalled',
  failed: 'failed',
  waiting: 'waiting',
};

/** The summary a reader hears: "2 done, 1 running, 4 waiting", in the order the states first appear. */
function stageSummary(stages: ReadonlyArray<StageState | '|'>): string {
  const counts = new Map<StageState, number>();
  for (const s of stages) if (s !== '|') counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${n} ${STAGE_WORD[s]}`).join(', ');
}

type StageBarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Each pass's state, in order; `'|'` parts the campaign's passes from the by-hand ones. */
  stages: ReadonlyArray<StageState | '|'>;
  /** The segments share the width (a run's live strip) instead of 16 px each. */
  fill?: boolean;
};

function StageBar({ stages, fill = false, className, ...props }: StageBarProps) {
  return (
    <div
      role="img"
      aria-label={stageSummary(stages)}
      data-slot="stage-bar"
      className={cn('flex h-(--space-4_5) items-center gap-(--space-0_5)', className)}
      {...props}
    >
      {stages.map((s, i) =>
        s === '|' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: stages are positional
          <i key={i} data-slot="stage-gap" aria-hidden="true" className="w-[0.375rem]" />
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: stages are positional
            key={i}
            data-slot="stage"
            data-state={s}
            aria-hidden="true"
            className={cn(
              'block h-[0.3125rem]',
              fill ? 'min-w-0 flex-1' : 'w-(--space-4)',
              STAGE_LOOK[s],
            )}
          />
        ),
      )}
    </div>
  );
}

// ── Sparkbars ────────────────────────────────────────────────────────────────────────────────

type Sparkbar = number | { value: number; bad?: number };

/** A bar's resting ink: the faint ink (`.trend`, `.spark`) or the muted one (Metrics' pulse). */
type SparkbarTone = 'faint' | 'muted';

const SPARK_INK: Record<SparkbarTone, string> = { faint: 'bg-fg3', muted: 'bg-fg2' };

type SparkbarsProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** One count a day, oldest first; `bad` is the part of it in the safety lane (red, at the foot). */
  values: readonly Sparkbar[];
  /** The top of the scale; otherwise the largest value. */
  max?: number;
  /** Light the latest bar (today). */
  lightLatest?: boolean;
  /** An amber dashed threshold across the bars, in the bars' units. */
  rule?: number;
  /** The bars' resting ink. Default `faint`. */
  tone?: SparkbarTone;
  /** What the bars count, for a reader ("Open flags, the last 14 days"). */
  'aria-label': string;
};

/** The day a `SparkbarSet` is pointing at, for the strips inside it. */
const SparkbarSetContext = createContext<number | null>(null);

function Sparkbars({
  values,
  max,
  lightLatest = false,
  rule,
  tone = 'faint',
  className,
  ...props
}: SparkbarsProps) {
  const active = useContext(SparkbarSetContext);
  const bars = values.map((v) => (typeof v === 'number' ? { value: v, bad: 0 } : { bad: 0, ...v }));
  const top = Math.max(max ?? 0, ...bars.map((b) => b.value), rule ?? 0, 1);
  const pct = (v: number) => `${(100 * v) / top}%`;
  return (
    <div
      role="img"
      data-slot="sparkbars"
      className={cn('relative flex h-(--space-8) items-end gap-[0.1875rem]', className)}
      {...props}
    >
      {bars.map((b, i) => {
        const latest = lightLatest && i === bars.length - 1;
        const hovered = active === i;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: days are positional
            key={i}
            aria-hidden="true"
            data-slot="sparkbar"
            data-latest={latest ? '' : undefined}
            data-hovered={hovered ? '' : undefined}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
          >
            {b.value === 0 ? (
              <span
                data-slot="sparkbar-zero"
                className={cn('block h-(--stroke-hair)', hovered ? 'bg-fg2' : 'bg-line')}
              />
            ) : (
              <>
                <span
                  data-slot="sparkbar-fill"
                  className={cn('block', latest || hovered ? 'bg-fg' : SPARK_INK[tone])}
                  style={{ height: pct(b.value - Math.min(b.bad, b.value)) }}
                />
                {b.bad > 0 && (
                  <span
                    data-slot="sparkbar-bad"
                    className="block bg-bad"
                    style={{ height: pct(Math.min(b.bad, b.value)) }}
                  />
                )}
              </>
            )}
          </span>
        );
      })}
      {rule !== undefined && (
        <span
          data-slot="sparkbars-rule"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-warn"
          style={{ bottom: pct(rule) }}
        />
      )}
    </div>
  );
}

// ── A set of strips, one hover ───────────────────────────────────────────────────────────────

type Span = { left: number; right: number };

/**
 * The bar under a pointer at `x`, from the bars' spans in order: the bar whose half of the gap on
 * either side holds it, so the whole strip answers with no dead pixel between bars; `null` past
 * the first or last bar's outer half-gap. Exported for its test.
 */
function barAt(bars: readonly Span[], x: number): number | null {
  const n = bars.length;
  const first = bars[0];
  const last = bars[n - 1];
  if (first === undefined || last === undefined) return null;
  const halfGap = n > 1 ? ((bars[1] as Span).left - first.right) / 2 : 0;
  if (x < first.left - halfGap || x > last.right + halfGap) return null;
  for (let i = 0; i < n - 1; i++) {
    const edge = ((bars[i] as Span).right + (bars[i + 1] as Span).left) / 2;
    if (x < edge) return i;
  }
  return n - 1;
}

/** Where the set's hairline and plate go, in the set's own box. */
type SetGeometry = { x: number; top: number; bottom: number; width: number };

type SparkbarSetRow = {
  /** The strip's name ("Reports"). */
  label: ReactNode;
  /** Its value that day, as the plate shows it ("12", "—"). */
  value: ReactNode;
};

type SparkbarSetProps = Omit<ComponentProps<'div'>, 'children' | 'title'> & {
  /** How many days every strip in the set draws. */
  length: number;
  /** A day's title on the plate and to a reader ("Sat 4 Oct"). */
  title: (index: number) => string;
  /** A day's rows on the plate: each strip's name and its value, in the strips' order. */
  rows: (index: number) => readonly SparkbarSetRow[];
  /** A day to show hovered from the start (a board's drawn hover state). */
  defaultActive?: number | null;
  /** The set's name for a reader ("Each day"). */
  'aria-label': string;
  /** Any layout holding the strips (`Sparkbars`): labels, totals, an axis. */
  children: ReactNode;
};

const PLATE = [
  'absolute z-(--z-plate) grid w-max grid-cols-[auto_auto] gap-x-(--space-4_5) gap-y-(--space-1_5)',
  'px-(--space-3) py-(--space-2_5) pointer-events-none',
  'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
];

/**
 * Strips of daily bars read as one (Metrics' *Each day*): wrap them, in whatever layout, and the set
 * owns one hover — a hairline in the muted ink through every strip at the hovered day, from just
 * over the first strip to the last one's foot, and one plate beside it with the day and each
 * strip's value; the hovered bar lights in every strip. The plate opens away from the nearer edge.
 *
 * Read a day at a time, so to a keyboard and a reader it is a slider over the days: ← → step,
 * Home and End jump, Esc lets go, and the day it rests on is spoken. Every strip in the set draws
 * `length` days on one axis; where they are is measured, so labels and totals may sit beside them.
 */
function SparkbarSet({
  length,
  title,
  rows,
  defaultActive = null,
  className,
  children,
  onPointerMove,
  onPointerLeave,
  onKeyDown,
  onBlur,
  ...props
}: SparkbarSetProps) {
  const [active, setActive] = useState<number | null>(defaultActive);
  const [geometry, setGeometry] = useState<SetGeometry | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const day = active !== null && active >= 0 && active < length ? active : null;

  // Where the hovered day sits: measured from the strips themselves, after every layout.
  useLayoutEffect(() => {
    const el = root.current;
    /* v8 ignore next */
    if (el === null) return;
    const measure = () => {
      const strips = [...el.querySelectorAll<HTMLElement>('[data-slot="sparkbars"]')];
      const bar = day === null ? undefined : strips[0]?.children[day];
      if (bar === undefined || strips.length === 0) {
        setGeometry(null);
        return;
      }
      const box = el.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      const tops = strips.map((s) => s.getBoundingClientRect());
      const next = {
        x: r.left + r.width / 2 - box.left,
        top: Math.min(...tops.map((t) => t.top)) - box.top,
        bottom: Math.max(...tops.map((t) => t.bottom)) - box.top,
        width: box.width,
      };
      setGeometry((prev) =>
        prev !== null &&
        prev.x === next.x &&
        prev.top === next.top &&
        prev.bottom === next.bottom &&
        prev.width === next.width
          ? prev
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [day]);

  const dayAt = (clientX: number): number | null => {
    const strip = root.current?.querySelector('[data-slot="sparkbars"]');
    if (!strip) return null;
    const spans = [...strip.children]
      .filter((c) => c.matches('[data-slot="sparkbar"]'))
      .map((c) => c.getBoundingClientRect());
    return barAt(spans, clientX);
  };

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (by !== undefined && length > 0) {
      event.preventDefault();
      setActive((at) => Math.max(0, Math.min(length - 1, (at ?? length) + by)));
    } else if ((event.key === 'Home' || event.key === 'End') && length > 0) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : length - 1);
    } else if (event.key === 'Escape') setActive(null);
  };

  const resting = day ?? Math.max(0, length - 1);
  const onRight = day !== null && day < length / 2;
  return (
    <div
      ref={root}
      data-slot="sparkbar-set"
      role="slider"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, length - 1)}
      aria-valuenow={resting}
      aria-valuetext={length > 0 ? title(resting) : undefined}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        setActive(dayAt(event.clientX));
        onPointerMove?.(event);
      }}
      onPointerLeave={(event) => {
        setActive(null);
        onPointerLeave?.(event);
      }}
      onKeyDown={(event) => {
        step(event);
        onKeyDown?.(event);
      }}
      onBlur={(event) => {
        setActive(null);
        onBlur?.(event);
      }}
      className={cn('relative outline-none focus-visible:shadow-focus', className)}
      {...props}
    >
      <SparkbarSetContext.Provider value={day}>{children}</SparkbarSetContext.Provider>
      {day !== null && geometry !== null && (
        <>
          <span
            aria-hidden="true"
            data-slot="sparkbar-set-hairline"
            className="pointer-events-none absolute w-(--stroke-hair) -translate-x-1/2 bg-fg2"
            style={{
              left: geometry.x,
              top: `calc(${geometry.top}px - var(--space-1))`,
              height: `calc(${geometry.bottom - geometry.top}px + var(--space-1))`,
            }}
          />
          <div
            data-slot="sparkbar-set-plate"
            role="status"
            className={cn(PLATE)}
            style={{
              top: `calc(${geometry.top}px - var(--space-1))`,
              ...(onRight
                ? { left: `calc(${geometry.x}px + var(--space-2_5))` }
                : { right: `calc(${geometry.width - geometry.x}px + var(--space-2_5))` }),
            }}
          >
            <span
              data-slot="sparkbar-set-title"
              className="col-span-2 text-kick leading-none font-medium tracking-head text-fg uppercase"
            >
              {title(day)}
            </span>
            {rows(day).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row is its strip's place
              <span key={i} className="contents">
                <span className="text-assist leading-none whitespace-nowrap text-fg2">
                  {row.label}
                </span>
                <b
                  data-slot="sparkbar-set-value"
                  className="text-right font-(family-name:--family-mono) text-mono-sm leading-none font-medium tracking-value text-fg tabular-nums"
                >
                  {row.value}
                </b>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export {
  barAt,
  endLabelYs,
  LedStrip,
  type LedStripProps,
  paperColor,
  SparkbarSet,
  type SparkbarSetProps,
  type SparkbarSetRow,
  Sparkbars,
  type SparkbarsProps,
  type SparkbarTone,
  StageBar,
  type StageBarProps,
  type StageState,
  spreadLabels,
  stageSummary,
  type Theme,
  type Trace,
  type TraceBand,
  TraceChart,
  type TraceChartProps,
  type TraceRule,
  type TraceTone,
  themeOf,
  traceGeometry,
  useNearestTheme,
};
