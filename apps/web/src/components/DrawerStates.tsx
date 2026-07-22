import { Link } from '@tanstack/react-router';
import { SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

/**
 * Shared loading + unavailable states for the detail drawers (§D), so the water-body and report
 * drawers present an identical skeleton and "not available" panel instead of two copies that drift.
 */

/** Placeholder shown while a drawer's queries resolve. */
export function DetailSkeleton() {
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <Skeleton className="h-5 w-40" />
        </SheetTitle>
        <SheetDescription>
          <Skeleton className="mt-1 h-4 w-28" />
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </>
  );
}

/** Friendly not-found / not-available / not-visible panel with a way back to the map. */
export function UnavailableState({ title, message }: { title: string; message: string }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{message}</SheetDescription>
      </SheetHeader>
      <div className="px-4 pb-4">
        <Link to="/" className="text-primary text-sm underline-offset-4 hover:underline">
          Back to the map
        </Link>
      </div>
    </>
  );
}
