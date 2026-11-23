import { type RefObject, useContext, useState } from 'react';

import { Badge } from '@/components/kit/badge';
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
  siblingsCutLine,
  siblingViews,
  stageState,
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

  return (
    <div data-subject="photo" data-slot="photo-subject" className="flex min-w-0 flex-col">
      {stage.kind === 'stage' ? (
        <PhotoStage
          thumb={stage.thumb}
          full={reveal.kind === 'ready' ? reveal.url : null}
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
    </div>
  );
}
