import { AUDIT_REASON_MAX } from '@skating/core';
import {
  type ComponentProps,
  cloneElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useState,
} from 'react';

import { ActionBar } from '@/components/kit/action-bar';
import { Badge } from '@/components/kit/badge';
import { buttonVariants } from '@/components/kit/button';
import { DisplayWord } from '@/components/kit/display-word';
import { ItemTimeline, type ItemTimelineEvent } from '@/components/kit/item-timeline';
import { LabelRows } from '@/components/kit/label-rows';
import { Section } from '@/components/kit/section-slug';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';
import { ReasonAsk } from '../../../body/tabs/access/ReasonAsk';
import { dayMonth } from '../../../shell/consoleTime';
import { ListCutLine, listTotalOf } from '../../blocks/listCut';
import { TimelineEventBody } from '../../blocks/TimelineEventBody';
import { InspectorHeadEnd, InspectorHeadTitle } from '../../inspector/InspectorFrame';
import {
  type AccessAct,
  type AccessItem,
  accessBar,
  accessStats,
  accessTimeline,
  bodyKicker,
  hasBar,
  headBadge,
  ifBlocks,
  type TimelineEvent,
} from './accessModel';
import { ACCESS_WORDS as W } from './accessWords';

/**
 * **Board 2.2, drawn from props** — the access handler's three slots for the inspector frame:
 *
 * - **`AccessHead`** — the lane's kicker, the dispute badge, *Open in Body →* (live: the body's
 *   Access tab).
 * - **`AccessBody`** — the body's line and name, the stats, the claims and the ruling as a
 *   timeline; beside them (under them on a narrow page) the map and the two *If* blocks.
 * - **`AccessActions`** — the bar: *No public access* (N, its reason asked in the console's reason
 *   dialog), *Confirm accessible* (C), *Clear the … ruling* (no key). A button is drawn only where
 *   the item's `can` allows it; with none allowed there is no bar. The keys act only while focus is
 *   in the inspector pane (`pane`).
 *
 * No reads, no writes: the container (`useAccessHandler`) binds them. A write's refusal is the
 * shell's toast, never printed here (D268).
 */

export type AccessHandlerProps = {
  item: AccessItem;
  now: number;
  /**
   * The map slot: `ItemMap` in the app (it reads the item's geometry), a still in a story. A map
   * that draws nothing (nothing to place) collapses its slot.
   */
  map: ReactNode;
  /** The link into the body's Access tab: an anchor element (the router's `Link`), unstyled. */
  bodyLink: ReactElement;
  /** Sends a ruling; resolves whether it landed (the reason dialog closes on `true`). */
  onRule: (act: AccessAct, reason?: string) => Promise<boolean>;
  /** The ruling whose write is out, shown on its button. */
  pending: AccessAct | null;
  /** The inspector pane: the bar's keys act only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
  /** The reader's zone, for dates (the page's own by default). */
  timeZone?: string;
};

const KICK = 'text-kick leading-none font-semibold tracking-kick uppercase text-fg3';

// ── Head ─────────────────────────────────────────────────────────────────────────────────────

/** *Open in Body →*: the router's link in the kit's link face. */
function OpenInBody({ link }: { link: ReactElement }) {
  return cloneElement(
    link as ReactElement<ComponentProps<'a'>>,
    {
      'data-slot': 'open-in-body',
      className: cn(buttonVariants({ variant: 'link', size: 'xs' }), 'no-underline'),
      children: (
        <span data-slot="label" className="inline-flex items-center gap-[inherit]">
          {W.openInBody}
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        </span>
      ),
    } as ComponentProps<'a'>,
  );
}

