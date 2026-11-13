import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { isTextEntry, KeyBindingError, modKey } from '@/lib/keys';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { cn } from '@/lib/utils';

import { Button } from './button';
import { Kbd } from './kbd';

/**
 * The kit's Toast: Base UI's Toast, drawn as the states sheet's toast — the console's receipt for
 * an operator action, and the home of its ten-second Undo.
 *
 * - **A square plate** in the solid plate ground with a strong-rule edge and the action bar's
 *   shadow; a 6 px **tone stripe** at its left (gray, white for done, amber, red), then the title
 *   in the row step with its sub-line in the assist step, then the **action** at its right.
 * - **The action slot is load-bearing.** Every operator action undoes from its toast for ten
 *   seconds (then from History), so the action — Undo, canonically, with its key — is part of the
 *   toast, not an afterthought. Pressing it runs the action and closes the toast.
 * - **The time left is visible**: a 2 px bar along the foot shrinks to nothing as the toast's time
 *   runs out, and a toast with an action counts its seconds beside it. Both **pause while the
 *   toasts are hovered or focused, or the window is in the background** — exactly when Base UI
 *   holds the dismissal timer — so what the bar shows is what will happen.
 * - **One at a time**, docked at the rail's edge over the status bar, never over a decision; a newer
 *   toast takes the place of an older one (the older stays in History). A taller limit stacks them,
 *   each peeking above the one in front, and a hover fans them out.
 * - **Motion** rides the motion tokens: a toast slides up and fades in, and leaves the way it came
 *   (or the way it was swiped — left or down). Under reduced motion every move collapses to a fade,
 *   and the time bar ticks once a second instead of gliding.
 * - **The action's key works** while its toast is shown: the cap it wears (`kbd`, "⌘Z") is bound
 *   for as long as the toast is on screen — not while it waits behind the limit or is leaving —
 *   and released when it closes or is replaced. Two shown toasts claiming the same key: the one
 *   in front (the newer) wins, however they arrived. A key
 *   with ⌘ (or Ctrl, ⌥) acts from anywhere but a text field, where the field's own key (its undo)
 *   wins; a plain key (⏎, Esc) acts only when nothing has focus, since every control, list and
 *   dialog uses those. A key some handler already took (`defaultPrevented`) is left alone. Like
 *   every binding in the console, never J, K or a number key.
 * - **Safety (binding):** toast copy reports what an operator did ("Rate updated", "Photo hidden").
 *   It never says or implies that ice is safe, skateable or clear.
 */

/** How long an operator action can be undone from its toast. */
const UNDO_WINDOW_MS = 10_000;

type ToastTone = 'default' | 'lit' | 'warn' | 'bad';

/** The action at the toast's right: Undo, canonically. */
type ToastAction = {
  /** The verb, capitalized ("Undo", "Retry", "Stay"); the button sets it in caps. */
  label: string;
  /** Runs when it is pressed; the toast closes after. */
  onAction: () => void;
  /**
   * The key that does the same thing, shown as a cap inside the button ("⌘Z", "⇧⏎", "Esc") and
   * bound while the toast is shown. ⌘ is the platform's command key (Ctrl off a Mac).
   */
  kbd?: string;
};

type ToastData = { action?: ToastAction };

// ── The action's key ─────────────────────────────────────────────────────────────────────────

