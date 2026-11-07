import { useEffect } from 'react';

import { cn } from '@/lib/utils';
import { type LatestPhonePane, useChromeStore } from '@/stores/chromeStore';

import { ToggleGroup, ToggleGroupItem } from '../../kit/toggle-group';
import { useEscapeToClose } from '../lake/lakeNav';
import { useIsPhone } from './usePhoneLayout';

/**
 * Latest on a phone (board 9.7) shows one column at a time: the reports, the filters, or
 * Recommended with *Wanted near you*. This is the switch between them — a kit ToggleGroup (a mode
 * always has a value; ←→ move along it) across the top of the page, the filters' count beside their
 * name so a narrowed feed says so. Esc from the filters or Wanted goes back to the reports (one Esc
 * per screen), and leaving Latest leaves the reports chosen for next time.
 *
 * The pane lives in `useChromeStore` so the frame's columns read it without a prop chain.
 */
export function LatestPhoneBar({
  filterCount,
  className,
}: {
  /** How many filters are on (`activeFilterCount`), shown beside their name. */
  filterCount: number;
  className?: string;
}) {
  const phone = useIsPhone();
  const pane = useChromeStore((s) => s.latestPhonePane);
  const setPane = useChromeStore((s) => s.setLatestPhonePane);

  useEscapeToClose(phone && pane !== 'feed', () => setPane('feed'));
  useEffect(() => () => useChromeStore.getState().setLatestPhonePane('feed'), []);

  return (
    <div data-slot="latest-phone-bar" className={cn('shrink-0 md:hidden', className)}>
      <ToggleGroup
        aria-label="Latest"
        value={pane}
        onValueChange={(next) => setPane(next as LatestPhonePane)}
        className="w-full"
      >
        <ToggleGroupItem value="feed" data-attr="latest-pane-feed" className="flex-1">
          Reports
        </ToggleGroupItem>
        <ToggleGroupItem value="filters" data-attr="latest-pane-filters" className="flex-1">
          Filters
          {filterCount > 0 && (
            <span data-slot="latest-filter-count" className="ml-(--space-1_5)">
              {filterCount}
              <span className="sr-only"> on</span>
            </span>
          )}
        </ToggleGroupItem>
        <ToggleGroupItem value="wanted" data-attr="latest-pane-wanted" className="flex-1">
          Wanted
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
