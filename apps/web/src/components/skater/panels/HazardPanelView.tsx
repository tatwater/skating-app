import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/sharp-light-svg-icons';
import {
  FOOTPRINT_IS_APPROXIMATE,
  type HazardType,
  type HazardVerdict,
  isPassageMarker,
  verdictHelp,
  verdictLabel,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { Button } from '../../kit/button';
import { PersonName } from '../../PersonName';
import { CardHead, CardNote, CardRule, PlaceGlyph, useCardEscape } from './InsetCard';

/**
 * The open hazard (boards 2.1–2.3), props only: what it is and where, how current the report is,
 * who reported and who confirmed it, the notes that keep an old marker from reading as an all-clear,
 * the reporter's words, the weather around it, the photos — and the verdicts, "Seen this recently?".
 *
 * Every word about a hazard's *state* comes from `@skating/core`'s `hazardCopy` (the container
 * passes it in), so the D3 rule — nothing says the ice is safe — lives in one tested module.
 *
 * **Fully healed asks twice.** It's the one verdict that retires a marker for everyone, and a mis-tap
 * that clears a real hazard is the worst thing this card can do (D3) — so the first press opens a
 * second confirmation in the row. Clearing a hazard is good news, so that confirmation is drawn in
 * ice, not red (Review 4). It is never pre-opened, not even by `?action=confirm`.
 */
export interface HazardPanelData {
  hazardId: string;
  type: HazardType;
  /** "Open water / lead". */
  title: string;
  /** "Mascoma North · Mascoma Lake", with the lake a link. */
  bodyId: string;
  bodyName: string | null;
  /** The place before the lake: the bay, or the place line ("The Narrows, by Shaker Bridge"). */
  subAreaName?: string;
  /** "Recently reported", "Not confirmed recently" — the observation's age, never the ice's state. */
  freshnessLabel: string;
  fresh: boolean;
  /** The other badges, already in words: "Unconfirmed", "Reported healing", "Crossing point"… */
  badges: readonly string[];
  reporter: {
    displayName: string;
    username: string;
    profileImageUrl?: string;
    deleted?: true;
  } | null;
  /** "Reported Thursday by Sarah Berman · confirmed by Rob Tremblay and Pat Lacasse". */
  byline: string;
  /** The notes that do the work of not sounding like an all-clear, in reading order. */
  notes: readonly string[];
  description?: string;
  photos: ReadonlyArray<{ photoId: string; thumbUrl: string | null; caption?: string }>;
}

/** The verdicts, in the order they're offered: the claim about the report itself last (D65). */
export const VERDICTS: readonly HazardVerdict[] = [
  'still_there',
  'healing_unsafe',
  'fully_healed',
  'never_existed',
];

/** The second confirmation's words: a person's claim about what they saw, never about the ice. */
export function healedConfirmLabel(type: HazardType): string {
  return isPassageMarker(type) ? 'Yes, the crossing is gone' : 'Yes, I don’t see it anymore';
}

export interface HazardPanelViewProps {
  data: HazardPanelData;
  /** Absent: no verdicts (a retired marker, a leaving account). */
  onVerdict?: (verdict: HazardVerdict) => void;
  confirming?: boolean;
  /** A verdict that didn't land says so: silence would let a skater think they'd warned the next one. */
  confirmError?: string | null;
  /** `?action=confirm`: the card opens on the verdicts. */
  action?: 'confirm';
  weather?: ReactNode;
  /** Moderator levers, below everything; they render nothing for anyone else. */
  moderator?: ReactNode;
}

export function HazardPanelView({
  data,
  onVerdict,
  confirming = false,
  confirmError = null,
  action,
  weather,
  moderator,
}: HazardPanelViewProps) {
  const passage = isPassageMarker(data.type);
  const [arming, setArming] = useState(false);
  const questionId = useId();
  const verdictsRef = useRef<HTMLFieldSetElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useCardEscape(arming, () => setArming(false));

  // `?action=confirm`: bring the verdicts into view and put focus on them, once they render.
  const showVerdicts = onVerdict !== undefined;
  useEffect(() => {
    if (action !== 'confirm' || !showVerdicts) return;
    const node = verdictsRef.current;
    if (node === null) return;
    node.scrollIntoView?.({ block: 'center' });
    node.focus({ preventScroll: true });
  }, [action, showVerdicts]);

  // The second confirmation opens with focus on its words, so they're heard before the button.
  useEffect(() => {
    if (arming) confirmRef.current?.focus();
  }, [arming]);

  const where = (
    <>
      <PlaceGlyph />
      <span>
        {data.subAreaName !== undefined && <>{data.subAreaName} · </>}
        {data.bodyName !== null ? (
          <Link
            to="/water/$id"
            params={{ id: data.bodyId }}
            data-attr="hazard-lake"
            className="text-fg1 underline decoration-line2 underline-offset-[3px] hover:decoration-fg2"
          >
            {data.bodyName}
          </Link>
        ) : null}
      </span>
    </>
  );

  return (
    <>
      <CardHead kind="Hazard" title={data.title} where={where} />
      <div className="flex flex-wrap items-center gap-(--space-1_5)">
        {data.fresh ? (
          <Badge>{data.freshnessLabel}</Badge>
        ) : (
          <Badge variant="outline">{data.freshnessLabel}</Badge>
        )}
        {data.badges.map((badge) => (
          <Badge key={badge} variant="outline">
            {badge}
          </Badge>
        ))}
      </div>
      <div className="flex items-center gap-(--space-2_5) text-assist leading-(--lead-list) text-fg2">
        {data.reporter !== null && (
          <Avatar
            name={data.reporter.displayName}
            size="sm"
            {...(data.reporter.profileImageUrl !== undefined
              ? { src: data.reporter.profileImageUrl }
              : {})}
          />
        )}
        <PersonName>{data.byline}</PersonName>
      </div>
      {data.notes.map((note) => (
        <CardNote key={note}>{note}</CardNote>
      ))}
      {data.description !== undefined && data.description !== '' && (
        <p className="m-0 text-body leading-body text-fg1 [text-wrap:pretty]">{data.description}</p>
      )}
      {weather}
      {data.photos.some((p) => p.thumbUrl !== null) && (
        <div className="grid grid-cols-2 gap-(--space-1_5)">
          {data.photos.map((photo, i) =>
            photo.thumbUrl === null ? null : (
              <img
                key={photo.photoId}
                src={photo.thumbUrl}
                alt={photo.caption ?? `${data.title}, photo ${i + 1}`}
                className="h-32 w-full border border-solid border-line bg-raise object-cover"
              />
            ),
          )}
        </div>
      )}
      <p className="-mt-(--space-2_5) mb-0 text-[0.78125rem] leading-body text-fg3">
        {FOOTPRINT_IS_APPROXIMATE}
      </p>
      {showVerdicts && (
        <>
          <CardRule />
          <fieldset
            ref={verdictsRef}
            aria-labelledby={questionId}
            tabIndex={-1}
            data-slot="hazard-verdicts"
            className="m-0 flex min-w-0 scroll-mt-(--space-4) flex-col gap-(--space-1_5) border-0 p-0 outline-none"
          >
            <legend
              id={questionId}
              className="m-0 mb-(--space-2_5) p-0 text-body font-semibold text-fg"
            >
              {passage ? 'Been through here?' : 'Seen this recently?'}
            </legend>
            {VERDICTS.map((verdict) =>
              verdict === 'fully_healed' && arming ? (
                <div
                  key={verdict}
                  data-slot="healed-confirm"
                  className="flex flex-col gap-(--space-3) border border-solid border-acc bg-acc-wash px-(--space-3_5) py-(--space-3)"
                >
                  <div
                    ref={confirmRef}
                    tabIndex={-1}
                    className="flex flex-col gap-(--space-1_5) outline-none"
                  >
                    <span className="text-[0.90625rem] font-medium text-fg">
                      {verdictLabel(verdict, data.type)}
                    </span>
                    <span className="text-assist leading-body text-fg1">
                      {verdictHelp(verdict, data.type)} Say so only if you looked at this spot
                      yourself today.
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-(--space-2)">
                    <Button
                      size="sm"
                      variant="primary"
                      data-attr="hazard-healed-confirm"
                      disabled={confirming}
                      className="bg-acc text-inv-fg [--dot-opacity:0] lit:bg-acc lit:text-inv-fg lit:[--dot-opacity:0] pressed:bg-acc"
                      onClick={() => {
                        setArming(false);
                        onVerdict(verdict);
                      }}
                    >
                      {healedConfirmLabel(data.type)}
                    </Button>
                    <Button
                      size="sm"
                      data-attr="hazard-healed-cancel"
                      onClick={() => setArming(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <VerdictRow
                  key={verdict}
                  verdict={verdict}
                  type={data.type}
                  disabled={confirming}
                  onPress={() =>
                    verdict === 'fully_healed' ? setArming(true) : onVerdict(verdict)
                  }
                />
              ),
            )}
            {confirmError !== null && (
              <p role="alert" className="m-0 text-assist text-bad">
                {confirmError}
              </p>
            )}
          </fieldset>
        </>
      )}
      {moderator}
    </>
  );
}

/** One verdict: what you saw, what it does, a chevron — a whole-row button. */
function VerdictRow({
  verdict,
  type,
  disabled,
  onPress,
}: {
  verdict: HazardVerdict;
  type: HazardType;
  disabled: boolean;
  onPress: () => void;
}) {
  // The two that act on the marker's existence rather than its state read quieter.
  const quiet = verdict === 'fully_healed' || verdict === 'never_existed';
  return (
    <Button
      data-attr={`hazard-verdict-${verdict.replace(/_/g, '-')}`}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        // A whole-row choice: the kit's outlined action in row type, its content filling the row.
        'h-auto w-full justify-start px-(--space-3_5) py-[0.6875rem] text-left whitespace-normal',
        'font-regular tracking-normal normal-case [--dot-opacity:0] lit:[--dot-opacity:0]',
        '[&>[data-slot=label]]:flex-1 [&>[data-slot=label]]:gap-(--space-3)',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-0_5)">
        <span className={cn('text-[0.90625rem]', quiet ? 'text-fg1' : 'font-medium text-fg')}>
          {verdictLabel(verdict, type)}
        </span>
        <span className="text-[0.78125rem] leading-(--lead-list) text-fg2">
          {verdictHelp(verdict, type)}
        </span>
      </span>
      <FontAwesomeIcon
        icon={faChevronRight}
        aria-hidden="true"
        className="h-2.5 shrink-0 text-fg3"
      />
    </Button>
  );
}
