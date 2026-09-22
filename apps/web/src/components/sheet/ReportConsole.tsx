import { api } from '@skating/convex/api';
import {
  addEarlierVisit,
  addLake,
  isMinor,
  type MinimumSetTerm,
  POST_TITLE_MAX_CHARS,
  type PostDraft,
  type PostSheet,
  postRefusals,
  type ReportRefusal,
  removeReport,
  type SheetSection,
  sheetReducer,
  updateReport,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useConvex, useQuery } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { postSheetOnWeb, saveSheetEditOnWeb } from '../../lib/sheetActions';
import { releaseAllSheetPhotos, sheetPhotoPreview } from '../../lib/sheetPhotos';
import { clearStoredSheet, setSheet, updateSheet, useSheet } from '../../lib/sheetStore';
import { cn } from '../../lib/utils';
import { LeavingNotice, useIsLeaving } from '../LeavingNotice';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { BodyPicker } from './BodyPicker';
import { LakeMap } from './LakeMap';
import { ReportPanels } from './ReportPanels';
import { SheetHint } from './SheetPanel';
import { type SheetBody, useSheetBody } from './useSheetBody';

/** Which section a minimum-set term points at, for the *needed* mark (D189). */
const TERM_SECTION: Record<MinimumSetTerm, SheetSection | null> = {
  body: null,
  endTime: 'endTime',
  howWasIt: 'howWasIt',
  observation: 'iceAndSurface',
};

/**
 * The web console (A10-5 / §10.1) — the report sheet as a full-screen authoring view: the lake's
 * map and the photo rail on the left, the words and every section as a panel on the right, and a
 * tab per Report over the one map (§10.2).
 *
 * It is the **same sheet** the phone draws, not a second one: the model, the doors, which gaps
 * refuse a Post and what *Post* does all come from core's `postSheet` and `flushPost`. What is
 * web's is the composition — two columns instead of a scroll, a map that stays put while the
 * panels move, a keyboard — and the two things a desk has that a phone does not: width, and a
 * reload to survive (§10.3).
 *
 * **Not TanStack Form** (a delta from §10.3 as scoped, 2026-09-22): the plan named it before the
 * sheet had a model. It has one now — a reducer in core, with the validator and the refusals
 * already written — and the console's fields are chips, not inputs with their own validation. A
 * form library over that would be a second place for field state to live and a second answer to
 * "is this Post postable". The one free-text field that wants care (the prose) is a `<textarea>`.
 */
export function ReportConsole() {
  const post = useSheet();
  if (post === null) return null;
  return <Console post={post} />;
}

