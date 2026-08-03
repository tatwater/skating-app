import type { Doc } from '@skating/convex/dataModel';
import { Badge } from '../ui/badge';
import { Card, CardContent } from '../ui/card';

type ImportRun = Doc<'importRuns'>;
type Stage = ImportRun['stages'][number];

/**
 * The full path of one ETL run, rendered as an ordered chain of stages (N6c F2).
 *
 * **Why the path and not just the totals.** A run is an archived extract → an `osmium` filter → a
 * tested transform → a batched load, and the useful questions cross those boundaries: "the count
 * dropped 4% — did OSM change, or did our classifier?" is answerable only when the feature count
 * going *into* the transform sits next to the body count coming out, with the extract's build date
 * above them both. Totals alone answer "how many landed" and nothing else.
 */
export function ImportRunDetail({ run }: { run: ImportRun }) {
  return (
    <div className="flex flex-col gap-4">
      <RunSummary run={run} />
      <Coverage run={run} />
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-foreground text-sm">Path</h3>
        <ol className="flex flex-col gap-2">
          {run.stages.map((stage, i) => (
            <li key={stage.name}>
              <StageCard stage={stage} index={i} />
            </li>
          ))}
        </ol>
        {run.stages.length === 0 ? (
          <p className="text-foreground-muted text-sm">
            This run recorded no stages — it predates the path capture, or the loader was given no
            provenance sidecars.
          </p>
        ) : null}
      </section>
      <Failures run={run} />
    </div>
  );
}

