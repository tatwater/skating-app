import { MAX_REQUEST_NOTE_LENGTH } from '@skating/core';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useState,
} from 'react';

import { ActionBar, type ActionBarItem } from '@/components/kit/action-bar';
import { Badge } from '@/components/kit/badge';
import { CompareTable } from '@/components/kit/compare-table';
import { DisplayWord } from '@/components/kit/display-word';
import { LabelRows } from '@/components/kit/label-rows';
import { Note } from '@/components/kit/note';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';
import { ReasonAsk } from '../../../body/tabs/access/ReasonAsk';
import { formatDistance } from '../../../body/tabs/places/placesModel';
import { LinkChip } from '../../blocks/LinkChip';
import { ListCutLine, listTotalOf } from '../../blocks/listCut';
import { shownName } from '../../blocks/shownName';
import { ComingSoonLink } from '../../inspector/ComingSoonLink';
import {
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../inspector/InspectorFrame';
import { AskList, AskWords } from '../asks/AskList';
import { trustLine } from '../Drawn/drawnModel';
import { dayTime } from '../Flag/flagFormat';
import {
  askedName,
  askerStanding,
  bodyLine,
  compareRows,
  fromReport,
  hasBar,
  headAge,
  headTitle,
  ifApproved,
  ifDeclined,
  ifDrawn,
  ifSamePlace,
  landmarkHistory,
  landmarkLookalike,
  lookalikeHead,
  matchChips,
  type PlaceItem,
  placeBar,
  pointText,
  primaryAsk,
  proposalLookalike,
  refusalSaid,
} from './placeModel';
import { PLACE_WORDS as W } from './placeWords';
import type { PlaceAct } from './usePlaceWrites';

/**
 * **Board 2.4, drawn from props** — the place handler's three slots for the inspector frame:
 *
 * - **Head** — *Name a landmark* (or *Name a bay*), its age, and *Open in Reports →* (Coming soon,
 *   D286) for an ask from a report's *where*, else *Open in Body →* (the body's Places tab).
 * - **Body** — the body and the name asked for, where and who asked (one asker as the board's rows;
 *   several as the shared ask list), the map; for a landmark ask, *Same place?* — the ask against
 *   its lookalike in the compare table — then the two futures.
 * - **Bar** — *Same place* (S), *Approve* (A), *Draw in Body →* (B, the old editor in a new tab),
 *   *Decline* (D, its note asked: the asker reads it). Each only where the item's `can` allows it.
 *
 * No reads, no writes: the container binds them. A refusal is the shell's toast (D268).
 */

export type PlaceHandlerProps = {
  item: PlaceItem;
  now: number;
  /** The map slot: `ItemMap` in the app, a still in a story; a map that draws nothing collapses it. */
  map: ReactNode;
  /** The body's Places tab: an anchor element (the router's `Link`), unstyled. */
  bodyLink: ReactElement;
  /** The old editor, where a landmark is placed until the console's landmark tools land (B01-6b). */
  editorHref: string;
  /**
   * Draw the place in the Body console instead (B01-6a: a bay ask, `?task=`), in this tab — the
   * console's own page; the save comes back to this item. Absent: the old editor, in a new tab.
   */
  onDraw?: () => void;
  onSamePlace: (l: NonNullable<ReturnType<typeof landmarkLookalike>>) => Promise<boolean>;
  onApprove: () => Promise<boolean>;
  /** Sends the decline with its note; resolves whether it landed (the dialog closes on `true`). */
  onDecline: (note: string) => Promise<boolean>;
  pending: PlaceAct | null;
  /** The inspector pane: the bar's keys act only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
  timeZone?: string;
};

const KICK = 'text-kick leading-none font-semibold tracking-kick uppercase text-fg3';

// ── Head ─────────────────────────────────────────────────────────────────────────────────────

export function PlaceHead({
  item,
  now,
  bodyLink,
}: Pick<PlaceHandlerProps, 'item' | 'now' | 'bodyLink'>) {
  return (
    <>
      <InspectorHeadTitle>{headTitle(item)}</InspectorHeadTitle>
      <InspectorHeadAge>{headAge(item, now)}</InspectorHeadAge>
      <InspectorHeadEnd>
        {fromReport(item) ? (
          <ComingSoonLink data-slot="open-in-reports">{W.openInReports}</ComingSoonLink>
        ) : (
          <LinkChip link={bodyLink} label={W.openInBody} slot="open-in-body" />
        )}
      </InspectorHeadEnd>
    </>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

function Part({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-(--space-5) pt-(--space-5_5)', className)} {...props} />;
}

function Asker({ ask }: { ask: NonNullable<ReturnType<typeof primaryAsk>> }) {
  const p = ask.asker;
  const name = shownName(p);
  return p === null || name === null ? (
    <span className="text-fg3">{W.formerSkater}</span>
  ) : (
    <PersonLockup size="md" name={name} {...(p.username !== '' ? { handle: p.username } : {})} />
  );
}

export function PlaceBody({
  item,
  now,
  map,
  timeZone,
}: Pick<PlaceHandlerProps, 'item' | 'now' | 'map' | 'timeZone'>) {
  const ask = primaryAsk(item);
  const said = refusalSaid(item);
  const landmark = item.placeKind === 'name_landmark';
  const lookalike = landmark ? landmarkLookalike(item) : null;
  const proposal = landmark ? proposalLookalike(item) : null;
  const answered =
    item.placeKind === 'name_bay'
      ? item.drawnSubAreaId !== null
      : item.answeringLandmarkId !== null;
  const several = item.asks.length > 1;
  const futures = [
    ...(lookalike !== null && ask !== null
      ? [{ key: 'same', title: W.ifSamePlace, rows: ifSamePlace(ask) }]
      : []),
    answered
      ? { key: 'approved', title: W.ifApproved, rows: ifApproved(item) }
      : { key: 'drawn', title: W.ifDrawn, rows: ifDrawn() },
    { key: 'declined', title: W.ifDeclined, rows: ifDeclined(item) },
  ].slice(0, 2);
  const where = ask?.fromReport ?? null;
  return (
    <div data-slot="place-handler" className="@container">
      <div className="grid grid-cols-1 border-0 border-b-(length:--stroke-hair) border-solid border-line @[45rem]:grid-cols-[minmax(0,1fr)_23.75rem]">
        <div className="flex min-w-0 flex-col gap-(--space-3) px-(--space-5) pt-(--space-4) pb-(--space-4_5)">
          <div className="flex min-w-0 flex-col gap-(--space-1_5)">
            <span data-slot="place-body-line" className={KICK}>
              {bodyLine(item.body)}
            </span>
            <h2 className="m-0 min-w-0">
              <DisplayWord size="column" className="block truncate">
                “{askedName(item)}”
              </DisplayWord>
            </h2>
          </div>
          {ask !== null && where !== null && (
            <Note data-slot="place-from-where">
              {W.fromWhere(
                shownName(ask.asker) ?? W.formerSkater,
                dayTime(where.skateEndTime, timeZone),
              )}{' '}
              {where.where !== null && <strong>“{where.where}”</strong>}
            </Note>
          )}
          {ask !== null && (
            <LabelRows
              rows={[
                {
                  label: W.where,
                  value: (
                    <span className="font-(family-name:--family-mono) text-mono-sm tabular-nums">
                      {pointText(ask.coord)}
                    </span>
                  ),
                },
                ...(several
                  ? []
                  : [
                      { label: W.user, value: <Asker ask={ask} /> },
                      { label: W.trust, value: askerStanding(ask, trustLine(ask.asker)) },
                    ]),
              ]}
            />
          )}
          {/* One ask served: what the list's row would say of it — its note and its skate, drawn the
              same way — and, when it is one of more, how many of how many. */}
          {ask !== null && !several && (
            <div data-slot="place-ask-words" className="flex min-w-0 flex-col gap-(--space-1_5)">
              <AskWords ask={ask} timeZone={timeZone} />
              <ListCutLine
                members={item.asks}
                total={listTotalOf(item, item.asksCut)}
                noun="asks"
              />
            </div>
          )}
        </div>
        {/* Empty when the map draws nothing: the slot and its rule go with it. */}
        <div
          data-slot="place-map"
          className="min-w-0 border-0 border-t-(length:--stroke-hair) border-solid border-line empty:hidden @[45rem]:border-t-0 @[45rem]:border-l-(length:--stroke-hair)"
        >
          {map}
        </div>
      </div>
      {said !== null && (
        <Part data-slot="place-refusal">
          <Note>{said}</Note>
        </Part>
      )}
      {several && (
        <Part>
          <Section
            title={W.askedBy}
            count={{ count: item.memberCount, capped: item.memberCountIsFloor }}
            data-slot="place-asks"
          >
            <AskList
              asks={item.asks}
              now={now}
              total={listTotalOf(item, item.asksCut)}
              // Each asker's landmark history where it is served (the read serves the first few).
              rowMeta={(a) =>
                shownName(a.asker) === null ? null : landmarkHistory(a.landmarkAsks)
              }
            />
          </Section>
        </Part>
      )}
      {landmark && (
        <Part>
          <Section
            title={W.samePlace}
            data-slot="place-same"
            {...(lookalike !== null && ask !== null
              ? {
                  end: (
                    <span className="flex gap-(--space-1_5)">
                      {matchChips(ask, lookalike).map((c) => (
                        <Badge key={c.text} variant="outline" tone={c.tone}>
                          {c.text}
                        </Badge>
                      ))}
                    </span>
                  ),
                }
              : {})}
          >
            <div className="flex min-w-0 flex-col gap-(--space-3)">
              {lookalike !== null && ask !== null ? (
                <CompareTable
                  aria-label={W.samePlace}
                  columns={[
                    { label: W.theAsk, tone: 'lit' },
                    { label: lookalikeHead(lookalike), tone: 'warn' },
                  ]}
                  rows={compareRows(ask, lookalike)}
                />
              ) : (
                <p className="m-0 text-row leading-body text-fg2">{W.noLookalike}</p>
              )}
              {proposal !== null && (
                <p data-slot="place-proposal" className="m-0 text-row leading-body text-fg2">
                  {W.anotherAsk(proposal.name, formatDistance(proposal.meters))}
                </p>
              )}
            </div>
          </Section>
        </Part>
      )}
      <Part className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5_5) @[40rem]:grid-cols-2">
        {futures.map((f) => (
          <Section key={f.key} title={f.title} data-slot={`place-if-${f.key}`}>
            <LabelRows rows={f.rows} />
          </Section>
        ))}
      </Part>
    </div>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

