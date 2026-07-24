import { api } from '@skating/convex/api';
import { humanizeEnum } from '@skating/core';
import { useQuery } from 'convex/react';
import {
  ChartCard,
  ChartEmpty,
  type ChartStatus,
  CompositionChart,
  type CompositionSlice,
  DiagonalScatter,
  HistogramChart,
  MiniTable,
  type ScatterPoint,
  type SeriesLine,
  TimeSeriesChart,
} from '../charts/Charts';

/**
 * The bridge from the analytics queries to the chart kit (Phase 7b). Each component here fetches one
 * metric (or a small set) and renders it through the right chart for its shape, so the dashboard and
 * the tuning control-room stay declarative — a page names the metric it wants and gets a titled,
 * table-backed, empty-state-aware card. The metric's label + description + axis labels come from the
 * server `catalogue`, so a chart can never drift from the rollup that fills it.
 */

/** A day count for trend windows — the default the analytics queries use. */
const DEFAULT_DAYS = 30;

/** The metric catalogue, keyed for lookup. Cached by Convex, so calling this per card is cheap. */
export function useCatalogue() {
  const entries = useQuery(api.analytics.catalogue, {});
  if (!entries) return null;
  return new Map(entries.map((e) => [e.key, e]));
}

type CatalogueEntry =
  NonNullable<ReturnType<typeof useCatalogue>> extends Map<string, infer V> ? V : never;

