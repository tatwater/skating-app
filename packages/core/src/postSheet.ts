/**
 * The Post sheet's state (A10-3 / D186, D187) — pure, so the doors, the draft round trip and the
 * *Post* decision are unit-tested without a screen. A **Post sheet** is the words (title, prose)
 * over one or more **Report sheets** (`ReportSheetState`, one per lake or visit), each with the
 * things a sheet carries beside its chips: the photos not yet uploaded, the track it describes,
 * the D55 bundle choice.
 *
 * One sheet, every door (D187): a body (chips first), the tab (prose first), a finished recording,
 * an unreported skate, a saved draft, a published Report or Post to edit. Every door lands on the
 * same state shape; only what is pre-filled differs. `mode` says what *Post* does — queue a new
 * Post, or update what is published — and nothing else branches on the door.
 *
 * It lives in core, not on a surface (lifted from mobile at A10-5): the mobile sheet and the web
 * console are two compositions of this one model, and a rule that differed between them — which
 * gaps refuse a Post, what *Save changes* addresses — would be a rule with two answers. Ids are
 * plain strings here as everywhere in core; each surface casts at its own wire.
 */

import type { MultiPolygon, Polygon } from 'geojson';
import {
  type AccessPhotoTarget,
  createPostDraft,
  createReportDraft,
  type DraftPhoto,
  type HazardRef,
  type PostDraft,
  type ReportDraft,
  reportDraftInput,
  unassignedPhotosMessage,
} from './draftQueue';
import { type LatLng, polygonBBox } from './geometry';
import { hazardRefFor } from './hazardBundle';
import { type AssignCandidate, assignPhoto, onWater } from './photoAssignment';
import {
  type MinimumSetTerm,
  minimumSetGaps,
  minimumSetMessage,
  validateReportInput,
} from './report';
import { formCreateRefusal } from './reportForm';
import {
  emptySheet,
  type ReportSheetState,
  SHEET_SECTIONS,
  type SheetSeed,
  sectionFilled,
  selectedValues,
  sheetFromReport,
  toReportInput,
} from './reportSheet';

/** One Report on the sheet: its chips (core) and what rides beside them on this device. */
export interface SheetReport {
  id: string;
  idempotencyKey: string;
  sheet: ReportSheetState;
  bodyName?: string;
  /** Device GPS at capture, for a lake the cache could not name — the flush resolves it (D30). */
  coord?: LatLng;
  /** Photos picked on this device, not yet uploaded — the draft's own files once saved. */
  photos: DraftPhoto[];
  /** An edit's already-attached photos, kept unless the author removes one (A06f). */
  keptPhotoIds: string[];
  /** The **local** recording this Report describes (Phase 08), when opened from a finished skate. */
  trackDraftId?: string;
  /** A **server** activity (A06f): an unreported skate, or a draft's resolved track. */
  activityId?: string;
  /** D55: the candidates the prompt offered and the author's opt-outs — stored as opt-outs so a hazard that syncs in later is still included. */
  bundleCandidateIds: string[];
  unbundledHazardIds: string[];
  /** A reopened draft's saved choice, applied once the candidates load (A10-2b delta 6). */
  savedHazardRefs?: HazardRef[];
}

export type SheetMode =
  | { kind: 'create' }
  /** A published Report opened from its page: *Save changes* runs one `reports.update`, the Post's words included. */
  | { kind: 'edit'; reportId: string; postId?: string };

/** Which door opened the sheet — only the layout reads it (the tab focuses the prose). */
export type SheetDoor = 'body' | 'page' | 'track' | 'activity' | 'draft' | 'edit';

export interface PostSheet {
  /** The draft's id and key, minted at open so *Save draft* and *Post* address one row. */
  draftId: string;
  idempotencyKey: string;
  title: string;
  body: string;
  reports: SheetReport[];
  /**
   * The Post's pool (A10-7): photos the day could not put on a Report — no time in a window, no
   * location on a lake — waiting for the author to say. One with an `attachTo` is bound for the
   * put-in or the lot and posts as an access photo. Absent on sheets from before A10-7.
   */
  photos?: DraftPhoto[];
  mode: SheetMode;
  door: SheetDoor;
  /** The minute the sheet was opened — the pinned end-time chip's instant (D192). */
  openedAtMs: number;
  /** Has the author changed anything since open or last save? Decides the leave prompt. */
  dirty: boolean;
}

