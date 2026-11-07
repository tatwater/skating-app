import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { type DraftPhoto, type LatLng, type PostSheet, unassignedPhotos } from '@skating/core';
import { useConvex } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { useBodyOutlines } from '@/lib/bodyOutlines';
import { updateSheet } from '@/lib/sheetStore';
import {
  addPhotosByLakeAndDay,
  applyPhotoTabs,
  type SortLake,
  sortNote,
  sortPhotosIntoTabs,
} from './photoSort';

/** Photos a hundred meters apart are one lookup: the lake under them is the same. */
export function coordKey(c: LatLng): string {
  return `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
}

const mint = () => crypto.randomUUID();

/** The mounted sorter's line, for a sort that happened as photos were added. */
const noteListeners = new Set<(note: string) => void>();

/**
 * Photos added to the sheet being written, from any door (the cards, the strip, Google Photos):
 * the day's rules, then one tab per lake and day for the ones only their place put on a Report
 * (`addPhotosByLakeAndDay`) — and the line that says so, when that made more than one tab.
 */
export function addSheetPhotos(
  drafts: readonly DraftPhoto[],
  outlines: Parameters<typeof addPhotosByLakeAndDay>[2]['outlines'],
): void {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let note: string | null = null;
  updateSheet((p) => {
    const out = addPhotosByLakeAndDay(p, drafts, { timeZone, now: Date.now(), mint, outlines });
    note = sortNote(out.tabs);
    return out.post;
  });
  if (note !== null) for (const listener of noteListeners) listener(note);
}

/**
 * The EXIF sort, connected (5.17.1): photos the day couldn't put on a Report land in the Post's
 * pool; the ones with a place are looked up against the corpus (`resolveBodyForCoord`, one bounded
 * read per spot), sorted into one tab per lake and day, and laid onto the Post — the blank Report
 * answered, a Report opened for each other lake and day. Each photo is sorted once, when it
 * arrives while the sheet is open: a tab the author removes doesn't come back, and a restored
 * draft's pool stays the author's. Then the line that says what happened — also for photos sorted
 * as they were added (`addSheetPhotos`), which never reach the pool.
 */
export function PhotoSorter({
  post,
  activeId,
  onActivate,
}: {
  post: PostSheet;
  activeId: string;
  onActivate: (reportId: string) => void;
}) {
  const convex = useConvex();
  const outlines = useBodyOutlines();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    noteListeners.add(setNote);
    return () => {
      noteListeners.delete(setNote);
    };
  }, []);
  const creating = post.mode.kind === 'create';
  const pool = creating ? unassignedPhotos(post) : [];
  // What the pool already held when the sheet opened (a restored draft's `?` photos) is the
  // author's to place: only photos that arrive while the sheet is open are sorted.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(pool.map((p) => p.id));
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // The latest of what the sort reads when its lookups come back, without re-running it.
  const latest = useRef({ activeId, outlines, onActivate });
  latest.current = { activeId, outlines, onActivate };

  const poolKey = pool.map((p) => p.id).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pool's ids; the photos ride `pool`.
  useEffect(() => {
    const known = seen.current ?? new Set<string>();
    const fresh = pool.filter((p) => !known.has(p.id));
    if (fresh.length === 0) return;
    for (const p of fresh) known.add(p.id);
    if (!fresh.some((p) => p.coord !== undefined)) return;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void (async () => {
      const lakes = new Map<string, SortLake | null>();
      for (const p of fresh) {
        if (p.coord === undefined) continue;
        const key = coordKey(p.coord);
        if (lakes.has(key)) continue;
        try {
          const found = await convex.query(api.waterBodies.resolveBodyForCoord, {
            coord: p.coord,
          });
          lakes.set(key, found ? { waterBodyId: found.waterBodyId, name: found.name } : null);
        } catch {
          lakes.set(key, null);
        }
      }
      if (!mounted.current) return;
      const tabs = sortPhotosIntoTabs(
        fresh,
        (p) => (p.coord !== undefined ? (lakes.get(coordKey(p.coord)) ?? null) : null),
        timeZone,
      );
      if (tabs.length === 0) return;
      let first: string | null = null;
      updateSheet((current) => {
        // Only what is still in the pool: the author may have placed some while we looked.
        const pooled = new Set(unassignedPhotos(current).map((p) => p.id));
        const still = tabs
          .map((t) => ({ ...t, photoIds: t.photoIds.filter((id) => pooled.has(id)) }))
          .filter((t) => t.photoIds.length > 0);
        if (still.length === 0) return current;
        const out = applyPhotoTabs(current, still, {
          activeId: latest.current.activeId,
          timeZone,
          now: Date.now(),
          mint,
          outlines: latest.current.outlines,
        });
        first = out.firstReportId;
        return out.post;
      });
      if (first !== null) latest.current.onActivate(first);
      setNote(sortNote(tabs));
    })();
  }, [poolKey, convex]);

  if (note === null) return null;
  return <PhotoSortNote note={note} onDismiss={() => setNote(null)} />;
}

/** The line over the sorted tabs (5.17.1), with its dismiss. */
export function PhotoSortNote({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-slot="photo-sort-note"
      className="flex items-start gap-(--space-3) border border-solid border-line2 p-(--space-3) text-assist leading-body text-fg2 [text-wrap:pretty]"
    >
      <span className="flex-1">{note}</span>
      <button
        type="button"
        aria-label="Dismiss"
        data-attr="photo-sort-dismiss"
        onClick={onDismiss}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-fg2 outline-none hover:text-fg focus-visible:shadow-focus"
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </div>
  );
}
