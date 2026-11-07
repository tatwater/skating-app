import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { useNearestTheme } from './trace-chart';

/**
 * The kit's temperature matrix: one cell a night for each place, in the temperature scale. A CSS
 * grid, not a chart library — the cells are the data.
 *
 * - **The temperature scale**, one scale with two ends: under 20 °F the brightest cyan, through
 *   four colder steps to **neutral at freezing**, then three warm steps to orange at 40 °F and up.
 *   The scale is a reading, so it is the same in every theme; it never says what the ice is.
 * - **Cell text flips to the dark ink on the bright cells** (the boards' `.c4/.c3/.w2/.w3`) and on
 *   the mid cyan too: the boards' light ink measures 2.3:1 there, under the 3:1 a mark needs. The
 *   dark and light inks are the void and the bright gray in either mode, read from the nearest
 *   theme, because the cells don't change with it.
 * - **Kickers**: each row's name in a kicker column (left, or right beside a chart's end
 *   labels; 3.75 rem, wider for a longer name),
 *   and a row of column kickers under the cells (the ends only, by default, as the boards draw).
 * - **One hover plate**: hovering or focusing a cell lifts the focus ring onto it and shows the
 *   plate over it — the row and column as a kicker title, ~6 px, the mono value. The grid is one
 *   tab stop; the arrows move between cells, Home and End go to a row's ends.
 * - Sizes ride the surface: a cell is a kicker and a step tall, its value in the kicker step.
 */

/** The scale's eight steps, coldest first. Each is a `--temp-*` token. */
const TEMP_STEPS = [
  'cold-4',
  'cold-3',
  'cold-2',
  'cold-1',
  'freeze',
  'warm-1',
  'warm-2',
  'warm-3',
] as const;
type TempStep = (typeof TEMP_STEPS)[number];

/** The upper bound (°F, exclusive) of each step but the last: the boards' `ramp()`. */
const TEMP_BOUNDS_F = [20, 24, 28, 32, 34, 37, 40] as const;

/** The step a reading in °F falls in. */
function temperatureStep(f: number): TempStep {
  const i = TEMP_BOUNDS_F.findIndex((bound) => f < bound);
  return TEMP_STEPS[i === -1 ? TEMP_STEPS.length - 1 : i] as TempStep;
}

/** The legend's words for each step ("under 20", "20–24", …, "40 and up"). */
const TEMP_LEGEND: Record<TempStep, string> = {
  'cold-4': 'under 20',
  'cold-3': '20–24',
  'cold-2': '24–28',
  'cold-1': '28–32',
  freeze: '32–34',
  'warm-1': '34–37',
  'warm-2': '37–40',
  'warm-3': '40 and up',
};

const GROUND: Record<TempStep, string> = {
  'cold-4': 'bg-temp-cold-4',
  'cold-3': 'bg-temp-cold-3',
  'cold-2': 'bg-temp-cold-2',
  'cold-1': 'bg-temp-cold-1',
  freeze: 'bg-temp-freeze',
  'warm-1': 'bg-temp-warm-1',
  'warm-2': 'bg-temp-warm-2',
  'warm-3': 'bg-temp-warm-3',
};

/** The steps whose value is written in the dark ink. */
const DARK_INK: ReadonlySet<TempStep> = new Set(['cold-4', 'cold-3', 'cold-2', 'warm-2', 'warm-3']);

type MatrixRow = {
  key: string;
  /** The row's name ("Clouds"); set in caps as a kicker. */
  label: string;
  /** One reading a column; `null` is a night with no reading. */
  values: ReadonlyArray<number | null>;
};

type MatrixColumn = {
  key: string;
  /** The column's name ("7 Oct"). */
  label: string;
};

type MatrixChartProps = Omit<ComponentProps<'div'>, 'children'> & {
  rows: readonly MatrixRow[];
  columns: readonly MatrixColumn[];
  /** Appended to a value in the plate and a cell's name (" °F"). */
  unit?: string;
  /** Write each reading in its cell (the default), or show color alone. */
  showValues?: boolean;
  /** The row kickers' side: left, or right beside a chart's end labels. */
  kickerSide?: 'left' | 'right';
  /** Which column kickers show under the cells. */
  columnKickers?: 'ends' | 'all' | 'none';
  /** The step a reading falls in; the °F scale by default. */
  stepOf?: (value: number) => TempStep;
  /** What the matrix shows, for a reader ("Overnight lows, 1–12 Oct"). */
  'aria-label': string;
};

type Cell = { r: number; c: number };

/** A cell is a kicker and a step tall: 12 px on the console. */
const CELL_HEIGHT = { height: 'calc(var(--type-kick) + var(--space-0_5))' } as const;

