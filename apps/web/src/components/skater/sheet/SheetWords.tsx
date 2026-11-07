import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faEllipsis,
  faLocationCrosshairs,
  faLocationDot,
  faXmark,
} from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  addPostPhotos,
  assignCandidates,
  type DraftPhoto,
  POST_TITLE_MAX_CHARS,
  type PostSheet,
  type SheetReport,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { type ReactNode, useRef, useState } from 'react';
import { Input } from '@/components/kit/input';
import { Textarea } from '@/components/kit/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { useAnalytics } from '@/lib/analytics';
import { useBodyOutlines } from '@/lib/bodyOutlines';
import { addSheetPhoto, releaseSheetPhoto, sheetPhotoPreview } from '@/lib/sheetPhotos';
import { updateSheet } from '@/lib/sheetStore';
import { cn } from '@/lib/utils';
import { useSheetSlots } from './sheetSlots';

/**
 * The words and photos (5.1): the Post's title and story — the Post's, not a lake's (D186) — then
 * every photo of the day as a strip of tiles, the lake's number in the corner when the Post has
 * several, a pin when the photo is placed on the water and a hollow one when it is not, and the
 * add tile. A tile's menu (which lake, place it, this is a hazard, leave it out) is the second
 * half's (`photoTileMenu`); its corner mark is the trigger — and a new photo that needs no number
 * (an assigned one in a one-lake Post) still gets a quiet ⋯ mark, so its menu is never out of reach.
 *
 * `ph-no-capture` (D240) on the whole block: the words and photos are the author's.
 */
export function SheetWords({
  post,
  ordered,
  editing,
  activeReport,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  editing: boolean;
  activeReport: SheetReport;
}) {
  return (
    <div
      data-slot="sheet-words"
      className="ph-no-capture flex flex-col gap-(--space-2_5) border-0 border-b border-solid border-line pb-(--space-5)"
    >
      <Input
        aria-label="Title"
        data-attr="sheet-title"
        placeholder="Title — Mascoma Lake, Enfield 1/16"
        maxLength={POST_TITLE_MAX_CHARS}
        value={post.title}
        onChange={(e) => updateSheet((p) => ({ ...p, title: e.target.value, dirty: true }))}
        className="text-[1.0625rem] font-semibold"
      />
      {/* Board 5.1: the story is the page's writing, so it sits on the underline, as the title does. */}
      <Textarea
        variant="underline"
        aria-label="How was it?"
        data-attr="sheet-story"
        rows={3}
        placeholder="How was it? Write it the way you'd tell a friend — the chips below are for the hard numbers."
        value={post.body}
        onChange={(e) => updateSheet((p) => ({ ...p, body: e.target.value, dirty: true }))}
      />
      <PhotoStrip post={post} ordered={ordered} editing={editing} activeReport={activeReport} />
    </div>
  );
}

interface Tile {
  photo: DraftPhoto;
  reportId: string | null;
  /** The tab's number, when the photo is on a Report. */
  n: number | null;
  preview: string | null;
  /** On the published Report already (an edit's kept photo). */
  kept: boolean;
}

