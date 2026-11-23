import { type RefObject, useContext, useState } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { PhotoStage, PhotoThumb } from '@/components/kit/photo-stage';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { usePaneKeys } from '@/lib/keys';
import { LinkChip } from '../../blocks/LinkChip';
import { type InboxQuery, inboxHref } from '../../inboxSearch';
import { useInspectorContext } from '../../inspector/inspectorContext';
import { dayMonth } from './flagFormat';
import type { LiveTarget } from './flagTypes';
import { SubjectText } from './parts';
import {
  captionLine,
  photoViewOf,
  placeOnReport,
  purgeLine,
  sameImageLine,
  siblingsCutLine,
  siblingViews,
  stageState,
  twinViews,
  withdrawnLine,
} from './photoModel';
import { PhotoRevealContext } from './photoRevealContext';
import { PHOTO_WORDS as P } from './photoWords';

/**
 * **A photo** (board 2.7): the stage — the photo pixelated until the moderator chooses *Show the
 * photo* (S), when its full image is fetched (`inbox.photoReveal`, never in the item) —, its caption
 * and place on the report, then *On the same report*, the report's photos pixelated the same way, the
 * flagged one marked and another with an open flag linked to its item. The flag and its author follow, drawn by the
 * flag handler as for every subject; the bar (Hide, Remove, Dismiss, or Restore for a photo already
 * down) is the flag handler's too, from `can` alone.
 *
 * **A viewer the server serves no address** (no `content.read`) is told so in words: no image is drawn,
 * no broken image, and no *Show*. A deleted file (a removal's 30 days passed) is a tombstone: what was
 * removed, and when.
 *
 * Reveal is per photo and forgotten when the item changes (the caller keys this by the photo).
 */

const NO_PANE: RefObject<HTMLElement | null> = { current: null };

/** The Inbox's All open list, where a sibling's flag link opens its item. */
const ALL_OPEN: InboxQuery = { lane: 'all', facet: 'all', filter: null, item: null, from: null };

export type PhotoSubjectProps = {
  target: Extract<LiveTarget, { targetType: 'photo' }>;
  /** The inspector pane the reveal's key acts in. */
  pane?: RefObject<HTMLElement | null>;
  timeZone?: string | undefined;
};