/** A cell's element in the grid. */
const cellIn = (grid: HTMLElement | null, cell: Cell) =>
  grid?.querySelector<HTMLElement>(`[data-cell="${cell.r}:${cell.c}"]`) ?? null;

/*
 * The grid is ARIA's grid pattern on divs, not a <table>: the cells lay out as one CSS grid across
 * rows (a row is `display: contents`), which a table's own layout can't do.
 */

function MatrixChart({
  rows,
  columns,
  unit = ' °F',
  showValues = true,
  kickerSide = 'left',
  columnKickers = 'ends',
  stepOf = temperatureStep,
  className,
  ...props
}: MatrixChartProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const theme = useNearestTheme(root);
  const [active, setActive] = useState<Cell>({ r: 0, c: 0 });
  const [hot, setHot] = useState<Cell | null>(null);
  const [plateAt, setPlateAt] = useState<{ x: number; y: number } | null>(null);

  // The plate sits over the hot cell, centered on it.
  useLayoutEffect(() => {
    const box = root.current;
    const el = hot === null ? null : cellIn(box, hot);
    if (el === null || box === null) {
      setPlateAt(null);
      return;
    }
    const a = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setPlateAt({ x: a.left - b.left + a.width / 2, y: a.top - b.top });
  }, [hot]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = { r: rows.length - 1, c: columns.length - 1 };
    const { r, c } = active;
    const next: Cell | null =
      event.key === 'ArrowRight'
        ? { r, c: Math.min(c + 1, last.c) }
        : event.key === 'ArrowLeft'
          ? { r, c: Math.max(c - 1, 0) }
          : event.key === 'ArrowDown'
            ? { r: Math.min(r + 1, last.r), c }
            : event.key === 'ArrowUp'
              ? { r: Math.max(r - 1, 0), c }
              : event.key === 'Home'
                ? { r, c: 0 }
                : event.key === 'End'
                  ? { r, c: last.c }
                  : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    setHot(next);
    cellIn(root.current, next)?.focus();
  };

  const hotRow = hot === null ? undefined : rows[hot.r];
  const hotValue = hot === null ? undefined : hotRow?.values[hot.c];

  return (
    // biome-ignore lint/a11y/useSemanticElements: the ARIA grid pattern on a CSS grid (see above)
    <div
      ref={root}
      role="grid"
      data-slot="matrix-chart"
      data-ink={theme.mode}
      className={cn(
        'relative grid items-center gap-x-(--space-2_5) gap-y-[0.3125rem]',
        // The inks a cell's value can wear: the void and the bright gray, whichever mode this is.
        '[--mx-dark:var(--bg)] [--mx-light:var(--fg1)]',
        'data-[ink=light]:[--mx-dark:var(--fg)] data-[ink=light]:[--mx-light:var(--bg)]',
        kickerSide === 'left'
          ? 'grid-cols-[minmax(3.75rem,max-content)_minmax(0,1fr)]'
          : 'grid-cols-[minmax(0,1fr)_minmax(3.75rem,max-content)]',
        className,
      )}
      onKeyDown={move}
      onPointerLeave={() => setHot(null)}
      {...props}
    >
      {rows.map((row, r) => {
        const kicker = (
          // biome-ignore lint/a11y/useSemanticElements: the ARIA grid pattern on a CSS grid
          // biome-ignore lint/a11y/useFocusableInteractive: a row's name; focus moves between the cells
          <span
            role="rowheader"
            data-slot="matrix-row-kicker"
            className="text-kick leading-none font-semibold tracking-head whitespace-nowrap text-fg3 uppercase"
          >
            {row.label}
          </span>
        );
        return (
          // biome-ignore lint/a11y/useSemanticElements: the ARIA grid pattern on a CSS grid
          // biome-ignore lint/a11y/useFocusableInteractive: a row holds the focusable cells
          <div key={row.key} role="row" className="contents">
            {kickerSide === 'left' && kicker}
            <div
              data-slot="matrix-cells"
              className="grid auto-cols-fr grid-flow-col gap-(--space-1)"
            >
              {columns.map((col, c) => {
                const v = row.values[c] ?? null;
                const step = v === null ? null : stepOf(v);
                const isActive = active.r === r && active.c === c;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: the ARIA grid pattern on a CSS grid
                  <div
                    key={col.key}
                    role="gridcell"
                    tabIndex={isActive ? 0 : -1}
                    data-cell={`${r}:${c}`}
                    data-step={step ?? 'none'}
                    data-hot={hot?.r === r && hot.c === c ? '' : undefined}
                    aria-label={`${row.label}, ${col.label}: ${v === null ? 'no reading' : `${v}${unit}`}`}
                    className={cn(
                      'relative grid place-items-center outline-none',
                      'font-(family-name:--family-mono) text-kick leading-none font-medium tabular-nums',
                      step === null ? 'bg-raise' : GROUND[step],
                      step !== null && DARK_INK.has(step)
                        ? 'text-(--mx-dark)'
                        : 'text-(--mx-light)',
                      'focus-visible:z-1 focus-visible:shadow-focus data-hot:z-1 data-hot:shadow-focus',
                    )}
                    // Inline: Tailwind reads the `_` in `space-0_5` inside an arbitrary calc() as a space.
                    style={CELL_HEIGHT}
                    onPointerEnter={() => setHot({ r, c })}
                    onFocus={() => {
                      setActive({ r, c });
                      setHot({ r, c });
                    }}
                    onBlur={(event) => {
                      // Focus leaving the grid takes the plate with it; moving inside keeps it.
                      if (!root.current?.contains(event.relatedTarget as Node | null)) setHot(null);
                    }}
                  >
                    {showValues && v !== null && (
                      <span aria-hidden="true" data-slot="matrix-value">
                        {v}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {kickerSide === 'right' && kicker}
          </div>
        );
      })}
      {columnKickers !== 'none' && (
        <div aria-hidden="true" data-slot="matrix-column-kickers" className="contents">
          {kickerSide === 'left' && <span />}
          <div className="grid auto-cols-fr grid-flow-col gap-(--space-1)">
            {columns.map((col, c) => {
              const shown = columnKickers === 'all' || c === 0 || c === columns.length - 1;
              return (
                <span
                  key={col.key}
                  data-slot="matrix-column-kicker"
                  className={cn(
                    'font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase',
                    columnKickers === 'ends' && c === columns.length - 1 && c > 0
                      ? 'text-right'
                      : columnKickers === 'all' && 'text-center',
                  )}
                >
                  {shown ? col.label : null}
                </span>
              );
            })}
          </div>
          {kickerSide === 'right' && <span />}
        </div>
      )}
      {hot !== null && plateAt !== null && hotRow !== undefined && (
        <MatrixPlate
          at={plateAt}
          title={`${hotRow.label} · ${columns[hot.c]?.label ?? ''}`}
          value={hotValue == null ? 'No reading' : `${hotValue}${unit}`}
        />
      )}
    </div>
  );
}

/** The hover plate: the chart register's — the plate ground, a `line2` edge, the plate shadow. */
function MatrixPlate({
  at,
  title,
  value,
}: {
  at: { x: number; y: number };
  title: ReactNode;
  value: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      data-slot="matrix-plate"
      className={cn(
        'pointer-events-none absolute z-(--z-plate) flex w-max flex-col gap-(--space-1_5) px-(--space-3) py-(--space-2_5)',
        '-translate-x-1/2 -translate-y-full',
        'rounded-container border border-solid border-line2 bg-plate-solid shadow-plate',
      )}
      style={{ left: at.x, top: `calc(${at.y}px - var(--space-2))` }}
    >
      <span
        data-slot="matrix-plate-title"
        className="text-kick leading-none font-medium tracking-head text-fg uppercase"
      >
        {title}
      </span>
      <span
        data-slot="matrix-plate-value"
        className="font-(family-name:--family-mono) text-mono-sm leading-none tracking-value text-fg tabular-nums"
      >
        {value}
      </span>
    </div>
  );
}

type MatrixLegendProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The unit the step words are in, at the legend's right end. */
  unit?: string;
};

/** The scale's key: a swatch and its range for each step, the unit at the right end. */
function MatrixLegend({ unit = '°F', className, ...props }: MatrixLegendProps) {
  return (
    <div
      data-slot="matrix-legend"
      className={cn(
        'flex w-full flex-wrap items-center gap-x-(--space-3_5) gap-y-(--space-2) text-mono-sm leading-none whitespace-nowrap text-fg3',
        className,
      )}
      {...props}
    >
      {TEMP_STEPS.map((step) => (
        <span
          key={step}
          data-slot="matrix-legend-item"
          className="inline-flex items-center gap-(--space-1_5)"
        >
          <span
            aria-hidden="true"
            data-slot="matrix-legend-swatch"
            className={cn('block size-[0.5625rem]', GROUND[step])}
          />
          {TEMP_LEGEND[step]}
        </span>
      ))}
      <span
        data-slot="matrix-legend-unit"
        className="ms-auto font-(family-name:--family-mono) text-kick tracking-micro uppercase"
      >
        {unit}
      </span>
    </div>
  );
}

export {
  MatrixChart,
  type MatrixChartProps,
  type MatrixColumn,
  MatrixLegend,
  type MatrixLegendProps,
  type MatrixRow,
  TEMP_BOUNDS_F,
  TEMP_LEGEND,
  TEMP_STEPS,
  type TempStep,
  temperatureStep,
};
