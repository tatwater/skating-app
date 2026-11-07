import type { DialogRoot } from '@base-ui/react/dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faLocationDot } from '@fortawesome/sharp-light-svg-icons';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../kit/dialog';
import { Kbd } from '../../kit/kbd';
import { Skeleton } from '../../kit/skeleton';
import { escBelongsElsewhere, type FocusReturn, restoreFocus } from './panelNavigation';

/**
 * The inset card (B03 §1.8; boards 2.1–2.9): what opens from a lake's sidebar — a report, a hazard,
 * a bounty — sits on a square card over the sidebar, 12 px in, the sidebar dimmed behind it. Its head
 * is one full-width zone, "‹ Back to Mascoma Lake · Esc"; its body scrolls; its foot holds the actions.
 *
 * Built on the kit Dialog in its **scoped** mode (portaled into the sidebar column, scrim and all),
 * non-modal — the map beside it stays live, a click on another hazard opens that one — and never
 * dismissed by a press outside it. Esc and the head close it; both call `onClose`, which navigates
 * (the card is a route). Focus is moved in on open and put back by hand on close
 * (`panelNavigation.ts`), because a route unmounting is not a dialog closing.
 */

/** The element the card portals into: the sidebar's column (or, in a story, a quad). */
const ColumnContext = createContext<HTMLElement | null>(null);

/**
 * Something inside the card that Esc should close first — an armed confirm. One Esc per screen, and
 * it closes the outermost thing: while one of these is registered, Esc disarms it and the card stays.
 */
const CardEscapeContext = createContext<(handler: () => void) => () => void>(() => () => {});

/** Registers `handler` as the card's Esc while `active`; the most recent registration wins. */
export function useCardEscape(active: boolean, handler: () => void): void {
  const register = useContext(CardEscapeContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    return register(() => latest.current());
  }, [active, register]);
}

/**
 * The lake sidebar's position (27.5 rem, the boards' 440 px): what the card sits over. `behind` is
 * whatever the card dims — the lake's sidebar once it can be rendered under a card (a seam with the
 * Explore sidebar's frame); until then the column is bare ground.
 */
export function PanelColumn({
  behind,
  children,
  className,
}: {
  behind?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setEl}
      data-slot="panel-column"
      className={cn(
        'relative isolate h-full w-[27.5rem] max-w-full shrink-0 overflow-hidden border-r border-solid border-line bg-bg',
        className,
      )}
    >
      {behind}
      <ColumnContext.Provider value={el}>{el !== null && children}</ColumnContext.Provider>
    </div>
  );
}

export interface InsetCardProps {
  /** The lake (or bay) the head goes back to: "Back to Mascoma Lake". `null` while it's unknown. */
  backTo: string | null;
  /** Esc and the head. The card is a route, so this navigates; see `useClosePanel`. */
  onClose: () => void;
  /** The `data-panel-trigger` key of the row that opens this card, where focus returns. */
  returnKey: string;
  /** The card's name while it has no title of its own (loading, unavailable): "Report". */
  label: string;
  /** The actions, ruled off at the card's foot. */
  foot?: ReactNode;
  children: ReactNode;
  /** Portal target, when not inside a `PanelColumn`. */
  container?: HTMLElement | null;
}

