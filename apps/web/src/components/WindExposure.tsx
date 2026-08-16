import {
  areaPath,
  arrowPoints,
  COMPASS_POINTS_16,
  MIN_FETCH_CLAUSE_M,
  mostExposedSector,
  spokenDirection,
  WIND_ARROW_REFERENCE_MPS,
  windExposureSummary,
  windRoseChartModel,
} from '@skating/core';

/**
 * The wind-exposure section of a lake page (N7-3) — a 16-sector rose plus the sentences that say
 * what it means.
 *
 * **Two measurements, two channels, one hue.** The filled area is *frequency* (how often wind comes
 * from a direction); the arrows are *mean speed* (how hard it blows when it does). They routinely
 * disagree — Willoughby's commonest wind is northwesterly and its hardest is a rare easterly — and
 * that disagreement is the reason a plain rose was not enough.
 *
 * **Nothing here is coloured by value, deliberately.** Ramping the arrows warm would read as a
 * danger scale, and D145 settled that wind on a lake page is context rather than counsel. Intensity
 * rides on size, which is a magnitude channel; the single hue also means the chart survives every
 * kind of colour blindness, because no meaning is carried by hue at all.
 *
 * All the geometry comes from `@skating/core` so the native app draws the identical picture from
 * the same arithmetic — see `windRoseChart.ts`.
 */

const CHART_SIZE = 216;

export interface WindExposureBody {
  windRose?: number[];
  meanWindMps?: (number | null)[];
  fetchProfileM?: number[];
}

export function WindExposure({ body }: { body: WindExposureBody }) {
  const model = windRoseChartModel({
    rose: body.windRose ?? [],
    meanWindMps: body.meanWindMps,
    emphasizedSector: mostExposedSector(body.windRose, body.fetchProfileM)?.sector ?? null,
    size: CHART_SIZE,
  });
  if (!model) return null;

  const summary = windExposureSummary({
    rose: body.windRose as number[],
    meanWindMps: body.meanWindMps,
    fetchProfileM: body.fetchProfileM,
    mostExposedSector: mostExposedSector(body.windRose, body.fetchProfileM)?.sector ?? null,
    minFetchClauseM: MIN_FETCH_CLAUSE_M,
    spokenDirection,
    formatMiles: (meters) => {
      const miles = meters / 1609.344;
      return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)}`;
    },
  });

  const prose = summary?.sentences.join(' ') ?? '';

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-foreground-muted text-xs uppercase tracking-widest">
        Wind exposure
      </h3>
      {/* The rose is centred and the prose runs full width beneath it. Side by side, the chart was
          pinned left against a narrow column of wrapped text and read as an afterthought. */}
      <div className="flex flex-col gap-3">
        <svg
          width={CHART_SIZE}
          height={CHART_SIZE}
          viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
          role="img"
          aria-label={`Winter wind rose. ${prose}`}
          className="mx-auto shrink-0"
        >
          {/* Recessive grid: solid hairlines one shade off the surface, never dashed. */}
          {model.rings.map((ring) => (
            <circle
              key={ring.frequency}
              cx={model.center.x}
              cy={model.center.y}
              r={ring.radius}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={1}
            />
          ))}
          {model.spokes.map((spoke, i) => (
            <line
              key={COMPASS_POINTS_16[i]}
              x1={spoke.from.x}
              y1={spoke.from.y}
              x2={spoke.to.x}
              y2={spoke.to.y}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
          ))}
          {/* Frequency. A translucent fill so the grid stays readable through it. */}
          <path
            d={areaPath(model)}
            fill="var(--color-primary)"
            fillOpacity={0.22}
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {/* Mean speed. Sectors with no reading have no arrow — an absence, not a zero. */}
          {model.arrows.map((arrow) => (
            <polygon
              key={arrow.label}
              points={arrowPoints(arrow)}
              fill={arrow.emphasized ? 'var(--color-foreground)' : 'var(--color-foreground-muted)'}
              fillOpacity={arrow.emphasized ? 1 : 0.65}
            />
          ))}
          {model.cardinals.map((cardinal) => (
            <text
              key={cardinal.label}
              x={cardinal.at.x}
              y={cardinal.at.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-muted-foreground text-[9px]"
            >
              {cardinal.label}
            </text>
          ))}
        </svg>
        <p className="text-foreground text-sm leading-relaxed">{prose}</p>
      </div>

      {/* A legend is not optional with two encodings: without it the arrows read as decoration. */}
      <p className="text-muted-foreground text-xs">
        Shaded area: how often winter wind blows from each direction. Arrows: how hard it blows,
        against a {Math.round(WIND_ARROW_REFERENCE_MPS * 2.23694)} mph scale shared by every lake.
        {model.emphasizedSector !== null ? ' The solid arrow marks the most exposed shore.' : ''}
      </p>

      {/* The table view the chart owes: every value reachable without reading a shape or a size. */}
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">Show the numbers</summary>
        <table className="mt-2 w-full max-w-xs tabular-nums">
          <thead>
            <tr className="text-left">
              <th scope="col" className="font-medium">
                From
              </th>
              <th scope="col" className="font-medium">
                Hours
              </th>
              <th scope="col" className="font-medium">
                Mean
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPASS_POINTS_16.map((point, sector) => {
              const mps = body.meanWindMps?.[sector];
              return (
                <tr key={point}>
                  <th scope="row" className="font-normal">
                    {point}
                  </th>
                  <td>{Math.round((body.windRose?.[sector] ?? 0) * 100)}%</td>
                  <td>{typeof mps === 'number' ? `${Math.round(mps * 2.23694)} mph` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </section>
  );
}
