import type { ReactNode, Ref } from 'react';

import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/kit/tabs';
import { cn } from '@/lib/utils';

import { BODY_TABS, type BodyTabKey } from './bodySearch';
import { BODY_TAB_LABELS } from './tabRegistry';

/**
 * The inspector (§5.4's right column): the nine tabs as the kit's 3 × 3 grid (Review 11), the amber
 * square on any tab whose part of the record is missing something, and the open tab under it. The
 * grid never scrolls a tab out of sight; the panel scrolls under it and ends with room to spare.
 */

export interface BodyInspectorProps {
  tab: BodyTabKey;
  onTabChange: (tab: BodyTabKey) => void;
  /** Tabs that wear the amber square. */
  attention: ReadonlySet<BodyTabKey>;
  /** The open tab's content. */
  children: ReactNode;
  /** The panel: where focus lands when an item on the left opens a tab. */
  panelRef?: Ref<HTMLDivElement>;
  className?: string;
}

export function BodyInspector({
  tab,
  onTabChange,
  attention,
  children,
  panelRef,
  className,
}: BodyInspectorProps) {
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as BodyTabKey)}
      data-slot="body-inspector"
      aria-label="Inspector"
      className={cn(
        'flex min-h-0 flex-col gap-0 border-0 border-l border-solid border-line',
        className,
      )}
    >
      <div
        data-slot="body-tab-head"
        className="flex-none border-0 border-b border-solid border-line px-gutter pt-(--space-3_5) pb-(--space-4)"
      >
        <TabsList variant="grid" columns={3} aria-label="Tabs">
          {BODY_TABS.map((key) => (
            <TabsTab
              key={key}
              value={key}
              {...(attention.has(key) ? { flag: 'Missing something' } : {})}
            >
              {BODY_TAB_LABELS[key]}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <TabsPanel
        ref={panelRef}
        value={tab}
        data-slot="body-tab-panel"
        className="min-h-0 flex-1 overflow-y-auto px-gutter pt-(--space-5_5) pb-(--space-14) [scrollbar-width:none]"
      >
        {children}
      </TabsPanel>
    </Tabs>
  );
}