export function InsetCard({
  backTo,
  onClose,
  returnKey,
  label,
  foot,
  children,
  container,
}: InsetCardProps) {
  const column = useContext(ColumnContext);
  const target = container ?? column;
  const popupRef = useRef<HTMLDivElement>(null);

  // What held focus as the card opened — kept only if it sits outside the card (an opener that
  // survived the route change: a card drawn over a sidebar that stayed mounted).
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);

  // Focus moves in by hand: the popup itself, so a reader starts at the card's title.
  useEffect(() => {
    const popup = popupRef.current;
    if (popup !== null && !popup.contains(document.activeElement)) popup.focus();
  }, []);

  // And back out by hand, whenever the card goes — by its own close or by the browser's Back.
  const returnTo = useRef<FocusReturn>({ opener: null, key: returnKey });
  returnTo.current = { opener: opener.current, key: returnKey };
  useEffect(() => () => restoreFocus(returnTo.current), []);

  const inner = useRef<Array<() => void>>([]);
  const registerEscape = useCallback((handler: () => void) => {
    inner.current.push(handler);
    return () => {
      inner.current = inner.current.filter((h) => h !== handler);
    };
  }, []);

  const onOpenChange = useCallback(
    (open: boolean, details: DialogRoot.ChangeEventDetails) => {
      if (open) return;
      if (details.reason === 'escape-key') {
        if (escBelongsElsewhere()) return;
        const disarm = inner.current[inner.current.length - 1];
        if (disarm !== undefined) {
          disarm();
          return;
        }
      }
      onClose();
    },
    [onClose],
  );

  return (
    <Dialog open modal={false} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        container={target}
        aria-label={label}
        initialFocus={popupRef}
        finalFocus={false}
        data-slot="inset-card"
        className={cn(
          // The card's place: 12 px in from every edge of what it covers.
          // Above the scrim that dims what it covers. The column is its own stacking context
          // (`isolate`), so these layers never rise over the page's menus and tips.
          'inset-(--space-3) h-auto max-h-none w-auto max-w-none translate-x-0 translate-y-0 z-(--z-sheet)',
          // The ring that lifts it off the dimmed sidebar, and the corner squares of an inset card.
          'shadow-[0_0_0_5px_var(--bg),var(--box-shadow-modal)] corner-dots [--dot-color:var(--fg3)] [--dot-opacity:1]',
        )}
      >
        <DialogClose
          data-attr="inset-card-back"
          render={
            <Button
              className={cn(
                // The kit's outlined action, laid out as one full-width zone: the raised ground,
                // ruled off below, no ring and no corner dots (the card's corners carry those).
                'h-11 w-full shrink-0 justify-start rounded-none bg-raise pr-(--space-3) pl-(--space-4) inset-ring-0',
                'border-0 border-b border-solid border-line2 [--dot-opacity:0] lit:[--dot-opacity:0]',
                '[&>[data-slot=label]]:flex-1 [&>[data-slot=label]]:gap-(--space-2_5)',
              )}
            />
          }
        >
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" className="h-3 text-fg2" />
          {backTo === null ? 'Back' : `Back to ${backTo}`}
          <Kbd className="ml-auto" aria-hidden="true">
            Esc
          </Kbd>
        </DialogClose>
        <CardEscapeContext.Provider value={registerEscape}>
          <div
            data-slot="inset-card-body"
            // Report text, names and comments: never autocaptured (D240).
            className="ph-no-capture flex min-h-0 flex-1 flex-col gap-(--space-5_5) overflow-y-auto px-(--space-4) pb-(--space-6) text-body leading-body text-fg1"
          >
            {children}
          </div>
        </CardEscapeContext.Provider>
        {foot !== undefined && (
          <div
            data-slot="inset-card-foot"
            className="flex h-[3.625rem] shrink-0 items-center gap-(--space-2) border-t border-solid border-line2 px-(--space-4)"
          >
            {foot}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What the card is about: its kind (a kicker), its title, and where. Ruled off from the body. */
export function CardHead({
  kind,
  title,
  where,
}: {
  kind: string;
  title: ReactNode;
  where?: ReactNode;
}) {
  return (
    <div
      data-slot="card-head"
      className="-mx-(--space-4) flex shrink-0 flex-col gap-(--space-2_5) border-b border-solid border-line px-(--space-4) pt-(--space-4_5) pb-(--space-4)"
    >
      <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
        {kind}
      </span>
      <DialogTitle className="text-disp leading-(--lead-snug) font-semibold tracking-key text-fg uppercase">
        {title}
      </DialogTitle>
      {where !== undefined && (
        <div className="flex items-center gap-(--space-1_5) text-assist text-fg2">{where}</div>
      )}
    </div>
  );
}

/** The pin before a place line ("The Narrows, by Shaker Bridge · Mascoma North"). */
export function PlaceGlyph() {
  return (
    <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" className="h-[0.6875rem] text-fg3" />
  );
}

/** A labeled block in a card's body: a small kicker over its content. */
export function CardSection({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-(--space-2)', className)}>
      <h3 className="m-0 text-[0.625rem] leading-none font-medium tracking-head text-fg3 uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** A soft note in the card (the staleness caveat, a season note): raised ground, square. */
export function CardNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 bg-raise px-(--space-3_5) py-(--space-3) text-assist leading-body text-fg1">
      {children}
    </p>
  );
}

/** The hairline between a card's content and its questions. */
export function CardRule() {
  return <hr className="m-0 h-px shrink-0 border-0 bg-line" />;
}

/** 2.8: the card loading — its head and a few blocks, the sizes of what comes. */
export function PanelLoading() {
  return (
    <div data-slot="panel-loading" aria-busy="true" className="flex flex-col gap-(--space-5_5)">
      <span className="sr-only">Loading</span>
      <div className="-mx-(--space-4) flex flex-col gap-(--space-2_5) border-b border-solid border-line px-(--space-4) pt-(--space-4_5) pb-(--space-4)">
        <Skeleton className="h-[0.6875rem] w-16" />
        <Skeleton className="mt-(--space-1) h-6 w-[62%]" />
        <Skeleton className="h-3.5 w-[44%]" />
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** 2.9: the thing isn't there — said inside the card, with what's still true. */
export function PanelUnavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-slot="panel-unavailable" className="flex flex-col gap-(--space-3) pt-(--space-7)">
      <span className="mb-(--space-1_5) flex size-10 items-center justify-center border border-solid border-line2 text-fg2">
        <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" className="h-[1.0625rem]" />
      </span>
      <DialogTitle className="text-disp leading-(--lead-snug) font-semibold tracking-key text-fg uppercase">
        {title}
      </DialogTitle>
      <p className="m-0 text-body leading-body text-fg2">{children}</p>
    </div>
  );
}
