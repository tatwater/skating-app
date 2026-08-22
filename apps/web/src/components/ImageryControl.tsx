import { Layers, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from './ui/button';

/**
 * The map's one imagery control (N6e / D146, D81's surviving one-toggle rule).
 *
 * **Present only where a single lake is selected and the map is visible** — the founder's call, and
 * the reason there is no control on the browse map and no settings row anywhere. Imagery is content
 * scoped to a body, so its switch lives where the body does.
 *
 * The hazard toggle appears *inside* the reveal rather than beside it, because it is a question that
 * only exists once there is a photograph to put hazards on top of. Showing it while imagery is off
 * would be a control for a decision nobody has.
 */
export function ImageryControl({
  visible,
  imageryOn,
  onToggleImagery,
  hazardsOn,
  onToggleHazards,
  captureLabel,
  loading,
  hasHazards,
}: {
  visible: boolean;
  imageryOn: boolean;
  onToggleImagery: (on: boolean) => void;
  hazardsOn: boolean;
  onToggleHazards: (on: boolean) => void;
  /** *"June 2023"* — `null` until the scene is known, or where NAIP does not reach. */
  captureLabel: string | null;
  /** A fetch is in flight — a first load, or a sharper one on zoom-in. */
  loading: boolean;
  /** No hazards on this lake ⇒ no hazard toggle. A switch that governs nothing is noise. */
  hasHazards: boolean;
}) {
  if (!visible) return null;

  return (
    <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
      <Button
        type="button"
        variant={imageryOn ? 'default' : 'secondary'}
        size="sm"
        className="shadow-lg"
        aria-pressed={imageryOn}
        onClick={() => onToggleImagery(!imageryOn)}
      >
        <Layers aria-hidden className="mr-1.5 size-4" />
        {imageryOn ? 'Hide imagery' : 'Show imagery'}
      </Button>

      {/* Announced, not only animated. The lake's own pulse is the ambient signal; this is the one a
          screen reader gets, which is why the status lives here and not just on the canvas. */}
      <p aria-live="polite" className="sr-only">
        {loading ? 'Loading aerial imagery' : ''}
      </p>

      {imageryOn ? (
        <div className="flex flex-col items-end gap-1.5 rounded-md bg-background/95 p-2 shadow-lg">
          {/*
           * The date is not a caption detail, it is the content (D84/D147). NAIP flies in mid-summer
           * on a 2–3 year cycle, so a skater looking at green trees in January has to be told why —
           * and `null` renders as nothing at all rather than as a guessed year.
           */}
          {loading ? (
            <p className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              Loading imagery…
            </p>
          ) : captureLabel ? (
            <p className="px-1 text-muted-foreground text-xs">Aerial · {captureLabel}</p>
          ) : null}

          {hasHazards ? (
            <label className="flex cursor-pointer items-center gap-2 px-1 text-xs">
              <input
                type="checkbox"
                checked={hazardsOn}
                onChange={(event) => onToggleHazards(event.target.checked)}
                className="size-3.5 accent-[var(--destructive)]"
              />
              <TriangleAlert aria-hidden className="size-3.5 text-destructive" />
              Hazards
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