/** Ids are minted by the caller (mobile uses `expo-crypto`, web `crypto.randomUUID`); the model never guesses one. */
export type Mint = () => string;

export interface OpenReportArgs {
  waterBodyId?: string;
  bodyName?: string;
  coord?: LatLng;
  trackDraftId?: string;
  activityId?: string;
  showPutIn?: boolean;
  /** GPS-known end/start (a track door), stamped `gps` (D192). */
  gpsWindow?: { endMs: number; startMs?: number };
}

/** One fresh Report sheet for a door. */
export function openReport(args: OpenReportArgs, openedAtMs: number, mint: Mint): SheetReport {
  let sheet = emptySheet(openedAtMs, args.waterBodyId, {
    ...(args.showPutIn !== undefined ? { showPutIn: args.showPutIn } : {}),
  });
  if (args.gpsWindow !== undefined) {
    sheet = {
      ...sheet,
      fields: {
        ...sheet.fields,
        endTime: {
          ...sheet.fields.endTime,
          chips: [
            { key: 'gps', value: { ms: args.gpsWindow.endMs, precision: 'gps' }, tier: 'solid' },
          ],
        },
      },
      ...(args.gpsWindow.startMs !== undefined
        ? {
            scalars: { ...sheet.scalars, skateStartTime: args.gpsWindow.startMs },
            touchedScalars: { ...sheet.touchedScalars, skateStartTime: true as const },
          }
        : {}),
    };
  }
  return {
    id: mint(),
    idempotencyKey: mint(),
    sheet,
    ...(args.bodyName !== undefined ? { bodyName: args.bodyName } : {}),
    ...(args.coord !== undefined ? { coord: args.coord } : {}),
    photos: [],
    keptPhotoIds: [],
    ...(args.trackDraftId !== undefined ? { trackDraftId: args.trackDraftId } : {}),
    ...(args.activityId !== undefined ? { activityId: args.activityId } : {}),
    bundleCandidateIds: [],
    unbundledHazardIds: [],
  };
}

/** A fresh Post sheet with one Report, for the body, page, track and activity doors. */
export function openPostSheet(
  door: Exclude<SheetDoor, 'draft' | 'edit'>,
  first: OpenReportArgs,
  openedAtMs: number,
  mint: Mint,
): PostSheet {
  return {
    draftId: mint(),
    idempotencyKey: mint(),
    title: '',
    body: '',
    reports: [openReport(first, openedAtMs, mint)],
    mode: { kind: 'create' },
    door,
    openedAtMs,
    dirty: false,
  };
}

/**
 * Reopen a saved draft — held or queued — as the sheet it was. A pre-sheet Report draft (the
 * `form` shape) is lifted through the same seed the edit door uses, so nothing it said is lost and
 * the sheet has one case.
 */
export function postSheetFromDraft(draft: PostDraft, openedAtMs: number): PostSheet | null {
  const reports: SheetReport[] = [];
  for (const r of draft.reports) {
    let sheet: ReportSheetState;
    if (r.sheet !== undefined) {
      sheet = r.sheet;
    } else {
      const input = reportDraftInput(r, r.waterBodyId ?? '');
      if (input === null) return null;
      const seed: SheetSeed = {
        ...input,
        ...(r.waterBodyId !== undefined ? { waterBodyId: r.waterBodyId } : {}),
      };
      sheet = sheetFromReport(seed, openedAtMs);
      if (r.waterBodyId === undefined) sheet = { ...sheet, waterBodyId: undefined };
    }
    reports.push({
      id: r.id,
      idempotencyKey: r.idempotencyKey,
      sheet,
      ...(r.bodyName !== undefined ? { bodyName: r.bodyName } : {}),
      ...(r.coord !== undefined ? { coord: r.coord } : {}),
      photos: r.photos,
      keptPhotoIds: [],
      ...(r.trackDraftId !== undefined ? { trackDraftId: r.trackDraftId } : {}),
      ...(r.activityId !== undefined ? { activityId: r.activityId } : {}),
      bundleCandidateIds: [],
      unbundledHazardIds: [],
      ...(r.hazardRefs !== undefined ? { savedHazardRefs: r.hazardRefs } : {}),
    });
  }
  if (reports.length === 0) return null;
  return {
    draftId: draft.id,
    idempotencyKey: draft.idempotencyKey,
    title: draft.title ?? '',
    body: draft.body ?? '',
    reports,
    ...(draft.photos !== undefined && draft.photos.length > 0 ? { photos: draft.photos } : {}),
    mode: { kind: 'create' },
    door: 'draft',
    openedAtMs,
    dirty: false,
  };
}

