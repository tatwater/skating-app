import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Sheet, SheetContent } from './ui/sheet'

/**
 * The right-side drawer that hosts a water-body / report detail over the persistent map (D47),
 * built on the shadcn (Base UI) `Sheet`. Selection is URL-backed (`/water/$id`, `/report/$id`) so
 * it's deep-linkable off-platform; closing the drawer — via the ✕ or Esc — pops back to the map
 * (`/`). **Non-modal, no backdrop:** the map stays pannable and, crucially, tappable while the
 * drawer is open — which the report form's put-in-pin placement (§E) relies on.
 * `disablePointerDismissal` is essential here: without it, Base UI closes a non-modal dialog on
 * *any* outside pointer press, so tapping the map (to place a pin or select another lake) would
 * dismiss the drawer and discard a half-filled report. Escape and the ✕ still close it.
 */
export function DetailSheet({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <Sheet
      open
      modal={false}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) navigate({ to: '/' })
      }}
    >
      <SheetContent
        side="right"
        showOverlay={false}
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
      >
        {children}
      </SheetContent>
    </Sheet>
  )
}
