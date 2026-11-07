import {
  type ComponentProps,
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';
import { Separator } from './separator';

/**
 * The console's status bar (admin only): the page's state on the left, the keys that work here and
 * the connection lamp on the right — the 26 px strip locked to the viewport's foot.
 *
 * - **Status groups** (`status`): kicker caps in the quiet ink, lit, amber or red by meaning only;
 *   the groups (inbox · machinery · corpus) are split by the strong vertical rule. The bar never
 *   restates the page's name or a count the rail already carries.
 * - **Keys, per page and per focus** (`pageKeys`, `focusKeys`): each a recessed key cap and its
 *   words. The focused pane's keys lead; a key both lists name is the focused pane's.
 * - **A key a visible button already wears is not repeated** (the key registry): a button that
 *   shows a cap claims its key (`useClaimKey`), and the bar drops every claimed key. The same rule
 *   drops keys the console never binds for lists — number keys and J/K (Tab, the arrows and
 *   type-ahead move through lists).
 * - **The lamp** (`StatusLamp`): a small square LED and its words — live (white, breathing on the
 *   2400 ms lamp timing), idle (dim and still), amber or red. It holds still under reduced motion.
 */

// ── The key registry ─────────────────────────────────────────────────────────────────────────

type KeyHint = {
  /** The key as its cap shows it ("Esc", "⇧⏎", "Tab", "↑↓"). */
  keys: string;
  /** What it does here, lowercase ("close", "go to"). */
  label: string;
};

/** Keys compare by what they say, not how they're cased or spaced ("esc" is "Esc"). */
function normalizeKey(keys: string): string {
  return keys.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Keys the console never binds for lists: number keys (1–9) and J/K. */
const LIST_KEYS = /^(\d|J ?\/? ?K$)/;

/**
 * The hints the bar shows: in order, each key once (the first listing wins), without a key a
 * visible button already wears, and without the list keys the console never binds.
 */
function visibleKeyHints(hints: readonly KeyHint[], claimed: Iterable<string> = []): KeyHint[] {
  const seen = new Set(Array.from(claimed, normalizeKey));
  const out: KeyHint[] = [];
  for (const hint of hints) {
    const key = normalizeKey(hint.keys);
    if (seen.has(key) || LIST_KEYS.test(key)) continue;
    seen.add(key);
    out.push(hint);
  }
  return out;
}

type KeyRegistry = {
  /** Claim a key while a button wearing it is on screen; the returned function lets it go. */
  claim: (keys: string) => () => void;
  subscribe: (onChange: () => void) => () => void;
  /** The keys claimed right now (the same set until a claim changes). */
  snapshot: () => ReadonlySet<string>;
};

/** A registry: a count per key, so two buttons wearing one key both have to go before it returns. */
function createKeyRegistry(): KeyRegistry {
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let current: ReadonlySet<string> = new Set();
  const changed = () => {
    current = new Set(counts.keys());
    for (const listener of listeners) listener();
  };
  return {
    claim(keys) {
      const key = normalizeKey(keys);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      changed();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const left = (counts.get(key) ?? 1) - 1;
        if (left > 0) counts.set(key, left);
        else counts.delete(key);
        changed();
      };
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    snapshot: () => current,
  };
}

const KeyRegistryContext = createContext<KeyRegistry | null>(null);

/** Where buttons claim the keys they wear and the status bar reads them: one per console page. */
function KeyRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createKeyRegistry);
  return <KeyRegistryContext.Provider value={registry}>{children}</KeyRegistryContext.Provider>;
}

/**
 * A button that shows a key cap claims that key while it's mounted, so the status bar doesn't say
 * it twice. Pass `undefined` to claim nothing (a button with no key, or one that's hidden).
 */
function useClaimKey(keys: string | undefined): void {
  const registry = useContext(KeyRegistryContext);
  useEffect(() => {
    if (registry === null || keys === undefined) return;
    return registry.claim(keys);
  }, [registry, keys]);
}

const NOTHING: ReadonlySet<string> = new Set();
const noSubscription = () => () => {};

/** The keys claimed on this page right now; none outside a `KeyRegistryProvider`. */
function useClaimedKeys(): ReadonlySet<string> {
  const registry = useContext(KeyRegistryContext);
  return useSyncExternalStore(
    registry?.subscribe ?? noSubscription,
    registry?.snapshot ?? (() => NOTHING),
    registry?.snapshot ?? (() => NOTHING),
  );
}

// ── The bar's parts ──────────────────────────────────────────────────────────────────────────

const TONE = {
  default: 'text-fg3',
  lit: 'text-fg',
  warn: 'text-warn',
  bad: 'text-bad',
} as const;

