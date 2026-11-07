import { tokens } from '@skating/design';
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GroupProps, Layout } from 'react-resizable-panels';

import {
  type GoLetter,
  KeysProvider,
  modKey,
  type PaneBinding,
  type PaneKey,
  useGlobalKey,
  useGoMode,
  useGoTarget,
  usePaneKeys,
} from '@/lib/keys';
import { cn } from '@/lib/utils';

import { GoBar } from './go-bar';
import { RailItem, type RailItemProps } from './rail-item';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable';
import { type KeyHint, KeyRegistryProvider, StatusBar, type StatusBarProps } from './status-bar';

/**
 * The console's app shell (admin only): the frame every console page sits in, composed from the
 * kit — not shadcn's Sidebar (its collapse, its ⌘B and its provider don't fit). One CSS grid:
 *
 * - **The rail**, the first column the full height (`size-rail`, 64 px on the console): the logo,
 *   the modes (`ShellRailItem`), then the app item and the viewer at its foot. It never collapses
 *   and binds no key of its own — G then a mode's letter goes there.
 * - **The top bar** (`size-top`, 44 px): the page's own controls at its start, the season tape
 *   centered on the bar, the search trigger and the colleagues' faces at its end.
 * - **Main**, between them: the lanes, the middle list and the inspector as kit Resizable panes
 *   — sizes from the container tokens, `defaultLayout` to start from a persisted layout and
 *   `onLayoutChanged` to hear the operator's (the route keeps it in a cookie, so the server renders
 *   the operator's widths). A layout's keys are the panes on the page, so key a stored layout by
 *   them. A page without panes passes `children`. Narrower than the `lg` breakpoint the panes
 *   stack, one screen each, and main scrolls through them.
 * - **The status bar** (`size-status`, 26 px) along main's foot.
 *
 * The keyboard is wired once, here: the shell is the `KeysProvider` and the status bar's key
 * registry. **Tab** walks the page in order — the lanes (one stop), the separator, the middle list
 * (one stop), the separator, the inspector — and **↑↓** stay inside the lanes and the list (theirs,
 * not the shell's). A pane's letter keys (`paneKeys`) act only while focus is in that pane, and
 * the status bar lists the focused pane's keys first, without any a visible button already wears.
 * **⌘K** (`onCommandKey`) and **?** (`onKeySheetKey`) work anywhere. **G** opens go-mode: the go
 * bar comes up at the bottom center, the rail's letters light, and the rest of the frame steps
 * back to the dim opacity.
 *
 * Routing stays out of the kit: rail items take the router's link as `render`, and `useShell()`
 * hands a page the main region (a sheet's `container`) and `focusPane` (⏎ on a row moves focus to
 * the inspector).
 */

export type ShellPane = 'lanes' | 'middle' | 'inspector';

const PANES: readonly ShellPane[] = ['lanes', 'middle', 'inspector'];

const PANE_LABEL: Record<ShellPane, string> = {
  lanes: 'Lanes',
  middle: 'List',
  inspector: 'Inspector',
};

const size = (key: tokens.SizeKey) => tokens.toCssLength(tokens.size.admin[key]);

/**
 * Each pane's sizes, from the container tokens: the lanes and the list start at their columns'
 * widths and the inspector takes the rest. No pane narrows past the narrowest named column (the
 * search field's), and the inspector keeps its own width as a floor.
 */
const PANE_SIZE: Record<ShellPane, { defaultSize?: string; minSize: string }> = {
  lanes: { defaultSize: size('lanes'), minSize: size('search') },
  middle: { defaultSize: size('list'), minSize: size('search') },
  inspector: { minSize: size('inspector') },
};

/** Tailwind's `lg`, in rem: narrower than this, the panes stack (no groups on a phone). */
const STACK_BELOW_REM = 64;

// ── Context ──────────────────────────────────────────────────────────────────────────────────

type ShellState = {
  /** The main region: a sheet's `container`, so its scrim leaves the rail and status bar lit. */
  main: HTMLElement | null;
  /** Moves focus into a pane (the pane itself, where its letter keys act). */
  focusPane: (pane: ShellPane) => void;
  /** The pane focus is in, if any. */
  focusedPane: ShellPane | null;
  /** The panes stack (narrower than `lg`). */
  stacked: boolean;
};

