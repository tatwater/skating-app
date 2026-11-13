import type { ComponentProps, ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/kit/tabs';
import { cn } from '@/lib/utils';

import type { Head } from './overviewModel';

/**
 * The Overview's page: its word, its tabs, the heads row, and the chosen tab's panel.
 *
 * - **The tab is controlled.** It lives in the URL, so the route owns it: `value` names the chosen
 *   tab and `onValueChange` asks for another. The tabs are data (`tabs`), so a third (Seasons, if it
 *   folds in) joins without touching this file.
 * - **The heads row is the page's**, not a tab's: what needs a person and what needs a hand read
 *   the same on Home and Metrics.
 * - **The big word lives in the page**, never the top bar.
 */

export interface OverviewTab<V extends string = string> {
  value: V;
  /** The tab's word ("Home"), written capitalized; the tab sets it in caps. */
  label: string;
  /** What the tab shows. Only the chosen tab's panel is mounted. */
  panel: ReactNode;
}

type OverviewPageProps<V extends string> = Omit<ComponentProps<'div'>, 'children'> & {
  tabs: ReadonlyArray<OverviewTab<V>>;
  value: V;
  onValueChange: (value: V) => void;
  /** What needs a person and what needs a hand (`overviewHeads`). */
  heads?: readonly Head[];
  /** The page's word. Default "Overview". */
  title?: string;
};

export function OverviewPage<V extends string>({
  tabs,
  value,
  onValueChange,
  heads = [],
  title = 'Overview',
  className,
  ...props
}: OverviewPageProps<V>) {
  return (
    <Tabs
      data-slot="overview-page"
      value={value}
      onValueChange={(next) => onValueChange(next as V)}
      className={cn('min-h-0 gap-(--space-5_5)', className)}
      {...props}
    >
      <div data-slot="overview-head" className="flex min-w-0 items-end gap-(--space-4_5)">
        <h1
          data-slot="page-word"
          className="m-0 text-disp-lg leading-none font-semibold tracking-label whitespace-nowrap text-fg uppercase"
        >
          {title}
        </h1>
        <TabsList aria-label={`${title} tabs`} className="mb-px">
          {tabs.map((tab) => (
            <TabsTab key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTab>
          ))}
        </TabsList>
        {heads.length > 0 && <HeadsRow heads={heads} className="ms-auto" />}
      </div>
      {tabs.map((tab) => (
        <TabsPanel
          key={tab.value}
          value={tab.value}
          className="flex min-h-0 flex-1 flex-col"
          // Only the chosen tab's panel is mounted: Metrics reads its own data.
          keepMounted={false}
        >
          {tab.panel}
        </TabsPanel>
      ))}
    </Tabs>
  );
}

const KICK_TONE = { warn: 'text-warn', bad: 'text-bad' } as const;

/** The heads: a kicker over its badges, one state per badge. */
export function HeadsRow({
  heads,
  className,
  ...props
}: ComponentProps<'div'> & { heads: readonly Head[] }) {
  return (
    <div data-slot="heads" className={cn('flex items-end gap-(--space-7)', className)} {...props}>
      {heads.map((head) => (
        <section
          key={head.kicker}
          data-slot="head"
          aria-label={head.kicker}
          className="flex flex-col items-start gap-(--space-1_5)"
        >
          <span
            data-slot="head-kicker"
            className={cn(
              'text-kick leading-none font-medium tracking-kick whitespace-nowrap uppercase',
              KICK_TONE[head.tone],
            )}
          >
            {head.kicker}
          </span>
          <span className="flex gap-(--space-1)">
            {head.badges.map((badge) => (
              <Badge key={badge} tone={head.tone}>
                {badge}
              </Badge>
            ))}
          </span>
        </section>
      ))}
    </div>
  );
}