/** The edit door: a published Report (and its Post's words) as a one-Report sheet. */
export function postSheetForEdit(
  report: SheetSeed & { reportId: string; bodyName?: string; photoIds: string[] },
  post: { postId: string; title?: string; body?: string } | null,
  openedAtMs: number,
  mint: Mint,
): PostSheet {
  const sheet = sheetFromReport(report, openedAtMs);
  return {
    draftId: mint(),
    idempotencyKey: mint(),
    title: post?.title ?? '',
    body: post?.body ?? '',
    reports: [
      {
        id: report.reportId,
        idempotencyKey: mint(),
        sheet,
        ...(report.bodyName !== undefined ? { bodyName: report.bodyName } : {}),
        photos: [],
        keptPhotoIds: [...report.photoIds],
        bundleCandidateIds: [],
        unbundledHazardIds: [],
      },
    ],
    mode: { kind: 'edit', reportId: report.reportId, ...(post ? { postId: post.postId } : {}) },
    door: 'edit',
    openedAtMs,
    dirty: false,
  };
}

// ── Editing the sheet ───────────────────────────────────────────────────────────────────────────

/**
 * Advance one Report. `quiet` is the sheet's own doing — a peer ghost offered, the pinned minute
 * preselected, the bundle candidates arriving — and leaves `dirty` as it was: only the author
 * makes a sheet worth parking or worth a leave prompt.
 */
export function updateReport(
  post: PostSheet,
  reportId: string,
  update: (report: SheetReport) => SheetReport,
  opts: { quiet?: boolean } = {},
): PostSheet {
  let changed = false;
  const reports = post.reports.map((r) => {
    if (r.id !== reportId) return r;
    const next = update(r);
    if (next !== r) changed = true;
    return next;
  });
  if (!changed) return post;
  return opts.quiet ? { ...post, reports } : { ...post, reports, dirty: true };
}

/** *Add another lake* (§4.3): a fresh Report sheet after the last, on another body. */
export function addLake(
  post: PostSheet,
  body: { waterBodyId: string; bodyName: string },
  openedAtMs: number,
  mint: Mint,
): PostSheet {
  const report = openReport(
    { waterBodyId: body.waterBodyId, bodyName: body.bodyName, showPutIn: lastShowPutIn(post) },
    openedAtMs,
    mint,
  );
  return { ...post, reports: [...post.reports, report], dirty: true };
}

/** *Add an earlier visit* (§4.3): the same body as `afterId`, its own end time, before it in the day. */
export function addEarlierVisit(
  post: PostSheet,
  afterId: string,
  openedAtMs: number,
  mint: Mint,
): PostSheet {
  const source = post.reports.find((r) => r.id === afterId);
  if (!source) return post;
  const report = openReport(
    {
      ...(source.sheet.waterBodyId !== undefined ? { waterBodyId: source.sheet.waterBodyId } : {}),
      ...(source.bodyName !== undefined ? { bodyName: source.bodyName } : {}),
      showPutIn: lastShowPutIn(post),
    },
    openedAtMs,
    mint,
  );
  const at = post.reports.findIndex((r) => r.id === afterId);
  const reports = [...post.reports.slice(0, at + 1), report, ...post.reports.slice(at + 1)];
  return { ...post, reports, dirty: true };
}

/** Drop a Report from the sheet — never the last one (a Post requires a Report, D186). */
export function removeReport(post: PostSheet, reportId: string): PostSheet {
  if (post.reports.length <= 1) return post;
  return { ...post, reports: post.reports.filter((r) => r.id !== reportId), dirty: true };
}

function lastShowPutIn(post: PostSheet): boolean | undefined {
  const last = post.reports[post.reports.length - 1];
  return last?.sheet.scalars.showPutIn;
}

/** The ids this Report will bundle (D55): the prompt's candidates minus the author's opt-outs. */
export function bundledIds(report: SheetReport): string[] {
  return report.bundleCandidateIds.filter((id) => !report.unbundledHazardIds.includes(id));
}