export function AccessHead({ item, bodyLink }: Pick<AccessHandlerProps, 'item' | 'bodyLink'>) {
  const badge = headBadge(item);
  return (
    <>
      <InspectorHeadTitle>{W.lane}</InspectorHeadTitle>
      {/* The badge takes the head's free room, and leaves it whole when the room is short of it
          (a phone's page): the body then shows it over the body's line. Never truncated. */}
      <span
        data-slot="access-head-room"
        className="@container/headroom flex min-w-0 flex-1 items-center self-stretch"
      >
        {badge !== null && (
          <Badge
            data-slot="access-head-badge"
            variant="outline"
            tone={badge.tone}
            className="shrink-0 @max-[9rem]/headroom:hidden"
          >
            {badge.text}
          </Badge>
        )}
      </span>
      <InspectorHeadEnd>
        <OpenInBody link={bodyLink} />
      </InspectorHeadEnd>
    </>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

const MARK: Record<TimelineEvent['kind'], ItemTimelineEvent['mark']> = {
  report: 'bad',
  ruling: 'bright',
  dismissed: 'quiet',
};

export function AccessBody({
  item,
  now,
  map,
  timeZone,
}: Pick<AccessHandlerProps, 'item' | 'now' | 'map' | 'timeZone'>) {
  const stats = accessStats(item, now);
  const badge = headBadge(item);
  const events: ItemTimelineEvent[] = accessTimeline(item).map((e) => ({
    key: e.key,
    date: dayMonth(e.at, timeZone),
    mark: MARK[e.kind],
    children: <TimelineEventBody event={e} />,
  }));
  const ifs = ifBlocks(item, timeZone);
  return (
    <div data-slot="access-handler" className="@container">
      <div className="grid grid-cols-1 @[45rem]:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-(--space-4_5) px-(--space-5) pt-(--space-4) pb-(--space-4_5)">
          {/* The head's badge, on a page too narrow for it there (see `AccessHead`). */}
          {badge !== null && (
            <span className="hidden @max-[30rem]:flex">
              <Badge data-slot="access-body-badge" variant="outline" tone={badge.tone}>
                {badge.text}
              </Badge>
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-(--space-1_5)">
            <span data-slot="access-body-kicker" className={KICK}>
              {bodyKicker(item.body)}
            </span>
            <h2 className="m-0 min-w-0">
              <DisplayWord size="column" className="block truncate">
                {item.body.name}
              </DisplayWord>
            </h2>
          </div>
          <StatGrid columns={stats.length}>
            {stats.map((s) => (
              <StatTile
                key={s.id}
                data-stat={s.id}
                label={s.label}
                value={s.value}
                {...(s.unit !== undefined ? { unit: s.unit } : {})}
                {...(s.tone !== undefined ? { tone: s.tone } : {})}
                {...(s.sub !== undefined ? { sub: s.sub } : {})}
              />
            ))}
          </StatGrid>
          <Section title={W.claimsAndRuling}>
            <ItemTimeline events={events} />
            <ListCutLine
              members={item.reports}
              total={listTotalOf(item, item.reportsCut)}
              noun="reports"
            />
          </Section>
        </div>
        <div className="flex min-w-0 flex-col border-0 border-t-(length:--stroke-hair) border-solid border-line @[45rem]:border-t-0 @[45rem]:border-l-(length:--stroke-hair)">
          {/* Empty when the map draws nothing: the slot and its rule go with it. */}
          <div
            data-slot="access-map"
            className="border-0 border-b-(length:--stroke-hair) border-solid border-line empty:hidden"
          >
            {map}
          </div>
          <div className="flex flex-col gap-(--space-5_5) px-(--space-5) pt-(--space-5_5) pb-(--space-5)">
            <Section title={W.ifNoAccess} data-slot="if-no-access">
              <LabelRows rows={ifs.noAccess} />
            </Section>
            <Section title={W.ifAccessible} data-slot="if-accessible">
              <LabelRows rows={ifs.accessible} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

export function AccessActions({
  item,
  onRule,
  pending,
  pane,
}: Pick<AccessHandlerProps, 'item' | 'onRule' | 'pending' | 'pane'>) {
  const bar = accessBar(item);
  // The reason dialog is opened by state — its button's press or N, which the bar binds like every
  // other key — so the button is a plain bar button, held (disabled) while any ruling is out.
  const [asking, setAsking] = useState(false);
  const busy = pending !== null;
  if (!hasBar(bar)) return null;
  const ruling = [
    ...(bar.noAccess
      ? [
          {
            id: 'none',
            label: W.noPublicAccess,
            hotkey: 'N' as const,
            what: W.whatNoAccess,
            onPress: () => setAsking(true),
            loading: pending === 'none',
            disabled: busy,
          },
        ]
      : []),
    ...(bar.accessible
      ? [
          {
            id: 'open',
            label: W.confirmAccessible,
            hotkey: 'C' as const,
            what: W.whatAccessible,
            onPress: () => void onRule('open'),
            loading: pending === 'open',
            disabled: busy,
          },
        ]
      : []),
  ];
  return (
    <>
      {bar.noAccess && (
        // Its own write in flight keeps it open over the reason until the answer lands.
        <ReasonAsk
          open={asking}
          onOpenChange={setAsking}
          title={W.askTitle(item.body.name)}
          description={W.askDescription}
          confirm={W.noPublicAccess}
          label={W.askLabel}
          // The ruling's reason is its audit row's.
          maxLength={AUDIT_REASON_MAX}
          onConfirm={(reason) => onRule('none', reason)}
        />
      )}
      <ActionBar
        aria-label={W.bar}
        {...(pane !== undefined ? { pane } : {})}
        groups={[
          ...(ruling.length > 0 ? [{ id: 'ruling', label: W.bar, items: ruling }] : []),
          ...(bar.clear !== null
            ? [
                {
                  id: 'clear',
                  items: [
                    {
                      id: 'clear',
                      label: bar.clear,
                      hotkey: null,
                      what: W.whatClear,
                      onPress: () => void onRule('clear'),
                      loading: pending === 'clear',
                      disabled: busy,
                    },
                  ],
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

/** The three slots the inspector frame takes (`InspectorFrame`'s `head`, `actions`, children). */
export function accessSlots(props: AccessHandlerProps): {
  head: ReactNode;
  actions: ReactNode;
  body: ReactNode;
} {
  return {
    head: <AccessHead item={props.item} bodyLink={props.bodyLink} />,
    actions: (
      <AccessActions
        item={props.item}
        onRule={props.onRule}
        pending={props.pending}
        {...(props.pane !== undefined ? { pane: props.pane } : {})}
      />
    ),
    body: (
      <AccessBody
        item={props.item}
        now={props.now}
        map={props.map}
        {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      />
    ),
  };
}
