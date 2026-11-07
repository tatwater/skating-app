import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import {
  addPostPhotos,
  assignCandidates,
  isMinor,
  type PostSheet,
  postCreateSent,
  postRefusals,
  type ReportRefusal,
  reassignPool,
  reportEndMs,
  reportsInTimeOrder,
  type SheetReport,
  sectionsFilled,
} from '@skating/core';
import { useConvex, useQuery } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/kit/alert-dialog';
import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';
import { INK_PRIMARY } from '@/components/skater/styles';
import { useAnalytics } from '@/lib/analytics';
import { useBodyOutlines } from '@/lib/bodyOutlines';
import { useFeatureFlag } from '@/lib/featureFlags';
import { postSheetOnWeb, saveSheetEditOnWeb } from '@/lib/sheetActions';
import { addSheetPhoto } from '@/lib/sheetPhotos';
import { useResendOnReconnect } from '@/lib/sheetReconnect';
import {
  dismissSheetPhotosLost,
  type SheetSender,
  type SheetSendResult,
  sendSheet,
  updateSheet,
  usePersistedAt,
  useSheetAttempt,
  useSheetPhotosLost,
  useSheetPhotosNotKept,
  useSheetResend,
} from '@/lib/sheetStore';
import { useConnection } from '@/lib/useConnection';
import { cn } from '@/lib/utils';
import { ConsoleModeProvider } from './ConsoleMode';
import { InstrumentPane } from './InstrumentPane';
import { LakeNameSearch } from './LakeNameSearch';
import { ReportPanels } from './ReportPanels';
import { StatusSquare } from './SheetPanel';
import { SheetWords } from './SheetWords';
import {
  gapsFor,
  meterCells,
  meterLabel,
  missingCount,
  refusalMessage,
  removeLake,
  savedState,
  setReportBody,
} from './sheetModel';
import { useSheetSlots } from './sheetSlots';
import { useSheetBody } from './useSheetBody';
import { WhichLakeCards } from './WhichLakeCards';

/** What leaving the sheet asks of the host. */
export interface ReportSheetExits {
  /** × or Esc: close, keeping the draft. The host's blocker asks first when that would lose it. */
  onClose: () => void;
  /** Cancel, confirmed: the draft is thrown away; the host closes. */
  onDiscard: () => void;
  /** Posted or saved: the host goes to the published report. */
  onDone: (reportId: string) => void;
}

const SENT_COPY =
  'This post was sent, but the server hasn’t responded, so it may already be up. It’s saved on this device and sends itself again when the connection comes back. It can’t take changes until it has landed, but once it does you’ll be able to edit it from its page.';

/**
 * The New report sheet (B03 §5, boards 5.1–5.31): two panes over whatever page you came from. On
 * the left the instrument — the lake on its own map, the day's ruler, the weather you had — or,
 * until the open Report has a lake, *Which lake?*. On the right one sheet: your words and photos
 * first, then the questions in the fixed order (D187), the minimum-set ones open and the rest
 * folded to a line each; *Post* at its foot.
 *
 * The model, the doors, what refuses a Post and what *Post* does are all core's and the store's
 * (`postSheet`, `flushPost`, `sendSheet`) — the same sheet the phone draws; this is the composition.
 */
export function ReportSheet({ post, exits }: { post: PostSheet; exits: ReportSheetExits }) {
  return (
    <ConsoleModeProvider>
      <Sheet post={post} exits={exits} />
    </ConsoleModeProvider>
  );
}

