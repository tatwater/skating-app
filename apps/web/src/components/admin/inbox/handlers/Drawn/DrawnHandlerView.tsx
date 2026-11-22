import { MAX_REQUEST_NOTE_LENGTH, MERGE_SUGGEST_SHARE } from '@skating/core';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useState,
} from 'react';

import { ActionBar, type ActionBarItem } from '@/components/kit/action-bar';
import { LabelRows } from '@/components/kit/label-rows';
import { Note, Quote } from '@/components/kit/note';
import { OverlapGauge } from '@/components/kit/overlap-gauge';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import { ToolbarItem } from '@/components/kit/toolbar';
import {
  COMING_SOON,
  ComingSoonLink,
  UnavailableButton,
} from '@/components/kit/unavailable-button';
import { ReasonAsk } from '../../../body/tabs/access/ReasonAsk';
import { dayMonth } from '../../../shell/consoleTime';
import { LinkChip } from '../../blocks/LinkChip';
import { skateWords } from '../../blocks/skateWords';
import {
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../inspector/InspectorFrame';
import {
  type DrawnItem,
  drawnBar,
  hasBar,
  headLine,
  MERGE_PERCENT,
  mergeRows,
  refusalSaid,
  standingLine,
} from './drawnModel';
import { DRAWN_WORDS as W } from './drawnWords';
import type { DrawnAct } from './useDrawnWrites';

/**
 * **Board 2.5, drawn from props** — the drawn handler's three slots for the inspector frame:
 *
 * - **Head** — *Drawn body*, where it came from and its age, *Open in Body →* (live: the drawing's
 *   own Body console).
 * - **Body** — the map (the drawing dashed over the body it overlaps); the overlap gauge, from the
 *   server's share; the report it came from and who drew it; *If merged into ‹body›*, which says
 *   what a merge does and that it is not here yet — never an offer to do it.
 * - **Bar** — *Merge into ‹body›* drawn as *Coming soon* (D286), with no key until it does something, *Approve as new* (A),
 *   *Reject* (R, its reason asked: the drawer reads it). Each only where `can` allows its verb.
 *
 * No reads, no writes: the container binds them. A refusal is the shell's toast (D268).
 */

export type DrawnHandlerProps = {
  item: DrawnItem;
  now: number;
  /** The map slot: `ItemMap` in the app, a still in a story; a map that draws nothing collapses it. */
  map: ReactNode;
  /** The link into the drawing's Body console: an anchor element (the router's `Link`), unstyled. */
  bodyLink: ReactElement;
  onApprove: () => Promise<boolean>;
  /** Sends the rejection with its reason; resolves whether it landed (the dialog closes on `true`). */
  onReject: (reason: string) => Promise<boolean>;
  pending: DrawnAct | null;
  /** The inspector pane: the bar's keys act only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
  timeZone?: string;
};

// ── Head ─────────────────────────────────────────────────────────────────────────────────────

export function DrawnHead({
  item,
  now,
  bodyLink,
}: Pick<DrawnHandlerProps, 'item' | 'now' | 'bodyLink'>) {
  return (
    <>
      <InspectorHeadTitle>{W.title}</InspectorHeadTitle>
      <InspectorHeadAge>{headLine(item, now)}</InspectorHeadAge>
      <InspectorHeadEnd>
        <LinkChip link={bodyLink} label={W.openInBody} slot="open-in-body" />
      </InspectorHeadEnd>
    </>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

function Part({ children, ...props }: ComponentProps<'div'>) {
  return (
    <div className="px-(--space-5) pt-(--space-5_5)" {...props}>
      {children}
    </div>
  );
}

export function DrawnBody({
  item,
  map,
  timeZone,
}: Pick<DrawnHandlerProps, 'item' | 'map' | 'timeZone'>) {
  const said = refusalSaid(item);
  const drawer = item.drawer;
  const report = item.fromReport;
  return (
    <div data-slot="drawn-handler" className="@container">
      {/* Empty when the map draws nothing: the slot and its rule go with it. */}
      <div
        data-slot="drawn-map"
        className="border-0 border-b-(length:--stroke-hair) border-solid border-line empty:hidden"
      >
        {map}
      </div>
      {said !== null && (
        <Part data-slot="drawn-refusal">
          <Note>{said}</Note>
        </Part>
      )}
      <Part>
        <Section title={W.overlap} data-slot="drawn-overlap">
          {item.overlap !== null ? (
            <OverlapGauge
              share={item.overlap.share}
              threshold={MERGE_SUGGEST_SHARE}
              reached={item.overlap.suggested}
              sub={W.ofTheDrawingIs(item.overlap.body.name)}
              thresholdLabel={W.mergeSuggestedFrom(MERGE_PERCENT)}
            />
          ) : (
            <p data-slot="drawn-no-overlap" className="m-0 text-row leading-body text-fg2">
              {W.noOverlap}
            </p>
          )}
        </Section>
      </Part>
      <Part className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5_5) px-(--space-5) pt-(--space-5_5) @[40rem]:grid-cols-2">
        <Section title={W.theReport} data-slot="drawn-report">
          <div className="flex min-w-0 flex-col gap-(--space-2)">
            {report === null ? (
              <p className="m-0 text-row leading-body text-fg3">{W.noReportLinked}</p>
            ) : (
              <div className="flex min-w-0 flex-col items-start gap-(--space-2)">
                {report.excerpt !== null ? (
                  // An excerpt as the server cut it (its own ellipsis), never the whole report.
                  <Quote data-slot="drawn-report-excerpt" className="self-stretch">
                    “{report.excerpt}”
                  </Quote>
                ) : (
                  <p
                    data-slot="drawn-report-withheld"
                    className="m-0 text-row leading-body text-fg3"
                  >
                    {W.excerptWithheld}
                  </p>
                )}
                {/* The report lives in Reports, which isn't built (D286). */}
                <ComingSoonLink data-slot="drawn-open-report">{W.openInReports}</ComingSoonLink>
              </div>
            )}
            <LabelRows
              rows={[
                {
                  label: W.user,
                  value:
                    drawer === null || drawer.deleted ? (
                      <span className="text-fg3">{W.drawerGone}</span>
                    ) : (
                      <PersonLockup
                        size="md"
                        name={drawer.displayName}
                        {...(drawer.username !== '' ? { handle: drawer.username } : {})}
                      />
                    ),
                },
                { label: W.trust, value: standingLine(drawer, item.drawerReports) },
                ...(item.skate !== null
                  ? [{ label: W.skate, value: skateWords(item.skate, timeZone) }]
                  : report !== null
                    ? [{ label: W.skated, value: dayMonth(report.skateEndTime, timeZone) }]
                    : []),
              ]}
            />
          </div>
        </Section>
        {item.overlap !== null && (
          <Section title={W.ifMergedInto(item.overlap.body.name)} data-slot="drawn-if-merged">
            <LabelRows
              rows={[
                ...mergeRows(item.overlap.body.name),
                {
                  label: W.rowHere,
                  value: <span data-slot="drawn-merge-not-here">{W.mergeNotHere}</span>,
                },
              ]}
            />
          </Section>
        )}
      </Part>
    </div>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

