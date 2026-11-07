import { api } from '@skating/convex/api';
import { postCreateSent, sectionsFilled } from '@skating/core';
import { useBlocker, useNavigate, useRouterState } from '@tanstack/react-router';
import { useConvex, useConvexAuth, useQuery } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/kit/dialog';
import { CellLoader } from '@/components/kit/meter';
import { useAnalytics } from '@/lib/analytics';
import { postSheetOnWeb } from '@/lib/sheetActions';
import { openWebDoor, restoreMatchesDoor } from '@/lib/sheetDoors';
import { releaseAllSheetPhotos } from '@/lib/sheetPhotos';
import {
  clearStoredSheet,
  getSheetAttempt,
  resendSheet,
  restoreStoredSheet,
  setSheet,
  usePersistedAt,
  useSheet,
  useSheetAttempt,
  useSheetRestoring,
} from '@/lib/sheetStore';
import { type SkaterRootSearch, skaterRootSearchSchema } from '@/lib/skaterSearch';
import { LeaveDialog, ReportSheet } from './ReportSheet';
import {
  ABANDON_KEY,
  closedSearch,
  doorKey,
  entryRecorded,
  leaveAsks,
  parseAbandonMarker,
  type SheetDoor,
  settleAbandonMarker,
  sheetDoorOf,
  sheetOpenEntry,
  webDoorParams,
} from './sheetHostModel';
import { SheetContainerProvider, SheetSlotsProvider } from './sheetSlots';
import { SHEET_SLOTS } from './slots';

/**
 * The New report sheet's host (B03 §5, D242): mounted once in the skater layout, beside the page,
 * it reads `?post=` / `?postBody=` and opens the sheet over **whatever skater page is current** —
 * the page dims behind the scrim; the region map behind it is legitimate (§1.8).
 *
 * - **Doors.** `?post=new` a blank sheet (or the draft this browser kept for it), `?postBody=` its
 *   lake, `?post=<reportId>` that report for editing (`sheetDoors`). A door is answered once.
 * - **Restore.** A reload lands on the draft that was being written (`restoreStoredSheet`, with a
 *   restoring state while the photos come back); a draft that was owed a resend gets one try.
 * - **Closing removes the params** (`replace`), never `history.back()` — a deep link has nothing to
 *   go back to. Close keeps the draft; Cancel throws it away.
 * - **The browser's Back closes the sheet too**, which would slip past the leave dialog — so the
 *   guard is a router blocker (5.31), asking whenever leaving would lose what was written.
 */
export function ReportSheetHost() {
  const location = useRouterState({ select: (s) => s.location });
  const search = skaterRootSearchSchema.parse(location.search) as SkaterRootSearch;
  const door = sheetDoorOf(search);
  return <Host door={door} navState={location.state} />;
}

