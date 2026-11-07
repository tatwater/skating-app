/**
 * Photos from several lakes or days, sorted into one tab per lake and day (B03 §5, board 5.17.1;
 * Review 3 c-m8jjbe). Pure, so the rule — every photo lands in exactly one tab, the tabs in day
 * order — is a property test, not a hope.
 *
 * The photo's **place** names its lake (EXIF GPS, resolved by the caller against the corpus) and
 * its **time** its day, in the author's zone. A photo with no place goes with the same-day tab
 * nearest it in time — the day explains it, as the pool's own time-first rule does — and one with
 * no time joins its lake's first dated tab. A sort happens only when at least one photo names a
 * lake: with none, there is nothing to sort by, and the photos stay in the pool for the author.
 *
 * Two doors lead here. Photos the day couldn't place reach the sort from the pool (`PhotoSorter`,
 * after a lookup per place); photos only their **place** put on a Report — on its lake, but outside
 * its window or on a Report with no window yet — are sorted as they are added
 * (`addPhotosByLakeAndDay`), the Report's lake standing in for the lookup.
 *
 * Nothing here is a statement about the ice (D3): a tab is where and when the photos were taken.
 */

import {
  addPostPhotos,
  assignCandidates,
  assignPhoto,
  type DraftPhoto,
  type LatLng,
  type Mint,
  movePhotoToReport,
  openReport,
  type PostSheet,
  reportEndMs,
  type SheetReport,
  sheetReducer,
} from '@skating/core';
import type { MultiPolygon, Polygon } from 'geojson';

export interface SortablePhoto {
  id: string;
  coord?: LatLng;
  takenAtMs?: number;
}

export interface SortLake {
  waterBodyId: string;
  name: string;
}

export interface PhotoTab {
  waterBodyId: string;
  name: string;
  /** The local day, `YYYY-MM-DD` in the zone; `null` when no photo in the tab has a time. */
  day: string | null;
  startMs?: number;
  endMs?: number;
  photoIds: string[];
}

/** The calendar day of an instant in a zone, as a key that sorts as it reads. */
export function dayKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

interface Building extends PhotoTab {
  order: number;
}

function widen(tab: Building, ms: number | undefined): void {
  if (ms === undefined) return;
  tab.startMs = tab.startMs === undefined ? ms : Math.min(tab.startMs, ms);
  tab.endMs = tab.endMs === undefined ? ms : Math.max(tab.endMs, ms);
}

/** How far an instant sits from a tab's span — zero inside it. */
function distance(tab: PhotoTab, ms: number): number {
  if (tab.startMs === undefined || tab.endMs === undefined) return Number.POSITIVE_INFINITY;
  if (ms < tab.startMs) return tab.startMs - ms;
  if (ms > tab.endMs) return ms - tab.endMs;
  return 0;
}

/**
 * Sort the photos into tabs. `lakeOf` is the place lookup (`null`: no lake there, or no place).
 * Returns `[]` when no photo names a lake.
 */
export function sortPhotosIntoTabs(
  photos: readonly SortablePhoto[],
  lakeOf: (photo: SortablePhoto) => SortLake | null,
  timeZone: string,
): PhotoTab[] {
  const tabs = new Map<string, Building>();
  const placeless: SortablePhoto[] = [];
  const undated: { photo: SortablePhoto; lake: SortLake }[] = [];
  let order = 0;

  for (const photo of photos) {
    const lake = lakeOf(photo);
    if (lake === null) {
      placeless.push(photo);
      continue;
    }
    if (photo.takenAtMs === undefined) {
      undated.push({ photo, lake });
      continue;
    }
    const day = dayKey(photo.takenAtMs, timeZone);
    const key = `${lake.waterBodyId}|${day}`;
    let tab = tabs.get(key);
    if (!tab) {
      tab = { ...lake, day, photoIds: [], order: order++ };
      tabs.set(key, tab);
    }
    tab.photoIds.push(photo.id);
    widen(tab, photo.takenAtMs);
  }

  // A lake with no dated photo still gets its tab; an undated photo joins its lake's first day.
  for (const { photo, lake } of undated) {
    const dated = [...tabs.values()]
      .filter((t) => t.waterBodyId === lake.waterBodyId && t.day !== null)
      .sort((a, b) => (a.day as string).localeCompare(b.day as string));
    let tab = dated[0] ?? tabs.get(`${lake.waterBodyId}|`);
    if (!tab) {
      tab = { ...lake, day: null, photoIds: [], order: order++ };
      tabs.set(`${lake.waterBodyId}|`, tab);
    }
    tab.photoIds.push(photo.id);
  }

  if (tabs.size === 0) return [];
  const ordered = [...tabs.values()].sort(compareTabs);

  // A photo with no place: the same-day tab nearest it in time, else the nearest in time, else the
  // first tab — so it is never left out of the sort it arrived with.
  for (const photo of placeless) {
    const t = photo.takenAtMs;
    let best: Building = ordered[0] as Building;
    if (t !== undefined) {
      const day = dayKey(t, timeZone);
      const sameDay = ordered.filter((tab) => tab.day === day);
      const pool = sameDay.length > 0 ? sameDay : ordered;
      let bestD = Number.POSITIVE_INFINITY;
      for (const tab of pool) {
        const d = distance(tab, t);
        if (d < bestD) {
          bestD = d;
          best = tab;
        }
      }
      if (sameDay.length > 0) widen(best, t);
    }
    best.photoIds.push(photo.id);
  }

  return ordered.map(({ order: _order, ...tab }) => tab);
}

