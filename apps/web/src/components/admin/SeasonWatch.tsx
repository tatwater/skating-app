import {
  celsiusToFahrenheit,
  durationInWords,
  MAX_ROSTER_SITES,
  type SeasonWatchSettings,
  validateSeasonWatchSettings,
} from '@skating/core';
import { useTheme } from 'next-themes';
import { type ReactNode, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  chartRows,
  lowF,
  type PreviewRow,
  type RosterEntry,
  type SentinelCrossing,
  type SeriesDoc,
  type SettingsForm,
  shortDay,
} from '@/lib/seasonPreview';
import { ChartLegend } from '../charts/Charts';
import { CHART_TOKENS, chartSeries } from '../charts/palette';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { StatTile, Table, Td, Th } from './adminUi';

/**
 * `/admin/seasons`' parts (A06i §6, D213, D214) — presentational, so each renders from props in a
 * test. The route wires them to Convex.
 *
 * ⚠ **Air temperature, never ice (D3).** Every date on this page is a summit's cold night or a share
 * of lakes below a line. The copy says "had a night at or below", never "froze over", and no state
 * here means a lake is skateable.
 */

/** A section with a title and one line of why — the page is long, and each part answers one question. */
export function Section({
  title,
  blurb,
  actions,
  children,
}: {
  title: string;
  blurb?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-semibold text-foreground text-lg">{title}</h2>
          {blurb ? <p className="max-w-3xl text-foreground-muted text-sm">{blurb}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Run an async action with a busy flag and an inline error — every button here does the same. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, '') : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export interface NamedLow {
  name: string;
  state?: string;
  lowC: number;
}

export interface WatchRow {
  season: string;
  opensOn: string;
  openedBy: string[];
  winterFrom: string | null;
  closesOn?: string;
  detectedAt: number;
  settingsVersion?: number;
  opening?: { sentinels: NamedLow[]; corpus: { frozen: number; reporting: number } };
  imageryNudgeOn?: string;
  imageryNudgeSites?: NamedLow[];
  winter?: { frozen: NamedLow[]; reporting: number };
  emailQueue?: { email: { kind: string; date: string } }[];
  emailsSent?: { kind: string; sentOn: string }[];
  imageryStartedAt?: number;
  imageryPausedAt?: number;
}

const EMAIL_LABELS: Record<string, string> = {
  opened: 'Ice watch has begun',
  imagery: 'Time to start satellite imagery',
  winter: 'Winter has set in region-wide',
  closed: 'Ice watch has ended',
};

function siteName(s: { name: string; state?: string | null }) {
  return s.state ? `${s.name}, ${s.state}` : s.name;
}

function LowsTable({ label, sites }: { label: string; sites: NamedLow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>{label}</Th>
          <Th>Overnight low</Th>
        </tr>
      </thead>
      <tbody>
        {sites.map((s) => (
          <tr key={`${s.name}-${s.lowC}`}>
            <Td>{siteName(s)}</Td>
            <Td className="tabular-nums">{lowF(s.lowC)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** This season's watch: what opened it, what it has reached, which emails went, and the reset. */
export function WatchCard({
  season,
  floor,
  row,
  onReset,
}: {
  season: string;
  floor: string;
  row: WatchRow | null;
  onReset: (confirm: string) => Promise<unknown>;
}) {
  if (!row) {
    return (
      <Card>
        <CardContent className="py-5 text-foreground-muted text-sm">
          No ice watch is open for {season}. The daily check counts nights from {shortDay(floor)}.
        </CardContent>
      </Card>
    );
  }
  const by = row.openedBy.map((b) => (b === 'sentinel' ? 'a sentinel' : 'the ordinary lakes'));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Watch began"
          value={shortDay(row.opensOn)}
          hint={`Opened by ${by.join(' and ')}`}
        />
        <StatTile
          label="First imagery-line night"
          value={shortDay(row.imageryNudgeOn)}
          hint={row.imageryNudgeOn ? 'At a sentinel' : 'Not yet'}
        />
        <StatTile
          label="Winter region-wide"
          value={shortDay(row.winterFrom)}
          hint={
            row.winter
              ? `${row.winter.frozen.length} of ${row.winter.reporting} ordinary lakes`
              : 'Not yet'
          }
        />
        <StatTile
          label="Watch ended"
          value={shortDay(row.closesOn)}
          hint={row.closesOn ? '' : 'Still watching'}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-foreground text-sm">What opened it</h3>
          {row.opening ? (
            <>
              {row.opening.sentinels.length > 0 ? (
                <LowsTable
                  label={`Sentinel, ${shortDay(row.opensOn)}`}
                  sites={row.opening.sentinels}
                />
              ) : null}
              <p className="text-foreground-muted text-sm">
                That night {row.opening.corpus.frozen} of {row.opening.corpus.reporting} ordinary
                lakes had a low at or below the freezing line.
              </p>
            </>
          ) : (
            <p className="text-foreground-muted text-sm">
              Recorded before the watch kept its measurements; the next daily check fills this in.
            </p>
          )}
          <p className="text-foreground-muted text-xs">
            Decided under{' '}
            {row.settingsVersion === 0
              ? 'the defaults it shipped with (before versions)'
              : `settings version ${row.settingsVersion ?? '—'}`}{' '}
            · {new Date(row.detectedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-foreground text-sm">Staff emails</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {(row.emailsSent ?? []).map((e) => (
              <li key={`${e.kind}-${e.sentOn}`} className="flex justify-between gap-2">
                <span>{EMAIL_LABELS[e.kind] ?? e.kind}</span>
                <span className="text-foreground-muted tabular-nums">
                  sent {shortDay(e.sentOn)}
                </span>
              </li>
            ))}
            {(row.emailQueue ?? []).map((q) => (
              <li key={`${q.email.kind}-${q.email.date}`} className="flex justify-between gap-2">
                <span>{EMAIL_LABELS[q.email.kind] ?? q.email.kind}</span>
                <Badge variant="outline">queued — one a day</Badge>
              </li>
            ))}
            {(row.emailsSent ?? []).length + (row.emailQueue ?? []).length === 0 ? (
              <li className="text-foreground-muted">None yet.</li>
            ) : null}
          </ul>
          <ResetDialog season={season} onReset={onReset} />
        </div>
      </div>
    </div>
  );
}

function ResetDialog({
  season,
  onReset,
}: {
  season: string;
  onReset: (confirm: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="self-start">
            Reset this watch…
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset the {season} watch</DialogTitle>
          <DialogDescription>
            The record moves to the superseded list and is kept. The weather sweep and satellite
            imagery stop until the watch opens again, which the next daily check decides under the
            current settings — and re-sends the opening email, saying which notice it replaces.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-confirm">Type “reset” to confirm</Label>
          <Input id="reset-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || confirm.trim().toLowerCase() !== 'reset'}
            onClick={async () => {
              if (await run(() => onReset(confirm))) {
                setOpen(false);
                setConfirm('');
              }
            }}
          >
            Reset the watch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ImageryRun {
  _id: string;
  kind: string;
  startedAt: number;
  outcome: string;
  detail?: string;
  counts?: Record<string, number>;
}

export interface ImageryActivity {
  runs: ImageryRun[];
  counts: Record<string, number>;
  failed: { granuleId: string; lastError: string | null }[];
  /** When the pump resumes after Fly or the archive failed, or `null`. */
  backoffUntil?: number | null;
  /** When the index next re-reads manifests it could not read, or `null`. */
  indexRetryAt?: number | null;
  configured: boolean;
  pollCap: number;
  maxLive: number;
}

/** Live imagery: *Start* / *Pause*, the ledger, and every recent pass (D214). */
export function ImageryPanel({
  row,
  activity,
  onStart,
  onPause,
  onRetryFailed,
  onTryAgain,
}: {
  row: WatchRow | null;
  activity: ImageryActivity | undefined;
  onStart: () => Promise<unknown>;
  onPause: () => Promise<unknown>;
  onRetryFailed?: () => Promise<unknown>;
  onTryAgain?: () => Promise<unknown>;
}) {
  const { busy, error, run } = useAction();
  const status = !row
    ? 'No watch is open, so there is nothing to look for yet.'
    : row.closesOn
      ? `The watch ended ${shortDay(row.closesOn)}; imagery stood down with it.`
      : row.imageryStartedAt === undefined
        ? 'Not started. Nothing is cut until you start it.'
        : row.imageryPausedAt !== undefined
          ? `Paused ${new Date(row.imageryPausedAt).toLocaleString()}.`
          : `Running since ${new Date(row.imageryStartedAt).toLocaleString()} — the catalog is checked every 6 hours.`;
  const running =
    row && !row.closesOn && row.imageryStartedAt !== undefined && row.imageryPausedAt === undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-foreground text-sm">{status}</p>
        {row && !row.closesOn ? (
          running ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(onPause)}>
              Pause imagery
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => run(onStart)}>
              Start imagery
            </Button>
          )
        ) : null}
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {activity?.backoffUntil && activity.backoffUntil > Date.now() ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-warning">
            Backing off until {new Date(activity.backoffUntil).toLocaleTimeString()} — Fly or the
            archive was failing.
          </p>
          {onTryAgain ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(onTryAgain)}>
              Try again now
            </Button>
          ) : null}
        </div>
      ) : null}
      {activity?.indexRetryAt && activity.indexRetryAt > Date.now() ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-warning">
            Some cut frames could not be read into the index; it reads them again at{' '}
            {new Date(activity.indexRetryAt).toLocaleTimeString()}.
          </p>
          {/* One button does both; the pump's banner above already shows it. */}
          {onTryAgain && !(activity.backoffUntil && activity.backoffUntil > Date.now()) ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(onTryAgain)}>
              Try again now
            </Button>
          ) : null}
        </div>
      ) : null}
      {activity && !activity.configured ? (
        <p className="text-sm text-warning">
          The deployment is missing imagery credentials (Fly and R2). Started imagery refuses each
          check, and the admins get one email a day, until they are set.
        </p>
      ) : null}
      {activity ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {(['queued', 'spawned', 'landed', 'empty', 'failed'] as const).map((k) => (
              <StatTile
                key={k}
                label={k === 'spawned' ? 'cutting' : k}
                value={activity.counts[k] ?? 0}
                tone={k === 'failed' && (activity.counts[k] ?? 0) > 0 ? 'danger' : 'default'}
              />
            ))}
          </div>
          {activity.runs.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Pass</Th>
                  <Th>Outcome</Th>
                  <Th>Counts</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {activity.runs.map((r) => (
                  <tr key={r._id}>
                    <Td className="whitespace-nowrap tabular-nums">
                      {new Date(r.startedAt).toLocaleString()}
                    </Td>
                    <Td>{r.kind}</Td>
                    <Td>
                      <Badge variant={r.outcome === 'ok' ? 'outline' : 'destructive'}>
                        {r.outcome}
                      </Badge>
                    </Td>
                    <Td className="text-foreground-muted text-xs">
                      {Object.entries(r.counts ?? {})
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')}
                    </Td>
                    <Td className="text-foreground-muted text-xs">{r.detail ?? ''}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-foreground-muted text-sm">No passes yet.</p>
          )}
          {activity.failed.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-foreground-muted text-xs">
                Last failures:{' '}
                {activity.failed.map((f) => `${f.granuleId} (${f.lastError ?? '?'})`).join(', ')}
              </p>
              {onRetryFailed ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(onRetryFailed)}
                >
                  Retry failed
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="text-foreground-muted text-xs">
            Guards: at most {activity.pollCap} granules a check, {activity.maxLive} cut Machines at
            once.
          </p>
        </>
      ) : null}
    </div>
  );
}

const FIELDS: { key: keyof SettingsForm; label: string; unit: string; help: string }[] = [
  {
    key: 'startMonthDay',
    label: 'Earliest night that counts',
    unit: 'MM-DD',
    help: 'Nothing before this date in a season can open the watch — a cheap bound on an early cold snap. 09-01 at the earliest, where the stored history begins.',
  },
  {
    key: 'freezeF',
    label: 'Freezing line',
    unit: '°F',
    help: 'An overnight low at or below this counts as a freezing night, for every rule.',
  },
  {
    key: 'sentinelNights',
    label: 'Sentinel nights in a row',
    unit: 'nights',
    help: 'Consecutive freezing nights at one sentinel before it opens the watch. 1 is a single cold night.',
  },
  {
    key: 'corpusPct',
    label: 'Ordinary lakes to open',
    unit: '%',
    help: 'Opens the watch without a sentinel when this share of ordinary lakes freeze on one night.',
  },
  {
    key: 'winterPct',
    label: 'Ordinary lakes for winter',
    unit: '%',
    help: 'Winter has set in region-wide when this share freeze on one night. The end is measured from it.',
  },
  {
    key: 'imageryNudgeF',
    label: 'Imagery line',
    unit: '°F',
    help: 'The first sentinel night at or below this sends “Time to start satellite imagery”.',
  },
  {
    key: 'thawF',
    label: 'Thaw line',
    unit: '°F',
    help: 'A night above this counts as thawed at an ordinary lake.',
  },
  {
    key: 'thawRunDays',
    label: 'Thawed nights to end',
    unit: 'nights',
    help: 'Every ordinary lake thawed this many nights in a row ends the watch.',
  },
  {
    key: 'sampleSize',
    label: 'Ordinary lakes sampled',
    unit: 'lakes',
    help: 'How many prominent lakes vote beside the sentinels and pinned sites.',
  },
];

/** The settings form: fields in the founder's units, the two rosters, a note, and *Save*. */
export function SettingsEditor({
  form,
  onFormChange,
  edited,
  sentinels,
  pinned,
  onRosterChange,
  dirty,
  lost = [],
  picker,
  onSave,
  onDiscard,
}: {
  form: SettingsForm;
  onFormChange: (form: SettingsForm) => void;
  edited: SeasonWatchSettings;
  sentinels: RosterEntry[];
  pinned: RosterEntry[];
  onRosterChange: (next: { sentinels: RosterEntry[]; pinned: RosterEntry[] }) => void;
  dirty: boolean;
  /** Roster lakes that no longer resolve (merged or delisted): each one still listed is an error. */
  lost?: RosterEntry[];
  /** The lake search, rendered per list: `picker(onPick)`. */
  picker: (onPick: (entry: RosterEntry) => void) => ReactNode;
  onSave: (note: string) => Promise<unknown>;
  onDiscard: () => void;
}) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const errors = validateSeasonWatchSettings(edited);
  if (sentinels.length > MAX_ROSTER_SITES || pinned.length > MAX_ROSTER_SITES) {
    errors.push('At most ten sentinels and ten pinned sites.');
  }
  // A lost lake stays in the draft so it cannot be dropped unseen; the save would refuse it.
  const chosen = new Set([...sentinels, ...pinned].map((s) => s.waterBodyId));
  for (const m of lost) {
    if (chosen.has(m.waterBodyId)) errors.push(`${m.name} is not found any more — remove it.`);
  }
  const roster = (
    title: string,
    list: RosterEntry[],
    other: RosterEntry[],
    set: (next: RosterEntry[]) => void,
  ) => (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-foreground text-sm">{title}</h3>
      <ul className="flex flex-col gap-1">
        {list.map((s) => (
          <li key={s.waterBodyId} className="flex items-center justify-between gap-2 text-sm">
            <span>{siteName(s)}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${s.name}`}
              onClick={() => set(list.filter((x) => x.waterBodyId !== s.waterBodyId))}
            >
              Remove
            </Button>
          </li>
        ))}
        {list.length === 0 ? <li className="text-foreground-muted text-sm">None.</li> : null}
      </ul>
      {picker((entry) => {
        if ([...list, ...other].some((x) => x.waterBodyId === entry.waterBodyId)) return;
        set([...list, entry]);
      })}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <Label htmlFor={`watch-${f.key}`}>
              {f.label} <span className="text-foreground-muted">({f.unit})</span>
            </Label>
            <Input
              id={`watch-${f.key}`}
              inputMode={f.key === 'startMonthDay' ? 'text' : 'decimal'}
              value={form[f.key]}
              onChange={(e) => onFormChange({ ...form, [f.key]: e.target.value })}
            />
            <p className="text-foreground-muted text-xs">{f.help}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {roster('Sentinels', sentinels, pinned, (next) =>
          onRosterChange({ sentinels: next, pinned }),
        )}
        {roster('Pinned ordinary lakes', pinned, sentinels, (next) =>
          onRosterChange({ sentinels, pinned: next }),
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="watch-note">What changed, and why</Label>
        <Textarea
          id="watch-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Matt: three nights below 28°F at a summit before anything forms"
        />
      </div>
      {errors.length > 0 ? (
        <ul className="list-disc pl-5 text-destructive text-sm">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          disabled={!dirty || errors.length > 0 || busy}
          onClick={async () => {
            if (await run(() => onSave(note))) setNote('');
          }}
        >
          Save as a new version
        </Button>
        <Button variant="outline" disabled={!dirty || busy} onClick={onDiscard}>
          Discard edits
        </Button>
      </div>
      <p className="text-foreground-muted text-xs">
        A save never changes why a past watch opened — each season keeps the version that decided
        it. To have this season decided again under new settings, reset the watch above.
      </p>
    </div>
  );
}

function Changed({ now, before }: { now: ReactNode; before: ReactNode }) {
  if (now === before) return <>{now}</>;
  return (
    <span className="flex flex-col">
      <span className="font-medium text-foreground">{now}</span>
      <span className="text-foreground-muted text-xs line-through">{before}</span>
    </span>
  );
}

/** Every season under the edited settings, the saved result struck through where it differs. */
export function PreviewTable({
  edited,
  saved,
  fillHint,
}: {
  edited: PreviewRow[];
  saved: PreviewRow[];
  /** How the lows a season is missing get filled — by saving the edit, or *Fill history*. */
  fillHint: string;
}) {
  const before = new Map(saved.map((r) => [r.season, r]));
  const by = (r: PreviewRow) => r.evaluation.openedBy.join(' + ') || '—';
  return (
    <Table>
      <thead>
        <tr>
          <Th>Season</Th>
          <Th>Watch opens</Th>
          <Th>By</Th>
          <Th>Imagery line</Th>
          <Th>Winter region-wide</Th>
          <Th>Watch ends</Th>
          <Th>First skated</Th>
          <Th>Opened ahead by</Th>
        </tr>
      </thead>
      <tbody>
        {edited.map((r) => {
          const b = before.get(r.season);
          return (
            <tr key={r.season}>
              <Td className="whitespace-nowrap">
                {r.season.replace('winter-', '')}{' '}
                {r.source !== 'forecast' ? (
                  <span className="text-foreground-muted text-xs">({r.source})</span>
                ) : null}
                {r.missingLows > 0 ? (
                  // A replay over fewer lakes than the watch reads is not the whole result: say so.
                  <span className="block text-warning text-xs">
                    Lows incomplete for {r.missingLows} of {r.watched} lakes — {fillHint}
                  </span>
                ) : null}
              </Td>
              <Td>
                <Changed
                  now={shortDay(r.evaluation.opensOn)}
                  before={shortDay(b?.evaluation.opensOn)}
                />
              </Td>
              <Td>
                <Changed now={by(r)} before={b ? by(b) : '—'} />
              </Td>
              <Td>
                <Changed
                  now={shortDay(r.evaluation.imageryNudge?.date)}
                  before={shortDay(b?.evaluation.imageryNudge?.date)}
                />
              </Td>
              <Td>
                <Changed
                  now={shortDay(r.evaluation.winterFrom)}
                  before={shortDay(b?.evaluation.winterFrom)}
                />
              </Td>
              <Td>
                <Changed
                  now={shortDay(r.evaluation.closesOn)}
                  before={shortDay(b?.evaluation.closesOn)}
                />
              </Td>
              <Td>{shortDay(r.firstSkated)}</Td>
              <Td className="tabular-nums">
                <Changed
                  now={r.leadDays === null ? '—' : `${r.leadDays} days`}
                  before={b?.leadDays == null ? '—' : `${b.leadDays} days`}
                />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** One season's sentinel lows against the lines, with each sentinel's first crossings. */
export function SeasonDetail({
  seasons,
  season,
  onSeasonChange,
  docs,
  sentinels,
  crossings,
  settings,
  evaluation,
}: {
  seasons: string[];
  season: string;
  onSeasonChange: (season: string) => void;
  docs: SeriesDoc[];
  sentinels: RosterEntry[];
  crossings: SentinelCrossing[];
  settings: SeasonWatchSettings;
  evaluation: PreviewRow['evaluation'] | undefined;
}) {
  const from = evaluation?.floor ?? '';
  const rows = chartRows(
    season,
    docs,
    sentinels.map((s) => s.waterBodyId),
    from,
  );
  const { resolvedTheme } = useTheme();
  const colors = chartSeries(resolvedTheme === 'dark');
  const marks = [
    ['Opens', evaluation?.opensOn],
    ['Imagery', evaluation?.imageryNudge?.date],
    ['Winter', evaluation?.winterFrom],
    ['Ends', evaluation?.closesOn],
  ].filter((m): m is [string, string] => Boolean(m[1]));
  return (
    <div className="flex flex-col gap-3">
      <Select
        value={season}
        items={seasons.map((s) => ({ value: s, label: s.replace('winter-', 'Winter ') }))}
        onValueChange={(v) => onSeasonChange(v as string)}
      >
        <SelectTrigger size="sm" className="w-48" aria-label="Season">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {seasons.map((s) => (
            <SelectItem key={s} value={s}>
              {s.replace('winter-', 'Winter ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rows.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-2 py-3">
            <ChartLegend
              items={sentinels.map((s, i) => ({
                label: siteName(s),
                color: colors[i % colors.length] as string,
              }))}
            />
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} margin={{ top: 22, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART_TOKENS.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => shortDay(d)}
                  minTickGap={32}
                  fontSize={11}
                />
                <YAxis unit="°F" fontSize={11} width={48} />
                <Tooltip
                  formatter={(v: unknown) => `${v}°F`}
                  labelFormatter={(d: unknown) => shortDay(String(d))}
                />
                <ReferenceLine
                  y={Math.round(celsiusToFahrenheit(settings.freezeC))}
                  stroke={CHART_TOKENS.axis}
                  strokeDasharray="4 4"
                  label={{
                    value: 'freezing line',
                    fontSize: 10,
                    fill: CHART_TOKENS.axis,
                    position: 'insideTopRight',
                  }}
                />
                <ReferenceLine
                  y={Math.round(celsiusToFahrenheit(settings.imageryNudgeC))}
                  stroke={CHART_TOKENS.axis}
                  strokeDasharray="4 4"
                  label={{
                    value: 'imagery line',
                    fontSize: 10,
                    fill: CHART_TOKENS.axis,
                    position: 'insideBottomRight',
                  }}
                />
                {marks.map(([label, date]) => (
                  <ReferenceLine
                    key={label}
                    x={date}
                    stroke={CHART_TOKENS.axis}
                    strokeDasharray="2 3"
                    label={{ value: label, fontSize: 10, fill: CHART_TOKENS.axis, position: 'top' }}
                  />
                ))}
                {sentinels.map((s, i) => (
                  <Line
                    key={s.waterBodyId}
                    dataKey={s.waterBodyId}
                    name={s.name}
                    stroke={colors[i % colors.length]}
                    dot={false}
                    strokeWidth={2}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <p className="text-foreground-muted text-xs">
              Sentinel overnight air lows, from {shortDay(from)}. Air at a coordinate — never a
              reading of ice.
            </p>
          </CardContent>
        </Card>
      ) : (
        <p className="text-foreground-muted text-sm">
          No sentinel lows stored for this season yet.
        </p>
      )}
      {crossings.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Sentinel</Th>
              <Th>First night at the freezing line</Th>
              <Th>First night at the imagery line</Th>
              <Th>Coldest night</Th>
            </tr>
          </thead>
          <tbody>
            {crossings.map((c) => (
              <tr key={c.waterBodyId}>
                <Td>{siteName(c)}</Td>
                {(
                  [
                    ['freeze', c.firstFreeze],
                    ['imagery', c.firstImageryNight],
                    ['coldest', c.coldest],
                  ] as const
                ).map(([key, d]) => (
                  <Td key={key} className="tabular-nums">
                    {d ? `${shortDay(d.date)} · ${lowF(d.minTempC)}` : '—'}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

export interface FieldDateRow {
  _id: string;
  season: string;
  kind: 'first_skated' | 'last_skated';
  date: string;
  place?: string;
  note?: string;
}

/** The days people actually skated, so a rule can be judged by how far ahead of them it fires. */
export function FieldDates({
  dates,
  seasons,
  onAdd,
  onRemove,
}: {
  dates: FieldDateRow[];
  seasons: string[];
  onAdd: (row: {
    season: string;
    kind: FieldDateRow['kind'];
    date: string;
    place: string;
    note: string;
  }) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
}) {
  const [season, setSeason] = useState(seasons[0] ?? '');
  const [kind, setKind] = useState<FieldDateRow['kind']>('first_skated');
  const [date, setDate] = useState('');
  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col gap-3">
      {dates.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Season</Th>
              <Th>What</Th>
              <Th>Date</Th>
              <Th>Where</Th>
              <Th>Note</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => (
              <tr key={d._id}>
                <Td>{d.season.replace('winter-', '')}</Td>
                <Td>{d.kind === 'first_skated' ? 'First skated' : 'Last skated'}</Td>
                <Td className="tabular-nums">{d.date}</Td>
                <Td>{d.place ?? ''}</Td>
                <Td className="text-foreground-muted">{d.note ?? ''}</Td>
                <Td>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => run(() => onRemove(d._id))}
                  >
                    Remove
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-foreground-muted text-sm">None recorded yet.</p>
      )}
      <div className="grid items-end gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className="flex flex-col gap-1">
          <Label>Season</Label>
          <Select
            value={season}
            items={seasons.map((s) => ({ value: s, label: s.replace('winter-', '') }))}
            onValueChange={(v) => setSeason(v as string)}
          >
            <SelectTrigger size="sm" aria-label="Field date season">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {seasons.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace('winter-', '')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>What</Label>
          <Select
            value={kind}
            items={[
              { value: 'first_skated', label: 'First skated' },
              { value: 'last_skated', label: 'Last skated' },
            ]}
            onValueChange={(v) => setKind(v as FieldDateRow['kind'])}
          >
            <SelectTrigger size="sm" aria-label="Field date kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="first_skated">First skated</SelectItem>
              <SelectItem value="last_skated">Last skated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="field-date">Date</Label>
          <Input
            id="field-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="field-place">Where</Label>
          <Input id="field-place" value={place} onChange={(e) => setPlace(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="field-note">Note</Label>
          <Input id="field-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button
          disabled={busy || !season || !date}
          onClick={async () => {
            if (await run(() => onAdd({ season, kind, date, place, note }))) {
              setDate('');
              setPlace('');
              setNote('');
            }
          }}
        >
          Add
        </Button>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}

/**
 * What the history fill covers and how long it runs, roughly — so the button's promise is honest.
 * Both from the server's planner (`overview.historyFill`): the seasons it covers, and its pacing
 * for the lakes watched now.
 */
export function historyFillHint(seasons: number, spanMs: number): string {
  const what = `Fills whatever the watched lakes are missing from ${seasons} seasons of Open-Meteo's records.`;
  if (spanMs < 60_000) return what;
  return `${what} From nothing it is spread over about ${durationInWords(spanMs)}, so it never starves the daily weather sweep.`;
}
