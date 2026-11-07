import type { ReactNode } from 'react';

import { ScrollArea } from '@/components/kit/scroll-area';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/kit/tabs';
import { cn } from '@/lib/utils';

import { LAKE_TAB_LABELS, LAKE_TABS, type LakeTab } from './lakeSearch';

/**
 * The sidebar column: a header that stays and the body that scrolls. `label` names the region for a
 * screen reader. It fills the
 * skater layout's 27.5 rem view column, beside the region map (`MapFrame`); below `md` it takes
 * the width.
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
 * The scrolling body: the gutter on both sides, the sections a gap apart.
 *
 * **No credits here.** The founder, seeing the basemap's twice: *"Let's only show the one in the
 * chip over the map, NOT in the sidebar."* Every credit rides in the map's folded ⓘ — the sources'
 * own, and the contours', which the canvas hands it while they're drawn.
 */
export function SidebarBody({ children, className }: { children: ReactNode; className?: string }) {
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
      </div>
    </ScrollArea>
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
  children,
}: {
  tab: LakeTab;
  onTabChange: (tab: LakeTab) => void;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const covered = overlay !== null;
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => onTabChange(next as LakeTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="border-0 border-b border-solid border-line px-gutter py-(--space-3) max-md:px-(--space-5)">
        <TabsList aria-label="Lake sections" className="w-full">
          {LAKE_TABS.map((t) => (
            <TabsTab
              key={t}
              value={t}
              data-attr={`lake-tab-${t}`}
              className="flex-1 max-md:px-(--space-1_5)"
            >
              {LAKE_TAB_LABELS[t]}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <SidebarBody>
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
