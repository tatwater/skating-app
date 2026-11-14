import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faBoxArchive,
  faTachographDigital,
  type IconDefinition,
} from '@fortawesome/sharp-light-svg-icons';
import {
  createContext,
  Fragment,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AppShell, ShellRailItem } from '@/components/kit/app-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Logo } from '@/components/kit/logo';
import { RailViewer } from '@/components/kit/rail-item';
import { Separator } from '@/components/kit/separator';
import type { KeyHint } from '@/components/kit/status-bar';
import {
  type Colleague,
  ColleagueFaces,
  SearchTrigger,
  SeasonTape,
  type SeasonTapeProps,
} from '@/components/kit/top-bar-parts';
import type { ConsoleMode, LegacyPage } from './consoleNav';

/**
 * The console's frame, drawn from props: the kit `AppShell` filled with the console's rail, top
 * bar and status bar. `ConsoleLayout` is the same thing wired to the router, the role and Convex;
 * this half takes no hook of either, so a story draws it as a board.
 *
 * - **The rail** lists the modes built so far (never a placeholder for one to come), then
 *   **Legacy**: one item that opens a menu of the old pages still standing, so nothing the old
 *   console could do is out of reach while the new one fills in. The app item (a new tab) and the
 *   viewer sit at its foot. Every entry arrives already gated by the caller (D217); G then a
 *   mode's letter goes to it, G then L opens Legacy, G then A opens the app.
 * - **The top bar**: the season tape centered, the search trigger (it opens the palette, as ⌘K
 *   does from anywhere) and the colleagues' faces at its end — no faces when nobody else is on.
 * - **The status bar**: the page's own groups (a page states them with {@link ConsoleStatus}),
 *   the keys that work here, and the connection lamp.
 * - **Main** is the page, whole: no slice-one page splits into resizable panes, so the shell
 *   passes none (a page that wants them gets the kit shell's `lanes` / `middle` / `inspector`).
 */

const MODE_ICON: Record<ConsoleMode['id'], IconDefinition> = {
  overview: faTachographDigital,
};

/** A built mode as the rail draws it. */
export type RailMode = ConsoleMode & {
  current: boolean;
  /** What waits in it; leave it out when nothing does (never a `0`). */
  count?: number | string;
  countTone?: 'default' | 'warn' | 'bad';
};

export type ConsoleShellProps = {
  /** The modes the viewer may use, in the rail's order. */
  modes: readonly RailMode[];
  /** The old pages the viewer may use. None, and the Legacy item isn't drawn. */
  legacy: readonly LegacyPage[];
  /** A Legacy menu item was chosen. */
  onLegacy: (page: LegacyPage) => void;
  /** The router's link for a rail mode (`<Link to={to} />`); a plain anchor otherwise. */
  linkFor?: (to: string) => ReactElement;
  /** Where the app item opens, in a new tab. */
  appHref?: string;
  /** Who is signed in: the circle at the rail's foot. */
  viewer?: { name: string; src?: string };
  /** The season tape; none while it can't be drawn. */
  tape?: Omit<SeasonTapeProps, 'dimmed'>;
  /** Staff on the console besides the viewer. */
  colleagues?: readonly Colleague[];
  viewerId?: string;
  /** The search trigger was pressed: open the palette. */
  onSearch: () => void;
  /** ⌘K from anywhere: toggle the palette. */
  onCommandKey?: () => void;
  /** The connection lamp, at the status bar's end. */
  lamp?: ReactNode;
  /** What floats over the frame: the palette, the toasts, a dialog. */
  overlays?: ReactNode;
  /** The page. */
  children?: ReactNode;
  className?: string;
};

/** What every console page's status bar lists, whatever the page adds. */
const PAGE_KEYS: readonly KeyHint[] = [{ keys: 'G', label: 'go to' }];

type ChromeSlots = { status: HTMLElement | null; topStart: HTMLElement | null };

const ChromeContext = createContext<ChromeSlots | null>(null);