function RunSummary({ run }: { run: ImportRun }) {
  const duration =
    run.finishedAt === undefined ? undefined : formatDuration(run.finishedAt - run.startedAt);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="font-medium text-foreground">{run.label}</span>
          <Badge variant="outline">{run.kind}</Badge>
          {run.campaignId ? <Badge variant="outline">{run.campaignId}</Badge> : null}
          {/* A prod run must never be mistakable for a dev one at a glance. */}
          {run.isProd ? <Badge variant="destructive">production</Badge> : null}
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Deployment" value={<code className="text-xs">{run.deployment}</code>} />
          <Row label="Started" value={new Date(run.startedAt).toLocaleString()} />
          <Row
            label="Finished"
            value={
              run.finishedAt === undefined ? (
                // Not "still running": a row can sit here forever because the process was killed,
                // and that is precisely the failure a printed summary could never record.
                <span className="text-warning">no finish recorded</span>
              ) : (
                `${new Date(run.finishedAt).toLocaleString()}${duration ? ` (${duration})` : ''}`
              )
            }
          />
          <Row label="Failures" value={<FailureCount run={run} />} />
        </dl>
        {run.error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {run.error}
          </p>
        ) : null}
        {run.counts.length > 0 ? <CountGrid counts={run.counts} /> : null}
        {run.notes?.map((note) => (
          <p key={note} className="text-foreground-muted text-xs">
            {note}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Coverage: the rate, and the ledger that has to add up to it.
 *
 * The **unexplained** row is the point of this panel. `eligible − covered` minus the stated
 * omissions is a number nobody wrote down, and it separates "4,000 lakes sit below the source's
 * documented area floor" — a known limit, fine, expected — from "4,000 lakes went missing." Those
 * are indistinguishable in a totals-only summary and they are the two readings that matter, so the
 * remainder is computed here rather than trusted from the loader.
 */
function Coverage({ run }: { run: ImportRun }) {
  const c = run.coverage;
  if (!c) return null;

  const pct = c.eligible > 0 ? (c.covered / c.eligible) * 100 : 0;
  const stated = c.omissions.reduce((sum, o) => sum + o.count, 0);
  const unexplained = c.eligible - c.covered - stated;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-foreground text-sm">Coverage</h3>
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-semibold text-2xl text-foreground tabular-nums">
              {pct.toFixed(1)}%
            </span>
            <span className="text-foreground-muted text-sm">
              {c.covered.toLocaleString()} of {c.eligible.toLocaleString()} {c.unit}
            </span>
          </div>
          {/* Meter, not a chart: one proportion, read at a glance beside its own numbers. */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            role="img"
            aria-label={`${pct.toFixed(1)}% of ${c.unit} covered`}
          >
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
            />
          </div>

          {c.omissions.length > 0 || unexplained !== 0 ? (
            <dl className="flex flex-col gap-1 text-sm">
              {c.omissions.map((o) => (
                <div key={o.reason} className="flex justify-between gap-4">
                  <dt className="text-foreground-muted">{o.reason}</dt>
                  <dd className="tabular-nums">{o.count.toLocaleString()}</dd>
                </div>
              ))}
              {unexplained !== 0 ? (
                <div className="flex justify-between gap-4 border-border border-t pt-1">
                  <dt className="text-warning">
                    unexplained — not covered and not accounted for by any reason above
                  </dt>
                  <dd className="text-warning tabular-nums">{unexplained.toLocaleString()}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function StageCard({ stage, index }: { stage: Stage; index: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-foreground-muted text-xs">{index + 1}</span>
          <span className="font-medium text-foreground text-sm">{stage.name}</span>
          {stage.checksumVerified === true ? (
            <Badge variant="outline">checksum verified</Badge>
          ) : null}
          {/* Absent is not the same as failed, and the badge only claims the second one. */}
          {stage.checksumVerified === false ? (
            <Badge variant="destructive">checksum unverified</Badge>
          ) : null}
        </div>
        {stage.detail ? <p className="text-foreground-muted text-sm">{stage.detail}</p> : null}
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          {stage.sourceUrl ? (
            <Row
              label="Source"
              value={
                <a
                  className="break-all underline"
                  href={stage.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {stage.sourceUrl}
                </a>
              }
            />
          ) : null}
          {stage.sourceAt !== undefined ? (
            <Row label="Built" value={new Date(stage.sourceAt).toISOString().slice(0, 10)} />
          ) : null}
          {stage.input ? (
            <Row label="In" value={<code className="break-all">{stage.input}</code>} />
          ) : null}
          {stage.output ? (
            <Row label="Out" value={<code className="break-all">{stage.output}</code>} />
          ) : null}
          {stage.bytes !== undefined ? <Row label="Size" value={formatBytes(stage.bytes)} /> : null}
          {stage.sha256 ? <Row label="sha256" value={<code>{stage.sha256}</code>} /> : null}
          {stage.md5 ? <Row label="published md5" value={<code>{stage.md5}</code>} /> : null}
        </dl>
        {stage.command ? (
          <pre className="overflow-x-auto rounded-md bg-surface-muted px-3 py-2 text-xs">
            {stage.command}
          </pre>
        ) : null}
        {stage.counts && stage.counts.length > 0 ? <CountGrid counts={stage.counts} /> : null}
      </CardContent>
    </Card>
  );
}

function Failures({ run }: { run: ImportRun }) {
  if (run.failuresTotal === 0) return null;
  const hidden = run.failuresTotal - run.failures.length;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-foreground text-sm">
        Failures <span className="text-foreground-muted">({run.failuresTotal})</span>
      </h3>
      <Card>
        <CardContent className="flex flex-col gap-1 py-3">
          {run.failures.map((f, i) => (
            <div
              key={`${f.stage}-${f.key ?? i}`}
              className="flex flex-wrap items-baseline gap-2 text-sm"
            >
              <Badge variant="outline">{f.stage}</Badge>
              {f.key ? <code className="text-xs">{f.key}</code> : null}
              <span className="text-foreground-muted">{f.reason}</span>
            </div>
          ))}
          {/* The sample says it is a sample. Anything less would make this table a nicer-looking
              version of the problem it was built to fix. */}
          {hidden > 0 ? (
            <p className="pt-1 text-foreground-muted text-xs">
              …and {hidden.toLocaleString()} more not stored — the run keeps the first{' '}
              {run.failures.length} so the reasons are all visible without the repetition.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function FailureCount({ run }: { run: ImportRun }) {
  if (run.failuresTotal === 0) return <span>none</span>;
  return (
    <span className={run.status === 'failed' ? 'text-destructive' : 'text-warning'}>
      {run.failuresTotal.toLocaleString()}
    </span>
  );
}

export function StatusBadge({ status }: { status: ImportRun['status'] }) {
  if (status === 'succeeded') return <Badge variant="outline">succeeded</Badge>;
  if (status === 'failed') return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">running</Badge>;
}

function CountGrid({ counts }: { counts: { name: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      {counts.map((c) => (
        <div key={c.name} className="flex flex-col">
          <span className="font-mono text-foreground-muted text-[10px] uppercase tracking-widest">
            {c.name}
          </span>
          <span className="font-medium text-foreground text-sm tabular-nums">
            {c.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