// ── Leaving the sheet ───────────────────────────────────────────────────────────────────────────

/**
 * The draft this sheet saves — held (`draft`) or queued (`pending`). Photos are expected to be on
 * persistent paths already (the caller copies them out of the picker cache first); the bundle
 * choice rides as `hazardRefs`.
 */
export function toPostDraft(
  post: PostSheet,
  status: 'draft' | 'pending',
  now: number,
  existing?: PostDraft | null,
): PostDraft {
  const reports: ReportDraft[] = post.reports.map((r) => {
    const prior = existing?.reports.find((p) => p.id === r.id);
    const hazardRefs = bundledIds(r).map(hazardRefFor);
    return createReportDraft({
      id: r.id,
      idempotencyKey: r.idempotencyKey,
      sheet: r.sheet,
      ...(r.sheet.waterBodyId !== undefined ? { waterBodyId: r.sheet.waterBodyId } : {}),
      ...(r.bodyName !== undefined ? { bodyName: r.bodyName } : {}),
      ...(r.coord !== undefined ? { coord: r.coord } : {}),
      photos: r.photos,
      ...(r.trackDraftId !== undefined ? { trackDraftId: r.trackDraftId } : {}),
      ...(prior?.activityId !== undefined
        ? { activityId: prior.activityId }
        : r.activityId !== undefined
          ? { activityId: r.activityId }
          : {}),
      // The prompt's candidates come from the server; before they load a reopened draft keeps
      // the refs it saved rather than saving none.
      hazardRefs:
        r.bundleCandidateIds.length === 0 && r.savedHazardRefs !== undefined
          ? r.savedHazardRefs
          : hazardRefs,
    });
  });
  const draft = createPostDraft({
    id: post.draftId,
    idempotencyKey: post.idempotencyKey,
    now: existing?.createdAt ?? now,
    ...(post.title.trim() ? { title: post.title.trim() } : {}),
    ...(post.body.trim() ? { body: post.body.trim() } : {}),
    reports,
    ...(post.photos !== undefined && post.photos.length > 0 ? { photos: post.photos } : {}),
    status,
  });
  return { ...draft, updatedAt: now };
}

export interface ReportRefusal {
  reportId: string;
  bodyName?: string;
  /** What is missing (D189) — the chips the sheet can point at. */
  gaps: MinimumSetTerm[];
  /** The sentence, in the server's words. */
  message: string;
}

/**
 * Why this sheet cannot post yet, per Report: the validator's errors, then the create-only rules
 * (D189's set, D199's window) in the words `posts.create` would refuse with. Empty ⇒ may post.
 * Never asked on an edit (D189 amendment) — the edit door validates only.
 */
export function postRefusals(post: PostSheet, now: number): ReportRefusal[] {
  const out: ReportRefusal[] = [];
  // The pool first (A10-7): a photo nobody has placed is the Post's gap, not a Report's.
  const unassigned = unassignedPhotos(post).length;
  if (unassigned > 0 && post.mode.kind !== 'edit') {
    out.push({ reportId: '', gaps: [], message: unassignedPhotosMessage(unassigned) });
  }
  for (const r of post.reports) {
    const bodyName = r.bodyName;
    if (r.sheet.waterBodyId === undefined && r.coord === undefined) {
      out.push({ reportId: r.id, bodyName, gaps: ['body'], message: minimumSetMessage(['body']) });
      continue;
    }
    // A body-less capture stands in a placeholder: the lake resolves at flush (D30).
    const input = { ...toReportInput(r.sheet), waterBodyId: r.sheet.waterBodyId ?? 'pending' };
    const hazardCount = bundledIds(r).length + r.sheet.scalars.hazardIds.length;
    // What to add comes before what is wrong: the set names the chips, the validator the shapes.
    if (post.mode.kind !== 'edit') {
      const gaps = minimumSetGaps(input, hazardCount);
      if (gaps.length > 0) {
        out.push({ reportId: r.id, bodyName, gaps, message: minimumSetMessage(gaps) });
        continue;
      }
    }
    const validation = validateReportInput(input, { now });
    if (!validation.ok) {
      out.push({
        reportId: r.id,
        bodyName,
        gaps: [],
        message: validation.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
      });
      continue;
    }
    if (post.mode.kind === 'edit') continue;
    const refusal = formCreateRefusal(validation.normalized, hazardCount, now);
    if (refusal !== null) out.push({ reportId: r.id, bodyName, gaps: [], message: refusal });
  }
  return out;
}