/** Day order, an undated tab last; then the morning first; then arrival. */
function compareTabs(a: Building, b: Building): number {
  if (a.day !== b.day) {
    if (a.day === null) return 1;
    if (b.day === null) return -1;
    return a.day.localeCompare(b.day);
  }
  return (
    (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY) ||
    a.order - b.order
  );
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number) => WORDS[n] ?? String(n);

/**
 * The line over the sorted tabs (5.17.1), or `null` when the photos made only one tab: "Your 8
 * photos were taken on three lakes over two days, so they start three reports, one per tab."
 */
export function sortNote(tabs: readonly PhotoTab[]): string | null {
  if (tabs.length < 2) return null;
  const photos = tabs.reduce((n, t) => n + t.photoIds.length, 0);
  const lakes = new Set(tabs.map((t) => t.waterBodyId)).size;
  const days = new Set(tabs.flatMap((t) => (t.day === null ? [] : [t.day]))).size;
  const where = lakes > 1 ? `on ${word(lakes)} lakes` : 'on one lake';
  const when = days > 1 ? ` over ${word(days)} days` : '';
  return `Your ${photos} photos were taken ${where}${when}, so they start ${word(tabs.length)} reports, one per tab. A photo’s number is its tab.`;
}

type Outlines = Readonly<Record<string, Polygon | MultiPolygon | undefined>>;

function isBlank(r: SheetReport): boolean {
  return r.sheet.waterBodyId === undefined && r.coord === undefined;
}

/** Seed a Report's day from its photos: the last one's minute as the end, the first's as the start. */
function seedTimes(report: SheetReport, tab: PhotoTab): SheetReport {
  if (tab.endMs === undefined || reportEndMs(report) !== undefined) return report;
  let sheet = sheetReducer(report.sheet, {
    type: 'select',
    field: 'endTime',
    key: 'chosen',
    value: { ms: tab.endMs, precision: 'minute' },
  });
  if (tab.startMs !== undefined && tab.startMs < tab.endMs) {
    sheet = sheetReducer(sheet, { type: 'setScalar', key: 'skateStartTime', value: tab.startMs });
  }
  return { ...report, sheet };
}

/**
 * Lay the tabs onto the Post: each lake-and-day finds the Report already about it (same lake, and
 * its end on that day or not set yet), else the blank Report the sheet opened on, else a new one —
 * then its photos move there. Returns the Post and the first tab's Report, for the sheet to open.
 * The author's hand (they added the photos), so the Post is dirty.
 */
export function applyPhotoTabs(
  post: PostSheet,
  tabs: readonly PhotoTab[],
  opts: { activeId: string; timeZone: string; now: number; mint: Mint; outlines: Outlines },
): { post: PostSheet; firstReportId: string | null } {
  let next = post;
  let firstReportId: string | null = null;
  const used = new Set<string>();
  for (const tab of tabs) {
    const existing = next.reports.find((r) => {
      if (used.has(r.id) || r.sheet.waterBodyId !== tab.waterBodyId) return false;
      const end = reportEndMs(r);
      return end === undefined || tab.day === null || dayKey(end, opts.timeZone) === tab.day;
    });
    const blank = next.reports.find((r) => r.id === opts.activeId && isBlank(r) && !used.has(r.id));
    let target: SheetReport;
    if (existing) {
      target = seedTimes(existing, tab);
    } else if (blank) {
      target = seedTimes(
        {
          ...blank,
          bodyName: tab.name,
          sheet: sheetReducer(blank.sheet, { type: 'setBody', waterBodyId: tab.waterBodyId }),
        },
        tab,
      );
    } else {
      const last = next.reports[next.reports.length - 1];
      const showPutIn = last?.sheet.scalars.showPutIn;
      target = seedTimes(
        openReport(
          {
            waterBodyId: tab.waterBodyId,
            bodyName: tab.name,
            ...(showPutIn !== undefined ? { showPutIn } : {}),
          },
          opts.now,
          opts.mint,
        ),
        tab,
      );
    }
    used.add(target.id);
    const present = next.reports.some((r) => r.id === target.id);
    next = {
      ...next,
      reports: present
        ? next.reports.map((r) => (r.id === target.id ? target : r))
        : [...next.reports, target],
      dirty: true,
    };
    const candidates = assignCandidates(next, opts.outlines);
    for (const photoId of tab.photoIds) {
      next = movePhotoToReport(next, photoId, target.id, candidates);
    }
    firstReportId ??= target.id;
  }
  return { post: next, firstReportId };
}

