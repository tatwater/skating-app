import { api } from '@skating/convex/api';
import {
  addEarlierVisit,
  addLake,
  type CompassSector,
  endTimeRow,
  isMinor,
  isPassageMarker,
  type LatLng,
  type MinimumSetTerm,
  POST_SENT_COPY,
  POST_TITLE_MAX_CHARS,
  type PostSheet,
  postCreateSent,
  postRefusals,
  type ReportRefusal,
  removeReport,
  reportEndMs,
  reportsInTimeOrder,
  SHEET_SECTION_COUNT,
  type SheetReport,
  type SheetSection,
  sectionsFilled,
  selectedValues,
  sheetReducer,
  timelineFraction,
  timelineModel,
  updateReport,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useConvex, useQuery } from 'convex/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { postSheetOnWeb, saveSheetEditOnWeb } from '../../lib/sheetActions';
import { releaseAllSheetPhotos, sheetPhotoPreview } from '../../lib/sheetPhotos';
import {
  clearStoredSheet,
  setSheet,
  setSheetAttempt,
  updateSheet,
  usePersistedAt,
  useSheet,
  useSheetAttempt,
} from '../../lib/sheetStore';
import { cn } from '../../lib/utils';
import { LeavingNotice, useIsLeaving } from '../LeavingNotice';
import { Textarea } from '../ui/textarea';
import { BodyPicker } from './BodyPicker';
import { ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { LakeMap, type LakeMapHazard } from './LakeMap';
import { ReportPanels } from './ReportPanels';
import { Eyebrow, SheetHint, StatusSquare } from './SheetPanel';
import { Timeline } from './Timeline';
import { type SheetBody, useSheetBody } from './useSheetBody';
import { useSkateWeather, useSkateWindowHours } from './useSkateWeather';
import { WeatherBand } from './WeatherBand';
import { whereClickOnWater } from './WhereCards';

/** The meter's segments, one per section, keyed by their own number. */
const METER_SEGMENTS = Array.from({ length: SHEET_SECTION_COUNT }, (_, k) => k);

/** Which section a minimum-set term points at, for the *needed* mark (D189). */
const TERM_SECTION: Record<MinimumSetTerm, SheetSection | null> = {
  body: null,
  endTime: 'endTime',
  howWasIt: 'howWasIt',
  observation: 'iceAndSurface',
};

/**
 * The web console (A10-5 / §10.1, re-composed A10-6 / D206) — the report sheet as an application
 * surface: the whole viewport, three columns, nothing scrolls as a page.
 *
 * - **The Post** is the left column, full height: its title and prose, then every photo of the day
 *   with the number of the lake it is on. The words belong to the Post, not to a lake (D186), and
 *   the layout says so.
 * - **The Reports** are tabs across the top of the work area, in time order (`reportsInTimeOrder`),
 *   each with a ten-segment meter of its filled sections; *Another report* is one button with two
 *   answers (the same lake at another time, or a different lake).
 * - **The instrument** is the center: the active Report's lake, the timeline under it, the weather
 *   band under that. In a mode (`ConsoleMode`) it becomes the input for the open question and
 *   everything else dims.
 * - **The inspector** is the right column: the ten sections in their fixed order, *Post* at its
 *   foot. A status bar carries the draft's state and the meters.
 *
 * It is the **same sheet** the phone draws, not a second one: the model, the doors, which gaps
 * refuse a Post and what *Post* does all come from core's `postSheet` and `flushPost`. What is
 * web's is the composition.
 */
export function ReportConsole() {
  const post = useSheet();
  if (post === null) return null;
  return (
    <ConsoleModeProvider>
      <Console post={post} />
    </ConsoleModeProvider>
  );
}

function Console({ post }: { post: PostSheet }) {
  const convex = useConvex();
  const navigate = useNavigate();
  const leaving = useIsLeaving();
  const profile = useQuery(api.profiles.current, {});
  const { mode, setMode } = useConsoleMode();
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<ReportRefusal[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>(post.reports[0]?.id ?? '');
  const [picking, setPicking] = useState<
    { kind: 'add' } | { kind: 'set'; reportId: string } | null
  >(null);
  /** What a failed attempt already uploaded, so a retry resumes rather than repeats. */
  const attempt = useSheetAttempt();
  /**
   * The create went out and may have landed (`postCreateSent`): the sheet takes no change — the
   * store refuses one, and the editing areas are `inert` so none is offered — and *Post* becomes a
   * retry of what was sent. A change here would otherwise be dropped by the idempotent create.
   */
  const sent = postCreateSent(attempt);
  const editing = post.mode.kind === 'edit';
  const actionLabel = busy
    ? editing
      ? 'Saving…'
      : 'Posting…'
    : editing
      ? 'Save changes'
      : sent
        ? 'Try again'
        : 'Post';
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false;

  const ordered = useMemo(() => reportsInTimeOrder(post), [post]);
  // The tab a removed Report leaves behind falls back to the first.
  const active = post.reports.find((r) => r.id === activeId) ?? post.reports[0];
  // The active Report's lake, read **once** for the whole console and handed down.
  const body = useSheetBody(active?.sheet.waterBodyId);
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);
  // A tab switch leaves any mode: the question was about the other lake.
  const switchTo = useCallback(
    (id: string) => {
      setMode(null);
      setActiveId(id);
    },
    [setMode],
  );

  // Leaving a half-written Post with the browser's own prompt — the console has no *Save draft* to
  // offer (§10.3: no queue on web), so the only honest thing is to ask before the tab goes.
  useEffect(() => {
    if (!post.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [post.dirty]);

  const gapsFor = useCallback(
    (reportId: string): ReadonlySet<SheetSection> => {
      const set = new Set<SheetSection>();
      for (const r of refusals) {
        if (r.reportId !== reportId) continue;
        for (const term of r.gaps) {
          const section = TERM_SECTION[term];
          if (section) set.add(section);
        }
      }
      return set;
    },
    [refusals],
  );

  const done = (to: { reportId: string }) => {
    releaseAllSheetPhotos();
    setSheet(null);
    clearStoredSheet();
    void navigate({ to: '/report/$id', params: { id: to.reportId } });
  };

  const onPost = async () => {
    setMessage(null);
    const now = Date.now();
    // A sent Post is not asked the create-only rules again: it may be live, and one that went out
    // at day 6.9 must not be refused as stale at day 7.1 (`flushPost` skips them for the same reason).
    const found = sent ? [] : postRefusals(post, now);
    setRefusals(found);
    if (found.length > 0) {
      const first = found[0] as ReportRefusal;
      // Name the leg when there is more than one, so a two-lake Post says which one to fix.
      setMessage(
        first.bodyName && post.reports.length > 1
          ? `${first.bodyName}: ${first.message}`
          : first.message,
      );
      const gapReport = post.reports.find((r) => r.id === first.reportId);
      if (gapReport) switchTo(gapReport.id);
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const reportId = await saveSheetEditOnWeb(convex, post);
        done({ reportId });
        return;
      }
      const outcome = await postSheetOnWeb(convex, post, now, attempt);
      if (outcome.kind === 'refused') {
        setSheetAttempt(outcome.draft);
        setMessage(outcome.message);
        return;
      }
      done({ reportId: outcome.reportId });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = () => {
    const leave = sent
      ? 'Leave without finding out? This post may already be up — check your profile before posting it again.'
      : 'Leave without posting? What you wrote here will be gone.';
    if ((post.dirty || sent) && !window.confirm(leave)) return;
    releaseAllSheetPhotos();
    setSheet(null);
    clearStoredSheet();
    if (post.mode.kind === 'edit') {
      void navigate({ to: '/report/$id', params: { id: post.mode.reportId } });
      return;
    }
    void navigate({ to: '/feed' });
  };

  if (minor) {
    return (
      <p className="p-6 text-foreground-muted text-sm">
        Reports are shared publicly with the community, so posting opens when you turn 18. You can
        keep reading reports in the meantime.
      </p>
    );
  }
  if (leaving && !editing) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <h1 className="font-semibold text-foreground text-xl">Post a report</h1>
        <LeavingNotice />
      </div>
    );
  }
  if (!active) return null;
  const dim = mode !== null;
  const number = (id: string) => ordered.findIndex((r) => r.id === id) + 1;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] lg:grid-cols-[372px_minmax(0,1fr)_452px] lg:grid-rows-[36px_minmax(0,1fr)_30px]">
      <PostColumn
        post={post}
        ordered={ordered}
        activeId={active.id}
        editing={editing}
        sent={sent}
        dim={dim}
      />

      <ReportTabs
        post={post}
        ordered={ordered}
        activeId={active.id}
        onSelect={switchTo}
        gapReportIds={new Set(refusals.map((r) => r.reportId))}
        editing={editing}
        sent={sent}
        dim={dim}
        onAddLake={() => setPicking({ kind: 'add' })}
        onAddVisit={() => {
          let addedId: string | null = null;
          updateSheet((p) => {
            const next = addEarlierVisit(p, active.id, Date.now(), () => crypto.randomUUID());
            addedId = next.reports.find((r) => !p.reports.some((q) => q.id === r.id))?.id ?? null;
            return next;
          });
          if (addedId) switchTo(addedId);
        }}
      />

      <Instrument
        key={active.id}
        sent={sent}
        report={active}
        post={post}
        ordered={ordered}
        body={body}
        ordinal={number(active.id)}
        onPickBody={() => setPicking({ kind: 'set', reportId: active.id })}
      />

      <aside className="flex min-h-0 min-w-0 flex-col border-border border-l bg-surface">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sent ? (
            <p role="status" className="border-border border-b px-3.5 py-3 text-foreground text-xs">
              {POST_SENT_COPY}
            </p>
          ) : null}
          <div inert={sent}>
            {/* Keyed by the Report: the panels hold their own affordance state (which reading is
              being typed, which where card is up), and an unkeyed swap would carry the previous
              leg's state onto this one. */}
            <ReportPanels
              key={active.id}
              report={active}
              body={body}
              gaps={gapsFor(active.id)}
              editing={editing}
            />
            {post.reports.length > 1 && !editing && !sent ? (
              <div className={cn('px-3.5 py-3', dim && 'sheet-dim')}>
                <button
                  type="button"
                  className="text-foreground-muted text-xs hover:text-foreground hover:underline"
                  onClick={() => updateSheet((p) => removeReport(p, active.id))}
                >
                  Remove this report from the post
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div
          className={cn(
            'flex flex-none flex-col gap-2 border-border border-t px-3.5 py-2.5',
            dim && 'sheet-dim',
          )}
        >
          {message ? (
            <p role="alert" className="text-danger text-xs">
              {message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="h-8 px-3 font-semibold text-[12px] text-foreground-muted uppercase tracking-[0.08em] hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onPost()}
              disabled={busy}
              className="h-8 min-w-[132px] rounded-[2px] border border-foreground bg-foreground px-4 font-semibold text-[12px] text-background uppercase tracking-[0.08em] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {actionLabel}
            </button>
          </div>
        </div>
      </aside>

      <StatusBar post={post} ordered={ordered} editing={editing} dim={dim} />

      <BodyPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        title={picking?.kind === 'add' ? 'Which lake next?' : 'Which lake?'}
        onPick={(picked) => {
          const now = Date.now();
          if (picking?.kind === 'add') {
            let addedId: string | null = null;
            updateSheet((p) => {
              const next = addLake(
                p,
                { waterBodyId: picked.waterBodyId, bodyName: picked.name },
                now,
                () => crypto.randomUUID(),
              );
              addedId = next.reports[next.reports.length - 1]?.id ?? null;
              return next;
            });
            if (addedId) switchTo(addedId);
          } else if (picking?.kind === 'set') {
            const reportId = picking.reportId;
            updateSheet((p) =>
              updateReport(p, reportId, (r) => ({
                ...r,
                bodyName: picked.name,
                // Through the reducer: another lake's peer ghosts go with the lake.
                sheet: sheetReducer(r.sheet, { type: 'setBody', waterBodyId: picked.waterBodyId }),
                coord: undefined,
              })),
            );
          }
          setPicking(null);
        }}
      />
    </div>
  );
}

// ── The Post column ──────────────────────────────────────────────────────────────────────────────

/** The Post: its words, then every photo of the day with the number of the lake it is on. */
function PostColumn({
  post,
  ordered,
  activeId,
  editing,
  sent,
  dim,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  activeId: string;
  editing: boolean;
  /** The create went out: the words and photos are shown, not offered (`postCreateSent`). */
  sent: boolean;
  dim: boolean;
}) {
  const photoCount = post.reports.reduce((n, r) => n + r.photos.length + r.keptPhotoIds.length, 0);
  const lakes = post.reports.length;
  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col border-border border-b bg-surface lg:row-span-2 lg:border-r lg:border-b-0',
        dim && 'sheet-dim',
      )}
    >
      <div className="flex h-9 flex-none items-center gap-2.5 border-border border-b px-4">
        <Eyebrow>{editing ? 'Editing a post' : 'Post'}</Eyebrow>
        <span className="ml-auto font-mono text-[10px] text-foreground-muted uppercase">
          {lakes} {lakes === 1 ? 'lake' : 'lakes'} · {photoCount}{' '}
          {photoCount === 1 ? 'photo' : 'photos'}
        </span>
      </div>
      <div inert={sent} className="flex min-h-0 flex-1 flex-col gap-2 px-4 pt-3.5 pb-2.5">
        <input
          className="w-full bg-transparent font-semibold text-foreground text-lg placeholder:text-foreground-muted/70 focus:outline-none"
          placeholder="Title — Crystal Lake, Enfield 12/6"
          aria-label="Title"
          maxLength={POST_TITLE_MAX_CHARS}
          value={post.title}
          onChange={(e) => updateSheet((p) => ({ ...p, title: e.target.value, dirty: true }))}
        />
        <Textarea
          className="min-h-32 flex-1 resize-none border-0 bg-transparent px-0 text-sm leading-relaxed focus-visible:ring-0 dark:border-0 dark:bg-transparent"
          placeholder="How was it? Write it the way you'd tell a friend — the chips on the right are for the hard numbers."
          aria-label="The story"
          value={post.body}
          onChange={(e) => updateSheet((p) => ({ ...p, body: e.target.value, dirty: true }))}
        />
      </div>
      <div inert={sent} className="contents">
        <PhotoRail post={post} ordered={ordered} activeId={activeId} />
      </div>
    </aside>
  );
}

/**
 * Every photo of the day, in the Post column: each with the number of the lake it is on (the tab's
 * number), the active Report's bright and the others dim, a corner mark on the ones placed on the
 * water. Adding and removing is the Report's own Photos section; assignment by time and location,
 * the `?` menu and place-mode are the next PR (§8.1).
 */
function PhotoRail({
  post,
  ordered,
  activeId,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  activeId: string;
}) {
  const all = ordered.flatMap((r, i) => [
    ...r.photos.map((photo) => ({
      key: photo.id,
      reportId: r.id,
      n: i + 1,
      preview: sheetPhotoPreview(photo.id),
      placed: photo.placeOnMap,
      kept: false,
    })),
    ...r.keptPhotoIds.map((id) => ({
      key: id,
      reportId: r.id,
      n: i + 1,
      preview: null,
      placed: false,
      kept: true,
    })),
  ]);
  if (all.length === 0) return null;
  const many = post.reports.length > 1;
  return (
    <div className="flex-none border-border border-t px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Eyebrow>Photos from the day</Eyebrow>
        <span className="ml-auto font-mono text-[10px] text-foreground-muted uppercase">
          {ordered
            .map((r, i) => {
              const n = r.photos.length + r.keptPhotoIds.length;
              return n > 0 ? `${n} on ${many ? i + 1 : 'the lake'}` : null;
            })
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {all.map((ph) => (
          <div
            key={ph.key}
            className={cn(
              'relative aspect-square overflow-hidden rounded-[2px] border border-border bg-surface-muted',
              ph.reportId !== activeId && 'opacity-45',
            )}
          >
            {ph.preview ? (
              <img src={ph.preview} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center text-center text-[9px] text-foreground-muted">
                {ph.kept ? 'On the report' : 'Re-add'}
              </span>
            )}
            {many ? (
              <span className="absolute top-[3px] left-[3px] h-3.5 min-w-3.5 rounded-[2px] bg-foreground px-[3px] text-center font-mono font-semibold text-[9px] text-background leading-[14px]">
                {ph.n}
              </span>
            ) : null}
            {ph.placed ? (
              <span
                title="Placed on the lake"
                className="absolute right-1 bottom-1 size-1.5 bg-primary shadow-[0_0_5px_var(--ring)]"
              >
                <span className="sr-only">placed on the lake</span>
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {many ? (
        <p className="mt-2 text-[11px] text-foreground-muted">
          The number is the lake a photo is on.
        </p>
      ) : null}
    </div>
  );
}

// ── The Report tabs ──────────────────────────────────────────────────────────────────────────────

/** A tab per Report in time order, with its meter; *Another report* with its two answers. */
function ReportTabs({
  post,
  ordered,
  activeId,
  onSelect,
  gapReportIds,
  editing,
  sent,
  dim,
  onAddLake,
  onAddVisit,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  activeId: string;
  onSelect: (id: string) => void;
  gapReportIds: ReadonlySet<string>;
  editing: boolean;
  /** The create went out: the tabs still switch, but no Report is added (`postCreateSent`). */
  sent: boolean;
  dim: boolean;
  onAddLake: () => void;
  onAddVisit: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const activeName = post.reports.find((r) => r.id === activeId)?.bodyName;
  return (
    <div
      className={cn(
        'relative flex min-w-0 items-stretch overflow-x-auto border-border border-b bg-surface lg:col-span-2',
        dim && 'sheet-dim',
      )}
    >
      <div role="tablist" aria-label="The lakes in this post" className="flex items-stretch">
        {ordered.map((report, i) => {
          const selected = report.id === activeId;
          const end = reportEndMs(report);
          const filled = sectionsFilled(report.sheet);
          const needed = gapReportIds.has(report.id);
          return (
            <button
              key={report.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(report.id)}
              className={cn(
                'relative flex items-center gap-2.5 whitespace-nowrap border-border border-r px-4 text-xs',
                selected
                  ? 'bg-background text-foreground after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-0.5 after:bg-primary'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'inline-flex size-4 items-center justify-center rounded-[2px] border font-mono font-semibold text-[10px]',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border-strong',
                )}
              >
                {i + 1}
              </span>
              <span className="font-semibold">{report.bodyName ?? 'Which lake?'}</span>
              {end !== undefined ? (
                <span className="font-mono text-[10.5px]">
                  {report.sheet.scalars.skateStartTime !== undefined
                    ? `${clock(report.sheet.scalars.skateStartTime)}–`
                    : ''}
                  {clock(end)}
                </span>
              ) : null}
              <span
                role="img"
                className="flex gap-0.5"
                aria-label={`${filled} of ${SHEET_SECTION_COUNT} sections filled`}
              >
                {METER_SEGMENTS.map((k) => (
                  <i
                    key={k}
                    className={cn(
                      'block h-2 w-[5px]',
                      k < filled
                        ? selected
                          ? 'bg-foreground'
                          : 'bg-foreground-muted'
                        : 'bg-surface-muted',
                    )}
                  />
                ))}
              </span>
              {needed ? (
                <span className="font-mono text-[9.5px] text-warning uppercase">needed</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {editing || sent ? null : (
        <div className="relative flex items-stretch">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className="whitespace-nowrap px-4 font-semibold text-[12px] text-foreground-muted uppercase tracking-[0.06em] hover:text-foreground"
          >
            + Another report
          </button>
          {menu ? (
            <div
              role="menu"
              className="absolute top-full left-0 z-20 mt-1 flex w-60 flex-col rounded-[2px] border border-border-strong bg-surface-muted p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                className="rounded-[2px] px-2.5 py-1.5 text-left text-sm hover:bg-surface"
                onClick={() => {
                  setMenu(false);
                  onAddVisit();
                }}
                disabled={activeName === undefined}
              >
                {activeName ? `${activeName}, another time` : 'The same lake, another time'}
                <span className="block text-[11px] text-foreground-muted">
                  A second visit to the lake this report is about
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="rounded-[2px] px-2.5 py-1.5 text-left text-sm hover:bg-surface"
                onClick={() => {
                  setMenu(false);
                  onAddLake();
                }}
              >
                A different lake
                <span className="block text-[11px] text-foreground-muted">Pick it by name</span>
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(ms);
}

// ── The instrument ───────────────────────────────────────────────────────────────────────────────

/**
 * The center column: the active Report's lake, the timeline, the weather band. In a mode the lake
 * takes the click for the open question — the ring in where-mode, the lit launches in put-in mode
 * — and the readouts around it dim with the rest.
 */
function Instrument({
  sent,
  report,
  post,
  ordered,
  body,
  ordinal,
  onPickBody,
}: {
  /** The create went out: the lake, timeline and weather are shown, not offered (`postCreateSent`). */
  sent: boolean;
  report: SheetReport;
  post: PostSheet;
  ordered: readonly SheetReport[];
  body: SheetBody | null;
  ordinal: number;
  onPickBody: () => void;
}) {
  const { mode } = useConsoleMode();
  const sheet = report.sheet;
  const timeZone = body?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [end] = selectedValues(sheet, 'endTime');
  const endMs = end?.ms;
  const startMs = sheet.scalars.skateStartTime;
  const gps = end?.precision === 'gps';
  const editing = post.mode.kind === 'edit';
  const dispatch = useCallback(
    (action: Parameters<typeof sheetReducer>[1]) =>
      updateSheet((p) =>
        updateReport(p, report.id, (r) => ({ ...r, sheet: sheetReducer(r.sheet, action) })),
      ),
    [report.id],
  );

  const hours = useSkateWeather(body?.waterBodyId, endMs, timeZone);
  const windowHours = useSkateWindowHours(hours, endMs, startMs);
  const [now] = useState(() => Date.now());
  const sun = useMemo(() => body?.sunAt(endMs ?? now) ?? null, [body, endMs, now]);
  // D192's ladder as the ruler's tappable ticks, as on the phone — the WHEN panel's chips are the
  // same instants for a keyboard. A track's end is exact and offers no ladder.
  const ladder = useMemo(() => {
    if (gps) return [];
    const row = endTimeRow({
      openedAtMs: sheet.openedAtMs,
      nowMs: now,
      timeZone,
      sun: body?.sunAt(sheet.openedAtMs) ?? null,
    });
    return row.chips.map((c) => ({ ms: c.ms, pinned: c.pinned }));
  }, [gps, sheet.openedAtMs, now, timeZone, body]);
  const model = useMemo(() => {
    // The other Reports of the Post, numbered as their tabs are (time order).
    const others = ordered.flatMap((r, i) => {
      const e = r.id === report.id ? undefined : reportEndMs(r);
      if (e === undefined) return [];
      return [
        {
          id: r.id,
          label: `${i + 1} · ${(r.bodyName ?? 'lake').toUpperCase()}`,
          ...(r.sheet.scalars.skateStartTime !== undefined
            ? { startMs: r.sheet.scalars.skateStartTime }
            : {}),
          endMs: e,
        },
      ];
    });
    return timelineModel({
      timeZone,
      nowMs: now,
      ...(endMs !== undefined ? { endMs } : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      sun,
      others,
      ladder,
    });
  }, [ordered, report.id, timeZone, now, endMs, startMs, sun, ladder]);

  const chosenPin = sheet.scalars.putInId ?? sheet.scalars.parkingAreaId;
  const placed = report.photos.filter((p) => p.placeOnMap && p.coord !== undefined);
  const hazards: LakeMapHazard[] = useMemo(
    () =>
      (body?.hazards ?? []).map((h) => ({
        id: h.id,
        lat: (h.bbox.minLat + h.bbox.maxLat) / 2,
        lng: (h.bbox.minLng + h.bbox.maxLng) / 2,
        label: h.label,
        passage: isPassageMarker(h.type),
      })),
    [body?.hazards],
  );
  // In where-mode the lake shows the open card's answer and nothing else's: another chip's sector
  // or the put-in's point drawn under an unanswered card would read as this card's answer.
  const asking = mode?.kind === 'where';
  const where = asking ? mode.where : undefined;
  const sector = asking ? where?.sector : firstSector(report);
  const modePoint = where?.point
    ? {
        ...where.point.coord,
        ...(where.point.radiusMeters !== undefined
          ? { radiusMeters: where.point.radiusMeters }
          : {}),
      }
    : undefined;
  const point = asking ? modePoint : chosenPin === undefined ? sheet.scalars.point : undefined;
  const putInName = body?.putIns.find((p) => p.id === sheet.scalars.putInId)?.name;
  const dim = mode !== null;

  return (
    <main inert={sent} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div
          className={cn('absolute top-3.5 left-[18px] flex flex-col gap-0.5', dim && 'sheet-dim')}
        >
          <Eyebrow>
            Report {ordinal} of {post.reports.length}
          </Eyebrow>
          {editing ? (
            <span className="font-semibold text-foreground text-xl leading-tight">
              {report.bodyName ?? body?.name ?? 'This report'}
            </span>
          ) : (
            <button
              type="button"
              onClick={onPickBody}
              className="text-left font-semibold text-foreground text-xl leading-tight hover:underline"
            >
              {report.bodyName ?? body?.name ?? 'Which lake?'} <span aria-hidden>›</span>
            </button>
          )}
          {body?.frame ? (
            <span className="font-mono text-[10.5px] text-foreground-muted">
              {body.frame.origin.lat.toFixed(4)}°N {Math.abs(body.frame.origin.lng).toFixed(4)}°W
            </span>
          ) : report.coord ? (
            <span className="text-foreground-muted text-xs">
              Matched from your location when it posts.
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            'absolute top-3.5 right-[18px] flex flex-col items-end gap-0.5 text-right',
            dim && 'sheet-dim',
          )}
        >
          {gps ? (
            <>
              <Eyebrow>Track</Eyebrow>
              <span className="font-semibold text-foreground text-[13px]">
                Your recording
                {startMs !== undefined && endMs !== undefined
                  ? ` · ${clock(startMs)}–${clock(endMs)}`
                  : ''}
              </span>
            </>
          ) : putInName ? (
            <>
              <Eyebrow>Put-in</Eyebrow>
              <span className="font-semibold text-foreground text-[13px]">{putInName}</span>
            </>
          ) : null}
        </div>
        {mode ? (
          <div className="-translate-x-1/2 absolute top-3.5 left-1/2 z-10 flex items-center gap-3 whitespace-nowrap rounded-[2px] border border-primary bg-background px-3 py-1.5 text-xs shadow-[0_0_0_4px_var(--ring)]/20">
            <Eyebrow className="text-primary">
              {mode.kind === 'where'
                ? `Where is the ${mode.label.toLowerCase()}?`
                : 'Where did you get on?'}
            </Eyebrow>
            <span className="text-foreground-muted">
              {mode.kind === 'where'
                ? 'Click a sector on the ring, a bay, or a point on the water'
                : 'Click a launch, or the shore for somewhere else'}
            </span>
            <kbd className="rounded-[2px] border border-border-strong px-1 font-mono text-[10px] text-foreground-muted">
              esc
            </kbd>
          </div>
        ) : null}
        {body?.silhouette ? (
          <div className="w-full max-w-[520px] px-4">
            <LakeMap
              data={body.silhouette}
              pins={[
                ...body.putIns.map((p) => ({
                  id: p.id,
                  ...p.coord,
                  label: p.name,
                  kind: 'putIn' as const,
                })),
                ...body.parking.map((p) => ({
                  id: p.id,
                  ...p.coord,
                  label: p.name,
                  kind: 'parking' as const,
                })),
              ]}
              {...(chosenPin !== undefined ? { chosenPinId: chosenPin } : {})}
              {...(sector !== undefined ? { sector } : {})}
              {...(point !== undefined ? { point } : {})}
              {...(body.silhouette.path !== undefined ? { path: body.silhouette.path } : {})}
              photos={placed.map((p) => ({
                id: p.id,
                lat: (p.coord as LatLng).lat,
                lng: (p.coord as LatLng).lng,
              }))}
              hazards={mode ? [] : hazards}
              width={480}
              height={mode?.kind === 'where' ? 420 : 380}
              ring={mode?.kind === 'where'}
              litPins={mode?.kind === 'putIn'}
              {...(mode?.kind === 'where'
                ? {
                    onPickSector: (s: CompassSector) =>
                      mode.onChange({ ...(mode.where ?? {}), sector: s }),
                    onPick: (coord: LatLng) => mode.onChange(whereClickOnWater(mode.where, coord)),
                  }
                : mode?.kind === 'putIn'
                  ? {
                      onPickPin: (pin: { id: string; kind: 'putIn' | 'parking' }) =>
                        mode.onPickPin(pin.id, pin.kind),
                      onPick: (coord: LatLng) => mode.onPickShore(coord),
                    }
                  : {})}
              label={`${body.name || 'The lake'}, with your put-in and any photos you placed.`}
            />
          </div>
        ) : (
          <div className="px-6">
            <SheetHint>
              {sheet.waterBodyId === undefined
                ? 'Pick the lake and it will be drawn here, with your put-in on it.'
                : 'Drawing the lake…'}
            </SheetHint>
          </div>
        )}
        <div
          className={cn(
            'absolute bottom-3 left-[18px] flex gap-3.5 text-[10.5px] text-foreground-muted',
            dim && 'sheet-dim',
          )}
        >
          <Legend swatch="rounded-full bg-primary">put-in</Legend>
          <Legend swatch="border border-foreground-muted">lot</Legend>
          <Legend swatch="h-0 w-3.5 border-foreground border-t border-dashed">your track</Legend>
          <Legend swatch="border border-foreground">photo</Legend>
          <Legend swatch="size-0 border-x-[5px] border-x-transparent border-b-[8px] border-b-danger">
            hazard
          </Legend>
        </div>
        {mode?.kind === 'where' && where?.sector ? (
          <div className="absolute right-[18px] bottom-3 flex flex-col items-end">
            <Eyebrow className="text-primary">{where.sector}</Eyebrow>
            <span className="text-foreground text-xs">
              {mode.label}
              {where.extent ? ` · ${where.extent}` : ''}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex-none border-border border-t">
        <Timeline
          model={model}
          dim={dim}
          endLocked={gps}
          {...(!gps
            ? {
                onSetEnd: (ms: number) =>
                  dispatch({
                    type: 'select',
                    field: 'endTime',
                    key: 'chosen',
                    value: { ms, precision: 'minute' },
                  }),
                onSetStart: (ms: number) =>
                  dispatch({ type: 'setScalar', key: 'skateStartTime', value: ms }),
              }
            : {})}
        />
      </div>
      <div className="flex-none border-border border-t">
        <WeatherBand
          hours={hours}
          windowHours={windowHours}
          endMs={endMs}
          timeZone={timeZone}
          sun={sun}
          fractionOf={(ms) => timelineFraction(model, ms)}
          report={report}
          dispatch={dispatch}
          dim={dim}
        />
      </div>
    </main>
  );
}

function Legend({ swatch, children }: { swatch: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn('inline-block size-2', swatch)} />
      {children}
    </span>
  );
}

/** The first sector any located chip names — the wash when no where question is open. */
function firstSector(report: SheetReport) {
  const located = [
    ...selectedValues(report.sheet, 'iceTypes'),
    ...selectedValues(report.sheet, 'surfaceTags'),
  ];
  return located.find((c) => c.where?.sector !== undefined)?.where?.sector;
}

// ── The status bar ───────────────────────────────────────────────────────────────────────────────

function StatusBar({
  post,
  ordered,
  editing,
  dim,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  editing: boolean;
  dim: boolean;
}) {
  const persistedAt = usePersistedAt();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  void tick;
  const photos = post.reports.reduce((n, r) => n + r.photos.length + r.keptPhotoIds.length, 0);
  return (
    <footer
      className={cn(
        'flex h-[30px] items-center gap-4 border-border border-t bg-surface px-3.5 font-mono text-[10.5px] text-foreground-muted uppercase lg:col-span-3',
        dim && 'sheet-dim',
      )}
    >
      <span className="inline-flex items-center gap-2">
        <StatusSquare state={editing ? 'empty' : persistedAt !== null ? 'ice' : 'empty'} />
        {editing
          ? 'Editing the published report'
          : persistedAt !== null
            ? `Saved in this browser · ${ago(persistedAt)}`
            : 'Not saved yet'}
      </span>
      <span className="flex items-center gap-4">
        {ordered.map((r, i) => (
          <span key={r.id}>
            <span className="text-foreground-muted/70">
              {ordered.length > 1 ? `${i + 1} ` : ''}
              {(r.bodyName ?? 'lake').split(' ')[0]}{' '}
            </span>
            <span className="text-foreground">
              {sectionsFilled(r.sheet)} / {SHEET_SECTION_COUNT}
            </span>
          </span>
        ))}
        {photos > 0 ? (
          <span>
            <span className="text-foreground-muted/70">Photos </span>
            <span className="text-foreground">{photos}</span>
          </span>
        ) : null}
      </span>
      <span className="ml-auto">{online ? 'Online' : 'Offline — a post will not send'}</span>
    </footer>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