type StatusTextProps = ComponentProps<'span'> & {
  /** The quiet ink, or lit, amber (needs a person) or red (failed) by meaning. */
  tone?: keyof typeof TONE;
};

/** One status item: kicker caps, colored only by what it means. */
function StatusText({ tone = 'default', className, ...props }: StatusTextProps) {
  return (
    <span
      data-slot="status-text"
      data-tone={tone}
      className={cn('whitespace-nowrap', TONE[tone], className)}
      {...props}
    />
  );
}

const LAMP = {
  live: { dot: 'bg-fg led [--led-glow:var(--glow)]', text: 'text-fg' },
  idle: { dot: 'bg-fg3', text: 'text-fg3' },
  warn: { dot: 'bg-warn led [--led-glow:var(--warn-glow)]', text: 'text-warn' },
  bad: { dot: 'bg-bad led [--led-glow:var(--bad-glow)]', text: 'text-bad' },
} as const;

type StatusLampProps = ComponentProps<'span'> & {
  /** Live (white, breathing), idle (dim, still), amber or red. */
  state?: keyof typeof LAMP;
};

/**
 * A lamp and its words: the connection ("Convex live"), or a machinery run ("Running · corpus
 * load", "Nothing running"). A status region, so a change is announced.
 */
function StatusLamp({ state = 'live', className, children, ...props }: StatusLampProps) {
  return (
    <span
      role="status"
      data-slot="status-lamp"
      data-state={state}
      className={cn(
        'inline-flex items-center gap-(--space-1_5) whitespace-nowrap',
        LAMP[state].text,
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="status-led"
        className={cn('size-(--space-1_5) shrink-0', LAMP[state].dot)}
      />
      {children}
    </span>
  );
}

type StatusBarProps = Omit<ComponentProps<'footer'>, 'children'> & {
  /** The page's state, in groups; the strong vertical rule stands between groups. */
  status?: readonly ReactNode[];
  /** Keys the focused pane listens for. They lead. */
  focusKeys?: readonly KeyHint[];
  /** Keys that work anywhere on the page. */
  pageKeys?: readonly KeyHint[];
  /** Keys already worn by a visible button, beyond those claimed through the registry. */
  claimed?: Iterable<string>;
  /** The lamp at the bar's right end (`StatusLamp`). */
  lamp?: ReactNode;
};

/** The status bar: status groups left; the keys that work here and the lamp right. */
function StatusBar({
  status = [],
  focusKeys = [],
  pageKeys = [],
  claimed = [],
  lamp,
  className,
  ...props
}: StatusBarProps) {
  const registered = useClaimedKeys();
  const keys = visibleKeyHints([...focusKeys, ...pageKeys], [...registered, ...claimed]);
  return (
    <footer
      data-slot="status-bar"
      className={cn(
        'flex h-status w-full min-w-0 shrink-0 items-center gap-(--space-5_5) overflow-hidden',
        'border-0 border-t border-solid border-line bg-bg px-(--space-3)',
        'text-kick leading-none font-medium tracking-label whitespace-nowrap text-fg3 uppercase',
        className,
      )}
      {...props}
    >
      {status.length > 0 && (
        <div data-slot="status-groups" className="flex min-w-0 items-center gap-(--space-3_5)">
          {status.map((group, i) => (
            // Groups are positional: the bar's layout, not data with identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: a group's place is its identity.
            <Fragment key={i}>
              {i > 0 && <Separator orientation="vertical" strong data-slot="status-sep" />}
              <span data-slot="status-group" className="flex items-center gap-(--space-5_5)">
                {group}
              </span>
            </Fragment>
          ))}
        </div>
      )}
      <div data-slot="status-end" className="ml-auto flex items-center gap-(--space-4)">
        {keys.length > 0 && (
          <ul
            aria-label="Keys"
            data-slot="status-keys"
            className="m-0 flex list-none items-center gap-(--space-3) p-0"
          >
            {keys.map((hint) => (
              <li
                key={normalizeKey(hint.keys)}
                data-slot="status-key"
                className="flex items-center gap-(--space-1_5) tracking-normal normal-case"
              >
                <Kbd variant="dim">{hint.keys}</Kbd>
                <span data-slot="status-key-label">{hint.label}</span>
              </li>
            ))}
          </ul>
        )}
        {lamp}
      </div>
    </footer>
  );
}

export {
  createKeyRegistry,
  type KeyHint,
  type KeyRegistry,
  KeyRegistryProvider,
  normalizeKey,
  StatusBar,
  type StatusBarProps,
  StatusLamp,
  type StatusLampProps,
  StatusText,
  type StatusTextProps,
  useClaimedKeys,
  useClaimKey,
  visibleKeyHints,
};
