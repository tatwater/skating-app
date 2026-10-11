import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  archiveSeasonAt,
  DEFAULT_SEASON_WATCH_SETTINGS,
  searchQueryArg,
  seasonFloorDate,
} from '@skating/core';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import {
  FieldDates,
  historyFillHint,
  ImageryPanel,
  PreviewTable,
  SeasonDetail,
  Section,
  SettingsEditor,
  useAction,
  WatchCard,
} from '../components/admin/SeasonWatch';
import { type LakeHit, LakeSearchBox } from '../components/LakeSearch';
import { Button } from '../components/ui/button';
import {
  draftRoster,
  editedSitesFor,
  fromForm,
  type MissingSite,
  previewSeasons,
  type RosterEntry,
  rosterEntries,
  rosterOf,
  type SeriesDoc,
  sameSettings,
  seasonsIn,
  sentinelCrossings,
  toForm,
  type WatchedSite,
} from '../lib/seasonPreview';

/**
 * Seasons (A06i §6, D213, D214) — **admin-only**. The season watch made legible: why this season's ice
 * watch opened and what it measured, the satellite imagery it started, the settings that decide it
 * with a preview against every past winter, and the days people actually skated.
 *
 * Unlike `/admin/tuning`, these values are edited here: each save is a new version, and a season
 * keeps the version that decided it, so an edit can never rewrite why a past watch began.
 */
export const Route = createFileRoute('/admin/seasons')({ component: AdminSeasons });

function RosterPicker({ onPick }: { onPick: (entry: RosterEntry) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(id);
  }, [text]);
  const arg = searchQueryArg(debounced);
  const results = useQuery(
    api.waterBodies.searchByName,
    arg === 'skip' ? 'skip' : { ...arg, bodiesOnly: true },
  );
  return (
    <LakeSearchBox
      items={(results ?? []) as LakeHit[]}
      inputValue={text}
      onInputValueChange={setText}
      emptyVisible={arg !== 'skip' && results !== undefined && results.length === 0}
      onSelect={(hit) => {
        setText('');
        onPick({
          waterBodyId: hit.waterBodyId,
          name: hit.name,
          ...(hit.states[0] ? { state: hit.states[0] } : {}),
        });
      }}
    />
  );
}

