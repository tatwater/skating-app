import { api } from '@skating/convex/api';
import { cmToInches, formatTemperatureF, roundTo } from '@skating/core';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';

/**
 * **Does the growth model work?** — the ice-thickness calibration instrument (N6h / **D160**).
 *
 * ## This page is the entire reason the estimator is allowed to exist
 *
 * The Stefan model produces a number in inches, which is the most counsel-shaped quantity this
 * codebase can produce and exactly what D3 forbids publishing. D160 permits it as an **operator
 * instrument that ships dark**, on the same pattern as N5c's hazard advisory and N6e's phenology
 * brackets: computed, stored, shown only here, and judged against reality before anyone decides
 * whether it earns a skater surface.
 *
 * So the job of this page is not to display thicknesses. It is to answer *how wrong are we* — and to
 * make a bad answer visible rather than comfortable.
 *
 * ⚠ **Nothing here writes anything.** The fitted α is reported and never applied; `estimateIceThickness`
 * keeps its published default until a human changes the constant in code. An auto-retuning model
 * would be a derived thickness feeding itself, which is what D160's second rule forbids.
 *
 * ⚠ **Do not add a link to this from any skater surface.** Graduating the estimate needs its own
 * decision, and the honest expectation recorded in the phase doc is that it will perform poorly —
 * because air-temperature FDD ignores snow insulation, wind, depth, current and springs.
 */
export const Route = createFileRoute('/admin/ice-calibration')({ component: AdminIceCalibration });

/** Below this many pairs the fit is a curiosity rather than a calibration, and the page says so. */
const MEANINGFUL_SAMPLE = 12;

function AdminIceCalibration() {
  const data = useQuery(api.iceCalibration.calibrationPairs, {});
  const fit = useQuery(api.iceCalibration.calibrationFit, {});

  if (data === undefined) return <AdminPageHeader title="Ice calibration" />;

  const pairs = data.pairs;
  const usable = pairs.filter((p) => !p.declined && p.predictedCm !== null);

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        subtitle={`Stefan h = α√(FDD) against measured thicknesses, over a ${data.windowDays}-day growth window. Operator-only (D160) — never shown to skaters, and never an input to anything.`}
        title="Ice calibration"
      />

      <Card>
        <CardContent className="flex flex-col gap-2">
          <h2 className="font-semibold text-sm">The fit</h2>
          {fit === undefined ? (
            <p className="text-foreground-muted text-sm">Fitting…</p>
          ) : fit.fitted === null ? (
            <p className="text-foreground-muted text-sm">
              No usable pairs yet. A pair needs a visible report with at least one{' '}
              <code>measured</code> reading and archived weather covering the {data.windowDays} days
              before it.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <Stat label="Fitted α" value={roundTo(fit.fitted.alpha, 2)} />
                <Stat label="Shipped α" value={roundTo(fit.defaultAlpha, 2)} />
                <Stat label="RMSE" value={`${roundTo(cmToInches(fit.fitted.rmseCm), 1)}″`} />
                <Stat label="Pairs" value={fit.fitted.n} />
              </dl>
              {fit.fitted.n < MEANINGFUL_SAMPLE && (
                <p className="text-foreground-muted text-xs italic">
                  {fit.fitted.n} pair{fit.fitted.n === 1 ? '' : 's'} is a curiosity, not a
                  calibration. The number to watch is RMSE once a season has accumulated.
                </p>
              )}
              {/* The published lake-ice range. A fit outside it is a signal about the *data*, not a
                  better coefficient — most likely reports paired against the wrong window. */}
              {(fit.fitted.alpha < 1.4 || fit.fitted.alpha > 3.0) && (
                <p className="text-warning text-xs">
                  Fitted α is outside the published lake-ice range of 1.4–3.0, which usually means
                  the pairs are wrong rather than the coefficient.
                </p>
              )}
              {fit.declined > 0 && (
                <p className="text-foreground-muted text-xs">
                  {fit.declined} pair{fit.declined === 1 ? '' : 's'} excluded: too much thaw in the
                  window for a growth model to mean anything.
                </p>
              )}
            </>
          )}
          {data.excludedEstimates > 0 && (
            <p className="text-foreground-muted text-xs">
              {data.excludedEstimates} report{data.excludedEstimates === 1 ? '' : 's'} skipped for
              having only <code>estimated</code> readings — fitting to a guess and reporting the
              agreement would be validating nothing.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-2">
          <h2 className="font-semibold text-sm">
            Pairs <span className="font-normal text-foreground-muted">({pairs.length})</span>
          </h2>
          {pairs.length === 0 ? (
            <AdminEmpty>
              Nothing to calibrate against yet. This fills as reports with drilled measurements
              accumulate over a season.
            </AdminEmpty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-foreground-muted text-xs uppercase">
                  <tr>
                    <th className="py-1 text-left font-normal">Lake</th>
                    <th className="py-1 text-right font-normal">Measured</th>
                    <th className="py-1 text-right font-normal">Predicted</th>
                    <th className="py-1 text-right font-normal">Error</th>
                    <th className="py-1 text-right font-normal">FDD</th>
                    <th className="py-1 text-right font-normal">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair) => {
                    const observedIn = cmToInches(pair.observedCm);
                    const predictedIn =
                      pair.predictedCm === null ? null : cmToInches(pair.predictedCm);
                    const errorIn = predictedIn === null ? null : predictedIn - observedIn;
                    return (
                      <tr className="border-border border-t" key={pair.reportId}>
                        <td className="py-1">
                          {pair.waterBodyName || <span className="italic">unnamed</span>}
                          {pair.readingCount > 1 && (
                            <span className="ml-1 text-foreground-muted text-xs">
                              ×{pair.readingCount}
                            </span>
                          )}
                        </td>
                        <td className="py-1 text-right tabular-nums">{roundTo(observedIn, 1)}″</td>
                        <td className="py-1 text-right tabular-nums">
                          {predictedIn === null ? (
                            <Badge variant="outline">declined</Badge>
                          ) : (
                            `${roundTo(predictedIn, 1)}″`
                          )}
                        </td>
                        <td
                          className={`py-1 text-right tabular-nums ${
                            errorIn !== null && Math.abs(errorIn) > 2 ? 'text-warning' : ''
                          }`}
                        >
                          {errorIn === null
                            ? '—'
                            : `${errorIn > 0 ? '+' : ''}${roundTo(errorIn, 1)}″`}
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          {roundTo(pair.freezingDegreeHours / 24, 0)}
                        </td>
                        <td className="py-1 text-right tabular-nums">{pair.daysObserved}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-1 text-foreground-muted text-xs">
          <p>
            <strong className="text-foreground">What this cannot tell you.</strong> Stefan is a
            growth model: it answers how much ice would form on still open water exposed to this
            much cold. It does not know what was there when the window opened, and thaw does not
            appear in it — which is why a window with more than a few days of it is declined
            outright.
          </p>
          <p>
            FDD is accumulated freezing degree-days below {formatTemperatureF(0)}, from the{' '}
            {data.windowDays} days before each skate. The window is a fixed lookback rather than the
            season's first sustained freeze, because the phenology brackets that would anchor it
            properly are not wired yet.
          </p>
          <p>
            {usable.length} of {pairs.length} pairs are usable. Air-temperature FDD ignores snow
            insulation, wind, water depth, current and springs, so a large RMSE is the expected
            result rather than a bug — the point of collecting a season is to find out how large.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-foreground-muted text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