/** A toast action's key, read from the cap it wears. */
type ToastKey = {
  /** `KeyboardEvent.key` for a named key ("Enter"), or the character ("Z", "?"). */
  key: string;
  /** ⌘: the platform's command key (Meta on a Mac, Control elsewhere). */
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

/** Named keys as their caps read (the status bar's caps, and the spelled-out forms). */
const NAMED_CAPS: Partial<Record<string, string>> = {
  '⏎': 'Enter',
  Enter: 'Enter',
  Esc: 'Escape',
  Escape: 'Escape',
  Del: 'Delete',
  Delete: 'Delete',
  '⌫': 'Backspace',
  Backspace: 'Backspace',
};

const MODIFIER_CAPS: readonly [string | RegExp, keyof Omit<ToastKey, 'key'>][] = [
  ['⌘', 'mod'],
  ['⇧', 'shift'],
  ['⌥', 'alt'],
  ['⌃', 'ctrl'],
  [/^Ctrl\b/, 'ctrl'],
];

/**
 * Reads a cap ("⌘Z", "⇧⏎", "Ctrl Z", "Esc") as the key it names. A cap the kit can't bind — or one
 * the console's rules refuse (J, K, a number key) — throws at render, so a toast never wears a key
 * that does nothing.
 */
function parseToastKey(cap: string): ToastKey {
  const parsed: ToastKey = { key: '', mod: false, ctrl: false, shift: false, alt: false };
  let rest = cap.trim();
  for (let found = true; found; ) {
    found = false;
    for (const [mark, flag] of MODIFIER_CAPS) {
      const m =
        typeof mark === 'string' ? (rest.startsWith(mark) ? mark : null) : mark.exec(rest)?.[0];
      if (m == null) continue;
      parsed[flag] = true;
      rest = rest.slice(m.length).trimStart();
      found = true;
    }
  }
  const key = NAMED_CAPS[rest] ?? ([...rest].length === 1 ? rest.toUpperCase() : undefined);
  if (key === undefined) {
    throw new KeyBindingError(`"${cap}" is not a key a toast can bind.`);
  }
  if (key === 'J' || key === 'K' || /^[0-9]$/.test(key)) {
    throw new KeyBindingError(`"${cap}" is refused: J, K and number keys are never bound.`);
  }
  return { ...parsed, key };
}

/** Whether `event` is the key, with exactly its modifiers (⌘ read as `mod`'s key). */
function toastKeyMatches(
  k: ToastKey,
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mod: 'Meta' | 'Control',
): boolean {
  const meta = k.mod && mod === 'Meta';
  const ctrl = k.ctrl || (k.mod && mod === 'Control');
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== k.alt) return false;
  // A letter by its place on the keyboard (⌥ and ⇧ change the character, not the code).
  if (/^[A-Z]$/.test(k.key)) return event.shiftKey === k.shift && event.code === `Key${k.key}`;
  // Punctuation carries its own shift ("?" is ⇧/).
  if ([...k.key].length === 1) return event.key === k.key;
  return event.shiftKey === k.shift && event.key === k.key;
}

/** Whether the focused element keeps this key for itself (see the doc above). */
function focusOwnsToastKey(k: ToastKey): boolean {
  const el = document.activeElement;
  if (isTextEntry(el)) return true;
  if (k.mod || k.ctrl || k.alt) return false;
  return el !== null && el !== document.body;
}

/** A shown toast's claim on its action's key. */
type KeyClaim = { key: ToastKey; run: () => void };

/** Claims (or, with `null`, releases) a toast's key in its Toaster. */
// The default only serves a toast drawn outside a Toaster — a misuse, not a case worth a test.
/* v8 ignore next */
const ClaimKeyContext = createContext<(id: string, claim: KeyClaim | null) => void>(() => {});

type ToastOptions = {
  /** What happened, in the row step ("Photo hidden · Mascoma Lake"). */
  title: ReactNode;
  /** The consequence or the next step, in the assist step. */
  description?: ReactNode;
  /** The stripe: gray by default, `lit` for done, `warn` waits on a person, `bad` failed. */
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before it dismisses; the Toaster's default (ten seconds) otherwise; 0 never. */
  timeout?: number;
  /** Reusing an id updates that toast in place and restarts its time. */
  id?: string;
  onClose?: () => void;
};

/** A toast queue. The app has one (`toastManager`); a story or a test makes its own. */
const createToastManager = ToastPrimitive.createToastManager;

/** The app's one toast queue: `toast()` adds to it, and the app's `<Toaster />` draws it. */
const toastManager = createToastManager();

type ToastManager = typeof toastManager;

/** Queue a toast — from anywhere, React tree or not. Returns its id. */
function toast(options: ToastOptions, manager: ToastManager = toastManager): string {
  const { tone = 'default', action, ...rest } = options;
  return manager.add<ToastData>({
    ...rest,
    type: tone,
    // A failure interrupts; everything else is announced politely.
    priority: tone === 'bad' ? 'high' : 'low',
    data: { action },
  });
}

