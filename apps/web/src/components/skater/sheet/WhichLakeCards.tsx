import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faImage, faRoute } from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { type ReactNode, useRef, useState } from 'react';
import garminMark from '@/assets/brands/garmin-mark.svg';
import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { cn } from '@/lib/utils';

/**
 * *Which lake?* (5.2/5.3, 5.17): until a Report has its lake, the instrument is the question — two
 * ways in that answer it from what the author already has, and a search under them.
 *
 * - **From a GPX file** — a track picks its lake and its times set the day. Behind the `gpx-import`
 *   flag (D239, D240): flag off, the card stands with its drop zone inert and says so; flag on, the
 *   import flow (the second half's) mounts in the drop zone.
 * - **From your photos** — a photo taken on the water picks its lake (the sort is the second
 *   half's); today the photos land on the Post and the lake is still asked.
 * - **Garmin** ships later (D24): one disabled row under the GPX card, marked *Coming soon*, with
 *   its official mark.
 *
 * The cards take about two thirds of the pane's height, the search directly under them (Review 4).
 * Props only; `ReportSheet` wires it.
 */
export function WhichLakeCards({
  ordinal,
  gpxEnabled,
  gpx,
  photosBusy,
  onPhotos,
  googlePhotos,
  search,
}: {
  /** 1 for the Post's first Report ("First"), 2+ for another ("Report 2"). */
  ordinal: number;
  /** The `gpx-import` flag. */
  gpxEnabled: boolean;
  /** The GPX import flow, when the flag is on and the flow is mounted. */
  gpx?: ReactNode;
  photosBusy: boolean;
  onPhotos: (files: File[]) => void;
  /** The Google Photos button, when mounted. */
  googlePhotos?: ReactNode;
  /** The lake search, under the cards. */
  search: ReactNode;
}) {
  return (
    <div
      data-slot="which-lake"
      className="flex min-h-0 flex-1 flex-col gap-(--space-6) px-(--space-8) pt-(--space-6) pb-(--space-8)"
    >
      <div className="flex flex-col gap-(--space-2_5)">
        <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
          {ordinal > 1 ? `Report ${ordinal}` : 'First'}
        </span>
        <h2 className="m-0 text-disp-lg leading-none font-semibold tracking-kick text-fg uppercase">
          Which lake?
        </h2>
      </div>
      <div className="grid h-2/3 min-h-0 grid-cols-2 gap-(--space-6)">
        <Card
          icon={faRoute}
          title="From a GPX file"
          sub="A track from your watch or phone picks its lake, and its time sets when you were there"
          foot={
            <div
              data-slot="garmin-soon"
              aria-disabled="true"
              className="flex items-center gap-(--space-3) border-0 border-t border-solid border-line pt-(--space-3)"
            >
              <span
                role="img"
                aria-label="Garmin"
                className="h-4 w-14 shrink-0 bg-fg2 [mask-position:left_center] [mask-repeat:no-repeat] [mask-size:contain]"
                style={{ maskImage: `url("${garminMark}")` }}
              />
              <span className="min-w-0 truncate text-assist text-fg2">
                Sync skates from your watch
              </span>
              <Badge variant="outline" className="ml-auto">
                Coming soon
              </Badge>
            </div>
          }
        >
          <Drop icon={faRoute} title="Drop a GPX file" mount="gpx-import" inert={!gpxEnabled}>
            {gpxEnabled ? (
              (gpx ?? (
                <Button size="sm" disabled data-attr="gpx-choose">
                  <FontAwesomeIcon icon={faPlus} />
                  Choose a file
                </Button>
              ))
            ) : (
              <Badge variant="outline">Coming soon</Badge>
            )}
          </Drop>
        </Card>
        <Card
          icon={faCamera}
          title="From your photos"
          sub="A photo taken on the water picks its lake, and its time sets when you were there"
        >
          <PhotoDrop busy={photosBusy} onPhotos={onPhotos} googlePhotos={googlePhotos} />
        </Card>
      </div>
      {search}
    </div>
  );
}

function Card({
  icon,
  title,
  sub,
  children,
  foot,
}: {
  icon: typeof faRoute;
  title: string;
  sub: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 flex-col gap-(--space-4) border border-solid border-line2 p-(--space-5)"
    >
      <div className="flex items-start gap-(--space-3_5)">
        <span className="flex size-9 shrink-0 items-center justify-center bg-fg1 text-bg">
          <FontAwesomeIcon icon={icon} />
        </span>
        <div className="flex flex-col gap-(--space-1)">
          <h3 className="m-0 text-kick leading-none font-semibold tracking-head text-fg uppercase">
            {title}
          </h3>
          <p className="m-0 text-assist leading-body text-fg2 [text-wrap:pretty]">{sub}</p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {foot}
    </section>
  );
}

function Drop({
  icon,
  title,
  children,
  mount,
  inert = false,
  dragging = false,
  ...handlers
}: {
  icon: typeof faRoute;
  title: string;
  children: ReactNode;
  mount: string;
  inert?: boolean;
  dragging?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      data-mount={mount}
      data-dragging={dragging ? '' : undefined}
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-(--space-3) border border-dashed border-line2 p-(--space-6) text-center',
        dragging && 'bg-lift-05',
        inert && 'text-fg-disabled',
      )}
      {...handlers}
    >
      <FontAwesomeIcon icon={icon} className={cn('text-2xl', inert ? 'text-fg3' : 'text-fg2')} />
      <span className={cn('text-row font-medium', inert ? 'text-fg2' : 'text-fg')}>{title}</span>
      <div className="flex gap-(--space-2)">{children}</div>
    </div>
  );
}

function PhotoDrop({
  busy,
  onPhotos,
  googlePhotos,
}: {
  busy: boolean;
  onPhotos: (files: File[]) => void;
  googlePhotos?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <Drop
      icon={faImage}
      title="Drop photos from the day"
      mount="photos"
      dragging={dragging}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onPhotos(Array.from(e.dataTransfer.files));
      }}
    >
      <Button
        size="sm"
        loading={busy}
        data-attr="which-lake-photos"
        onClick={() => inputRef.current?.click()}
      >
        <FontAwesomeIcon icon={faPlus} />
        Photos
      </Button>
      {googlePhotos}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Photos from the day"
        onChange={(e) => {
          onPhotos(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </Drop>
  );
}