function Console({ post }: { post: PostSheet }) {
  const convex = useConvex();
  const navigate = useNavigate();
  const leaving = useIsLeaving();
  const profile = useQuery(api.profiles.current, {});
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<ReportRefusal[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>(post.reports[0]?.id ?? '');
  const [picking, setPicking] = useState<
    { kind: 'add' } | { kind: 'set'; reportId: string } | null
  >(null);
  /** What a failed attempt already uploaded, so a retry resumes rather than repeats. */
  const attemptRef = useRef<PostDraft | null>(null);
  const editing = post.mode.kind === 'edit';
  const minor = profile ? isMinor(profile.dateOfBirth, Date.now()) : false;

  // The tab a removed Report leaves behind falls back to the first.
  const active = post.reports.find((r) => r.id === activeId) ?? post.reports[0];
  // The active Report's lake, read **once** for the whole console and handed down: the map column,
  // the header and the panels all want the same body, and each calling `useSheetBody` itself is
  // five more query subscriptions and three `SheetBody` identities for one lake.
  const body = useSheetBody(active?.sheet.waterBodyId);
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

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
    attemptRef.current = null;
    releaseAllSheetPhotos();
    setSheet(null);
    clearStoredSheet();
    void navigate({ to: '/report/$id', params: { id: to.reportId } });
  };

  const onPost = async () => {
    setMessage(null);
    const now = Date.now();
    const found = postRefusals(post, now);
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
      if (gapReport) setActiveId(gapReport.id);
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const reportId = await saveSheetEditOnWeb(convex, post);
        done({ reportId });
        return;
      }
      const outcome = await postSheetOnWeb(convex, post, now, attemptRef.current);
      if (outcome.kind === 'refused') {
        attemptRef.current = outcome.draft;
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
    if (post.dirty && !window.confirm('Leave without posting? What you wrote here will be gone.')) {
      return;
    }
    attemptRef.current = null;
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

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-foreground text-xl">
          {editing ? 'Edit your report' : 'Post a report'}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void onPost()} disabled={busy}>
            {busy ? (editing ? 'Saving…' : 'Posting…') : editing ? 'Save changes' : 'Post'}
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
        <aside className="flex h-fit flex-col gap-4 lg:sticky lg:top-6">
          <MapColumn report={active} body={body} />
          <PhotoRail report={active} />
        </aside>

        <main className="flex min-w-0 flex-col gap-4">
          {/* The words: the community's subject-line habit, then the story (D186). */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
            <Input
              className="h-auto border-0 bg-transparent px-0 font-semibold text-base focus-visible:ring-0"
              placeholder="Title — Crystal Lake, Enfield 12/6"
              aria-label="Title"
              maxLength={POST_TITLE_MAX_CHARS}
              value={post.title}
              onChange={(e) => updateSheet((p) => ({ ...p, title: e.target.value, dirty: true }))}
            />
            <Textarea
              className="min-h-32 border-0 bg-transparent px-0 focus-visible:ring-0"
              placeholder="How was it? Write it the way you'd tell a friend — the chips below are for the hard numbers."
              aria-label="The story"
              value={post.body}
              onChange={(e) => updateSheet((p) => ({ ...p, body: e.target.value, dirty: true }))}
            />
          </div>

          {post.reports.length > 1 ? (
            <ReportTabs
              post={post}
              activeId={active.id}
              onSelect={setActiveId}
              gapReportIds={new Set(refusals.map((r) => r.reportId))}
            />
          ) : null}

          <ReportHeader
            post={post}
            reportId={active.id}
            body={body}
            onPickBody={() => setPicking({ kind: 'set', reportId: active.id })}
          />

          {/* Keyed by the Report: the panels hold their own affordance state (which reading is
              being typed, which chip's *where* is open, the archive's hours for this lake), and an
              unkeyed swap would carry the previous leg's state — and its weather — onto this one. */}
          <ReportPanels
            key={active.id}
            report={active}
            body={body}
            gaps={gapsFor(active.id)}
            editing={editing}
          />

          {editing ? null : (
            <div className="flex flex-wrap gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setPicking({ kind: 'add' })}>
                + Another lake
              </Button>
              {post.reports[post.reports.length - 1]?.sheet.waterBodyId !== undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const last = post.reports[post.reports.length - 1];
                    if (!last) return;
                    updateSheet((p) =>
                      addEarlierVisit(p, last.id, Date.now(), () => crypto.randomUUID()),
                    );
                  }}
                >
                  + An earlier visit
                </Button>
              ) : null}
            </div>
          )}

          {message ? (
            <p role="alert" className="text-danger text-sm">
              {message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void onPost()} disabled={busy}>
              {busy ? (editing ? 'Saving…' : 'Posting…') : editing ? 'Save changes' : 'Post'}
            </Button>
          </div>
        </main>
      </div>

      <BodyPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        title={picking?.kind === 'add' ? 'Which lake next?' : 'Which lake?'}
        onPick={(body) => {
          const now = Date.now();
          if (picking?.kind === 'add') {
            let addedId: string | null = null;
            updateSheet((p) => {
              const next = addLake(
                p,
                { waterBodyId: body.waterBodyId, bodyName: body.name },
                now,
                () => crypto.randomUUID(),
              );
              addedId = next.reports[next.reports.length - 1]?.id ?? null;
              return next;
            });
            if (addedId) setActiveId(addedId);
          } else if (picking?.kind === 'set') {
            const reportId = picking.reportId;
            updateSheet((p) =>
              updateReport(p, reportId, (r) => ({
                ...r,
                bodyName: body.name,
                // Through the reducer: another lake's peer ghosts go with the lake.
                sheet: sheetReducer(r.sheet, { type: 'setBody', waterBodyId: body.waterBodyId }),
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

/** A tab per Report, over the one map (§10.2). A leg the minimum set still wants is marked. */
function ReportTabs({
  post,
  activeId,
  onSelect,
  gapReportIds,
}: {
  post: PostSheet;
  activeId: string;
  onSelect: (id: string) => void;
  gapReportIds: ReadonlySet<string>;
}) {
  return (
    <div role="tablist" aria-label="The lakes in this post" className="flex flex-wrap gap-1">
      {post.reports.map((report, i) => {
        const selected = report.id === activeId;
        return (
          <button
            key={report.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(report.id)}
            className={cn(
              'rounded-t-lg border-b-2 px-3 py-1.5 text-sm',
              selected
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground',
            )}
          >
            {report.bodyName ?? `Lake ${i + 1}`}
            {gapReportIds.has(report.id) ? <span className="text-warning"> ·</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The lake a Report is about: its name (a click picks or changes it, on a create) and *remove* when
 * the Post has more than one.
 */
function ReportHeader({
  post,
  reportId,
  body,
  onPickBody,
}: {
  post: PostSheet;
  reportId: string;
  body: SheetBody | null;
  onPickBody: () => void;
}) {
  const report = post.reports.find((r) => r.id === reportId);
  const editing = post.mode.kind === 'edit';
  if (!report) return null;
  const name = report.bodyName ?? (body?.name || undefined);
  return (
    <div className="flex items-center gap-3">
      {editing ? (
        <h2 className="font-bold text-foreground text-lg">{name ?? 'This report'}</h2>
      ) : (
        <button
          type="button"
          onClick={onPickBody}
          className="font-bold text-foreground text-lg hover:underline"
        >
          {name ?? 'Which lake?'} <span aria-hidden>›</span>
        </button>
      )}
      <span className="flex-1" />
      {post.reports.length > 1 && !editing ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => updateSheet((p) => removeReport(p, reportId))}
        >
          Remove this lake
        </Button>
      ) : null}
    </div>
  );
}

/** The map column (§10.1): the lake, its chosen put-in, the skate's path, and the placed photos. */
function MapColumn({
  report,
  body,
}: {
  report: PostSheet['reports'][number];
  body: SheetBody | null;
}) {
  const placed = report.photos.filter((p) => p.placeOnMap && p.coord !== undefined);
  if (!body?.silhouette) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <SheetHint>
          {report.sheet.waterBodyId === undefined
            ? 'Pick the lake and it will be drawn here, with your put-in on it.'
            : 'Drawing the lake…'}
        </SheetHint>
      </div>
    );
  }
  const chosen = report.sheet.scalars.putInId;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
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
        {...(chosen !== undefined ? { chosenPinId: chosen } : {})}
        {...(chosen === undefined && report.sheet.scalars.point
          ? { point: report.sheet.scalars.point }
          : {})}
        photos={placed.map((p) => ({
          id: p.id,
          lat: (p.coord as { lat: number; lng: number }).lat,
          lng: (p.coord as { lat: number; lng: number }).lng,
        }))}
        height={300}
        label={`${body.name || 'The lake'}, with your put-in and any photos you placed.`}
      />
      <p className="text-foreground-muted text-xs">
        {body.name || 'This lake'} — the put-in is chosen under <em>Access</em>.
      </p>
    </div>
  );
}

/** The thumbnail rail (§10.1): what this Report is carrying, beside the map rather than in the scroll. */
function PhotoRail({ report }: { report: PostSheet['reports'][number] }) {
  const count = report.photos.length + report.keptPhotoIds.length;
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <p className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {count} {count === 1 ? 'photo' : 'photos'}
      </p>
      <div className="flex flex-wrap gap-2">
        {report.photos.map((photo) => {
          const preview = sheetPhotoPreview(photo.id);
          // A photo whose blob died with a reload still counts and still has to be re-added; the
          // rail draws it as itself rather than dropping it and disagreeing with its own count.
          return preview ? (
            <img
              key={photo.id}
              src={preview}
              alt=""
              className={cn(
                'size-14 rounded-md object-cover',
                photo.placeOnMap ? 'ring-2 ring-primary' : undefined,
              )}
            />
          ) : (
            <span
              key={photo.id}
              className="flex size-14 items-center justify-center rounded-md bg-surface-muted text-center text-[0.625rem] text-foreground-muted"
            >
              Re-add
            </span>
          );
        })}
        {report.keptPhotoIds.map((photoId) => (
          <span
            key={photoId}
            className="flex size-14 items-center justify-center rounded-md bg-surface-muted text-center text-[0.625rem] text-foreground-muted"
          >
            On the report
          </span>
        ))}
      </div>
      <p className="text-foreground-muted text-xs">
        A ring means the photo is placed on the map above.
      </p>
    </div>
  );
}
