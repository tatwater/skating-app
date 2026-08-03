import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import {
  ChartCard,
  ChartEmpty,
  MiniTable,
  type SeriesLine,
  TimeSeriesChart,
} from '../charts/Charts';
import { AdminEmpty, StatTile } from './adminUi';

/**
 * The long-horizon watch on the base map under the whole product (N7).
 *
 * USGS retired the National Hydrography Dataset in 2023 and replaced it with the 3D Hydrography
 * Program, whose promise is hydrography traced from LiDAR rather than compiled at 1:24,000. Where
 * that elevation-derived hydrography does not exist yet, 3DHP **republishes NHD** — and labels each
 * feature's provenance in `workunitid`. So this panel answers one question: *how much of the water we
 * draw has actually been re-surveyed?*
 *
 * **It reads near zero today and is expected to for years.** That is the point rather than a defect:
 * a series that starts at zero and steps up is only legible if somebody recorded the zeroes.
 *
 * ## Why stat tiles first and the chart second
 *
 * The measurement runs on the *publisher's* cadence — 3DHP ships annually — so this series has one
 * point per year, not one per day. Two consequences shape the layout:
 *
 * - With a single measurement there is no trend, and the honest form for "a current value" is a stat
 *   tile, not a one-point line (which the chart kit would draw as literally nothing, since it renders
 *   lines without dots). The trend appears once a second year exists, and says so until then.
 * - The read goes through `analytics.catalogueHistory`, which returns the rows **as measured**, rather
 *   than `analytics.series`, which generates a dense run of days and fills gaps with nulls. Dense days
 *   are right for a rollup, where a quiet day is a real zero; here the gaps are years of nothing being
 *   published, and the dense reader also caps at 365 days — which would hide every prior year, the
 *   entire point of the panel.
 *
 * ## The two numbers, and why the gap between them matters
 *
 * `archive` is the annual release we mirror and build the corpus from. `live` is the same layer from
 * the quarterly-refreshed service. **The gap is what the annual cadence costs us** — as of 2026-08-03
 * the archive holds 0 elevation-derived bodies while the service already publishes 1,590, all in
 * western Massachusetts. Showing both makes that visible instead of a surprise at the next refresh.
 */

const METRIC = 'catalogue_edh_coverage';

interface CoverageSide {
  total?: number;
  elevationDerived?: number;
  share?: number;
}

interface CoverageMeta {
  release?: string;
  archive?: CoverageSide;
  live?: CoverageSide;
}

/**
 * Percent with enough precision to be worth reading near zero.
 *
 * The kit's default percent formatter rounds to whole numbers, which for a metric that spends its
 * first years between 0% and 0.5% renders every point as `0%` — a chart that looks broken while
 * working perfectly. Scales its own precision to the value instead.
 */
export function formatShare(share: number | null | undefined): string {
  if (share === null || share === undefined) return '—';
  if (share === 0) return '0%';
  const pct = share * 100;
  if (pct < 0.01) return `${pct.toFixed(4)}%`;
  if (pct < 1) return `${pct.toFixed(3)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function formatCount(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString();
}

const LINES: SeriesLine[] = [
  { key: 'archive', label: 'In our corpus' },
  { key: 'live', label: 'Published upstream' },
];

export function CatalogueCoverage() {
  const history = useQuery(api.analytics.catalogueHistory, { metric: METRIC });

  if (history === undefined) return <AdminEmpty>Loading…</AdminEmpty>;
  if (history.length === 0) {
    return (
      <AdminEmpty>
        No catalogue measurement yet — run <code>pnpm --filter @skating/etl measure-3dhp</code>.
      </AdminEmpty>
    );
  }

  const newest = history[history.length - 1];
  const meta = (newest?.meta ?? {}) as CoverageMeta;
  const archive = meta.archive ?? {};
  const live = meta.live ?? {};

  const rows = history.map((row) => {
    const m = (row.meta ?? {}) as CoverageMeta;
    return {
      date: row.date,
      archive: row.scalar ?? m.archive?.share ?? null,
      live: m.live?.share ?? null,
    };
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Re-surveyed"
          value={formatShare(archive.share)}
          hint={`${formatCount(archive.elevationDerived)} of ${formatCount(archive.total)} water bodies in the release we build from`}
        />
        <StatTile
          label="Published upstream"
          value={formatShare(live.share)}
          hint={`${formatCount(live.elevationDerived)} of ${formatCount(live.total)} in the live service — refreshed quarterly, so it moves first`}
        />
        <StatTile
          label="Still from NHD"
          value={formatCount(
            archive.total !== undefined && archive.elevationDerived !== undefined
              ? archive.total - archive.elevationDerived
              : undefined,
          )}
          hint="Inherited from the dataset USGS retired in 2023 — accurate, but compiled rather than measured"
        />
        <StatTile
          label="Measured"
          value={newest?.date ?? '—'}
          hint={`${meta.release ?? 'unknown'} release · ${history.length} measurement${history.length === 1 ? '' : 's'} on file`}
        />
      </div>

      <ChartCard
        title="Elevation-derived hydrography over time"
        description="Share of the water bodies in our five states that USGS has re-traced from LiDAR rather than inherited from the retired NHD. Expected to sit near zero for years and then step up a work unit at a time."
        note={
          history.length < 2
            ? 'One measurement so far — the trend line starts at the next annual release. The zero is recorded on purpose: a series that begins at zero is only legible if somebody wrote the zeroes down.'
            : undefined
        }
        table={
          <MiniTable
            headers={['Measured', 'In our corpus', 'Published upstream']}
            rows={rows.map((r) => [r.date, formatShare(r.archive), formatShare(r.live)])}
          />
        }
      >
        {history.length >= 2 ? (
          <TimeSeriesChart data={rows} lines={LINES} height={200} yFormatter={formatShare} />
        ) : (
          <ChartEmpty>
            A trend needs two measurements. The next one is due with the next annual 3DHP release.
          </ChartEmpty>
        )}
      </ChartCard>
    </div>
  );
}