function Host({ door, navState }: { door: SheetDoor; navState: unknown }) {
  const navigate = useNavigate();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const profile = useQuery(api.profiles.current, isAuthenticated ? {} : 'skip');
  const { capture } = useAnalytics();
  const sheet = useSheet();
  const attempt = useSheetAttempt();
  const persistedAt = usePersistedAt();
  const restoring = useSheetRestoring();
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const open = door.kind !== 'none';
  const key = doorKey(door);
  /** The door this mount already answered — what the author does to the sheet then is theirs. */
  const answered = useRef<string | null>(null);
  /** The first door this host saw arrived with the page: a landing, not an in-app open. */
  const firstDoor = useRef<string | null>(null);
  if (firstDoor.current === null) firstDoor.current = key;

  // ── Closing ───────────────────────────────────────────────────────────────────────────────────
  const close = useCallback(() => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => closedSearch(prev),
      replace: true,
    } as never);
  }, [navigate]);

  const discard = useCallback(() => {
    const current = sheet;
    if (
      current !== null &&
      current.mode.kind === 'create' &&
      (current.dirty || postCreateSent(attempt))
    ) {
      capture('report_sheet_abandoned', {
        sections_answered: current.reports.reduce((n, r) => n + sectionsFilled(r.sheet), 0),
      });
    }
    writeAbandonMarker(null);
    releaseAllSheetPhotos();
    setSheet(null);
    clearStoredSheet();
    close();
  }, [attempt, capture, close, sheet]);

  const done = useCallback(
    (reportId: string) => {
      writeAbandonMarker(null);
      setSheet(null);
      clearStoredSheet();
      void navigate({ to: '/report/$id', params: { id: reportId } });
    },
    [navigate],
  );

  // ── The leave guard (5.31): ×, Esc, Back, Forward and any link go through it ────────────────────
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => {
      const nextDoor = sheetDoorOf(skaterRootSearchSchema.parse(next.search ?? {}));
      if (doorKey(nextDoor) === key) return false;
      return leaveAsks({ how: 'close', sheet, attempt, persistedAt });
    },
    enableBeforeUnload: () => open && leaveAsks({ how: 'close', sheet, attempt, persistedAt }),
    disabled: !open,
    withResolver: true,
  });

  /** The next open settles a marker: the draft came back, or it was abandoned. */
  const settleAbandon = useCallback(
    (reopenedDraftId: string | null) => {
      const settled = settleAbandonMarker(readAbandonMarker(), reopenedDraftId);
      writeAbandonMarker(null);
      if (settled !== null) {
        capture('report_sheet_abandoned', { sections_answered: settled.sectionsAnswered });
      }
    },
    [capture],
  );

  // ── Opening: the door, the restore, the analytics ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      answered.current = null;
      return;
    }
    if (!isAuthenticated || profile === undefined) return;
    if (answered.current === key) return;
    answered.current = key;
    setError(null);

    const entry = sheetOpenEntry({
      door,
      landed: firstDoor.current === key,
      recorded: entryRecorded(navState),
    });
    if (entry !== null) capture('report_sheet_opened', { entry });

    const params = webDoorParams(door);
    // A sheet already open for this door is the one being written — never rebuilt under the author.
    // A sent Post is kept whatever the door: it may be live, and only a retry finds out.
    if (
      sheet !== null &&
      (restoreMatchesDoor(sheet, params) || postCreateSent(getSheetAttempt()))
    ) {
      settleAbandon(sheet.draftId);
      return;
    }
    void (async () => {
      const restored = await restoreStoredSheet(Date.now());
      if (answered.current !== key) return;
      if (
        restored !== null &&
        (restoreMatchesDoor(restored.sheet, params) || postCreateSent(restored.attempt))
      ) {
        setSheet(restored.sheet, restored.attempt, restored.resendArmed);
        settleAbandon(restored.sheet.draftId);
        capture('report_draft_restored');
        // The reconnect hook fires only on the way into online; a restore owed a resend gets one try.
        if (restored.resendArmed) {
          capture('report_post_retried', { offline: true });
          const result = await resendSheet((s, previous) =>
            postSheetOnWeb(convex, s, Date.now(), previous),
          );
          if (result.kind === 'posted') {
            capture('report_posted', { report_count: restored.sheet.reports.length });
            done(result.reportId);
          }
        }
        return;
      }
      settleAbandon(null);
      const next = await openWebDoor(convex, params, profile?.showPutInDefault, Date.now());
      if (answered.current !== key) return;
      if (next === null) {
        setError("That report isn't yours to edit, or it's no longer there.");
        return;
      }
      setSheet(next);
    })();
  }, [
    open,
    isAuthenticated,
    profile,
    key,
    door,
    navState,
    sheet,
    convex,
    capture,
    done,
    settleAbandon,
  ]);

  // ── Abandonment: a page hidden over an unsent, touched draft leaves a marker ──────────────────
  useEffect(() => {
    if (!open) return;
    const onHide = () => {
      const current = sheet;
      if (current === null || current.mode.kind !== 'create' || !current.dirty) return;
      writeAbandonMarker({
        draftId: current.draftId,
        sectionsAnswered: current.reports.reduce((n, r) => n + sectionsFilled(r.sheet), 0),
      });
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [open, sheet]);

  const ready = sheet !== null && !restoring && error === null;
  return (
    <>
      <Dialog
        open={open}
        disablePointerDismissal
        onOpenChange={(next, details) => {
          if (!next && details.reason === 'escape-key') close();
        }}
      >
        <DialogContent
          ref={setContainer}
          size="viewer"
          // The words are where a report starts (5.1), or the lake search before a lake (5.2).
          initialFocus={() =>
            container?.querySelector<HTMLElement>(
              '[data-attr="which-lake-search"], [data-attr="sheet-title"]',
            ) ?? true
          }
          data-slot="report-sheet-frame"
          className="top-18 right-8 bottom-5 left-8 overflow-hidden bg-bg max-md:inset-0"
        >
          <DialogTitle className="sr-only">
            {sheet?.mode.kind === 'edit' ? 'Editing a post' : 'New report'}
          </DialogTitle>
          <SheetContainerProvider value={container}>
            <SheetSlotsProvider value={SHEET_SLOTS}>
              {error !== null ? (
                <HostMessage text={error} onClose={close} />
              ) : ready ? (
                <ReportSheet
                  post={sheet}
                  exits={{ onClose: close, onDiscard: discard, onDone: done }}
                />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <CellLoader
                    label={restoring ? 'Bringing your draft back' : 'Opening the report'}
                  />
                </div>
              )}
            </SheetSlotsProvider>
          </SheetContainerProvider>
        </DialogContent>
      </Dialog>
      <LeaveDialog
        open={blocker.status === 'blocked'}
        sent={postCreateSent(attempt)}
        onKeep={() => blocker.reset?.()}
        onLeave={() => {
          // An edit closed without saving leaves nothing behind to restore.
          if (sheet?.mode.kind === 'edit') setSheet(null);
          blocker.proceed?.();
        }}
      />
    </>
  );
}

function HostMessage({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-(--space-4) p-(--space-8)">
      <p role="alert" className="m-0 text-row text-fg2">
        {text}
      </p>
      <button
        type="button"
        data-attr="sheet-close"
        onClick={onClose}
        className="h-btn-sm cursor-pointer rounded-control border-0 bg-transparent px-(--space-3) text-kick font-semibold tracking-head text-fg1 uppercase inset-ring inset-ring-line2 outline-none focus-visible:shadow-focus"
      >
        Close
      </button>
    </div>
  );
}

function readAbandonMarker() {
  try {
    return parseAbandonMarker(window.localStorage.getItem(ABANDON_KEY));
  } catch {
    return null;
  }
}

function writeAbandonMarker(marker: { draftId: string; sectionsAnswered: number } | null): void {
  try {
    if (marker === null) window.localStorage.removeItem(ABANDON_KEY);
    else window.localStorage.setItem(ABANDON_KEY, JSON.stringify(marker));
  } catch {
    // A disabled store: the marker is a convenience for the count, never for the draft.
  }
}