const ShellContext = createContext<ShellState | null>(null);

/** The shell around a page: its main region, its panes. Throws outside an `AppShell`. */
export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error('useShell needs an <AppShell> above it.');
  return shell;
}

// ── Rail ─────────────────────────────────────────────────────────────────────────────────────

type ShellRailItemProps = Omit<RailItemProps, 'go' | 'goKey'> & {
  /** The letter after G that goes here ("I" for Inbox). */
  goKey: GoLetter;
};

/**
 * A rail item wired to go-mode: G then `goKey` presses it (so a router link navigates as if
 * clicked, and the app item opens its new tab), and in go-mode it wears its letter.
 */
function ShellRailItem({ goKey, name, ...props }: ShellRailItemProps) {
  const link = useRef<HTMLAnchorElement>(null);
  const { active } = useGoMode();
  useGoTarget({ key: goKey, label: name, run: () => link.current?.click() });
  return <RailItem ref={link} name={name} go={active} goKey={goKey} {...props} />;
}

// ── Keys as the status bar shows them ────────────────────────────────────────────────────────

const CAP: Partial<Record<string, string>> = {
  Enter: '⏎',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  Shift: '⇧',
};

/** A pane key as its cap reads: "R", "⇧⏎", "⌘⏎" (Ctrl ⏎ off a Mac), "Esc". */
export function keyCap(key: PaneKey, mod: 'Meta' | 'Control' = modKey()): string {
  return key
    .split('+')
    .map((part) => (part === 'Mod' ? (mod === 'Meta' ? '⌘' : 'Ctrl ') : (CAP[part] ?? part)))
    .join('');
}

/** A pane's labeled keys as status-bar hints, the label lowercased to the bar's voice. */
export function paneHints(bindings: readonly PaneBinding[], mod?: 'Meta' | 'Control'): KeyHint[] {
  return bindings.flatMap((b) =>
    b.label === undefined
      ? []
      : [{ keys: keyCap(b.key, mod), label: b.label.charAt(0).toLowerCase() + b.label.slice(1) }],
  );
}

/** What a page with panes always says first: how to move (the mock's wording). */
const PANE_HINTS: readonly KeyHint[] = [
  { keys: 'Tab', label: 'panels' },
  { keys: '↑↓', label: 'move' },
  { keys: 'A–Z', label: 'type to jump' },
];

// ── The shell ────────────────────────────────────────────────────────────────────────────────

type AppShellProps = {
  /** The logo, at the rail's head. */
  railHead?: ReactNode;
  /** The modes: `ShellRailItem`s, in order. */
  rail: ReactNode;
  /** The rail's foot: the app item and the viewer. */
  railFoot?: ReactNode;
  /** The rail's name for a reader. */
  railLabel?: string;

  /** The page's own controls, at the top bar's start (a place control, a task chip). */
  topStart?: ReactNode;
  /** Centered on the top bar: the season tape. */
  topCenter?: ReactNode;
  /** At the top bar's end: the search trigger, then the colleagues' faces. */
  topEnd?: ReactNode;

  /** The lanes pane. */
  lanes?: ReactNode;
  /** The middle list pane. */
  middle?: ReactNode;
  /** The inspector pane. */
  inspector?: ReactNode;
  /** A pane's name for a reader, where the default (Lanes, List, Inspector) doesn't fit. */
  paneLabels?: Partial<Record<ShellPane, string>>;
  /** Each pane's letter keys: they act only while focus is in that pane. */
  paneKeys?: Partial<Record<ShellPane, readonly PaneBinding[]>>;
  /** The layout to start from (a persisted one): pane id → percent. */
  defaultLayout?: Layout;
  /**
   * The operator resized the panes: once per drag or key press, never for the layout the group
   * starts with (so a route writes its cookie only when something changed).
   */
  onLayoutChanged?: GroupProps['onLayoutChanged'];
  /** Stack the panes (or don't), whatever the width. Otherwise narrower than `lg` stacks. */
  stacked?: boolean;
  /** Main's content on a page without panes. */
  children?: ReactNode;

  /** The status bar's groups, the page's keys and its lamp. The focused pane's keys lead. */
  status?: StatusBarProps['status'];
  pageKeys?: StatusBarProps['pageKeys'];
  lamp?: StatusBarProps['lamp'];

  /** ⌘K, from anywhere: open the palette. */
  onCommandKey?: () => void;
  /** ?, from anywhere a key isn't typed: open the key sheet. */
  onKeySheetKey?: () => void;
  /** What floats over the frame: the palette, the key sheet. */
  overlays?: ReactNode;

  className?: string;
};

