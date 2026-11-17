import type { ComponentProps, ReactNode } from 'react';
import {
  FirstSkatedTile,
  IceWatchTile,
  ImageryTile,
  NOT_RECORDED,
  type SeasonPending,
  WinterTile,
} from '@/components/admin/season/SeasonTiles';
import { SentinelLows } from '@/components/admin/season/SentinelLows';
import type {
  FirstSkate,
  IceWatch,
  ImageryState,
  RegionWinter,
} from '@/components/admin/season/seasonFacts';
import type { LowsState } from '@/components/admin/season/sentinelLowsModel';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { AuditFeed } from './AuditFeed';
import { CostSection, MonthlySpend } from './CostPanel';
import { CorpusCard, InboxCard, MachineryCard, PeopleCard } from './OverviewCards';
import type {
  CorpusCardData,
  CostData,
  FeedRow,
  FeedTarget,
  InboxCardData,
  MachineryCardData,
  PeopleCardData,
} from './overviewData';
import { type LinkTo, OverviewLinkProvider } from './overviewLinks';

/**
 * The Overview's Home tab: what needs a person. The season's stat strip, the four count cards
 * (Inbox by lane, Corpus by task, Machinery, People), the sentinels' overnight lows (the Seasons
 * board's row, B01-2b), then cost beside the audit feed — the lower half runs to the foot of the
 * page, at least its board height, the feed scrolling inside it.
 *
 * Props, not Convex: the route (or `useOverviewHome`) reads and passes each block its view model,
 * and a block still loading is `undefined` and holds its place. Links go through `linkTo`, so the
 * router stays the integrator's.
 */

/**
 * Each block's view model: `undefined` while its read loads (the block holds its place), `null`
 * where nothing records it (the block says *Not recorded yet* — cost, and whatever a read returns
 * as `null`). The season's four also take `SeasonPending` from 1 July to
 * 30 September: the new season, empty, saying when its record begins.
 */
export interface OverviewHomeData {
  watch?: IceWatch | SeasonPending | null | undefined;
  winter?: RegionWinter | SeasonPending | null | undefined;
  imagery?: ImageryState | SeasonPending | null | undefined;
  firstSkate?: FirstSkate | SeasonPending | null | undefined;
  cost?: CostData | null | undefined;
  inbox?: InboxCardData | undefined;
  corpus?: CorpusCardData | undefined;
  /** `'withheld'` from a viewer who can't read Machinery (admin only): the card is left out. */
  machinery?: MachineryCardData | null | undefined | 'withheld';
  people?: PeopleCardData | undefined;
  /**
   * The sentinels' overnight lows (`sentinelLows.forSeason`) in its four answers; `'withheld'` from
   * a viewer the read's capability leaves out (D275's one line) — the row is then simply absent.
   * Absent (a story or test that doesn't draw it) leaves it out too.
   */
  lows?: LowsState | 'withheld' | undefined;
  feed?: readonly FeedRow[] | undefined;
}

type OverviewHomeProps = Omit<ComponentProps<'div'>, 'children'> & {
  data: OverviewHomeData;
  /** The instant every age and clock word is read against. */
  now: number;
  /** The audit feed's live mark (`LiveMark`), wired by whoever knows the connection. */
  live?: ReactNode;
  /** Opens a feed row's target. */
  onOpenTarget?: (target: FeedTarget) => void;
  /** Every link on Home, through the router (default: plain anchors to the console's routes). */
  linkTo?: LinkTo;
};

/**
 * The board's columns, shared by the cards and the lower half: each card's width follows its
 * content so each has the same room to spare, and the lower half sits on the same lines.
 */
const COLUMNS = 'grid grid-cols-[238fr_298fr_328fr_323fr] gap-x-[2.25rem]';

export function OverviewHome({
  data,
  now,
  live,
  onOpenTarget,
  linkTo,
  className,
  ...props
}: OverviewHomeProps) {
  return (
    <OverviewLinkProvider linkTo={linkTo}>
      <div
        data-slot="overview-home"
        className={cn('flex min-h-0 flex-1 flex-col gap-(--space-5_5)', className)}
        {...props}
      >
        <section aria-label="This season" data-slot="overview-stats" className="pb-(--space-1)">
          {/* The kit's bare strip: five stats on the grid's gap, no rules between them. */}
          <StatGrid columns={5} ruled={false}>
            <IceWatchTile data={data.watch} />
            <WinterTile data={data.winter} />
            <ImageryTile data={data.imagery} />
            <FirstSkatedTile data={data.firstSkate} />
            {data.cost === null ? (
              <StatTile label="Cost · this season" {...NOT_RECORDED} />
            ) : (
              <StatTile
                label="Cost · this season"
                value={data.cost?.total ?? '$0.00'}
                sub={data.cost?.totalSub ?? 'Loading'}
                loading={data.cost === undefined}
              />
            )}
          </StatGrid>
        </section>

        <div data-slot="overview-cards" className={cn(COLUMNS, 'items-start')}>
          <InboxCard data={data.inbox} now={now} />
          <CorpusCard data={data.corpus} />
          {data.machinery === 'withheld' ? (
            // The column keeps its width, so People stays on the board's line.
            <div data-slot="machinery-withheld" />
          ) : (
            <MachineryCard data={data.machinery} now={now} />
          )}
          <PeopleCard data={data.people} />
        </div>

        {data.lows !== undefined && data.lows !== 'withheld' && (
          // Between the four cards and the cost and audit row (the founder, 2026-11-16).
          <SentinelLows state={data.lows} />
        )}

        {/* At least the board's height: with the sentinel row above it Home scrolls under the page
            head, and the feed keeps room to scroll inside. */}
        <div data-slot="overview-lower" className={cn(COLUMNS, 'min-h-[26.875rem] flex-1')}>
          {/* The board's 26 px between the services and the months. */}
          <div className="col-span-2 flex min-h-0 min-w-0 flex-col gap-[1.625rem]">
            <CostSection data={data.cost} />
            <MonthlySpend
              months={data.cost === null ? null : data.cost?.months}
              className="flex-1"
            />
          </div>
          <AuditFeed
            rows={data.feed}
            now={now}
            live={live}
            onOpenTarget={onOpenTarget}
            // Sized by its row, never by its rows: inside Home's scroll area the row's height is
            // its content's, and a feed counted in would grow the half to every row it holds
            // rather than scroll inside it.
            className="col-span-2 min-w-0 [contain:size]"
          />
        </div>
      </div>
    </OverviewLinkProvider>
  );
}
