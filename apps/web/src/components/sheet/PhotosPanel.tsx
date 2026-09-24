import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { DraftPhoto } from '@skating/core';
import { useQuery } from 'convex/react';
import { type DragEvent, useRef, useState } from 'react';
import { addSheetPhoto, releaseSheetPhoto, sheetPhotoPreview } from '../../lib/sheetPhotos';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel } from './SheetPanel';
import type { SectionProps } from './sectionProps';

/**
 * *Photos* (A10 §8.2): the browser's half of the pipeline the phone already runs — decode,
 * read the EXIF coordinate from the original, re-encode with all metadata stripped (D31/D42) — with
 * the photos held on the sheet until *Post* uploads them. **Drag a folder of photos onto the panel**
 * or use the picker; both go through the same `processPhoto`.
 *
 * Nothing uploads from here. The upload is `flushPost`'s step 4, which checkpoints each object id
 * as it lands, so a Post that fails halfway and is retried reuses what already went up.
 *
 * The time-window query over the camera roll (§8.1) is the phone's, and matching a desktop drop to
 * the skate's window by `takenAt` is A10-4's; what a drop gets today is the coordinate.
 */
export function PhotosPanel({ report, dispatch, setReport, gaps, editing }: SectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheet = report.sheet;
  const count = report.photos.length + report.keptPhotoIds.length;
  const summary = count > 0 ? `${count} ${count === 1 ? 'photo' : 'photos'}` : '';

  // The thumbnails of an edit's already-attached photos, so a review shows the report as it is.
  // Addressed by the Report, which is what `photos.getUrls` takes — and on the edit door the
  // sheet's own id *is* the Report's (`postSheetForEdit` seeds it that way).
  const keptUrls = useQuery(
    api.photos.getUrls,
    editing && report.keptPhotoIds.length > 0 ? { reportId: report.id as Id<'reports'> } : 'skip',
  );

  const add = async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((f) => f.type.startsWith('image/') || f.type === '');
    if (picked.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // Processed concurrently — each is a decode plus two re-encodes — and added together, so a
      // sibling that fails does not leave half a drop on the sheet.
      const drafts: DraftPhoto[] = await Promise.all(picked.map(addSheetPhoto));
      setReport((r) => ({ ...r, photos: [...r.photos, ...drafts] }));
    } catch {
      setError("Couldn't read one of those images — try a different file.");
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string) => {
    releaseSheetPhoto(id);
    setReport((r) => ({ ...r, photos: r.photos.filter((p) => p.id !== id) }));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void add(e.dataTransfer.files);
  };

  return (
    <SheetPanel
      label="Photos"
      summary={summary}
      collapsed={sheet.collapsed.photos}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'photos', collapsed: !sheet.collapsed.photos })
      }
      gap={gaps.has('photos')}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone is a convenience over
          the file input inside it, which is the keyboard and screen-reader path. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col gap-3 rounded-[2px] border border-dashed p-3 transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        {count > 0 ? (
          <div className="flex flex-wrap gap-3">
            {report.keptPhotoIds.map((photoId) => {
              const url = keptUrls?.find((u) => u.photoId === photoId)?.thumbUrl ?? null;
              return (
                <figure key={photoId} className="flex w-20 flex-col items-center gap-1">
                  {url ? (
                    <img
                      src={url}
                      alt="Already on this report"
                      className="size-20 rounded-[2px] object-cover"
                    />
                  ) : (
                    <span className="flex size-20 items-center justify-center rounded-[2px] bg-surface-muted text-center text-foreground-muted text-xs">
                      On the report
                    </span>
                  )}
                  <button
                    type="button"
                    className="text-foreground-muted text-xs hover:underline"
                    onClick={() =>
                      setReport((r) => ({
                        ...r,
                        keptPhotoIds: r.keptPhotoIds.filter((id) => id !== photoId),
                      }))
                    }
                  >
                    Remove
                  </button>
                </figure>
              );
            })}
            {report.photos.map((photo) => {
              const preview = sheetPhotoPreview(photo.id);
              return (
                <figure key={photo.id} className="flex w-20 flex-col items-center gap-1">
                  {preview ? (
                    <img
                      src={preview}
                      alt="One you picked"
                      className="size-20 rounded-[2px] object-cover"
                    />
                  ) : (
                    <span className="flex size-20 items-center justify-center rounded-[2px] bg-surface-muted text-center text-foreground-muted text-xs">
                      Re-add
                    </span>
                  )}
                  {photo.coord ? (
                    <SheetChip
                      compact
                      label="On the map"
                      {...(photo.placeOnMap ? { tier: 'solid' as const } : {})}
                      onClick={() =>
                        setReport((r) => ({
                          ...r,
                          photos: r.photos.map((p) =>
                            p.id === photo.id ? { ...p, placeOnMap: !p.placeOnMap } : p,
                          ),
                        }))
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    className="text-foreground-muted text-xs hover:underline"
                    onClick={() => remove(photo.id)}
                  >
                    Remove
                  </button>
                </figure>
              );
            })}
          </div>
        ) : (
          <SheetHint>Drag photos here, or pick them below.</SheetHint>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) void add(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Adding…' : '+ Photos'}
        </Button>
      </div>
      {report.photos.some((p) => p.coord) ? (
        <SheetHint>
          A photo's location is only sent if you put it on the map. Everything else in the file —
          camera, timestamp, GPS — is stripped before it leaves this tab.
        </SheetHint>
      ) : null}
      {editing ? <SheetHint>A photo you remove leaves the report when you save.</SheetHint> : null}
      {error ? <p className="text-danger text-xs">{error}</p> : null}
    </SheetPanel>
  );
}
