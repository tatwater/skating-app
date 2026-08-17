import { useNavigate } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

/**
 * The detail panel that fills the map sidebar — a water body, report, hazard or bounty.
 *
 * **This used to be a `Sheet` (a Base UI dialog) and deliberately is not one any more.** The
 * sidebar is now permanent: it is a column of the map layout, open on every map route, showing
 * what's in view when nothing is selected. A dialog cannot be that. A dialog is a thing that is
 * *open over* the page — it portals to the body, positions itself `fixed`, and owns focus — so it
 * can't be a flex child of the layout, and "always open" would be a lie told to a component whose
 * whole contract is opening and closing.
 *
 * What that costs, and what replaces it:
 *  - **The ✕** was `SheetContent`'s built-in close. It's ours now, and it means *deselect* rather
 *    than *close* — it returns to `/`, where the sidebar shows the lakes in view.
 *  - **Escape** was the dialog's. Re-bound below, with the one guard that matters.
 *  - **`SheetTitle`/`SheetDescription`** were `Dialog.Title`/`Dialog.Description`, which throw
 *    outside a dialog root; `PanelTitle`/`PanelDescription` below are the same markup with no
 *    context requirement. Every drawer body uses those instead.
 *  - **Focus trapping and `aria-modal`** are gone, which is correct: the panel is a region of the
 *    page, not an overlay over it. On a phone it still covers the map (see the `_map` layout), but
 *    it covers it *instead of* the map rather than on top of it, so there's nothing behind to trap
 *    focus away from.
 *
 * The old non-modal `Sheet` also needed `disablePointerDismissal` so that tapping the map — to
 * place a put-in pin, or to select another lake — didn't dismiss the drawer and discard a
 * half-filled report. That whole class of bug is gone with the dialog: the map is a sibling
 * element, and clicking a sibling does nothing at all to this one.
 */
export function DetailPanel({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  // Escape returns to the map, as the dialog used to do — but **never while a form is open**.
  //
  // The report/hazard/bounty composers are real modal dialogs rendered *inside* this panel's
  // subtree. Without the guard, one Escape would close the composer and navigate away from the lake
  // in the same tick, discarding a half-filled report — the exact failure the old sheet's
  // `disablePointerDismissal` existed to prevent, reintroduced through the keyboard. A dialog on
  // screen owns Escape; we take it only when there isn't one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[data-slot="dialog-content"], [data-slot="sheet-content"]'))
        return;
      navigate({ to: '/' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-3 right-3 z-10"
        onClick={() => navigate({ to: '/' })}
      >
        <XIcon />
        <span className="sr-only">Close</span>
      </Button>
      {children}
    </div>
  );
}

/**
 * A detail panel's header block. Same markup the `Sheet` header had — the panel's contents were
 * designed against it and shouldn't shift a pixel for a change that is about where they're mounted.
 * `pr-12` keeps the title clear of the ✕ that now sits in the panel rather than in the sheet.
 */
export function PanelHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-slot="panel-header" className={cn('flex flex-col gap-0.5 p-4 pr-12', className)}>
      {children}
    </div>
  );
}

/** The panel's heading. A real `h2`: the sidebar is a landmark region, not a dialog. */
export function PanelTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h2 data-slot="panel-title" className={cn('font-medium text-base text-foreground', className)}>
      {children}
    </h2>
  );
}

/** The line under the heading — type, size, whatever the drawer's subject is summarized by. */
export function PanelDescription({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p data-slot="panel-description" className={cn('text-muted-foreground text-sm', className)}>
      {children}
    </p>
  );
}