function PhotoStrip({
  post,
  ordered,
  editing,
  activeReport,
}: {
  post: PostSheet;
  ordered: readonly SheetReport[];
  editing: boolean;
  activeReport: SheetReport;
}) {
  const outlines = useBodyOutlines();
  const { photoTileMenu, googlePhotos } = useSheetSlots();
  const { capture } = useAnalytics();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An edit's kept photos, by the Report — `photos.getUrls` takes the Report, and on the edit door
  // the sheet's Report id *is* the published one's.
  const keptUrls = useQuery(
    api.photos.getUrls,
    editing && activeReport.keptPhotoIds.length > 0
      ? { reportId: activeReport.id as Id<'reports'> }
      : 'skip',
  );

  const many = post.reports.length > 1;
  const tiles: Tile[] = [
    ...ordered.flatMap((r, i) => [
      ...r.keptPhotoIds.map((id) => {
        const found = keptUrls?.find((k) => k.photoId === id);
        return {
          photo: { id, fullUri: '', thumbUri: '', placeOnMap: false } as DraftPhoto,
          reportId: r.id,
          n: i + 1,
          preview: found?.thumbUrl ?? null,
          kept: true,
        };
      }),
      ...r.photos.map((photo) => ({
        photo,
        reportId: r.id,
        n: i + 1,
        preview: sheetPhotoPreview(photo.id),
        kept: false,
      })),
    ]),
    ...(post.photos ?? []).map((photo) => ({
      photo,
      reportId: null,
      n: null,
      preview: sheetPhotoPreview(photo.id),
      kept: false,
    })),
  ];

  const add = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/') || f.type === '');
    if (picked.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const drafts = await Promise.all(picked.map(addSheetPhoto));
      if (editing) {
        // An edit's new photos go on its one Report and upload with the save.
        updateSheet((p) =>
          updateReport(p, activeReport.id, (r) => ({ ...r, photos: [...r.photos, ...drafts] })),
        );
      } else {
        updateSheet((p) => addPostPhotos(p, drafts, assignCandidates(p, outlines)));
      }
      capture('report_photos_added', { source: 'device', count: drafts.length });
    } catch {
      setError("Couldn't read one of those images — try a different file.");
    } finally {
      setBusy(false);
    }
  };

  const remove = (tile: Tile) => {
    if (tile.kept) {
      updateSheet((p) =>
        updateReport(p, tile.reportId ?? activeReport.id, (r) => ({
          ...r,
          keptPhotoIds: r.keptPhotoIds.filter((id) => id !== tile.photo.id),
        })),
      );
      return;
    }
    releaseSheetPhoto(tile.photo.id);
    updateSheet((p) =>
      updateReport(p, tile.reportId ?? activeReport.id, (r) => ({
        ...r,
        photos: r.photos.filter((ph) => ph.id !== tile.photo.id),
      })),
    );
  };

  return (
    <div className="flex flex-col gap-(--space-2)">
      <div data-slot="photo-strip" className="flex flex-wrap items-center gap-(--space-1_5)">
        {tiles.map((tile) => (
          <PhotoTile
            key={tile.photo.id}
            tile={tile}
            many={many}
            editing={editing}
            onRemove={() => remove(tile)}
            menu={
              photoTileMenu !== undefined && !tile.kept
                ? (trigger) =>
                    photoTileMenu({ photo: tile.photo, reportId: tile.reportId, trigger })
                : null
            }
          />
        ))}
        <button
          type="button"
          aria-label="Add photos"
          data-attr="sheet-add-photos"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex size-15.5 cursor-pointer items-center justify-center rounded-control border border-dashed border-line2 bg-transparent text-fg2 outline-none hover:text-fg focus-visible:shadow-focus disabled:cursor-progress"
        >
          <FontAwesomeIcon icon={faPlus} />
        </button>
        {tiles.length === 0 && !editing && googlePhotos !== undefined
          ? googlePhotos({
              disabled: busy,
              onPhotos: (drafts) =>
                updateSheet((p) => addPostPhotos(p, drafts, assignCandidates(p, outlines))),
            })
          : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Photos to add"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {error ? <p className="m-0 text-assist text-warn">{error}</p> : null}
    </div>
  );
}

function PhotoTile({
  tile,
  many,
  editing,
  onRemove,
  menu,
}: {
  tile: Tile;
  many: boolean;
  editing: boolean;
  onRemove: () => void;
  /** The tile's menu around its corner mark; `null` when the tile has none (a kept photo). */
  menu: ((trigger: ReactNode) => ReactNode) | null;
}) {
  const unassigned = tile.reportId === null && tile.photo.attachTo === undefined;
  const placed = tile.photo.placeOnMap;
  const mark = unassigned ? '?' : many && tile.n !== null ? String(tile.n) : null;
  const markClass =
    'absolute top-1 left-1 h-3.5 min-w-3.5 px-0.5 text-center font-(family-name:--family-mono) text-[0.5625rem] leading-3.5';
  return (
    <div
      data-slot="photo-tile"
      data-unassigned={unassigned ? '' : undefined}
      className={cn(
        'group/tile relative size-15.5 overflow-hidden rounded-control border border-solid bg-raise',
        unassigned ? 'border-warn' : 'border-line',
      )}
    >
      {tile.preview ? (
        <img src={tile.preview} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-center text-assist text-fg3">
          {tile.kept ? '' : 'Re-add'}
        </span>
      )}
      {mark !== null
        ? (menu ?? ((t: ReactNode) => t))(
            <span
              data-slot="photo-tile-mark"
              className={cn(
                markClass,
                unassigned ? 'border border-dashed border-warn text-warn' : 'bg-fg1 text-bg',
              )}
            >
              {mark}
            </span>,
          )
        : menu !== null
          ? // No number to show, but the menu still has to be reachable: a quiet mark opens it.
            menu(
              <span data-slot="photo-tile-mark" className={cn(markClass, 'bg-bg/80 text-fg1')}>
                <FontAwesomeIcon icon={faEllipsis} />
              </span>,
            )
          : null}
      {tile.kept ? null : (
        <span
          role="img"
          aria-label={placed ? 'Placed on the lake' : 'Not placed on the lake'}
          className={cn(
            'absolute right-1 bottom-1 text-[0.625rem]',
            placed ? 'text-acc' : 'text-fg3',
          )}
        >
          <FontAwesomeIcon icon={placed ? faLocationDot : faLocationCrosshairs} />
        </span>
      )}
      {editing ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Remove this photo"
                data-attr="sheet-photo-remove"
                onClick={onRemove}
                className="absolute top-1 right-1 flex size-4 cursor-pointer items-center justify-center border-0 bg-bg/80 text-fg1 opacity-0 outline-none group-hover/tile:opacity-100 focus-visible:opacity-100 focus-visible:shadow-focus"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            }
          />
          <TooltipContent>A photo you remove leaves the report when you save.</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
