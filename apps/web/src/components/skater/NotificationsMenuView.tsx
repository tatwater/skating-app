import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBell,
  faBullseyeArrow,
  faClock,
  faFileLines,
  faFlag,
  faGear,
  faTriangleExclamation,
} from '@fortawesome/sharp-light-svg-icons';

import { cn } from '@/lib/utils';

import { Avatar } from '../kit/avatar';
import { Button, buttonVariants } from '../kit/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../kit/popover';
import { Skeleton } from '../kit/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../kit/tooltip';
import { isPlainLeftClick, navLinkProps } from './chrome';
import {
  type NotificationIcon,
  type NotificationRowModel,
  notificationGroups,
} from './notificationRows';

/**
 * The bell and its dropdown (boards 3.21–3.23), props only. A dropdown, not a page: a square plate
 * under the bell with New and Earlier groups (unread rows carry the ice wash and a rule), the
 * empty state's own sentence, and a gear to the notification settings.
 */
export interface NotificationsMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bell's dot: anything unread. */
  unreadCount: number;
  /** `undefined` while the first page loads. */
  rows: readonly NotificationRowModel[] | undefined;
  /** More pages wait behind "Load more". */
  canLoadMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** A row with somewhere to go was pressed (the plate closes after). */
  onOpenRow: (row: NotificationRowModel) => void;
  onNavigate: (href: string) => void;
  /** Story quads hold their own plate and don't trap focus. */
  container?: HTMLElement | null;
  modal?: boolean;
}

export const NOTIFICATION_SETTINGS_HREF = '/settings/notifications';

const ICONS: Record<NotificationIcon, IconDefinition> = {
  hazard: faTriangleExclamation,
  clock: faClock,
  report: faFileLines,
  bounty: faBullseyeArrow,
  flag: faFlag,
  bell: faBell,
};