/** The console's frame. Wraps everything in the keyboard layer and the status bar's registry. */
function AppShell(props: AppShellProps) {
  return (
    <KeysProvider>
      <KeyRegistryProvider>
        <ShellFrame {...props} />
      </KeyRegistryProvider>
    </KeysProvider>
  );
}

/** Go-mode's dim: everything but the rail steps back while its letters light. */
const DIM = 'transition-opacity duration-(--duration-fast) ease-standard';

function ShellFrame({
  railHead,
  rail,
  railFoot,
  railLabel = 'Modes',
  topStart,
  topCenter,
  topEnd,
  lanes,
  middle,
  inspector,
  paneLabels,
  paneKeys,
  defaultLayout,
  onLayoutChanged,
  stacked: stackedProp,
  children,
  status,
  pageKeys = [],
  lamp,
  onCommandKey,
  onKeySheetKey,
  overlays,
  className,
}: AppShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const [main, setMain] = useState<HTMLElement | null>(null);
  const { active: go } = useGoMode();
  const stacked = useStacked(root, stackedProp);

  useGlobalKey('Mod+K', () => onCommandKey?.(), { enabled: onCommandKey !== undefined });
  useGlobalKey('?', () => onKeySheetKey?.(), { enabled: onKeySheetKey !== undefined });

  // One ref per pane, its keys bound to it — every pane, every render (hooks keep their order).
  const lanesRef = useRef<HTMLElement>(null);
  const middleRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const refs = useMemo<Record<ShellPane, RefObject<HTMLElement | null>>>(
    () => ({ lanes: lanesRef, middle: middleRef, inspector: inspectorRef }),
    [],
  );
  usePaneKeys(refs.lanes, paneKeys?.lanes ?? []);
  usePaneKeys(refs.middle, paneKeys?.middle ?? []);
  usePaneKeys(refs.inspector, paneKeys?.inspector ?? []);

  // Which pane focus is in: its keys lead the status bar.
  const [focusedPane, setFocusedPane] = useState<ShellPane | null>(null);
  useEffect(() => {
    const el = root.current;
    /* v8 ignore next */
    if (el === null) return;
    const track = () => {
      const focused = document.activeElement;
      const pane = el.contains(focused)
        ? focused?.closest<HTMLElement>('[data-pane]')?.dataset.pane
        : undefined;
      setFocusedPane((pane as ShellPane | undefined) ?? null);
    };
    // Focus leaving lands after `focusout`; read where it went on the next frame.
    const left = () => requestAnimationFrame(track);
    el.addEventListener('focusin', track);
    el.addEventListener('focusout', left);
    return () => {
      el.removeEventListener('focusin', track);
      el.removeEventListener('focusout', left);
    };
  }, []);

  const nodes: Record<ShellPane, ReactNode> = { lanes, middle, inspector };
  const present = PANES.filter((p) => nodes[p] !== undefined && nodes[p] !== null);
  const focusKeys = useMemo(
    () => (focusedPane === null ? [] : paneHints(paneKeys?.[focusedPane] ?? [])),
    [focusedPane, paneKeys],
  );

  const focusPane = useCallback((pane: ShellPane) => refs[pane].current?.focus(), [refs]);
  const shell = useMemo<ShellState>(
    () => ({ main, focusPane, focusedPane, stacked }),
    [main, focusPane, focusedPane, stacked],
  );

  const pane = (name: ShellPane) => (
    <section
      ref={refs[name]}
      data-pane={name}
      data-slot="shell-pane"
      aria-label={paneLabels?.[name] ?? PANE_LABEL[name]}
      tabIndex={-1}
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-bg outline-none',
        'focus-visible:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg)]',
        stacked
          ? 'h-full shrink-0 border-0 border-b border-solid border-line last:border-b-0'
          : 'size-full',
      )}
    >
      {nodes[name]}
    </section>
  );

  return (
    <ShellContext.Provider value={shell}>
      <div
        ref={root}
        data-slot="app-shell"
        data-go={go ? '' : undefined}
        data-stacked={stacked ? '' : undefined}
        className={cn(
          'relative grid h-dvh w-full overflow-hidden bg-bg font-(family-name:--family-sans) text-fg',
          'grid-cols-[var(--size-rail)_minmax(0,1fr)] grid-rows-[var(--size-top)_minmax(0,1fr)_var(--size-status)]',
          className,
        )}
      >
        <div
          data-slot="shell-rail"
          className="row-span-3 flex min-h-0 flex-col items-stretch border-0 border-r border-solid border-line bg-bg py-(--space-2_5)"
        >
          {railHead}
          <nav aria-label={railLabel} data-slot="shell-modes" className="flex flex-col">
            {rail}
          </nav>
          <div className="min-h-0 flex-1" />
          {railFoot !== undefined && (
            <div data-slot="shell-rail-foot" className="flex flex-col">
              {railFoot}
            </div>
          )}
        </div>

        <header
          data-slot="shell-top"
          className="relative col-start-2 row-start-1 flex min-w-0 items-center gap-bar-gap border-0 border-b border-solid border-line pr-bar-x pl-(--space-3)"
        >
          {topStart !== undefined && (
            <div
              data-slot="shell-top-start"
              className={cn(
                'flex min-w-0 items-center gap-bar-gap',
                DIM,
                go && 'opacity-(--opacity-dim)',
              )}
            >
              {topStart}
            </div>
          )}
          {topCenter !== undefined && (
            <div
              data-slot="shell-top-center"
              className={cn(
                'absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center',
                DIM,
                go && 'opacity-(--opacity-dim)',
              )}
            >
              {topCenter}
            </div>
          )}
          {topEnd !== undefined && (
            <div
              data-slot="shell-top-end"
              className={cn(
                'ml-auto flex items-center gap-(--space-4)',
                DIM,
                go && 'opacity-(--opacity-dim)',
              )}
            >
              {topEnd}
            </div>
          )}
        </header>

        <main
          ref={setMain}
          data-slot="shell-main"
          className={cn(
            'relative col-start-2 row-start-2 min-h-0 min-w-0',
            stacked && present.length > 0 ? 'flex flex-col overflow-y-auto' : 'overflow-hidden',
            DIM,
            go && 'opacity-(--opacity-dim)',
          )}
        >
          {present.length === 0 ? (
            children
          ) : stacked ? (
            present.map((name) => <Fragment key={name}>{pane(name)}</Fragment>)
          ) : (
            <ResizablePanelGroup
              data-slot="shell-panes"
              defaultLayout={defaultLayout}
              onLayoutChanged={(layout, meta) => {
                // The group's own first layout isn't the operator's; only theirs is stored.
                if (meta.isUserInteraction) onLayoutChanged?.(layout, meta);
              }}
            >
              {present.flatMap((name, i) => [
                ...(i > 0 ? [<ResizableHandle key={`${name}-edge`} />] : []),
                <ResizablePanel
                  key={name}
                  id={name}
                  defaultSize={PANE_SIZE[name].defaultSize}
                  minSize={PANE_SIZE[name].minSize}
                >
                  {pane(name)}
                </ResizablePanel>,
              ])}
            </ResizablePanelGroup>
          )}
        </main>

        <StatusBar
          data-slot="shell-status"
          className={cn('col-start-2 row-start-3', DIM, go && 'opacity-(--opacity-dim)')}
          status={status}
          focusKeys={focusKeys}
          pageKeys={present.length > 0 ? [...PANE_HINTS, ...pageKeys] : pageKeys}
          lamp={lamp}
        />

        <GoBar />
        {overlays}
      </div>
    </ShellContext.Provider>
  );
}

/**
 * Whether the panes stack: forced by the prop, or the shell narrower than `lg`. Measured on the
 * shell itself (it fills the window in the app), so the server renders panes.
 */
function useStacked(root: RefObject<HTMLElement | null>, forced: boolean | undefined): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (forced !== undefined || el === null) return;
    const check = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      setNarrow(el.getBoundingClientRect().width < STACK_BELOW_REM * rem);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, forced]);
  return forced ?? narrow;
}

export { AppShell, type AppShellProps, ShellRailItem, type ShellRailItemProps };
