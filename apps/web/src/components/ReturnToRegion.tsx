import { Button } from './ui/button';

/**
 * The way home, offered only once home has left the screen.
 *
 * The map used to be fenced: `maxBounds` was the five-state box and MapLibre simply refused to pan
 * past it. That fence existed because outside the box there was nothing to draw — the basemap
 * archive was a bbox extract and the world ended at its edge. With a whole-planet overview archive
 * underneath, it doesn't: you can zoom out to the Atlantic, or pan to Ireland, and the map stays a
 * map. So the fence came down (founder, 2026-08-05) and this took its place.
 *
 * **Offered, not imposed.** A wall stops a deliberate action — zooming out to see where the region
 * sits in the world is a reasonable thing to want, and the old bounds forbade it. A button costs a
 * wanderer one tap and costs everyone else nothing, because it isn't there: `isRegionOffscreen` is
 * a plain bbox intersection, so any sliver of the five states in view keeps it hidden.
 *
 * It announces itself through a live region — appearing silently is exactly the failure mode for
 * the one control a lost user needs to find.
 */
export function ReturnToRegion({ visible, onReturn }: { visible: boolean; onReturn: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center"
    >
      {visible ? (
        <Button
          type="button"
          variant="secondary"
          className="pointer-events-auto shadow-lg"
          onClick={onReturn}
        >
          Back to the Northeast
        </Button>
      ) : null}
    </div>
  );
}