export function PlaceActions({
  item,
  editorHref,
  onDraw,
  onSamePlace,
  onApprove,
  onDecline,
  pending,
  pane,
}: Pick<
  PlaceHandlerProps,
  'item' | 'editorHref' | 'onDraw' | 'onSamePlace' | 'onApprove' | 'onDecline' | 'pending' | 'pane'
>) {
  const bar = placeBar(item);
  const [asking, setAsking] = useState(false);
  const busy = pending !== null;
  if (!hasBar(bar)) return null;
  const same = bar.samePlace;
  const items: ActionBarItem[] = [
    ...(same !== null
      ? [
          {
            id: 'same',
            label: W.samePlaceButton,
            what: W.whatSamePlace,
            onPress: () => void onSamePlace(same),
            loading: pending === 'samePlace',
            disabled: busy,
          },
        ]
      : []),
    ...(bar.approve
      ? [
          {
            id: 'approve',
            label: W.approve,
            what: W.whatApprove,
            onPress: () => void onApprove(),
            loading: pending === 'approve',
            disabled: busy,
          },
        ]
      : []),
    ...(bar.draw
      ? [
          {
            id: 'draw',
            label: `${W.drawInBody} →`,
            hotkey: 'B' as const,
            what: onDraw !== undefined ? W.whatDrawInBody : W.whatDraw,
            // The Body console is the console's own page: this tab. The old editor is outside it:
            // a new tab (the console's link rule).
            onPress: () =>
              onDraw !== undefined ? onDraw() : void window.open(editorHref, '_blank', 'noopener'),
          },
        ]
      : []),
    ...(bar.decline
      ? [
          {
            id: 'decline',
            label: W.decline,
            what: W.whatDecline,
            onPress: () => setAsking(true),
            danger: true,
            loading: pending === 'decline',
            disabled: busy,
          },
        ]
      : []),
  ];
  return (
    <>
      {bar.decline && (
        <ReasonAsk
          open={asking}
          onOpenChange={setAsking}
          title={W.declineTitle(askedName(item))}
          description={W.declineDescription}
          confirm={W.decline}
          label={W.declineLabel}
          // The asker reads it: core's cap on a decline's note, which the write refuses past.
          maxLength={MAX_REQUEST_NOTE_LENGTH}
          onConfirm={onDecline}
        />
      )}
      <ActionBar
        data-slot="place-actions"
        aria-label={W.bar}
        {...(pane !== undefined ? { pane } : {})}
        groups={[{ id: 'place', items }]}
      />
    </>
  );
}

/** The three slots the inspector frame takes. */
export function placeSlots(props: PlaceHandlerProps): {
  head: ReactNode;
  actions: ReactNode;
  body: ReactNode;
} {
  return {
    head: <PlaceHead item={props.item} now={props.now} bodyLink={props.bodyLink} />,
    actions: (
      <PlaceActions
        item={props.item}
        editorHref={props.editorHref}
        {...(props.onDraw !== undefined ? { onDraw: props.onDraw } : {})}
        onSamePlace={props.onSamePlace}
        onApprove={props.onApprove}
        onDecline={props.onDecline}
        pending={props.pending}
        {...(props.pane !== undefined ? { pane: props.pane } : {})}
      />
    ),
    body: (
      <PlaceBody
        item={props.item}
        now={props.now}
        map={props.map}
        {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      />
    ),
  };
}
