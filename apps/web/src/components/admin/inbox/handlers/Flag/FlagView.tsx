import type { ReactElement, ReactNode, RefObject } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { PersonLockup } from '@/components/kit/person-lockup';
import { ComingSoonLink } from '@/components/kit/unavailable-button';
import {
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../../inspector/InspectorFrame';
import type { AroundState } from '../../around/AroundLine';
import { AuthorBlock } from '../../blocks/AuthorBlock';
import { FlagBlock } from '../../blocks/FlagBlock';
import { LinkChip } from '../../blocks/LinkChip';
import { listTotalOf } from '../../blocks/listCut';
import { FlagActions } from './FlagActions';
import { allows, flagHead, type HistoryLink, isDown, liveFlags } from './flagModel';
import type { FlagItem } from './flagTypes';
import { ALERT_WORDS as A, FLAG_WORDS as W } from './flagWords';
import { PhotoSubject } from './PhotoSubject';
import { AlsoOnReport, type Retry, SubHead, type WeatherState } from './parts';
import {
  AlertFacts,
  AlertSubject,
  BodySubject,
  CommentSubject,
  ContradictedReports,
  DownNote,
  GoneSubject,
  HazardSubject,
  PostSubject,
  ReportSubject,
  RetractedNote,
  SubjectRow,
  WithdrawnNote,
} from './subjects';
import type { FlagWrite } from './useFlagWrites';

/**
 * **The flag handler, drawn from props** — the frame's three slots for a `flag` item: the pane
 * `head`, the bar (`actions`), the scrolling `body`, and the decided state the frame locks on. No
 * reads and no writes here: the container (`FlagHandler`) binds them, and the stories pass fixtures.
 *
 * The body is the subject (one view per target kind), then the flags and the author side by side
 * (2.1) — a flag on a person leads with the person; an alert puts the flag under its card and its
 * facts under its life (2.6).
 */

export type FlagSlots = {
  head: ReactNode;
  actions: ReactNode;
  body: ReactNode;
};

export type FlagViewProps = {
  item: FlagItem;
  now: number;
  timeZone?: string;
  /** *That night, at the body* — a report in the Safety lane. */
  weather?: WeatherState;
  /** *Around it* — a report in the Safety lane. */
  around?: AroundState;
  onCompare?: () => void;
  /** *Try again* for a failed context read. */
  retry?: Retry;
  /** The Inbox map embed for this subject (W3's `InboxMap`), when it has a place. */
  map?: ReactNode;
  onWrite: (write: FlagWrite) => Promise<boolean>;
  /** The inspector pane the bar's keys act in. */
  pane?: RefObject<HTMLElement | null>;
  /** The author menu control (`inspector/AuthorMenu`), drawn in the bar. */
  authorMenu?: ReactNode;
  /**
   * The Body console's link for a body, as the handler builds it — the router's, with the way back
   * (every handler's *Open in Body →* is built so, and drawn through `blocks/LinkChip`).
   */
  bodyLink: (waterBodyId: string) => ReactElement;
};

/** The People page's address for a person. */
const peopleHref = (userId: string) => `/admin/people/${userId}`;

/** The frame's slots. A decided item's bar is dropped by the frame itself (D283). */
export function flagSlots(props: FlagViewProps): FlagSlots {
  const { item } = props;
  return {
    head: <FlagHeadView {...props} />,
    actions: (
      <FlagActions
        item={item}
        onWrite={props.onWrite}
        {...(props.pane !== undefined && { pane: props.pane })}
        {...(props.authorMenu !== undefined &&
          !(item.target.exists && item.target.targetType === 'accessAlert') && {
            author: props.authorMenu,
          })}
      />
    ),
    body: <FlagBodyView {...props} />,
  };
}

/** The pane head: what kind of flag, the Safety badge, the age written out, the history link. */
export function FlagHeadView({ item, now, bodyLink }: FlagViewProps) {
  const head = flagHead(item, now);
  return (
    <span data-slot="flag-head" className="contents">
      <InspectorHeadTitle>{head.title}</InspectorHeadTitle>
      {head.safety && (
        <Badge variant="outline" tone="bad" data-slot="flag-head-safety">
          {W.safetyBadge}
        </Badge>
      )}
      <span data-slot="flag-head-sub" className="contents">
        <InspectorHeadAge>{head.sub}</InspectorHeadAge>
      </span>
      {head.link !== null && (
        <InspectorHeadEnd>
          <HistoryLinkView link={head.link} bodyLink={bodyLink} />
        </InspectorHeadEnd>
      )}
    </span>
  );
}

function HistoryLinkView({
  link,
  bodyLink,
}: {
  link: HistoryLink;
  bodyLink: FlagViewProps['bodyLink'];
}) {
  switch (link.kind) {
    case 'reports':
      return <ComingSoonLink data-slot="flag-history">{W.openInReports}</ComingSoonLink>;
    case 'people':
      return (
        <Button
          variant="link"
          size="xs"
          data-slot="flag-history"
          nativeButton={false}
          render={<a href={peopleHref(link.userId)} />}
        >
          {W.openInPeople}
        </Button>
      );
    case 'body':
      return (
        <LinkChip link={bodyLink(link.waterBodyId)} label={W.openInBody} slot="flag-history" />
      );
  }
}

/** The scrolling body: the subject, then the flags and the author. */
export function FlagBodyView({
  item,
  now,
  timeZone,
  weather,
  around,
  onCompare,
  retry,
  map,
  pane,
}: FlagViewProps) {
  const { target } = item;
  const safety = item.lane === 'safety';
  const down = isDown(target);
  const withdrawnAt = target.exists ? target.withdrawnAt : null;
  // An alert its author took down: its retraction's moment (null when the life doesn't record it).
  const retractedAt =
    target.exists && target.targetType === 'accessAlert' && target.alert.status === 'retracted'
      ? (target.alert.life.filter((e) => e.event === 'retracted').at(-1)?.at ?? null)
      : undefined;
  const flags = (extra?: ReactNode, bare = false) => (
    <FlagBlock
      bare={bare}
      flags={item.flags}
      total={listTotalOf(item, item.flagsCut)}
      targetType={target.targetType}
      now={now}
      {...(target.exists && target.targetType === 'hazard' && { hazardType: target.hazard.type })}
      {...(timeZone !== undefined && { timeZone })}
    >
      {extra}
    </FlagBlock>
  );
  const author =
    item.author === null ? null : (
      <AuthorBlock
        author={item.author}
        ownFlags={item.flags.filter((f) => f.status === 'open').length}
        {...(timeZone !== undefined && { timeZone })}
      />
    );
  const two = (left: ReactNode, right: ReactNode) => (
    <div
      data-slot="flag-columns"
      className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5) px-gutter pt-(--space-5) @[45rem]:grid-cols-2"
    >
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );

  let subject: ReactNode;
  let under: ReactNode = two(flags(), author);
  if (!target.exists) {
    subject = <GoneSubject />;
  } else {
    switch (target.targetType) {
      case 'report':
        subject = (
          <ReportSubject
            report={target.report}
            safety={safety}
            {...(weather !== undefined && { weather })}
            {...(around !== undefined && { around })}
            {...(onCompare !== undefined && { onCompare })}
            {...(retry !== undefined && { retry })}
            {...(map !== undefined && { map })}
            {...(timeZone !== undefined && { timeZone })}
          />
        );
        under = two(
          flags(
            <AlsoOnReport
              ratings={target.report.ratings}
              corroborations={target.report.corroborations}
            />,
          ),
          author,
        );
        break;
      case 'post':
        subject = (
          <PostSubject
            down={down !== null}
            post={target.post}
            safety={safety}
            {...(timeZone !== undefined && { timeZone })}
          />
        );
        break;
      case 'comment':
        subject = (
          <CommentSubject
            comment={target.comment}
            down={down !== null}
            {...(timeZone !== undefined && { timeZone })}
          />
        );
        break;
      case 'hazard':
        subject = (
          <HazardSubject
            down={down !== null}
            hazard={target.hazard}
            {...(map !== undefined && { map })}
            {...(timeZone !== undefined && { timeZone })}
          />
        );
        break;
      case 'accessAlert': {
        const flaggers = liveFlags(item.flags)
          .map((f) => f.filer?.displayName.split(/\s+/u)[0])
          .filter((n): n is string => n !== undefined);
        const does = [
          ...(allows(item.can, 'pin') ? [{ label: W.pin, value: A.does.pin }] : []),
          ...(allows(item.can, 'unpin') ? [{ label: W.unpin, value: A.does.unpin }] : []),
          ...(allows(item.can, 'retract') ? [{ label: W.retract, value: A.does.retract }] : []),
          ...(allows(item.can, 'dismiss')
            ? [
                {
                  label: W.dismiss,
                  value: A.does.dismiss(flaggers.length === 1 ? (flaggers[0] ?? '') : ''),
                },
              ]
            : []),
        ];
        subject = (
          <AlertSubject
            alert={target.alert}
            summary={target.summary}
            flags={
              <div className="flex flex-col gap-(--space-2)">
                <SubHead>{A.theFlag}</SubHead>
                {flags(undefined, true)}
              </div>
            }
            {...(map !== undefined && { map })}
            now={now}
            {...(timeZone !== undefined && { timeZone })}
          />
        );
        under = (
          <AlertFacts
            alert={target.alert}
            author={
              item.author === null || item.author.person.deleted ? (
                <span className="text-fg3">{W.departed}</span>
              ) : (
                <PersonLockup
                  size="md"
                  name={item.author.person.displayName}
                  {...(item.author.person.username !== '' && {
                    handle: item.author.person.username,
                  })}
                />
              )
            }
            does={does}
          />
        );
        break;
      }
      case 'user':
        // A flag on a person: the person leads; no content levers.
        subject = (
          <SubjectRow data-subject="user">
            <AuthorBlock
              author={target.person}
              title={W.thePerson}
              ownFlags={item.flags.filter((f) => f.status === 'open').length}
              {...(timeZone !== undefined && { timeZone })}
            />
            <ContradictedReports author={target.person} timeZone={timeZone} />
          </SubjectRow>
        );
        under = (
          <div className="px-gutter pt-(--space-5)">
            <FlagBlock
              flags={item.flags}
              total={listTotalOf(item, item.flagsCut)}
              targetType={target.targetType}
              now={now}
              counted={target.person.contradicted}
              {...(timeZone !== undefined && { timeZone })}
            />
          </div>
        );
        break;
      case 'photo':
        // Board 2.7: the stage, then the flag and the uploader as 2.1 draws them. Keyed by the photo,
        // so a reveal never carries to another item's photo.
        subject = (
          <PhotoSubject
            key={target.photo.photoId}
            target={target}
            {...(pane !== undefined && { pane })}
            timeZone={timeZone}
          />
        );
        break;
      case 'waterbody':
        subject = (
          <BodySubject
            body={target.body}
            summary={target.summary}
            {...(map !== undefined && { map })}
          />
        );
        under = <div className="px-gutter pt-(--space-5)">{flags()}</div>;
        break;
      default: {
        // Every subject the server sends is drawn above: a new one is a type error here.
        const unknown: never = target;
        void unknown;
        subject = null;
        break;
      }
    }
  }

  return (
    <div data-slot="flag-body" data-lane={item.lane} className="@container flex min-w-0 flex-col">
      {withdrawnAt !== null ? (
        // Withdrawn outranks down: nothing brings it back, so the down note's Restore line would lie.
        <div className="px-gutter pt-(--space-4)">
          <WithdrawnNote
            at={withdrawnAt}
            // The server pairs the two (`withdrawal` is null exactly when `withdrawnAt` is); a
            // withdrawal it couldn't name reads as the author's delete, the only other cause.
            withdrawal={(target.exists ? target.withdrawal : null) ?? 'deleted'}
            timeZone={timeZone}
          />
        </div>
      ) : retractedAt !== undefined ? (
        <div className="px-gutter pt-(--space-4)">
          <RetractedNote at={retractedAt} timeZone={timeZone} />
        </div>
      ) : (
        down !== null && (
          <div className="px-gutter pt-(--space-4)">
            <DownNote status={down} />
          </div>
        )
      )}
      {subject}
      {under}
    </div>
  );
}