export function ConsoleShell({
  modes,
  legacy,
  onLegacy,
  linkFor,
  appHref = '/',
  viewer,
  tape,
  colleagues = [],
  viewerId,
  onSearch,
  onCommandKey,
  lamp,
  overlays,
  children,
  className,
}: ConsoleShellProps) {
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);
  // One value per pair of slots, so a page's status and top-bar portals re-render only when a slot
  // mounts, not on every render of the shell.
  const chrome = useMemo<ChromeSlots>(
    () => ({ status: statusSlot, topStart: topSlot }),
    [statusSlot, topSlot],
  );

  return (
    <ChromeContext.Provider value={chrome}>
      <AppShell
        className={className}
        railHead={
          <span
            data-slot="console-logo"
            className="mb-(--space-2_5) flex h-(--space-8) items-center justify-center"
          >
            <Logo className="h-(--space-4)" />
          </span>
        }
        rail={
          <>
            {modes.map((m) => (
              <ShellRailItem
                key={m.id}
                goKey={m.goKey}
                name={m.name}
                icon={<FontAwesomeIcon icon={MODE_ICON[m.id]} />}
                current={m.current}
                count={m.count}
                countTone={m.countTone}
                {...(linkFor !== undefined ? { render: linkFor(m.to) } : { href: m.to })}
              />
            ))}
            {legacy.length > 0 && <LegacyItem pages={legacy} onChoose={onLegacy} />}
          </>
        }
        railFoot={
          <>
            <ShellRailItem
              variant="app"
              goKey="A"
              name="App"
              icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
              href={appHref}
            />
            {viewer !== undefined && (
              <RailViewer
                name={viewer.name}
                {...(viewer.src !== undefined ? { src: viewer.src } : {})}
              />
            )}
          </>
        }
        topStart={<div ref={setTopSlot} data-slot="console-top-start" className="contents" />}
        topCenter={tape !== undefined ? <SeasonTape {...tape} /> : undefined}
        topEnd={
          <>
            <SearchTrigger onClick={onSearch} />
            <ColleagueFaces people={colleagues} {...(viewerId !== undefined ? { viewerId } : {})} />
          </>
        }
        status={[
          <span
            key="page"
            ref={setStatusSlot}
            data-slot="console-status"
            className="flex items-center gap-(--space-3_5)"
          />,
        ]}
        pageKeys={PAGE_KEYS}
        lamp={lamp}
        onCommandKey={onCommandKey}
        overlays={overlays}
      >
        {children}
      </AppShell>
    </ChromeContext.Provider>
  );
}

/**
 * The rail's Legacy item: one rail row that opens a menu of the old pages, beside the rail — the
 * old sidebar's fourteen links would not fit the rail as rows of their own, and they are leaving.
 */
function LegacyItem({
  pages,
  onChoose,
}: {
  pages: readonly LegacyPage[];
  onChoose: (page: LegacyPage) => void;
}) {
  return (
    <DropdownMenu>
      <ShellRailItem
        goKey="L"
        name="Legacy"
        icon={<FontAwesomeIcon icon={faBoxArchive} />}
        render={<DropdownMenuTrigger />}
      />
      <DropdownMenuContent side="right" align="start" sideOffset={0} aria-label="Old pages">
        {pages.map((page) => (
          <DropdownMenuItem key={page.to} onClick={() => onChoose(page)}>
            {page.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A console page's status groups, drawn in the shell's status bar ("1 safety", then the strong
 * rule, then "1 stalled · 2 failed"). Render it anywhere in the page; it portals into the bar.
 * The bar never restates the page's name or a count the rail already carries.
 */
export function ConsoleStatus({ groups }: { groups: readonly ReactNode[] }) {
  const slot = useContext(ChromeContext)?.status ?? null;
  if (slot === null) return null;
  return createPortal(
    groups.map((group, i) => (
      // Groups are positional: the bar's layout, not data with identity.
      // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity.
      <Fragment key={i}>
        {i > 0 && <Separator orientation="vertical" strong data-slot="status-sep" />}
        <span data-slot="status-group" className="flex items-center gap-(--space-5_5)">
          {group}
        </span>
      </Fragment>
    )),
    slot,
  );
}

/**
 * A console page's own controls at the top bar's start (a place control, a task chip). Render it
 * anywhere in the page; it portals into the bar.
 */
export function ConsoleTopStart({ children }: { children: ReactNode }) {
  const slot = useContext(ChromeContext)?.topStart ?? null;
  if (slot === null) return null;
  return createPortal(children, slot);
}