export function NotificationsMenuView({
  open,
  onOpenChange,
  unreadCount,
  rows,
  canLoadMore = false,
  loadingMore = false,
  onLoadMore,
  onOpenRow,
  onNavigate,
  container,
  modal,
}: NotificationsMenuViewProps) {
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';
  const settings = navLinkProps(NOTIFICATION_SETTINGS_HREF, (href) => {
    onOpenChange(false);
    onNavigate(href);
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      {...(modal !== undefined ? { modal } : {})}
    >
      <PopoverTrigger
        data-attr="notifications"
        aria-label={label}
        render={
          <Button
            variant="bare"
            size="icon"
            className={cn('relative text-fg2', open && 'bg-raise text-fg')}
          />
        }
      >
        <FontAwesomeIcon icon={faBell} aria-hidden="true" className="h-[1.0625rem]" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            data-slot="notifications-dot"
            className="absolute top-[0.5rem] right-[0.5625rem] size-[0.4375rem] rounded-full bg-acc shadow-[0_0_0_2px_var(--bg)]"
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        {...(container !== undefined ? { container } : {})}
        align="end"
        // Focus lands on the first row, not the gear (whose tip would open on every opening).
        initialFocus={() =>
          document.querySelector<HTMLElement>('[data-slot="notification-row"][href]') ?? true
        }
        // Names and what people did: never autocaptured (D240).
        className="ph-no-capture w-[26.25rem]"
        aria-label="Notifications"
      >
        <PopoverHeader className="h-12 py-0 pr-(--space-2) pl-(--space-4)">
          <PopoverTitle>Notifications</PopoverTitle>
          <Tooltip>
            <TooltipTrigger
              render={
                // A link (it goes somewhere), in the kit's bare icon-button look.
                <a
                  href={settings.href}
                  onClick={settings.onClick}
                  aria-label="Notification settings"
                  className={cn(buttonVariants({ variant: 'bare', size: 'icon-sm' }), 'ml-auto')}
                />
              }
            >
              <FontAwesomeIcon icon={faGear} aria-hidden="true" className="h-[0.9375rem]" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Notification settings</TooltipContent>
          </Tooltip>
        </PopoverHeader>
        <div data-slot="notifications-body" className="min-h-0 flex-1 overflow-y-auto">
          {rows === undefined ? (
            <Loading />
          ) : rows.length === 0 ? (
            <Empty settings={settings} />
          ) : (
            notificationGroups(rows).map((group, i) => (
              <section
                key={group.id}
                aria-label={group.label}
                data-slot="notifications-group"
                className={cn(i > 0 && 'border-0 border-t border-solid border-line')}
              >
                <h3 className="m-0 px-(--space-4) pt-(--space-3_5) pb-(--space-1_5) text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
                  {group.label}
                </h3>
                <ul className="m-0 list-none p-0">
                  {group.rows.map((row, j) => (
                    <li
                      key={row.id}
                      // Rules between rows only: a list's last row has none under it.
                      className={cn(j > 0 && 'border-0 border-t border-solid border-line')}
                    >
                      <Row row={row} onOpenRow={onOpenRow} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        {(canLoadMore || loadingMore) && (
          <div className="flex shrink-0 border-0 border-t border-solid border-line px-(--space-4) pt-(--space-2_5) pb-(--space-3)">
            <Button size="sm" className="flex-1" loading={loadingMore} onClick={onLoadMore}>
              Load more
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Mark({ row }: { row: NotificationRowModel }) {
  if (row.mark.kind === 'person') {
    return <Avatar name={row.mark.name} aria-hidden="true" className="shrink-0" />;
  }
  const bad = row.mark.tone === 'bad';
  return (
    <span
      aria-hidden="true"
      data-slot="notification-glyph"
      data-tone={row.mark.tone ?? 'default'}
      className={cn(
        'flex size-avatar shrink-0 items-center justify-center rounded-container border border-solid',
        bad ? 'border-bad bg-bad text-bg' : 'border-line2 text-fg2',
      )}
    >
      <FontAwesomeIcon icon={ICONS[row.mark.icon]} className="h-[0.8125rem]" />
    </span>
  );
}

function Row({
  row,
  onOpenRow,
}: {
  row: NotificationRowModel;
  onOpenRow: (row: NotificationRowModel) => void;
}) {
  const body = (
    <>
      <Mark row={row} />
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-0_5)">
        <span
          data-slot="notification-title"
          className={cn(
            'text-row leading-(--lead-list) text-pretty',
            row.unread ? 'font-medium text-fg' : 'text-fg1',
          )}
        >
          {row.title}
        </span>
        {row.detail !== undefined && (
          <span className="text-assist leading-(--lead-snug) text-fg2">{row.detail}</span>
        )}
      </span>
      <span
        data-slot="notification-when"
        className={cn(
          'shrink-0 font-(family-name:--family-mono) text-mono-sm leading-(--lead-body) whitespace-nowrap',
          row.unread ? 'text-fg2' : 'text-fg3',
        )}
      >
        {row.when}
      </span>
    </>
  );
  const box = cn(
    'relative flex items-center gap-(--space-3) px-(--space-4) py-[0.6875rem] no-underline',
    row.unread &&
      'bg-acc-wash before:absolute before:inset-y-0 before:left-0 before:w-(--stroke-note) before:bg-acc',
  );
  if (row.href === null) {
    // Gone, or nowhere honest to go: shown, not a link (A08 #5).
    return (
      <div data-slot="notification-row" data-unread={row.unread ? '' : undefined} className={box}>
        {body}
      </div>
    );
  }
  return (
    <a
      href={row.href}
      data-slot="notification-row"
      data-unread={row.unread ? '' : undefined}
      onClick={(event) => {
        // A modified press opens a tab and leaves the plate where it is.
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onOpenRow(row);
      }}
      className={cn(
        box,
        'rounded-control outline-none transition-colors duration-(--duration-instant) ease-standard',
        'lit:bg-raise focus-visible:shadow-focus',
      )}
    >
      {body}
    </a>
  );
}

function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading notifications"
      className="flex flex-col gap-(--space-3) p-(--space-4)"
    >
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function Empty({ settings }: { settings: ReturnType<typeof navLinkProps> }) {
  return (
    <div
      data-slot="notifications-empty"
      className="flex flex-col items-start gap-(--space-2_5) px-(--space-7) pt-[1.875rem] pb-[2.125rem]"
    >
      <span className="text-kick leading-none font-semibold tracking-head text-fg uppercase">
        Nothing yet
      </span>
      <span className="text-assist leading-body text-pretty text-fg2">
        When someone comments on your report, finds it helpful, or a lake you follow gets a new
        report, it shows up here. Which of those reach you is up to you in Settings.
      </span>
      <a
        {...settings}
        className={cn(buttonVariants({ size: 'sm' }), 'mt-(--space-1_5) no-underline')}
      >
        <FontAwesomeIcon icon={faGear} aria-hidden="true" className="h-[1.1em]" />
        Notification settings
      </a>
    </div>
  );
}