/** *Merge into ‹body›*: the bar's button, in the kit's unavailable face — it says *Coming soon*. */
function MergeComingSoon({ name }: { name: string }) {
  return (
    <ToolbarItem
      data-slot="drawn-merge"
      render={({ children, ...props }) => (
        <UnavailableButton {...props} variant="outline" title={COMING_SOON} what={W.whatMerge}>
          {children}
        </UnavailableButton>
      )}
    >
      {W.mergeInto(name)}
    </ToolbarItem>
  );
}

export function DrawnActions({
  item,
  onApprove,
  onReject,
  pending,
  pane,
}: Pick<DrawnHandlerProps, 'item' | 'onApprove' | 'onReject' | 'pending' | 'pane'>) {
  const bar = drawnBar(item);
  const [asking, setAsking] = useState(false);
  const busy = pending !== null;
  if (!hasBar(bar)) return null;
  const items: ActionBarItem[] = [
    ...(bar.merge !== null
      ? [{ kind: 'control' as const, id: 'merge', control: <MergeComingSoon name={bar.merge} /> }]
      : []),
    ...(bar.approve
      ? [
          {
            id: 'approve',
            label: W.approveAsNew,
            what: W.whatApprove,
            onPress: () => void onApprove(),
            loading: pending === 'approve',
            disabled: busy,
          },
        ]
      : []),
    ...(bar.reject
      ? [
          {
            id: 'reject',
            label: W.reject,
            what: W.whatReject,
            onPress: () => setAsking(true),
            danger: true,
            loading: pending === 'reject',
            disabled: busy,
          },
        ]
      : []),
  ];
  return (
    <>
      {bar.reject && (
        <ReasonAsk
          open={asking}
          onOpenChange={setAsking}
          title={W.rejectTitle(item.body.name)}
          description={W.rejectDescription}
          confirm={W.reject}
          label={W.rejectLabel}
          // The drawer reads it, as an asker reads a decline's note: core's cap on such a note.
          maxLength={MAX_REQUEST_NOTE_LENGTH}
          onConfirm={onReject}
        />
      )}
      <ActionBar
        data-slot="drawn-actions"
        aria-label={W.bar}
        {...(pane !== undefined ? { pane } : {})}
        groups={[{ id: 'drawn', items }]}
      />
    </>
  );
}

/** The three slots the inspector frame takes. */
export function drawnSlots(props: DrawnHandlerProps): {
  head: ReactNode;
  actions: ReactNode;
  body: ReactNode;
} {
  return {
    head: <DrawnHead item={props.item} now={props.now} bodyLink={props.bodyLink} />,
    actions: (
      <DrawnActions
        item={props.item}
        onApprove={props.onApprove}
        onReject={props.onReject}
        pending={props.pending}
        {...(props.pane !== undefined ? { pane: props.pane } : {})}
      />
    ),
    body: (
      <DrawnBody
        item={props.item}
        map={props.map}
        {...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {})}
      />
    ),
  };
}