type ToasterProps = {
  /** The queue to draw. The app's one queue by default; a story or a test passes its own. */
  manager?: ToastManager;
  /** How many show at once. One, by the console's rule; a newer one replaces the older. */
  limit?: number;
  /** The default time before a toast dismisses: the undo window. */
  timeout?: number;
  /**
   * Where the dock sits. `rail` (the console): past the rail, over the status bar. `edge` (skater,
   * which has neither): the gutter in from the bottom-left corner.
   */
  placement?: 'rail' | 'edge';
  /** Draws the dock inside its positioned container instead of the window (a story's frame). */
  contained?: boolean;
  /** Where the dock is portaled (a four-up quad, so it takes that quad's theme). */
  container?: HTMLElement | null;
  /** Components that call `useToastManager()` go inside. */
  children?: ReactNode;
};

/** Mounted once, near the app's root: the dock and every toast in it. */
function Toaster({
  manager = toastManager,
  limit = 1,
  timeout = UNDO_WINDOW_MS,
  placement = 'rail',
  contained = false,
  container,
  children,
}: ToasterProps) {
  // The shown toasts' keys, by toast id. Which claim wins is read at the key press from the
  // toasts' current order (`stack`, front first) — never from when a claim was made: two toasts
  // that mount in one render claim in effect order, which is the list's, front first, so the
  // last claim would be the older toast's.
  const claims = useRef(new Map<string, KeyClaim>());
  const stack = useRef<readonly string[]>([]);
  const claimKey = useCallback((id: string, claim: KeyClaim | null) => {
    if (claim === null) claims.current.delete(id);
    else claims.current.set(id, claim);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const mod = modKey();
      // The frontmost shown toast that claims the key.
      let hit: KeyClaim | undefined;
      for (const id of stack.current) {
        const claim = claims.current.get(id);
        if (claim !== undefined && toastKeyMatches(claim.key, event, mod)) {
          hit = claim;
          break;
        }
      }
      if (hit === undefined || focusOwnsToastKey(hit.key)) return;
      event.preventDefault();
      hit.run();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={limit} timeout={timeout}>
      <ClaimKeyContext.Provider value={claimKey}>
        {children}
        <ToastPrimitive.Portal container={container}>
          <ToastPrimitive.Viewport
            data-slot="toast-viewport"
            data-placement={placement}
            className={cn(
              'z-(--z-toast) outline-none',
              contained ? 'absolute inset-x-0 bottom-0' : 'fixed',
              !contained &&
                placement === 'rail' && [
                  'bottom-[calc(var(--size-status)+var(--gap-heading))] left-[calc(var(--size-rail)+var(--gap-bar-x))]',
                  'w-[min(var(--size-sheet-sm),calc(100vw-var(--size-rail)-2*var(--gap-bar-x)))]',
                ],
              !contained &&
                placement === 'edge' &&
                'bottom-gutter left-gutter w-[min(var(--size-sheet-sm),calc(100vw-2*var(--gap-gutter)))]',
            )}
          >
            <ToastList timeout={timeout} stack={stack} />
          </ToastPrimitive.Viewport>
        </ToastPrimitive.Portal>
      </ClaimKeyContext.Provider>
    </ToastPrimitive.Provider>
  );
}

function ToastList({
  timeout,
  stack,
}: {
  timeout: number;
  /** Where the Toaster's key listener reads the toasts' order: their ids, front (newest) first. */
  stack: RefObject<readonly string[]>;
}) {
  const { toasts } = ToastPrimitive.useToastManager();
  useLayoutEffect(() => {
    stack.current = toasts.map((t) => t.id);
  }, [toasts, stack]);
  return toasts.map((t) => <KitToast key={t.id} toast={t} defaultTimeout={timeout} />);
}

/** Whether the dock is expanded (hovered or focused) — Base UI's own state, read in the toast. */
const ExpandedContext = createContext(false);

/** The plate, the stripe's ink per tone (the toast's `data-type`), the stack and the motion. */
const ROOT = [
  // The plate — in the kit's face by name, as every kit popup is, since it portals to `body`.
  'absolute bottom-0 left-0 w-full overflow-hidden select-none',
  'rounded-container border border-solid border-line2 bg-plate-solid shadow-actbar',
  'font-(family-name:--family-sans)',
  'outline-none focus-visible:shadow-focus',
  '[--stripe:var(--fg2)] data-[type=lit]:[--stripe:var(--fg)]',
  'data-[type=warn]:[--stripe:var(--warn)] data-[type=bad]:[--stripe:var(--bad)]',
  // The stack: each toast behind the front one peeks above it; a hover fans them out.
  '[--gap:var(--space-2)] [--peek:var(--space-1_5)] z-[calc(1000-var(--toast-index))]',
  'translate-x-(--toast-swipe-movement-x)',
  'translate-y-[calc(var(--toast-swipe-movement-y)-var(--toast-index)*var(--peek))]',
  'data-expanded:translate-y-[calc(var(--toast-swipe-movement-y)-var(--toast-offset-y)-var(--toast-index)*var(--gap))]',
  'data-limited:opacity-0',
  // Arriving: up from below, fading in. Leaving: the way it came, or the way it was swiped.
  'transition-[translate,opacity] duration-(--duration-base) ease-enter data-ending-style:ease-exit',
  'data-starting-style:translate-y-full data-starting-style:opacity-0',
  'data-ending-style:opacity-0 [&[data-ending-style]:not([data-swipe-direction])]:translate-y-full',
  'data-ending-style:data-[swipe-direction=left]:translate-x-[calc(var(--toast-swipe-movement-x)-100%)]',
  'data-ending-style:data-[swipe-direction=down]:translate-y-[calc(var(--toast-swipe-movement-y)+100%)]',
  // Reduced motion: arriving and leaving are fades only.
  'motion-reduce:data-starting-style:translate-y-0',
  'motion-reduce:[&[data-ending-style]:not([data-swipe-direction])]:translate-y-0',
];

type ToastObject = ToastPrimitive.Root.ToastObject<ToastData>;

function KitToast({ toast: t, defaultTimeout }: { toast: ToastObject; defaultTimeout: number }) {
  const manager = ToastPrimitive.useToastManager();
  const action = t.data?.action;
  const timeout = t.timeout ?? defaultTimeout;
  const timed = timeout > 0 && t.type !== 'loading';
  // The time bar's animation, which the countdown reads.
  const time = useRef<Animation | null>(null);

  // The action's key, bound while this toast is shown: not behind the limit, not leaving.
  const kbd = action?.kbd;
  const key = useMemo(() => (kbd === undefined ? null : parseToastKey(kbd)), [kbd]);
  const shown = !t.limited && t.transitionStatus !== 'ending';
  const claimKey = use(ClaimKeyContext);
  // The press, kept current without re-claiming: the manager's handle is new every render, and
  // re-claiming on it would churn the claims for nothing.
  const pressNow = () => {
    action?.onAction();
    manager.close(t.id);
  };
  const press = useRef(pressNow);
  press.current = pressNow;
  useEffect(() => {
    if (key === null || !shown) return;
    claimKey(t.id, { key, run: () => press.current() });
    return () => claimKey(t.id, null);
  }, [key, shown, claimKey, t.id]);

  return (
    <ToastPrimitive.Root
      toast={t}
      data-slot="toast"
      swipeDirection={['left', 'down']}
      className={cn(ROOT)}
      render={(props, state) => (
        <ExpandedContext.Provider value={state.expanded}>
          <div {...props} />
        </ExpandedContext.Provider>
      )}
    >
      <ToastPrimitive.Content
        data-slot="toast-content"
        className={cn(
          'grid grid-cols-[var(--stroke-tick)_minmax(0,1fr)_auto] items-center gap-(--space-3)',
          'py-(--space-2_5) pe-(--space-3)',
          'transition-opacity duration-(--duration-base) ease-standard data-behind:opacity-0 data-expanded:opacity-100',
        )}
      >
        <span data-slot="toast-stripe" aria-hidden="true" className="self-stretch bg-(--stripe)" />
        <span className="flex min-w-0 flex-col gap-(--space-0_5)">
          <ToastPrimitive.Title
            data-slot="toast-title"
            className="text-row leading-list font-regular text-fg"
          />
          <ToastPrimitive.Description
            data-slot="toast-description"
            className="text-assist leading-list font-regular text-fg3 empty:hidden"
          />
        </span>
        {action !== undefined && (
          <span data-slot="toast-actions" className="flex items-center gap-(--space-2)">
            {timed && <Countdown key={t.updateKey} time={time} duration={timeout} />}
            <ToastPrimitive.Action
              data-slot="toast-action"
              aria-keyshortcuts={action.kbd}
              render={<Button size="sm" />}
              onClick={() => {
                action.onAction();
                manager.close(t.id);
              }}
            >
              {action.label}
              {action.kbd !== undefined && (
                <Kbd aria-hidden variant="dim">
                  {action.kbd}
                </Kbd>
              )}
            </ToastPrimitive.Action>
          </span>
        )}
      </ToastPrimitive.Content>
      {/* Keyed by the update count: a toast updated in place starts its time over. */}
      {timed && <TimeBar key={t.updateKey} time={time} duration={timeout} />}
    </ToastPrimitive.Root>
  );
}

/** Whether the window has focus — Base UI holds every toast's timer while it doesn't. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const blur = () => setFocused(false);
    const focus = () => setFocused(true);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
    };
  }, []);
  return focused;
}

type TimeProps = {
  /** The toast's time-bar animation: the bar writes it, the countdown reads it. */
  time: RefObject<Animation | null>;
  duration: number;
};