/** The end time a Report's sheet holds, if any — the tabs sort on it. */
export function reportEndMs(report: SheetReport): number | undefined {
  const [end] = selectedValues(report.sheet, 'endTime');
  return end?.ms;
}

/**
 * The Post's Reports in **time order** (founder call 2026-09-23): by end time, earliest first; a
 * Report with no end time yet keeps its place after the timed ones, in the order it was added. The
 * tabs and the timeline's other-Report spans read this; the stored order (`post.reports`) is the
 * author's and is what posts.
 */
export function reportsInTimeOrder(post: PostSheet): SheetReport[] {
  const timed: { r: SheetReport; i: number; end: number }[] = [];
  const untimed: SheetReport[] = [];
  post.reports.forEach((r, i) => {
    const end = reportEndMs(r);
    if (end === undefined) untimed.push(r);
    else timed.push({ r, i, end });
  });
  timed.sort((a, b) => a.end - b.end || a.i - b.i);
  return [...timed.map((x) => x.r), ...untimed];
}

/** How many sections the sheet counts (the meter's denominator). */
export const SHEET_SECTION_COUNT = SHEET_SECTIONS.length;

/** How many of a Report's sections have something in them — the tab meter and the status bar. */
export function sectionsFilled(sheet: ReportSheetState): number {
  return SHEET_SECTIONS.filter((s) => sectionFilled(sheet, s)).length;
}

// ── The photo pool (A10-7) ──────────────────────────────────────────────────────────────────────

/** The pool photos still waiting for the author — not bound for a put-in or a lot. */
export function unassignedPhotos(post: PostSheet): DraftPhoto[] {
  return (post.photos ?? []).filter((p) => p.attachTo === undefined);
}

/**
 * A Report as the assignment rules see it: its window and, when its lake's outline is known, the
 * outline and its box. `outlines` is keyed by water body id.
 */
export function assignCandidates(
  post: PostSheet,
  outlines: Readonly<Record<string, Polygon | MultiPolygon | undefined>>,
): AssignCandidate[] {
  return post.reports.map((r) => {
    const end = reportEndMs(r);
    const start = r.sheet.scalars.skateStartTime;
    const polygon = r.sheet.waterBodyId !== undefined ? outlines[r.sheet.waterBodyId] : undefined;
    return {
      reportId: r.id,
      ...(start !== undefined ? { startMs: start } : {}),
      ...(end !== undefined ? { endMs: end } : {}),
      ...(polygon !== undefined ? { bbox: polygonBBox(polygon), polygon } : {}),
    };
  });
}

/**
 * A photo landing on a Report is placed when its location is on that lake's water (D42, pre-answered
 * by the water; `onWater`) — and only then: a placement from a previous lake does not ride along to
 * one the coordinate is not on, so a coordinate off the water is never sent. The author places by
 * hand.
 */
function onReport(
  photo: DraftPhoto,
  reportId: string,
  candidates: readonly AssignCandidate[],
): DraftPhoto {
  const polygon = candidates.find((c) => c.reportId === reportId)?.polygon;
  const { attachTo: _attachTo, ...rest } = photo;
  return { ...rest, placeOnMap: onWater(photo.coord, polygon) };
}

/**
 * Add photos to the Post: each lands on the Report the day says (by time, then by location), placed
 * when its location is on that lake, else in the pool. The author's hand, so the sheet is dirty.
 */
export function addPostPhotos(
  post: PostSheet,
  photos: readonly DraftPhoto[],
  candidates: readonly AssignCandidate[],
): PostSheet {
  let next = post;
  const pool: DraftPhoto[] = [...(post.photos ?? [])];
  for (const photo of photos) {
    const to = assignPhoto(photo, candidates);
    if (to === null) {
      pool.push(photo);
      continue;
    }
    next = updateReport(next, to.reportId, (r) => ({
      ...r,
      photos: [...r.photos, onReport(photo, to.reportId, candidates)],
    }));
  }
  return { ...next, photos: pool, dirty: true };
}

/**
 * Re-run the rules over the pool — a lake's geometry arrived, a Report's window changed. Quiet: the
 * sheet's doing. Only photos with no `attachTo`; what the author sent to a launch stays there.
 */
