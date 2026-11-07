import type { ReactNode } from 'react';

import { ScrollArea } from '@/components/kit/scroll-area';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/kit/tabs';
import { cn } from '@/lib/utils';

import { SkaterMap } from '../map/SkaterMap';
import { attributionLines } from './lakeModel';
import { LAKE_TAB_LABELS, LAKE_TABS, type LakeTab } from './lakeSearch';

/**
 * The Explore page's frame (B03 §1.1): the fixed 27.5 rem sidebar on the left, the region map
 * beside it. The page fills the shell's page area exactly and never scrolls; the sidebar's body
 * scrolls on its own.
 *
 * **The map.** `SkaterMap` is the one persistent region map, and its home is the skater layout
 * (§1.8) so it never unmounts between `/`, `/water/$id` and the panels. Until the layout mounts it,
 * this frame does — in the map column, one instance per page. Hoisting it is a one-line move: the
 * map column becomes the layout's, and this frame keeps only the sidebar.
 *
 * Below `md` the sidebar takes the width and the map stands down; the phone's own frame (row 9)
 * replaces this there.
 */
export function ExploreFrame({ sidebar, map }: { sidebar: ReactNode; map?: ReactNode }) {
  return (
    <div
      data-slot="explore-frame"
      className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[27.5rem_minmax(0,1fr)]"
    >
      {sidebar}
      <div data-slot="explore-map" className="relative h-full min-h-0 min-w-0 max-md:hidden">
        {map ?? <SkaterMap />}
      </div>
    </div>
  );
}

/**
 * The sidebar column: a header that stays, the body that scrolls, and the attribution at the foot
 * of the body (Review 4: `.caveat.foot`). `label` names the region for a screen reader.
 */
export function LakeSidebar({
  label,
  header,
  body,
  busy = false,
  className,
}: {
  label: string;
  header?: ReactNode;
  body: ReactNode;
  busy?: boolean;
  className?: string;
}) {
  return (
    <aside
      aria-label={label}
      aria-busy={busy || undefined}
      data-slot="lake-sidebar"
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg',
        'border-0 border-r border-solid border-line',
        className,
      )}
    >
      {header}
      {body}
    </aside>
  );
}

/**
 * The scrolling body: the gutter on both sides, the sections a gap apart, and the attribution
 * resting at the foot — pushed there when the content is short, after it when it's long.
 */
export function SidebarBody({
  children,
  contourCredit = null,
  className,
}: {
  children: ReactNode;
  /** The contours' credit line while depth is drawn (the map store's `contourCredit`). */
  contourCredit?: string | null;
  className?: string;
}) {
  return (
    <ScrollArea
      className="min-h-0 flex-1"
      gutter={false}
      viewportClassName="[&>div]:flex [&>div]:min-h-full [&>div]:flex-col"
    >
      <div
        data-slot="lake-sidebar-body"
        className={cn(
          'flex flex-1 flex-col gap-(--space-7) px-gutter pt-(--space-5_5) pb-(--space-6)',
          className,
        )}
      >
        {children}
        <SidebarFoot contourCredit={contourCredit} />
      </div>
    </ScrollArea>
  );
}

/** The sources, at the foot: the contours' credit while depth is drawn, then the basemap's. */
export function SidebarFoot({ contourCredit = null }: { contourCredit?: string | null }) {
  return (
    <footer
      data-slot="lake-sidebar-foot"
      className="mt-auto flex flex-col gap-(--space-1) pt-(--space-2_5) text-assist text-fg3"
    >
      {attributionLines(contourCredit).map((line) => (
        <p key={line} className="m-0 [text-wrap:pretty]">
          {line}
        </p>
      ))}
    </footer>
  );
}

/**
 * The four tabs under the header and the scrolling body they fill (boards 1.2–1.14): Reports,
 * Weather, Getting there, About, in that order. An action (`overlay`) opens over the tab it came
 * from — views stack — so the tab stays drawn under it, dimmed and inert.
 */
export function LakeTabs({
  tab,
  onTabChange,
  overlay = null,
  contourCredit = null,
  children,
}: {
  tab: LakeTab;
  onTabChange: (tab: LakeTab) => void;
  overlay?: ReactNode;
  contourCredit?: string | null;
  children: ReactNode;
}) {
  const covered = overlay !== null;
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => onTabChange(next as LakeTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="border-0 border-b border-solid border-line px-gutter py-(--space-3)">
        <TabsList aria-label="Lake sections" className="w-full">
          {LAKE_TABS.map((t) => (
            <TabsTab key={t} value={t} data-attr={`lake-tab-${t}`} className="flex-1">
              {LAKE_TAB_LABELS[t]}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <SidebarBody contourCredit={contourCredit}>
        {overlay}
        <TabsPanel
          value={tab}
          data-slot="lake-tab-panel"
          inert={covered}
          className={cn(covered && 'opacity-25')}
        >
          {children}
        </TabsPanel>
      </SidebarBody>
    </Tabs>
  );
}
