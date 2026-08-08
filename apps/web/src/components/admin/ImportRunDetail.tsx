import type { Doc } from '@skating/convex/dataModel';
import type { ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { Card, CardContent } from '../ui/card';

type ImportRun = Doc<'importRuns'>;
type Stage = ImportRun['stages'][number];
type Count = ImportRun['counts'][number];

/**
 * The full path of one ETL run (N6c F2), read top-down as **outcome → funnel → detail → evidence**.
 *
 * **Why the path and not just the totals.** A run is an archived extract → an `osmium` filter → a
 * tested transform → a batched load, and the useful questions cross those boundaries: "the count
 * dropped 4% — did OSM change, or did our classifier?" is answerable only when the feature count
 * going *into* the transform sits next to the body count coming out, with the extract's build date
 * above them both. Totals alone answer "how many landed" and nothing else.
 *
 * **Why the ordering was rebuilt.** The first version rendered every one of a run's tallies as an
 * equal-weight cell in one uppercase grid. That is fine at eight counts and unreadable at forty-five:
 * the N7 merge reports `groups`, `emitted` and `dropped` — the three numbers the pass exists to
 * produce — in the same typeface and the same box as `refused.refused-over-silence`, so nothing on
 * the page said which numbers were the answer. Every count is still here, and none of them is still
 * equal: the outcome is a KPI row, the funnel is a ledger that has to balance, and the long tail is
 * grouped by the prefix the loaders already name it with, sorted, and measured against its own
 * family. Nothing is summarised away — magnitude is just drawn instead of only printed.
 */
export function ImportRunDetail({ run }: { run: ImportRun }) {
  return (
    <div className="flex flex-col gap-6">
      <RunSummary run={run} />
      <Outcome run={run} />
      <Coverage run={run} />
      <Tallies counts={run.counts} />
      <Path run={run} />
      <Failures run={run} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. What this run was
// ─────────────────────────────────────────────────────────────────────────────

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
        {run.notes?.map((note) => (
          <p key={note} className="text-foreground-muted text-xs">
            {note}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The outcome — the four numbers the run exists to produce
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The headline tallies, **taken from the run's last stage when it has one**.
 *
 * A loader's final stage is by construction the one that produced the result — `load` reports what
 * it inserted, `merge` reports what it emitted — so the page does not need a per-loader table of
 * which count names matter, and a new loader gets a correct KPI row for free by naming its own
 * stage counts. {@link HEADLINE_COUNTS} is only the fallback for a run that recorded no stages at
 * all, which is every row written before the provenance pass.
 */
const HEADLINE_COUNTS = [
  'inserted',
  'updated',
  'emitted',
  'kept',
  'created',
  'matched',
  'groups',
  'dropped',
  'stamped',
];

/** How many tiles a KPI row carries before it stops reading as a headline. */
const MAX_HEADLINE_TILES = 4;

function headlineCounts(run: ImportRun): Count[] {
  const last = run.stages.at(-1);
  const fromStage = last?.counts ?? [];
  if (fromStage.length > 0) return fromStage.slice(0, MAX_HEADLINE_TILES);
  const known = HEADLINE_COUNTS.map((name) => run.counts.find((c) => c.name === name)).filter(
    (c): c is Count => c !== undefined,
  );
  const source = known.length > 0 ? known : run.counts.filter((c) => !c.name.includes('.'));
  return source.slice(0, MAX_HEADLINE_TILES);
}

function Outcome({ run }: { run: ImportRun }) {
  const headline = headlineCounts(run);
  if (headline.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        title="Outcome"
        note={
          run.stages.at(-1)?.counts?.length
            ? `as reported by the run's last stage, ${run.stages.at(-1)?.name}`
            : undefined
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {headline.map((c) => (
          <Card key={c.name}>
            <CardContent className="flex flex-col gap-1 py-4">
              <span className="text-foreground-muted text-xs">{humanize(c.name)}</span>
              {/* Proportional figures on a display number — `tabular-nums` makes 121 read loose at
                  this size, and nothing here aligns vertically. */}
              <span className="font-semibold text-2xl text-foreground">
                {c.value.toLocaleString()}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Coverage — the rate, and the ledger that has to add up to it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The **unexplained** row is the point of this panel. `eligible − covered` minus the stated
 * omissions is a number nobody wrote down, and it separates "4,000 lakes sit below the source's
 * documented area floor" — a known limit, fine, expected — from "4,000 lakes went missing." Those
 * are indistinguishable in a totals-only summary, and the remainder is computed here rather than
 * trusted from the loader.
 *
 * The omissions carry proportion bars because the ledger is a funnel and a funnel's shape is the
 * finding: fifteen right-aligned numbers make the reader do the division that says "the area floor
 * is two-thirds of everything we dropped and the rest is noise". One neutral hue, more-is-longer —
 * a magnitude scale, not identity, so no categorical color is involved (and none is warranted).
 */
function Coverage({ run }: { run: ImportRun }) {
  const c = run.coverage;
  if (!c) return null;

  const pct = c.eligible > 0 ? (c.covered / c.eligible) * 100 : 0;
  const stated = c.omissions.reduce((sum, o) => sum + o.count, 0);
  const unexplained = c.eligible - c.covered - stated;
  const omissions = [...c.omissions].sort((a, b) => b.count - a.count);
  const widest = Math.max(1, ...omissions.map((o) => o.count), Math.abs(unexplained));

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        title="Coverage"
        note="everything this pass could have covered, and where the rest went"
      />
      <Card>
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-semibold text-2xl text-foreground">{pct.toFixed(1)}%</span>
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

          {omissions.length > 0 || unexplained !== 0 ? (
            <dl className="flex flex-col gap-2">
              {omissions.map((o) => (
                <MeterRow
                  key={o.reason}
                  label={o.reason}
                  value={o.count}
                  share={o.count / widest}
                  total={c.eligible}
                />
              ))}
              {unexplained !== 0 ? (
                <div className="border-border border-t pt-2">
                  <MeterRow
                    label="unexplained — not covered and not accounted for by any reason above"
                    value={unexplained}
                    share={Math.abs(unexplained) / widest}
                    total={c.eligible}
                    tone="warning"
                  />
                </div>
              ) : null}
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The tallies — every count, grouped by the prefix its loader named it with
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What each known count prefix means, in the words an operator needs rather than the token the
 * loader emits. Anything unlisted falls back to its own prefix, so a new loader's counts group
 * correctly on the day it ships and only lose the prose.
 */
const COUNT_GROUPS: Record<string, { title: string; note?: string }> = {
  refused: {
    title: 'Refused',
    note: 'no catalogue classed the merged group as still water we carry — these never became bodies',
  },
  floor: {
    title: 'Below the admission floor',
    note: 'real water, under the size a named or unnamed body needs to earn a row (D96)',
  },
  queue: {
    title: 'Sent to the review queue',
    note: 'admitted, but flagged for a human — these ARE in the corpus',
  },
  osm: { title: 'OSM lane', note: 'what the five Geofabrik extracts contributed' },
  nhd: { title: 'NHD lane', note: 'what the five USGS geodatabases contributed' },
  '3dhp': { title: '3DHP lane', note: 'what the national 3DHP clip contributed' },
  nhdid: { title: 'NHD identifiers', note: 'how well `Permanent_Identifier` parsed' },
};

/** The bucket for counts with no prefix at all — the run's own totals. */
const UNGROUPED = 'Totals';

/** Rows a group shows before the rest go behind a disclosure. */
const GROUP_PREVIEW = 6;

interface CountGroup {
  key: string;
  title: string;
  note?: string;
  counts: Count[];
}

/**
 * Split `refused.no-class` into `refused` / `no-class`, and file every count under its family.
 *
 * The loaders have named counts this way since N7 (`refused.*`, `floor.*`, `queue.*`, `osm.*`) —
 * the structure was always in the data and the page simply flattened it back out. Groups keep
 * first-appearance order so a loader's own reporting order survives; rows sort by size, because
 * within a family the question is always "which of these is the big one".
 */
export function groupCounts(counts: readonly Count[]): CountGroup[] {
  const groups = new Map<string, CountGroup>();
  for (const count of counts) {
    const dot = count.name.indexOf('.');
    const key = dot === -1 ? UNGROUPED : count.name.slice(0, dot);
    const existing = groups.get(key);
    if (existing) {
      existing.counts.push(count);
      continue;
    }
    const known = COUNT_GROUPS[key];
    groups.set(key, {
      key,
      title: known?.title ?? (key === UNGROUPED ? UNGROUPED : humanize(key)),
      note: known?.note,
      counts: [count],
    });
  }
  // Totals first when present — it is the group every other one is a breakdown of.
  const all = [...groups.values()];
  const totals = all.filter((g) => g.key === UNGROUPED);
  const rest = all.filter((g) => g.key !== UNGROUPED);
  for (const g of rest) g.counts.sort((a, b) => b.value - a.value);
  return [...totals, ...rest];
}

function Tallies({ counts }: { counts: ImportRun['counts'] }) {
  if (counts.length === 0) return null;
  const groups = groupCounts(counts);
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        title="Tallies"
        note={`${counts.length} named count${counts.length === 1 ? '' : 's'}, grouped as the loader named them`}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((group) => (
          <CountGroupCard key={group.key} group={group} />
        ))}
      </div>
    </section>
  );
}

function CountGroupCard({ group }: { group: CountGroup }) {
  // Measured against the family's own largest, not against a run-wide total: a lane's `seen` and
  // `kept` and `dropped` overlap by construction, so a share-of-total bar would sum past 100% and
  // claim a part-to-whole relationship that isn't there. Longest-is-biggest is true in every family.
  const widest = Math.max(1, ...group.counts.map((c) => c.value));
  const shown = group.counts.slice(0, GROUP_PREVIEW);
  const hidden = group.counts.slice(GROUP_PREVIEW);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-col gap-0.5">
          <h4 className="font-medium text-foreground text-sm">{group.title}</h4>
          {group.note ? <p className="text-foreground-muted text-xs">{group.note}</p> : null}
        </div>
        <dl className="flex flex-col gap-2">
          {shown.map((c) => (
            <MeterRow
              key={c.name}
              label={humanize(stripPrefix(c.name))}
              value={c.value}
              share={c.value / widest}
            />
          ))}
        </dl>
        {hidden.length > 0 ? (
          <details className="group">
            <summary className="cursor-pointer text-foreground-muted text-xs underline">
              {hidden.length} more in this group
            </summary>
            <dl className="mt-2 flex flex-col gap-2">
              {hidden.map((c) => (
                <MeterRow
                  key={c.name}
                  label={humanize(stripPrefix(c.name))}
                  value={c.value}
                  share={c.value / widest}
                />
              ))}
            </dl>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One labelled number with a proportion bar under it.
 *
 * The bar is a **hairline under the row**, not a chart: it makes relative size readable without
 * turning a ledger into a plot, and it never replaces the number — the value is always printed, so
 * nothing here is encoded in length alone.
 */
function MeterRow({
  label,
  value,
  share,
  total,
  tone = 'default',
}: {
  label: string;
  value: number;
  share: number;
  /** When given, the row also states its share of this — the funnel reading. */
  total?: number;
  tone?: 'default' | 'warning';
}) {
  const pct = total !== undefined && total > 0 ? (Math.abs(value) / total) * 100 : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <dt className={tone === 'warning' ? 'text-warning' : 'text-foreground-muted'}>{label}</dt>
        <dd
          className={`shrink-0 tabular-nums ${tone === 'warning' ? 'text-warning' : 'text-foreground'}`}
        >
          {value.toLocaleString()}
          {pct !== undefined ? (
            <span className="ml-2 text-foreground-muted text-xs">{pct.toFixed(1)}%</span>
          ) : null}
        </dd>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={`h-full rounded-full ${tone === 'warning' ? 'bg-warning/70' : 'bg-foreground/40'}`}
          style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The path — every file, grouped into the steps they belong to
// ─────────────────────────────────────────────────────────────────────────────

/** The convention loaders name multi-file stages with: `source · osm/vt`. Keep in step with run-log. */
const STAGE_SEPARATOR = ' · ';

interface StageFamily {
  key: string;
  stages: Stage[];
}

/**
 * Group `source · osm/vt`, `source · nhd/VT`, … into one **source** step.
 *
 * Seventeen archives is seventeen checksums and there is nowhere else to put them — `RunStage`
 * carries exactly one `sha256`, one URL, one date, so rolling a catalogue into a single stage would
 * discard the only field that answers "is this the archive we think". Grouping on the separator lets
 * the path read as the four steps it conceptually is while keeping every file's evidence one click
 * away. A stage with no separator is its own family of one and renders unchanged.
 */
export function groupStages(stages: readonly Stage[]): StageFamily[] {
  const families: StageFamily[] = [];
  for (const stage of stages) {
    const at = stage.name.indexOf(STAGE_SEPARATOR);
    const key = at === -1 ? stage.name : stage.name.slice(0, at);
    const last = families.at(-1);
    if (last && last.key === key) last.stages.push(stage);
    else families.push({ key, stages: [stage] });
  }
  return families;
}

function Path({ run }: { run: ImportRun }) {
  const families = groupStages(run.stages);
  let stageNumber = 0;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        title="Path"
        note="the archived files this run read, and what each step did to them"
      />
      {run.stages.length === 0 ? <NoPath /> : null}
      <ol className="flex flex-col gap-2">
        {families.map((family, i) => {
          const from = stageNumber + 1;
          stageNumber += family.stages.length;
          return (
            <li key={family.key}>
              {family.stages.length === 1 && family.stages[0] ? (
                <StageCard stage={family.stages[0]} index={i} label={String(from)} />
              ) : (
                <StageFamilyCard family={family} index={i} from={from} />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The empty state, which used to be the whole answer this page gave for the N7 merge.
 *
 * "The loader was given no provenance sidecars" was true and useless: it named an internal concept,
 * assigned the blame to a file nobody had heard of, and offered no way to tell "this loader cannot
 * record a path" from "this loader can and wasn't asked to". Say what a sidecar is, say which case
 * this is, and say the command.
 */
function NoPath() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-4 text-sm">
        <p className="text-foreground">This run recorded no stages, so its path is unknown.</p>
        <p className="text-foreground-muted">
          A stage is one step of the pipeline — a download, a filter, a transform, the load — and a
          loader learns about the steps before its own from the <strong>manifests</strong> the
          fetchers write beside every archived file (<code className="text-xs">manifest.json</code>,{' '}
          <code className="text-xs">merge-manifest.json</code>). Those files carry the source URL,
          the publisher's build date, the size and the checksum. A run with no stages either predates
          that capture or was invoked without reaching them.
        </p>
        <p className="text-foreground-muted">
          Re-running through <code className="text-xs">scripts/etl/run-corpus.sh</code> or{' '}
          <code className="text-xs">run-canonical.sh</code> records the full path; the loaders also
          discover a <code className="text-xs">merge-manifest.json</code> sitting beside their input
          on their own.
        </p>
      </CardContent>
    </Card>
  );
}

/** A step made of several archived files — the five OSM extracts, the five NHD geodatabases. */
function StageFamilyCard({
  family,
  index,
  from,
}: {
  family: StageFamily;
  index: number;
  from: number;
}) {
  const bytes = family.stages.reduce((sum, s) => sum + (s.bytes ?? 0), 0);
  const verified = family.stages.filter((s) => s.checksumVerified === true).length;
  const failed = family.stages.filter((s) => s.checksumVerified === false).length;
  const missing = family.stages.filter((s) => s.detail?.startsWith('MISSING')).length;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-foreground-muted text-xs">
            {index + 1}
            {family.stages.length > 1 ? ` · ${from}–${from + family.stages.length - 1}` : ''}
          </span>
          <span className="font-medium text-foreground text-sm">{family.key}</span>
          <span className="text-foreground-muted text-xs">
            {family.stages.length} files
            {bytes > 0 ? ` · ${formatBytes(bytes)}` : ''}
          </span>
          {verified > 0 ? (
            <Badge variant="outline">{`${verified}/${family.stages.length} checksum verified`}</Badge>
          ) : null}
          {/* Absent is not the same as failed, and each badge only claims its own case. */}
          {failed > 0 ? (
            <Badge variant="destructive">{`${failed} checksum unverified`}</Badge>
          ) : null}
          {missing > 0 ? <Badge variant="destructive">{`${missing} missing`}</Badge> : null}
        </div>
        <details>
          <summary className="cursor-pointer text-foreground-muted text-xs underline">
            {family.stages.map((s) => s.name.slice(family.key.length + STAGE_SEPARATOR.length)).join(', ')}
          </summary>
          <ol className="mt-2 flex flex-col gap-2">
            {family.stages.map((stage, i) => (
              <li key={stage.name}>
                <StageCard stage={stage} index={from + i - 1} nested />
              </li>
            ))}
          </ol>
        </details>
      </CardContent>
    </Card>
  );
}

function StageCard({
  stage,
  index,
  label,
  nested = false,
}: {
  stage: Stage;
  index: number;
  label?: string;
  nested?: boolean;
}) {
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-foreground-muted text-xs">{label ?? index + 1}</span>
        <span className="font-medium text-foreground text-sm">{stage.name}</span>
        {stage.checksumVerified === true ? (
          <Badge variant="outline">checksum verified</Badge>
        ) : null}
        {/* Absent is not the same as failed, and the badge only claims the second one. */}
        {stage.checksumVerified === false ? (
          <Badge variant="destructive">checksum unverified</Badge>
        ) : null}
      </div>
      {stage.detail ? (
        <p
          className={
            stage.detail.startsWith('MISSING')
              ? 'text-destructive text-sm'
              : 'text-foreground-muted text-sm'
          }
        >
          {stage.detail}
        </p>
      ) : null}
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
      {stage.counts && stage.counts.length > 0 ? <StageCounts counts={stage.counts} /> : null}
    </>
  );

  if (nested) {
    return (
      <div className="flex flex-col gap-2 border-border border-l pl-3">{body}</div>
    );
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-3">{body}</CardContent>
    </Card>
  );
}

/** A stage's own tallies — few enough per stage that the flat row is still the right form. */
function StageCounts({ counts }: { counts: { name: string; value: number }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      {counts.map((c) => (
        <div key={c.name} className="flex flex-col">
          <span className="text-foreground-muted text-xs">{humanize(c.name)}</span>
          <span className="font-medium text-foreground text-sm tabular-nums">
            {c.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Failures
// ─────────────────────────────────────────────────────────────────────────────

function Failures({ run }: { run: ImportRun }) {
  if (run.failuresTotal === 0) return null;
  const hidden = run.failuresTotal - run.failures.length;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        title="Failures"
        note={`${run.failuresTotal.toLocaleString()} recorded — the items that did not make it`}
      />
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

/** A section title with the one line of context that stops it needing a legend. */
function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <h3 className="font-medium text-foreground text-sm">{title}</h3>
      {note ? <span className="text-foreground-muted text-xs">{note}</span> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-foreground-muted">{label}</dt>
      <dd className="min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

/** `refused.no-class` → `no-class`. The family is already the heading above it. */
function stripPrefix(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * `droppedByAreaFloor` / `below-hard-floor` → readable words.
 *
 * Not `UPPERCASE tracking-widest`, which is what these labels used to wear: a monospaced shout is
 * fine on four tiles and becomes a wall at forty-five, and it made `REFUSED.REFUSED-OVER-SILENCE`
 * harder to read than the token it was styling.
 */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