export function PhotoSubject({ target, pane, timeZone }: PhotoSubjectProps) {
  const photo = photoViewOf(target);
  const stage = stageState(photo);
  const [shown, setShown] = useState(false);
  const canShow = stage.kind === 'stage';
  const { linkFor } = useInspectorContext();
  // The full image, asked for only once shown (and only for a photo the stage may draw).
  const useReveal = useContext(PhotoRevealContext);
  const reveal = useReveal(photo.photoId, shown && canShow);
  usePaneKeys(pane ?? NO_PANE, [
    {
      key: 'S',
      run: () => setShown((s) => !s),
      enabled: canShow && pane !== undefined,
      label: shown ? P.pixelate : P.show,
    },
  ]);
  const purge = purgeLine(photo, timeZone);
  const withdrawn = withdrawnLine(photo, timeZone);
  const siblings = siblingViews(photo);
  const cut = siblingsCutLine(photo);
  const caption = photo.caption?.trim() ?? '';
  const twins = twinViews(photo);
  const sameImage = sameImageLine(photo);

  return (
    <div data-subject="photo" data-slot="photo-subject" className="flex min-w-0 flex-col">
      {stage.kind === 'stage' ? (
        <PhotoStage
          thumb={stage.thumb}
          full={reveal.kind === 'ready' ? reveal.url : null}
          // Failed, or answered with no address (purged since): words, never the thumbnail instead.
          fullFailed={reveal.kind === 'failed' || (reveal.kind === 'ready' && reveal.url === null)}
          loadingLabel={P.revealLoading}
          thumbUnavailable={P.thumbUnavailable}
          fullUnavailable={P.revealFailed}
          shown={shown}
          onShow={() => setShown(true)}
          onPixelate={() => setShown(false)}
          alt={caption === '' ? P.photoAlt : caption}
          label={P.stageLabel}
          veil={P.veil}
          showLabel={P.show}
          pixelateLabel={P.pixelate}
          {...(pane !== undefined && { showKey: 'S' })}
          caption={captionLine(photo, timeZone)}
          place={placeOnReport(photo)}
        />
      ) : (
        <div
          data-slot="photo-no-stage"
          data-state={stage.kind}
          className="border-0 border-b border-solid border-line px-gutter pt-(--space-5) pb-(--space-4)"
        >
          <Note data-slot={`photo-${stage.kind}`}>
            {stage.kind === 'noAccess' ? (
              <>
                <strong>{P.noAccess}</strong>
                <span className="block">{P.noAccessSub}</span>
              </>
            ) : stage.kind === 'noFile' ? (
              <>
                <strong>{P.noFile}</strong>
                <span className="block">{P.noFileSub}</span>
              </>
            ) : stage.kind === 'missing' ? (
              <>
                <strong>{P.missing}</strong>
                <span className="block">{P.missingSub(dayMonth(stage.at, timeZone))}</span>
              </>
            ) : (
              <>
                <strong>{P.purged(dayMonth(stage.purgedAt, timeZone))}</strong>
                <span className="block">
                  {P.purgedSub(
                    stage.removedAt === null ? null : dayMonth(stage.removedAt, timeZone),
                  )}
                </span>
              </>
            )}
          </Note>
          <span
            data-slot="photo-caption"
            className="mt-(--space-2_5) block font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
          >
            {[captionLine(photo, timeZone), placeOnReport(photo)]
              .filter((x): x is string => x !== null && x !== '')
              .join(' · ')}
          </span>
        </div>
      )}
      {reveal.kind === 'failed' && (
        <div className="px-gutter pt-(--space-4)">
          <RetryNote
            data-slot="photo-reveal-failed"
            onRetry={reveal.retry}
            pending={reveal.pending}
          >
            {P.revealFailed}
          </RetryNote>
        </div>
      )}
      {(purge !== null || withdrawn !== null || caption !== '') && (
        <div className="flex flex-col gap-(--space-2) px-gutter pt-(--space-4)">
          {caption !== '' && stage.kind === 'stage' && (
            <SubjectText data-slot="photo-caption-words">“{caption}”</SubjectText>
          )}
          {withdrawn !== null && (
            <span data-slot="photo-withdrawn" className="text-assist leading-list text-fg2">
              {withdrawn}
            </span>
          )}
          {purge !== null && (
            <span data-slot="photo-purge-on" className="text-assist leading-list text-fg2">
              {purge}
            </span>
          )}
        </div>
      )}
      {siblings.length > 0 && (
        <Section
          data-slot="photo-same-report"
          level={3}
          title={P.sameReport}
          className="px-gutter pt-(--space-5)"
        >
          <ul className="m-0 flex list-none flex-wrap gap-(--space-2_5) p-0">
            {siblings.map((s) => (
              <li
                key={s.photoId}
                data-slot="photo-sibling"
                data-photo={s.photoId}
                data-self={s.self ? '' : undefined}
                className="flex flex-col items-start gap-(--space-1_5)"
              >
                <PhotoThumb
                  // A viewer who can't see photos is served no thumbnail: an empty frame, no image.
                  thumb={canShow ? s.thumbUrl : null}
                  // Show reveals the staged photo and its unflagged, still-visible neighbors only.
                  shown={shown && canShow && s.revealable}
                  selected={s.self}
                  label={P.thumbLabel(s.n)}
                  alt={P.thumbAlt(s.n)}
                  unavailable={P.thumbUnavailable}
                />
                {s.flagRef !== null && linkFor !== undefined && (
                  <LinkChip
                    link={linkFor(inboxHref({ ...ALL_OPEN, item: s.flagRef }))}
                    label={P.itsFlag}
                    slot="photo-sibling-flag"
                  />
                )}
                {s.label !== null &&
                  (s.self ? (
                    <Badge variant="outline" data-slot="photo-sibling-label">
                      {s.label}
                    </Badge>
                  ) : (
                    <span
                      data-slot="photo-sibling-label"
                      className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
                    >
                      {s.label}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
          {cut !== null && (
            <span data-slot="photo-same-report-cut" className="text-assist leading-list text-fg3">
              {cut}
            </span>
          )}
        </Section>
      )}
      {sameImage !== null && (
        // The same image on other photos: a row per twin — its state, and where to decide on it.
        // No uploader is named and no image is drawn (a twin is decided in its own item).
        <Section
          data-slot="photo-same-image"
          level={3}
          title={sameImage}
          className="px-gutter pt-(--space-5)"
        >
          <ul className="m-0 list-none p-0">
            {twins.map((t) => (
              <li
                key={t.photoId}
                data-slot="photo-twin"
                data-photo={t.photoId}
                data-state={t.status}
                className="flex min-h-(--size-td) items-center justify-between gap-(--space-3) border-0 border-b border-dotted border-line last:border-b-0"
              >
                <span
                  data-slot="photo-twin-state"
                  className={
                    t.status === 'visible'
                      ? 'text-row leading-list text-fg1'
                      : 'text-row leading-list text-fg3'
                  }
                >
                  {t.label}
                </span>
                {t.link === 'flag' ? (
                  t.flagRef !== null &&
                  linkFor !== undefined && (
                    <LinkChip
                      link={linkFor(inboxHref({ ...ALL_OPEN, item: t.flagRef }))}
                      label={P.itsFlag}
                      slot="photo-twin-flag"
                    />
                  )
                ) : t.link === 'report' ? (
                  <Button
                    variant="link"
                    size="xs"
                    external
                    nativeButton={false}
                    data-slot="photo-twin-report"
                    render={
                      <a href={`/report/${t.reportId}`} target="_blank" rel="noopener noreferrer" />
                    }
                  >
                    {P.twinReport}
                  </Button>
                ) : (
                  <span
                    data-slot="photo-twin-no-report"
                    className="text-assist leading-list text-fg3"
                  >
                    {P.twinNoReport}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