/**
 * The 2 px bar along the toast's foot: the time left. It glides (ticks once a second under reduced
 * motion) and holds whenever the dismissal timer does.
 */
function TimeBar({ time, duration }: TimeProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const expanded = use(ExpandedContext);
  const windowFocused = useWindowFocused();
  const reduced = useReducedMotion();
  const paused = expanded || !windowFocused;

  useEffect(() => {
    const el = ref.current;
    /* v8 ignore next */
    if (el === null) return;
    const a = el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration,
      easing: reduced ? `steps(${Math.max(1, Math.round(duration / 1000))}, end)` : 'linear',
      fill: 'forwards',
    });
    time.current = a;
    return () => {
      a.cancel();
      time.current = null;
    };
  }, [duration, reduced, time]);

  useEffect(() => {
    const a = time.current;
    /* v8 ignore next */
    if (a === null) return;
    if (paused) a.pause();
    else a.play();
  }, [paused, time]);

  return (
    <span
      ref={ref}
      data-slot="toast-timebar"
      data-paused={paused ? '' : undefined}
      aria-hidden="true"
      className="absolute bottom-0 left-0 h-(--stroke-note) w-full origin-left bg-fg3"
    />
  );
}

/**
 * The seconds left, beside the action ("8 s"): read from the time bar's own animation, so it holds
 * when the bar holds and the two never disagree.
 */
function Countdown({ time, duration }: TimeProps) {
  // Full time until the bar's animation exists, so the slot never changes width on arrival.
  const [seconds, setSeconds] = useState(() => Math.ceil(duration / 1000));
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = time.current;
      // The bar mounts with the countdown, so it is always there; the guard is for the type.
      /* v8 ignore next */
      if (a === null) return;
      setSeconds(Math.max(0, Math.ceil((duration - Number(a.currentTime ?? 0)) / 1000)));
    }, 250);
    return () => window.clearInterval(id);
  }, [time, duration]);
  return (
    <span
      data-slot="toast-countdown"
      // Read once by a screen reader as part of the toast; the ticking isn't announced.
      aria-hidden="true"
      className="font-(family-name:--family-mono) text-kick leading-none tracking-value text-fg3 tabular-nums"
    >
      {seconds} s
    </span>
  );
}

export {
  createToastManager,
  parseToastKey,
  type ToastAction,
  Toaster,
  type ToasterProps,
  type ToastKey,
  type ToastManager,
  type ToastOptions,
  type ToastTone,
  toast,
  toastKeyMatches,
  toastManager,
  UNDO_WINDOW_MS,
};