/**
 * Add photos to a Post being written (5.17.1, c-m8jjbe): the day's rules first (`addPostPhotos`),
 * then a second look at the photos only their place put on a Report. The place says which lake, not
 * which day: a photo from Thursday on the lake of Saturday's Report — or two days' photos on a
 * Report with no end yet — would otherwise post as one visit on one day. Those photos are sorted
 * into one tab per lake and day, each tab finding the Report already on that lake and day (or with
 * no end yet), else a new one.
 *
 * A lake is sorted only when its photos disagree with the day — a photo off its Report's day, or a
 * Report with no end holding more than one day — so the common case (one visit's photos, added
 * after the lake) lands exactly as before, its end left for the author. Photos the time placed,
 * undated photos and the pool are untouched, and only the photos being added are looked at: what
 * the author placed earlier stays theirs. An edit has one Report and adds no other, so it is the
 * plain add. Returns the tabs for the line that says what happened (`sortNote`).
 */
export function addPhotosByLakeAndDay(
  post: PostSheet,
  photos: readonly DraftPhoto[],
  opts: { timeZone: string; now: number; mint: Mint; outlines: Outlines },
): { post: PostSheet; tabs: PhotoTab[] } {
  const candidates = assignCandidates(post, opts.outlines);
  const added = addPostPhotos(post, photos, candidates);
  if (post.mode.kind !== 'create') return { post: added, tabs: [] };

  // The dated photos only a lake put on a Report, by that lake.
  const byLake = new Map<
    string,
    { lake: SortLake; rows: { photo: DraftPhoto; report: SheetReport }[] }
  >();
  for (const photo of photos) {
    if (photo.takenAtMs === undefined) continue;
    const to = assignPhoto(photo, candidates);
    if (to?.by !== 'location') continue;
    const report = post.reports.find((r) => r.id === to.reportId) as SheetReport;
    // A box is only known for a Report with a lake: `assignCandidates` keys it by the lake.
    const waterBodyId = report.sheet.waterBodyId as string;
    let group = byLake.get(waterBodyId);
    if (!group) {
      group = { lake: { waterBodyId, name: report.bodyName ?? '' }, rows: [] };
      byLake.set(waterBodyId, group);
    }
    group.rows.push({ photo, report });
  }

  const routed: SortablePhoto[] = [];
  const lakeOfPhoto = new Map<string, SortLake>();
  for (const { lake, rows } of byLake.values()) {
    const daysOn = new Map<string, Set<string>>();
    for (const { photo, report } of rows) {
      const days = daysOn.get(report.id) ?? new Set<string>();
      days.add(dayKey(photo.takenAtMs as number, opts.timeZone));
      daysOn.set(report.id, days);
    }
    const offDay = rows.some(({ photo, report }) => {
      const end = reportEndMs(report);
      if (end === undefined) return (daysOn.get(report.id) as Set<string>).size > 1;
      return dayKey(photo.takenAtMs as number, opts.timeZone) !== dayKey(end, opts.timeZone);
    });
    if (!offDay) continue;
    for (const { photo } of rows) {
      routed.push(photo);
      lakeOfPhoto.set(photo.id, lake);
    }
  }
  if (routed.length === 0) return { post: added, tabs: [] };

  const tabs = sortPhotosIntoTabs(routed, (p) => lakeOfPhoto.get(p.id) as SortLake, opts.timeZone);
  // No blank Report is answered: these photos already have their lake, and a blank tab is the
  // author's to fill.
  const out = applyPhotoTabs(added, tabs, { ...opts, activeId: '' });
  return { post: out.post, tabs };
}