function Sheet({ post, exits }: { post: PostSheet; exits: ReportSheetExits }) {
  const convex = useConvex();
  const { capture } = useAnalytics();
  const profile = useQuery(api.profiles.current, {});
  const attempt = useSheetAttempt();
  const resend = useSheetResend();
  const persistedAt = usePersistedAt();
  const photosLost = useSheetPhotosLost();
  const photosNotKept = useSheetPhotosNotKept();
  const { status } = useConnection();
  const online = status !== 'offline';
  const outlines = useBodyOutlines();

  const [activeId, setActiveId] = useState(post.reports[0]?.id ?? '');
  const [refusals, setRefusals] = useState<ReportRefusal[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<SheetReport | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [photosBusy, setPhotosBusy] = useState(false);

  const editing = post.mode.kind === 'edit';
  const sent = postCreateSent(attempt);
  const posting = resend === 'sending' || saving;
  const ordered = useMemo(() => reportsInTimeOrder(post), [post]);
  const active = post.reports.find((r) => r.id === activeId) ?? post.reports[0];
  const body = useSheetBody(active?.sheet.waterBodyId);
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  // The photo pool re-runs its rules when a lake's outline arrives (A10-7). Quiet: the sheet's doing.
  useEffect(() => {
    if (!post.photos || post.photos.length === 0) return;
    updateSheet((p) => reassignPool(p, assignCandidates(p, outlines)));
  }, [outlines, post.photos]);

  const sender =
    (now: number): SheetSender =>
    (sheet, previous) =>
      postSheetOnWeb(convex, sheet, now, previous);

  /** What came of a send — *Post* pressed, a retry, or a resend when the connection came back. */
  const afterSend = useCallback(
    (result: SheetSendResult) => {
      if (result.kind === 'skipped') return;
      if (result.kind === 'refused') {
        setMessage(result.message);
        return;
      }
      capture('report_posted', { report_count: post.reports.length });
      exits.onDone(result.reportId);
    },
    [capture, exits, post.reports.length],
  );

  // A transient failure the author has not touched since goes out again when the connection returns.
  useResendOnReconnect((sheet, previous) => {
    capture('report_post_retried', { offline: true });
    return sender(Date.now())(sheet, previous);
  }, afterSend);

  const onPost = async () => {
    setMessage(null);
    const now = Date.now();
    // A sent Post is not asked the create-only rules again: it may be live (flushPost skips them too).
    const found = sent ? [] : postRefusals(post, now);
    setRefusals(found);
    if (found.length > 0) {
      capture('report_sheet_refused', { missing_count: missingCount(found) });
      setMessage(refusalMessage(found, post.reports.length));
      const gapReport = post.reports.find((r) => r.id === found[0]?.reportId);
      if (gapReport) setActiveId(gapReport.id);
      return;
    }
    if (editing) {
      setSaving(true);
      try {
        const reportId = await saveSheetEditOnWeb(convex, post);
        capture('report_updated');
        exits.onDone(reportId);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
      return;
    }
    if (attempt !== null) capture('report_post_retried', { offline: false });
    // Through the store, so *Post* and a reconnect's resend share one flight and one record.
    afterSend(await sendSheet(sender(now)));
  };

  const onDiscard = () => {
    if (post.dirty || sent) setDiscarding(true);
    else exits.onDiscard();
  };

  const addPhotosFromCards = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/') || f.type === '');
    if (picked.length === 0) return;
    setPhotosBusy(true);
    try {
      const drafts = await Promise.all(picked.map(addSheetPhoto));
      updateSheet((p) => addPostPhotos(p, drafts, assignCandidates(p, outlines)));
      capture('report_photos_added', { source: 'device', count: drafts.length });
    } catch {
      setMessage("Couldn't read one of those images — try a different file.");
    } finally {
      setPhotosBusy(false);
    }
  };

  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false;
  if (!active) return null;
  const waitingForLake = active.sheet.waterBodyId === undefined && active.coord === undefined;
  const ordinal = ordered.findIndex((r) => r.id === active.id) + 1;
  const saved = savedState({ editing, persistedAt, online, now: Date.now() });
  const offlineCreate = !online && !editing;

  return (
    <div
      data-slot="report-sheet"
      data-posting={posting ? '' : undefined}
      className="flex size-full min-h-0 flex-col"
    >
      <SheetTop
        ordered={ordered}
        activeId={active.id}
        refusals={refusals}
        editing={editing}
        inert={posting}
        saved={saved}
        onSelect={setActiveId}
        onRemove={(r) => setRemoving(r)}
        onClose={exits.onClose}
      />
      {minor ? (
        <p className="m-0 p-(--space-6) text-row text-fg2">
          Reports are shared publicly with the community, so posting opens when you turn 18. You can
          keep reading reports in the meantime.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          {waitingForLake ? (
            <WhichLake
              ordinal={ordinal}
              reportId={active.id}
              photosBusy={photosBusy}
              onPhotos={(files) => void addPhotosFromCards(files)}
            />
          ) : (
            <InstrumentPane
              key={active.id}
              report={active}
              ordered={ordered}
              body={body}
              inert={posting || sent}
            />
          )}
          <aside aria-label="Your report" className="flex w-[29.25rem] shrink-0 flex-col min-h-0">
            <div className="flex min-h-0 flex-1 flex-col gap-(--space-5_5) overflow-y-auto px-(--space-6) pt-(--space-5)">
              <Notices sent={sent} photosLost={photosLost} photosNotKept={photosNotKept} />
              <div
                inert={posting || sent}
                className={cn('flex flex-col gap-(--space-5_5)', (posting || sent) && 'opacity-50')}
              >
                <SheetWords post={post} ordered={ordered} editing={editing} activeReport={active} />
                <div
                  inert={waitingForLake}
                  className={cn(waitingForLake && 'opacity-30')}
                  {...(waitingForLake ? { 'aria-hidden': true } : {})}
                >
                  {/* Keyed by the Report: the panels hold their own affordance state. */}
                  <ReportPanels
                    key={active.id}
                    report={active}
                    body={body}
                    gaps={gapsFor(refusals, active.id)}
                    editing={editing}
                  />
                </div>
              </div>
              <div className="h-9 shrink-0" />
            </div>
            <SheetFoot
              editing={editing}
              sent={sent}
              posting={posting}
              offline={offlineCreate}
              message={message}
              onCancel={onDiscard}
              onPost={() => void onPost()}
            />
          </aside>
        </div>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.bodyName ?? 'this lake'}?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <p className="m-0 text-row text-fg1">
              Its answers go with it: how it was, the ice, when, where you got on, and the hazards
              you answered. Your words and photos stay.
            </p>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button
              data-attr="remove-lake-confirm"
              onClick={() => {
                const id = removing?.id;
                setRemoving(null);
                if (id !== undefined)
                  updateSheet((p) => removeLake(p, id, Date.now(), () => crypto.randomUUID()));
              }}
            >
              Remove
            </Button>
            <AlertDialogCancel className={INK_PRIMARY}>Keep it</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LeaveDialog
        open={discarding}
        sent={sent}
        onKeep={() => setDiscarding(false)}
        onLeave={() => {
          setDiscarding(false);
          exits.onDiscard();
        }}
      />
    </div>
  );
}

/**
 * 5.31: *Leave without posting?* — Leave or Keep writing. Shared by Cancel and by the host's blocker
 * (Back, a link) when leaving would lose the draft.
 */
export function LeaveDialog({
  open,
  sent,
  onKeep,
  onLeave,
}: {
  open: boolean;
  sent: boolean;
  onKeep: () => void;
  onLeave: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent data-slot="leave-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {sent ? 'Leave without finding out?' : 'Leave without posting?'}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <p className="m-0 text-row text-fg1">
            {sent
              ? 'This post may already be up. Check your profile before posting it again.'
              : 'What you wrote here will be gone.'}
          </p>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogAction data-attr="leave-confirm" onClick={onLeave}>
            Leave without posting
          </AlertDialogAction>
          <AlertDialogCancel data-attr="leave-keep" className={INK_PRIMARY}>
            Keep writing
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── The top: kicker, a tab per Report, the status, Close ────────────────────────────────────────

function SheetTop({
  ordered,
  activeId,
  refusals,
  editing,
  inert,
  saved,
  onSelect,
  onRemove,
  onClose,
}: {
  ordered: readonly SheetReport[];
  activeId: string;
  refusals: readonly ReportRefusal[];
  editing: boolean;
  inert: boolean;
  saved: ReturnType<typeof savedState>;
  onSelect: (id: string) => void;
  onRemove: (report: SheetReport) => void;
  onClose: () => void;
}) {
  const { anotherReport } = useSheetSlots();
  const many = ordered.length > 1;
  return (
    <div
      data-slot="sheet-top"
      className="flex h-13 shrink-0 items-stretch border-0 border-b border-solid border-line pl-(--space-5_5)"
    >
      <span className="mr-(--space-5_5) self-center text-kick leading-none font-medium tracking-head text-fg2 uppercase">
        {editing ? 'Editing a post' : 'New report'}
      </span>
      <div
        role="tablist"
        aria-label="The lakes in this post"
        inert={inert}
        className={cn('flex items-stretch', inert && 'opacity-50')}
      >
        {ordered.map((report, i) => (
          <ReportTab
            key={report.id}
            report={report}
            n={many ? i + 1 : null}
            full={report.id === activeId || ordered.length < 3}
            selected={report.id === activeId}
            needed={gapsFor(refusals, report.id).size}
            removable={!editing && (many || report.sheet.waterBodyId !== undefined)}
            onSelect={() => onSelect(report.id)}
            onRemove={() => onRemove(report)}
          />
        ))}
      </div>
      {!editing && anotherReport !== undefined ? (
        <div inert={inert} className={cn('flex items-stretch', inert && 'opacity-50')}>
          {anotherReport({ activeReportId: activeId, onAdded: onSelect })}
        </div>
      ) : null}
      <div className="ml-auto flex items-center gap-(--space-4) pr-(--space-3_5)">
        <span
          data-slot="sheet-saved"
          className={cn(
            'inline-flex items-center gap-(--space-2) font-(family-name:--family-mono) text-mono-sm',
            saved.tone === 'warn' ? 'text-warn' : 'text-fg2',
          )}
        >
          <StatusSquare
            state={saved.tone === 'hollow' ? 'empty' : saved.tone === 'warn' ? 'needed' : 'filled'}
          />
          {saved.text}
        </span>
        <Button size="sm" data-attr="sheet-close" onClick={onClose}>
          Close
          <Kbd variant="dim" aria-hidden="true">
            Esc
          </Kbd>
        </Button>
      </div>
    </div>
  );
}

function ReportTab({
  report,
  n,
  full,
  selected,
  needed,
  removable,
  onSelect,
  onRemove,
}: {
  report: SheetReport;
  n: number | null;
  full: boolean;
  selected: boolean;
  needed: number;
  removable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const end = reportEndMs(report);
  const start = report.sheet.scalars.skateStartTime;
  const answered = sectionsFilled(report.sheet);
  const name = report.bodyName ?? 'Which lake?';
  return (
    <div
      className={cn(
        'relative flex items-center border-0 border-r border-solid border-line',
        selected &&
          'bg-panel after:absolute after:right-0 after:-bottom-px after:left-0 after:h-0.5 after:bg-fg',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        data-attr="sheet-tab"
        onClick={onSelect}
        className="flex h-full cursor-pointer items-center gap-(--space-3) border-0 bg-transparent px-(--space-4_5) text-left outline-none focus-visible:shadow-focus"
      >
        {n !== null ? (
          <span className="flex size-4.5 items-center justify-center bg-fg1 font-(family-name:--family-mono) text-[0.625rem] text-bg">
            {n}
          </span>
        ) : null}
        <span className={cn('text-row', selected ? 'font-semibold text-fg' : 'text-fg1')}>
          {name}
        </span>
        {full && end !== undefined ? (
          <span className="font-(family-name:--family-mono) text-mono-sm text-fg2">
            {start !== undefined ? `${clock(start)}–` : ''}
            {clock(end)}
          </span>
        ) : null}
        {full ? <SectionMeter answered={answered} needed={needed} /> : null}
        {needed > 0 ? <span className="sr-only">, needs answers</span> : null}
      </button>
      {removable && selected ? (
        <button
          type="button"
          aria-label={`Remove ${name} from the report`}
          data-attr="sheet-tab-remove"
          onClick={onRemove}
          className="mr-(--space-3) flex size-5 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-fg3 outline-none hover:text-fg focus-visible:shadow-focus"
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      ) : null}
    </div>
  );
}

/** Ten cells: what is answered, then what a refused *Post* still needs. It never says "ready" (D3). */
export function SectionMeter({ answered, needed }: { answered: number; needed: number }) {
  return (
    <span role="img" aria-label={meterLabel(answered)} className="flex gap-0.5">
      {meterCells(answered, needed).map((cell, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: the cells are positions, fixed at ten.
          key={i}
          data-cell={cell}
          className={cn(
            'block h-2.25 w-1.75',
            cell === 'on' && 'bg-fg1',
            cell === 'need' && 'bg-warn',
            cell === 'off' && 'bg-line2',
          )}
        />
      ))}
    </span>
  );
}

// ── The left pane before a lake: Which lake? ─────────────────────────────────────────────────────

function WhichLake({
  ordinal,
  reportId,
  photosBusy,
  onPhotos,
}: {
  ordinal: number;
  reportId: string;
  photosBusy: boolean;
  onPhotos: (files: File[]) => void;
}) {
  const gpxEnabled = useFeatureFlag('gpx-import', false);
  const { gpxImport, googlePhotos } = useSheetSlots();
  const outlines = useBodyOutlines();
  return (
    <section
      aria-label="Which lake?"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-0 border-r border-solid border-line"
    >
      <WhichLakeCards
        ordinal={ordinal}
        gpxEnabled={gpxEnabled}
        {...(gpxEnabled && gpxImport !== undefined
          ? { gpx: gpxImport({ reportId, onImported: () => {} }) }
          : {})}
        photosBusy={photosBusy}
        onPhotos={onPhotos}
        {...(googlePhotos !== undefined
          ? {
              googlePhotos: googlePhotos({
                disabled: photosBusy,
                onPhotos: (drafts) =>
                  updateSheet((p) => addPostPhotos(p, drafts, assignCandidates(p, outlines))),
              }),
            }
          : {})}
        search={
          <LakeNameSearch
            onPick={(picked) => updateSheet((p) => setReportBody(p, reportId, picked))}
          />
        }
      />
    </section>
  );
}

// ── Notices and the foot ─────────────────────────────────────────────────────────────────────────

function Notices({
  sent,
  photosLost,
  photosNotKept,
}: {
  sent: boolean;
  photosLost: number;
  photosNotKept: boolean;
}) {
  const items: ReactNode[] = [];
  if (sent) {
    items.push(
      <Notice key="sent" tone="warn" slot="sent">
        {SENT_COPY}
      </Notice>,
    );
  }
  if (photosLost > 0) {
    items.push(
      <Notice key="lost" tone="warn" slot="photos-lost" onDismiss={dismissSheetPhotosLost}>
        Your words are back; {photosLost} {photosLost === 1 ? 'photo' : 'photos'} couldn't be kept.
        Add {photosLost === 1 ? 'it' : 'them'} again before you post.
      </Notice>,
    );
  }
  if (photosNotKept) {
    items.push(
      <Notice key="not-kept" tone="plain" slot="photos-not-kept">
        This browser won't keep these photos if the page reloads. They're still here, and they still
        post.
      </Notice>,
    );
  }
  return items.length > 0 ? <div className="flex flex-col gap-(--space-2)">{items}</div> : null;
}

function Notice({
  tone,
  slot,
  onDismiss,
  children,
}: {
  tone: 'warn' | 'plain';
  slot: string;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      data-slot={`notice-${slot}`}
      className={cn(
        'flex items-start gap-(--space-3) border border-solid p-(--space-3) text-assist leading-body [text-wrap:pretty]',
        tone === 'warn' ? 'border-warn-line bg-warn-wash text-fg1' : 'border-line2 text-fg2',
      )}
    >
      <span className="flex-1">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          data-attr="notice-dismiss"
          onClick={onDismiss}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-fg2 outline-none hover:text-fg focus-visible:shadow-focus"
        >
          <FontAwesomeIcon icon={faXmark} />
        </button>
      ) : null}
    </div>
  );
}

function SheetFoot({
  editing,
  sent,
  posting,
  offline,
  message,
  onCancel,
  onPost,
}: {
  editing: boolean;
  sent: boolean;
  posting: boolean;
  offline: boolean;
  message: string | null;
  onCancel: () => void;
  onPost: () => void;
}) {
  const label = posting
    ? editing
      ? 'Saving…'
      : 'Posting…'
    : editing
      ? 'Save changes'
      : sent
        ? 'Try again'
        : 'Post';
  const line =
    message ??
    (offline ? 'Your draft is saved on this device. Post once you’re back online.' : null);
  return (
    <div
      data-slot="sheet-foot"
      className="flex shrink-0 items-center gap-(--space-3) border-0 border-t border-solid border-line px-(--space-6) py-(--space-3_5)"
    >
      <Button data-attr="sheet-cancel" disabled={posting} onClick={onCancel}>
        Cancel
      </Button>
      {line !== null ? (
        <span
          role={message !== null ? 'alert' : 'status'}
          data-slot="sheet-foot-message"
          className={cn(
            'flex min-w-0 flex-1 items-start gap-(--space-2) text-assist leading-body [text-wrap:pretty]',
            message !== null ? 'text-warn' : 'text-fg2',
          )}
        >
          {line}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <Button
        variant="primary"
        data-attr="sheet-post"
        className={cn('w-35', INK_PRIMARY)}
        loading={posting}
        disabled={offline}
        onClick={onPost}
      >
        {label}
      </Button>
    </div>
  );
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(ms);
}