/** Humanize a metric meta key: `spam:actioned` → "Spam · Actioned", `still_here` → "Still here". */
function humanizeMetaKey(key: string): string {
  return key
    .split(':')
    .map((part) => humanizeEnum(part))
    .join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Scalar trends
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A time series of one or more scalar metrics over a trailing window. Pass `status` on a line whose
 * value carries polarity (a rate); otherwise it takes the next categorical slot. Renders the shared
 * `catalogue` description under the chart, so the "what does this tune?" text lives in one place.
 */
export function ScalarTrend({
  metrics,
  title,
  description,
  days = DEFAULT_DAYS,
  percent = false,
  height,
}: {
  metrics: Array<{ key: string; label: string; status?: ChartStatus }>;
  title: string;
  description?: string;
  days?: number;
  percent?: boolean;
  height?: number;
}) {
  const keys = metrics.map((m) => m.key);
  const result = useQuery(api.analytics.series, { metrics: keys, days });
  if (result === undefined) return <LoadingCard title={title} />;

  // Zip the per-metric series into one row per date: { date, [key]: value }.
  const rows = result.dates.map((date, i) => {
    const row: Record<string, number | string | null> = { date };
    for (const m of metrics) {
      const point = result.series[m.key]?.[i];
      row[m.key] = point?.scalar ?? null;
    }
    return row;
  });
  const lines: SeriesLine[] = metrics.map((m) => ({
    key: m.key,
    label: m.label,
    ...(m.status ? { status: m.status } : {}),
  }));
  const yFormatter = percent ? (v: number) => `${Math.round(v * 100)}%` : undefined;

  const hasData = rows.some((r) => metrics.some((m) => r[m.key] !== null));
  return (
    <ChartCard
      title={title}
      description={description}
      table={
        <MiniTable
          headers={['Day', ...metrics.map((m) => m.label)]}
          rows={rows.map((r) => [
            String(r.date),
            ...metrics.map((m) => formatCell(r[m.key], percent)),
          ])}
        />
      }
    >
      {hasData ? (
        <TimeSeriesChart
          data={rows}
          lines={lines}
          {...(height ? { height } : {})}
          {...(yFormatter ? { yFormatter } : {})}
        />
      ) : (
        <ChartEmpty>No data in the last {days} days yet.</ChartEmpty>
      )}
    </ChartCard>
  );
}

function formatCell(value: number | string | null | undefined, percent: boolean): string | number {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return percent ? `${Math.round(value * 100)}%` : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Histograms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The latest snapshot of a bucketed metric, drawn as a histogram with axis labels from the catalogue.
 * `markers` overlays labelled reference lines at named buckets — the trust-class cutoffs on the
 * reputation distribution, the flag threshold on the contradiction distribution.
 */
export function MetricHistogram({
  metricKey,
  catalogue,
  markers,
  color,
  height,
}: {
  metricKey: string;
  catalogue: Map<string, CatalogueEntry> | null;
  markers?: { atLabel: string; label: string }[];
  color?: ChartStatus;
  height?: number;
}) {
  const result = useQuery(api.analytics.latest, { metrics: [metricKey] });
  const entry = catalogue?.get(metricKey);
  if (result === undefined || catalogue === null)
    return <LoadingCard title={entry?.label ?? '…'} />;
  const point = result[metricKey];
  const labels = entry?.bucketLabels ?? [];
  const counts = point?.buckets ?? [];
  const empty = counts.length === 0 || counts.every((c) => c === 0);

  return (
    <ChartCard
      title={entry?.label ?? metricKey}
      description={entry?.description}
      note={point?.date ? `As of ${point.date}.` : undefined}
      table={
        <MiniTable
          headers={['Bucket', 'Count']}
          rows={labels.map((label, i) => [label, counts[i] ?? 0])}
        />
      }
    >
      {empty ? (
        <ChartEmpty>No data yet.</ChartEmpty>
      ) : (
        <HistogramChart
          labels={labels}
          counts={counts}
          {...(markers ? { markers } : {})}
          {...(color ? { color } : {})}
          {...(height ? { height } : {})}
        />
      )}
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compositions (meta records)
// ─────────────────────────────────────────────────────────────────────────────

/** Assign a status hue to a meta key by matching known polarity words — else undefined (categorical). */
function metaStatus(key: string): ChartStatus | undefined {
  const k = key.toLowerCase();
  if (/(allowed|good|helpful|fully_healed|resolved|actioned)/.test(k)) return 'good';
  if (/(suppressed|capped|bad|dismissed|still_here|aged)/.test(k)) return 'warning';
  if (/(unsafe|removed|banned|hidden)/.test(k)) return 'bad';
  return undefined;
}

/**
 * The latest snapshot of a `meta`-shaped metric as a horizontal composition. `statusByKey` opts a
 * metric into semantic hues (a gate mix, a disposition split); left off, slices take categorical slots.
 */
export function MetricComposition({
  metricKey,
  catalogue,
  semantic = false,
  height,
}: {
  metricKey: string;
  catalogue: Map<string, CatalogueEntry> | null;
  semantic?: boolean;
  height?: number;
}) {
  const result = useQuery(api.analytics.latest, { metrics: [metricKey] });
  const entry = catalogue?.get(metricKey);
  if (result === undefined || catalogue === null)
    return <LoadingCard title={entry?.label ?? '…'} />;
  const meta = result[metricKey]?.meta ?? {};
  const slices: CompositionSlice[] = Object.entries(meta).map(([key, value]) => ({
    key,
    label: humanizeMetaKey(key),
    value: value as number,
    ...(semantic && metaStatus(key) ? { status: metaStatus(key) as ChartStatus } : {}),
  }));

  return (
    <ChartCard
      title={entry?.label ?? metricKey}
      description={entry?.description}
      note={result[metricKey]?.date ? `As of ${result[metricKey]?.date}.` : undefined}
      table={
        <MiniTable headers={['Category', 'Count']} rows={slices.map((s) => [s.label, s.value])} />
      }
    >
      <CompositionChart slices={slices} {...(height ? { height } : {})} />
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The bounty suppression scatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bounty suppression scatter (roadmap D56 §7c) — one dot per create attempt, *report age* vs *the
 * freshness window actually applied*. A dot above the y=x diagonal is an attempt allowed through
 * (report older than its window); below, one blocked. A weather-reopened allow is drawn `good` — those
 * are the dots the reopen thresholds are there to produce — and everything else by its verdict.
 */
export function GateScatterCard({ days = DEFAULT_DAYS }: { days?: number }) {
  const result = useQuery(api.analytics.bountyGateScatter, { days });
  if (result === undefined) return <LoadingCard title="Bounty suppression" />;

  const points: ScatterPoint[] = result.points.map((p) => ({
    x: Math.round(p.reportAgeH * 10) / 10,
    y: Math.round(p.appliedWindowH * 10) / 10,
    status: p.weatherReopened ? 'good' : p.decision === 'suppressed' ? 'bad' : 'neutral',
  }));

  return (
    <ChartCard
      title="Bounty suppression"
      description="Report age at the attempt vs the freshness window applied. Above the line = allowed (older than its window); below = blocked. Green dots are weather-reopened allows — what BOUNTY_REOPEN_* exists to produce."
      note={
        result.truncated
          ? `Showing the oldest ${result.points.length} attempts in the window — the cap was hit.`
          : `${result.points.length} attempts in the last ${days} days.`
      }
      table={
        <MiniTable
          headers={['Age (h)', 'Window (h)', 'Decision', 'Weather-reopened']}
          rows={result.points.map((p) => [
            Math.round(p.reportAgeH * 10) / 10,
            Math.round(p.appliedWindowH * 10) / 10,
            p.decision,
            p.weatherReopened ? 'yes' : 'no',
          ])}
        />
      }
    >
      {points.length === 0 ? (
        <ChartEmpty>
          No bounty attempts recorded yet — this fills as people post bounties.
        </ChartEmpty>
      ) : (
        <DiagonalScatter points={points} xLabel="Report age (h)" yLabel="Window applied (h)" />
      )}
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

function LoadingCard({ title }: { title: string }) {
  return (
    <ChartCard title={title}>
      <ChartEmpty>Loading…</ChartEmpty>
    </ChartCard>
  );
}