export function reassignPool(post: PostSheet, candidates: readonly AssignCandidate[]): PostSheet {
  const pool = post.photos ?? [];
  if (pool.length === 0) return post;
  let next = post;
  const kept: DraftPhoto[] = [];
  let moved = false;
  for (const photo of pool) {
    const to = photo.attachTo === undefined ? assignPhoto(photo, candidates) : null;
    if (to === null) {
      kept.push(photo);
      continue;
    }
    moved = true;
    next = updateReport(
      next,
      to.reportId,
      (r) => ({ ...r, photos: [...r.photos, onReport(photo, to.reportId, candidates)] }),
      { quiet: true },
    );
  }
  return moved ? { ...next, photos: kept } : post;
}

/** Every photo on the sheet with where it sits. */
export function findPhoto(
  post: PostSheet,
  photoId: string,
): { photo: DraftPhoto; reportId: string | null } | null {
  for (const r of post.reports) {
    const photo = r.photos.find((p) => p.id === photoId);
    if (photo) return { photo, reportId: r.id };
  }
  const pooled = (post.photos ?? []).find((p) => p.id === photoId);
  return pooled ? { photo: pooled, reportId: null } : null;
}

function withoutPhoto(post: PostSheet, photoId: string): PostSheet {
  const reports = post.reports.map((r) =>
    r.photos.some((p) => p.id === photoId)
      ? { ...r, photos: r.photos.filter((p) => p.id !== photoId) }
      : r,
  );
  return { ...post, reports, photos: (post.photos ?? []).filter((p) => p.id !== photoId) };
}

/** The author says: this photo is on that Report (the `?` menu's lake, or a move between tabs). */
export function movePhotoToReport(
  post: PostSheet,
  photoId: string,
  reportId: string,
  candidates: readonly AssignCandidate[],
): PostSheet {
  const found = findPhoto(post, photoId);
  if (!found || !post.reports.some((r) => r.id === reportId)) return post;
  const stripped = withoutPhoto(post, photoId);
  const next = updateReport(stripped, reportId, (r) => ({
    ...r,
    photos: [...r.photos, onReport(found.photo, reportId, candidates)],
  }));
  return { ...next, dirty: true };
}

/** The author says: this photo documents the put-in or the lot, not the ice (an access photo, A06d). */
export function sendPhotoToAccess(
  post: PostSheet,
  photoId: string,
  target: AccessPhotoTarget,
): PostSheet {
  const found = findPhoto(post, photoId);
  if (!found) return post;
  const stripped = withoutPhoto(post, photoId);
  // Un-placed, never located as an access photo (the flush sends no coordinate for one) — but the
  // coordinate stays on the record, so a change of mind back to a lake can still place it by it.
  return {
    ...stripped,
    photos: [...(stripped.photos ?? []), { ...found.photo, placeOnMap: false, attachTo: target }],
    dirty: true,
  };
}

/** The author says: leave it out. The caller releases the file. */
export function dropPhoto(post: PostSheet, photoId: string): PostSheet {
  if (!findPhoto(post, photoId)) return post;
  return { ...withoutPhoto(post, photoId), dirty: true };
}

/** The author placed a photo on the lake by hand (place-mode): its location is the click, and it is placed. */
export function placePhotoByHand(post: PostSheet, photoId: string, coord: LatLng): PostSheet {
  const found = findPhoto(post, photoId);
  if (!found || found.reportId === null) return post;
  return updateReport(post, found.reportId, (r) => ({
    ...r,
    photos: r.photos.map((p) => (p.id === photoId ? { ...p, coord, placeOnMap: true } : p)),
  }));
}

/** How many photos the sheet holds, and how many of them have a home. */
export function photoCounts(post: PostSheet): { total: number; assigned: number } {
  const onReports = post.reports.reduce((n, r) => n + r.photos.length + r.keptPhotoIds.length, 0);
  const pool = post.photos ?? [];
  const bound = pool.filter((p) => p.attachTo !== undefined).length;
  return { total: onReports + pool.length, assigned: onReports + bound };
}

/** The chips a leave prompt or a label needs: which lakes this sheet is about. */
export function sheetLabel(post: PostSheet): string {
  if (post.title.trim()) return post.title.trim();
  const names = post.reports.map((r) => r.bodyName ?? 'Unknown lake');
  return names.join(' · ');
}
