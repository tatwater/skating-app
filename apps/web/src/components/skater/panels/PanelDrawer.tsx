import { createContext, type ReactNode, useContext, useState } from 'react';

import { cn } from '@/lib/utils';

import { Sheet, SheetContent, SheetHeader } from '../../kit/sheet';
import {
  CardEscapeProvider,
  CardInDrawerProvider,
  type InsetCardProps,
  useCardMechanics,
} from './InsetCard';

/**
 * Latest's open report (boards 4.5–4.7): the card a page hosts away from its lake, as a drawer from
 * the right over a scrim on the whole page — the kit Sheet at `md`, portaled into the page under the
 * top bar (`PanelDrawerHost`), so the bar stays lit and the page beneath stays mounted with its scroll.
 *
 * Same contract and mechanics as the inset card (`useCardMechanics`): focus moves in on open and
 * back to the row on close, Esc disarms an armed confirm before it closes, and every close calls
 * `onClose`, which navigates (the card is a URL). A press on the scrim closes it too, since nothing
 * under the scrim is live. The head names the card (its kind, said once — `CardHead` drops its own
 * kicker in here) and goes back to the host with its Esc key.
 */

/** Where a page's drawer portals: the page under its top bar. */
const DrawerTargetContext = createContext<HTMLElement | null>(null);

/**
 * The page a drawer covers: a positioned box around it, so the scrim and the drawer sit inside —
 * beside the page, never in its layout (a flex row would count the portal as a column). `drawer`
 * is the drawer itself, rendered once the box has mounted.
 */
export function PanelDrawerHost({
  className,
  drawer,
  children,
}: {
  className?: string;
  drawer?: ReactNode;
  children: ReactNode;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div ref={setEl} data-slot="panel-drawer-host" className={cn('relative', className)}>
      {children}
      <DrawerTargetContext.Provider value={el}>
        {el !== null && drawer}
      </DrawerTargetContext.Provider>
    </div>
  );
}

export function PanelDrawer({
  backTo,
  onClose,
  returnKey,
  label,
  foot,
  children,
  container,
}: InsetCardProps) {
  const host = useContext(DrawerTargetContext);
  const { popupRef, registerEscape, onOpenChange } = useCardMechanics(onClose, returnKey);
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        ref={popupRef}
        container={container ?? host}
        size="md"
        aria-label={label}
        initialFocus={popupRef}
        finalFocus={false}
        data-slot="panel-drawer"
      >
        <SheetHeader
          closeLabel={backTo === null ? 'Back' : `Back to ${backTo}`}
          className="pr-(--space-3)"
        >
          <span className="text-kick leading-none font-semibold tracking-kick whitespace-nowrap text-fg uppercase">
            {label}
          </span>
        </SheetHeader>
        <CardInDrawerProvider value={true}>
          <CardEscapeProvider value={registerEscape}>
            <div
              data-slot="panel-drawer-body"
              // Report text, names and comments: never autocaptured (D240).
              className="ph-no-capture flex min-h-0 flex-1 flex-col gap-(--space-5_5) overflow-y-auto px-(--card-pad) pb-(--space-14) text-body leading-body text-fg1 [--card-pad:var(--gap-gutter)]"
            >
              {children}
            </div>
          </CardEscapeProvider>
        </CardInDrawerProvider>
        {foot !== undefined && (
          <div
            data-slot="panel-drawer-foot"
            className="flex shrink-0 items-center gap-(--space-2) border-t border-solid border-line px-gutter py-(--space-3)"
          >
            {foot}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