function AdminSeasons() {
  const overview = useQuery(api.seasonWatch.overview, {});
  const series = useQuery(api.seasonWatch.series, { current: archiveSeasonAt(Date.now()) }) as
    | SeriesDoc[]
    | undefined;
  const activity = useQuery(api.imageryLive.activity, {});
  const saveSettings = useMutation(api.seasonWatch.saveSettings);
  const resetSeason = useMutation(api.seasonWatch.resetSeason);
  const startImagery = useMutation(api.seasonWatch.startImagery);
  const pauseImagery = useMutation(api.seasonWatch.pauseImagery);
  const addFieldDate = useMutation(api.seasonWatch.addFieldDate);
  const removeFieldDate = useMutation(api.seasonWatch.removeFieldDate);
  const requestHistoryFill = useMutation(api.seasonWatch.requestHistoryFill);
  const retryFailed = useMutation(api.imageryLive.retryFailed);
  const tryAgainNow = useMutation(api.imageryLive.tryAgainNow);
  const fill = useAction();

  const season = archiveSeasonAt(Date.now());
  const saved = overview?.current;
  // The saved roster as the cron reads it: followed to survivors, still listed (`sampleSites`).
  const savedSites = overview?.sites as WatchedSite[] | undefined;
  const savedMissing = overview?.missing as MissingSite[] | undefined;

  // The draft: the form, in the founder's units, and the two rosters. Re-seeded whenever a new
  // version lands, so a save (here or elsewhere) is what the form shows next.
  const [form, setForm] = useState(() => toForm(saved?.settings ?? DEFAULT_SEASON_WATCH_SETTINGS));
  const [sentinels, setSentinels] = useState<RosterEntry[]>([]);
  const [pinned, setPinned] = useState<RosterEntry[]>([]);
  const [seeded, setSeeded] = useState<number | null>(null);
  const resetDraft = () => {
    if (!saved || !savedSites || !savedMissing) return;
    const roster = draftRoster(savedSites, savedMissing);
    setSeeded(saved.version);
    setForm(toForm(saved.settings));
    setSentinels(roster.sentinels);
    setPinned(roster.pinned);
  };
  // Seeded during render, not in an effect: an effect would commit one frame with no draft, and the
  // page would blank to "Loading…" — and lose its scroll — on every save.
  if (saved && savedSites && savedMissing && seeded !== saved.version) resetDraft();

  const [detailSeason, setDetailSeason] = useState<string | null>(null);

  const draft = useMemo(() => {
    if (!saved || !savedSites || !savedMissing || seeded !== saved.version) return null;
    const edited = fromForm(form, saved.settings);
    const roster = draftRoster(savedSites, savedMissing);
    const ids = (list: RosterEntry[]) => list.map((s) => s.waterBodyId).join();
    const rosterChanged =
      ids(sentinels) !== ids(roster.sentinels) || ids(pinned) !== ids(roster.pinned);
    const dirty = !sameSettings(edited, saved.settings) || rosterChanged;
    const valid = Object.values(edited).every((v) => typeof v === 'string' || Number.isFinite(v));
    // The sample is drawn around the roster at its size, so either changing re-draws it.
    const resample = rosterChanged || edited.sampleSize !== saved.settings.sampleSize;
    return { edited, dirty, valid, resample };
  }, [saved, savedSites, savedMissing, seeded, form, sentinels, pinned]);

  // ⚠ **The edited preview samples by the server's own rule** (`previewSites` is `sampleSites`), not
  // the saved sample with the roster swapped: a smaller sample, or a lake moving in or out of the
  // roster, changes which ordinary lakes vote.
  const toSite = (s: RosterEntry) => ({ ...s, waterBodyId: s.waterBodyId as Id<'waterBodies'> });
  const resampling = Boolean(draft?.resample && draft.valid);
  const previewed = useQuery(
    api.seasonWatch.previewSites,
    resampling && draft
      ? {
          sentinels: sentinels.map(toSite),
          pinned: pinned.map(toSite),
          sampleSize: draft.edited.sampleSize,
        }
      : 'skip',
  );
  // Each keystroke is a new query: hold the last answer while the next loads, rather than flicking
  // the table back to the saved result between them.
  const [lastPreview, setLastPreview] = useState<typeof previewed>(undefined);
  useEffect(() => {
    // Forgotten once the edit stops re-drawing (Discard, a save), so a later edit never borrows it.
    if (!resampling) setLastPreview(undefined);
    else if (previewed !== undefined) setLastPreview(previewed);
  }, [previewed, resampling]);
  const preview = resampling ? (previewed ?? lastPreview) : undefined;
  const editedSites =
    savedSites && draft
      ? editedSitesFor(draft.resample, savedSites, preview as { sites: WatchedSite[] } | null)
      : undefined;

  const derived = useMemo(() => {
    if (!overview || !series || !saved || !savedSites || !draft) return null;
    const fieldDates = overview.fieldDates;
    const savedRows = previewSeasons(series, rosterOf(savedSites), saved.settings, fieldDates);
    const editedRows =
      draft.valid && editedSites
        ? previewSeasons(series, rosterOf(editedSites), draft.edited, fieldDates)
        : savedRows;
    return { ...draft, savedRows, editedRows };
  }, [overview, series, saved, savedSites, draft, editedSites]);

  if (overview === undefined || series === undefined || !saved || !savedSites || !derived) {
    return <AdminEmpty>Loading…</AdminEmpty>;
  }

  const row = overview.seasons.find((s) => s.season === season) ?? null;
  const seasons = seasonsIn(series);
  const shownSeason = detailSeason ?? seasons[0] ?? season;
  const shownSettings = derived.valid ? derived.edited : saved.settings;
  const allSeasons = [...new Set([season, ...seasons])].sort().reverse();
  // The chart and its crossings follow the same resolved sentinels as the table.
  const shownSentinels = rosterEntries(editedSites ?? savedSites, 'sentinel');
  const missing = (preview ?? overview).missing;

  return (
    <div className="flex flex-col gap-10">
      <AdminPageHeader
        title="Seasons"
        subtitle="The ice watch: when it opens, what it measured, and the settings that decide it. Every number here is an overnight air low at a coordinate — never a reading of ice."
      />

      <Section
        title={`This season — ${season.replace('winter-', 'Winter ')}`}
        blurb="The watch is a monitoring window: daily weather across the corpus and, once you start it, satellite imagery. It is not a skating season."
      >
        <WatchCard
          season={season}
          floor={seasonFloorDate(season, saved.settings.startMonthDay)}
          row={row}
          onReset={(confirm) => resetSeason({ season, confirm })}
        />
        {overview.superseded.length > 0 ? (
          <p className="text-foreground-muted text-xs">
            Superseded:{' '}
            {overview.superseded
              .map(
                (s) =>
                  `${s.season} opened ${s.opensOn}, reset ${new Date(s.supersededAt).toLocaleDateString()}`,
              )
              .join(' · ')}
          </p>
        ) : null}
      </Section>

      <Section
        title="Satellite imagery"
        blurb="Once started, the catalog is checked every 6 hours and each new pass of our lakes is cut, until the watch ends. A whole season costs about $1.50 of compute."
      >
        <ImageryPanel
          row={row}
          activity={activity}
          onStart={() => startImagery({ season })}
          onPause={() => pauseImagery({ season })}
          onRetryFailed={() => retryFailed({})}
          onTryAgain={() => tryAgainNow({})}
        />
      </Section>

      <Section
        title="Settings"
        blurb={`Version ${saved.version}${saved.version === 0 ? ' (the defaults — nothing saved yet)' : ''}. Edit and the table below previews every past season before you save.`}
      >
        {missing.length > 0 ? (
          <p className="text-sm text-warning">
            Not found any more (merged or delisted): {missing.map((m) => m.name).join(', ')}.
          </p>
        ) : null}
        <SettingsEditor
          form={form}
          onFormChange={setForm}
          edited={derived.edited}
          sentinels={sentinels}
          pinned={pinned}
          onRosterChange={(next) => {
            setSentinels(next.sentinels);
            setPinned(next.pinned);
          }}
          dirty={derived.dirty}
          lost={missing}
          picker={(onPick) => <RosterPicker onPick={onPick} />}
          onSave={(note) =>
            saveSettings({
              settings: derived.edited,
              sentinels: sentinels.map((s) => s.waterBodyId as Id<'waterBodies'>),
              pinned: pinned.map((s) => s.waterBodyId as Id<'waterBodies'>),
              ...(note.trim() ? { note } : {}),
            })
          }
          onDiscard={resetDraft}
        />
        {overview.versions.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-foreground-muted">Version history</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {overview.versions.map((v) => (
                <li key={v.version}>
                  <span className="tabular-nums">v{v.version}</span> ·{' '}
                  {new Date(v.savedAt).toLocaleString()} · {v.note ?? 'no note'}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Section>

      <Section
        title="Every season, replayed"
        blurb="The same rules the daily check runs, over the lows the watch kept and Open-Meteo's archive before it. Where an edit changes a date, the saved result is struck through beside it."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={fill.busy}
            onClick={() => fill.run(() => requestHistoryFill({}))}
          >
            Fill history
          </Button>
        }
      >
        <p className="text-foreground-muted text-xs">
          {historyFillHint(overview.historyFill.seasons, overview.historyFill.spanMs)}
        </p>
        {fill.error ? <p className="text-destructive text-sm">{fill.error}</p> : null}
        {resampling && previewed === undefined ? (
          <p className="text-foreground-muted text-xs">Re-drawing the sample for the edit…</p>
        ) : null}
        {derived.editedRows.length > 0 ? (
          <PreviewTable
            edited={derived.editedRows}
            saved={derived.savedRows}
            // Saving fills what a previewed edit lacks; *Fill history*, what the saved settings lack
            // — which is what the table shows while the edit's sample loads or is refused.
            fillHint={
              derived.resample && editedSites ? 'saving fills them' : 'Fill history fills them'
            }
          />
        ) : (
          <AdminEmpty>
            No lows stored yet — fill the history, or wait for the next daily check.
          </AdminEmpty>
        )}
      </Section>

      <Section
        title="A season up close"
        blurb="Each sentinel's overnight lows against the freezing and imagery lines, under the settings above."
      >
        <SeasonDetail
          seasons={seasons}
          season={shownSeason}
          onSeasonChange={setDetailSeason}
          docs={series}
          sentinels={shownSentinels}
          crossings={sentinelCrossings(
            shownSeason,
            series,
            shownSentinels.map((s) => s.waterBodyId),
            shownSettings,
          )}
          settings={shownSettings}
          evaluation={derived.editedRows.find((r) => r.season === shownSeason)?.evaluation}
        />
      </Section>

      <Section
        title="Field dates"
        blurb="The first and last days anyone skated, per season. Staff-only; they never leave this page. The preview measures each rule against them."
      >
        <FieldDates
          dates={overview.fieldDates}
          seasons={allSeasons}
          onAdd={(d) =>
            addFieldDate({
              season: d.season,
              kind: d.kind,
              date: d.date,
              ...(d.place.trim() ? { place: d.place } : {}),
              ...(d.note.trim() ? { note: d.note } : {}),
            })
          }
          onRemove={(id) => removeFieldDate({ id: id as Id<'seasonFieldDates'> })}
        />
      </Section>

      <Section
        title="Where the defaults live"
        blurb="The values version 1 was seeded from, and the rules themselves."
      >
        <ul className="flex flex-col gap-1 font-mono text-foreground-muted text-xs">
          {Object.entries(overview.defaultsInCode).map(([k, v]) => (
            <li key={k}>{v}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
