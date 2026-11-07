import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { Kbd } from './kbd';
import { useReducedMotion } from './skeleton';

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
  /** The key that does the same thing, shown as a cap inside the button ("⌘Z"). */
  kbd?: string;
};

type ToastData = { action?: ToastAction };

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
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={limit} timeout={timeout}>
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
          <ToastList timeout={timeout} />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList({ timeout }: { timeout: number }) {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((t) => <KitToast key={t.id} toast={t} defaultTimeout={timeout} />);
}

/** Whether the dock is expanded (hovered or focused) — Base UI's own state, read in the toast. */
const ExpandedContext = createContext(false);

/** The plate, the stripe's ink per tone (the toast's `data-type`), the stack and the motion. */
const ROOT = [
  // The plate.
  'absolute bottom-0 left-0 w-full overflow-hidden select-none',
  'rounded-container border border-solid border-line2 bg-plate-solid shadow-actbar',
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
  type ToastAction,
  Toaster,
  type ToasterProps,
  type ToastManager,
  type ToastOptions,
  type ToastTone,
  toast,
  toastManager,
  UNDO_WINDOW_MS,
};
