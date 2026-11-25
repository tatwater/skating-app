import type { ChordResult, LatLng, SubAreaMouth } from '@skating/core';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ChordState } from '@/lib/chordDraw';
import type { BBoxLike } from '@/lib/mapSurface';

/**
 * **The map's tools** (B01-6, D299): how a tab draws on the Body console's map without touching it.
 *
 * The tab contract (`tabRegistry`) says a tab never touches the map, and that stays true: a tab
 * *claims* a tool here — a chord across a bay's mouth, a ring or a line to trace or edit, a point to
 * place or move, or none at all (a pasted shape or a suggested grid, only previewed) — with what the map should show while it is held (the mode bar's
 * words, the draft) and the callbacks the drawing answers through. The frame's map attaches the
 * engine to its own MapLibre instance (`useMapToolEngine`) and hands the results back.
 *
 * - **One claim at a time.** The claim is the tab's render-time state, mirrored here by an effect;
 *   a new claim replaces the old, and the tab's unmount (another tab opened, another body) drops it,
 *   so no shape on screen has an ambiguous owner.
 * - **`session`** says when the drawing starts over: the engine is re-attached only when it (or the
 *   tool's kind) changes, never because a callback or the mode bar's words did. The callbacks are
 *   read through a ref, so a claim may pass fresh closures every render.
 * - **The cursor is a crosshair** whenever a click on the map will place something (D300); a mark
 *   that drags shows the grab hand only under the pointer.
 * - **Esc leaves the tool** (`onExit`), unless something else already took the key (a dialog, an
 *   open menu) or it was pressed in a field — the same call as the mode bar's Esc cap.
 */

export type MapToolEngine =
  | {
      kind: 'chord';
      /** The body's outline: what the shore points snap to and the bay is cut from. */
      parent: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      /** A stored mouth to re-open, ready to adjust; absent starts from nothing. */
      mouth?: SubAreaMouth;
      /** Each settled change, with the mouth and its derivation once the gesture is complete. */
      onChange: (
        state: ChordState,
        mouth: SubAreaMouth | null,
        preview: ChordResult | null,
      ) => void;
    }
  | {
      kind: 'ring';
      /** A ring to edit; absent starts a new one. */
      polygon?: GeoJSON.Polygon;
      /** The ring as it stands (finished, or a vertex moved); `null` when it was removed. */
      onChange: (polygon: GeoJSON.Polygon | null) => void;
      /** The draw engine couldn't be loaded (its chunk failed). */
      onUnavailable: () => void;
    }
  | {
      kind: 'line';
      /** A line to edit; absent starts a new one. */
      line?: GeoJSON.LineString;
      /** The line as it stands (finished, or a vertex moved); `null` when it was removed. */
      onChange: (line: GeoJSON.LineString | null) => void;
      /** The draw engine couldn't be loaded (its chunk failed). */
      onUnavailable: () => void;
    }
  | {
      kind: 'point';
      /** The mark already there (a landmark being moved); absent starts with none. */
      point?: LatLng;
      /**
       * Snap the mark to this outline's edge (a put-in to the shore), shown while hovering; absent
       * places it where the click is.
       */
      snapTo?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      /**
       * How far from the outline the snap reaches; past it the mark stays where the pointer is, so
       * the server's own "too far from the water" refusal is the one that answers (a put-in).
       */
      snapWithinM?: number;
      /** A click, or a drag's release: the mark is here now. */
      onPick: (point: LatLng) => void;
    }
  /** Nothing to draw with: the shape comes from elsewhere (a paste, a grid), and the map shows it. */
  | { kind: 'none' };

export interface MapToolClaim {
  /** A new value starts the drawing over: the engine is detached and attached again. */
  session: string;
  engine: MapToolEngine;
  /** The mode bar: the mode's name, what to do next, and where the task stands. */
  mode: string;
  line?: string;
  step?: string;
  /**
   * The shape the drawing makes, as it would be saved, drawn under the engine's own marks: an area
   * filled, a line stroked, points as hollow rings (a suggested grid).
   */
  draft?: GeoJSON.Geometry | null;
  /** Where to take the camera when the session starts: a point, or a box to frame. */
  focus?: { point: LatLng } | { bbox: BBoxLike } | null;
  /** Leave the tool (Esc, or the mode bar's cap). */
  onExit: () => void;
}

/** Where a typed Esc belongs to the field, not the map's tool. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

const ClaimContext = createContext<MapToolClaim | null>(null);
const SetClaimContext = createContext<((claim: MapToolClaim | null) => void) | null>(null);

/** Held once, by the console's frame, around both the inspector and the map. */
export function MapToolProvider({ children }: { children: ReactNode }) {
  const [claim, setClaim] = useState<MapToolClaim | null>(null);
  const exit = useRef<(() => void) | null>(null);
  exit.current = claim?.onExit ?? null;
  const held = claim !== null;
  useEffect(() => {
    if (!held) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Esc in a field (a bay's name, its pasted GeoJSON) is the field's: it never throws away
      // the drawing and everything typed with it.
      if (e.target instanceof Element && e.target.closest(EDITABLE)) return;
      e.preventDefault();
      exit.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [held]);
  return (
    <SetClaimContext.Provider value={setClaim}>
      <ClaimContext.Provider value={claim}>{children}</ClaimContext.Provider>
    </SetClaimContext.Provider>
  );
}

/** What the map draws with now, if anything. */
export function useMapToolClaim(): MapToolClaim | null {
  return useContext(ClaimContext);
}

/**
 * A tab's claim on the map: `null` while it draws nothing. Kept until the tab says otherwise or
 * unmounts. Outside a console (a story, a test) there is no map to claim, and it does nothing.
 */
export function useClaimMapTool(claim: MapToolClaim | null): void {
  const set = useContext(SetClaimContext);
  useLayoutEffect(() => {
    set?.(claim);
  }, [set, claim]);
  useLayoutEffect(() => () => set?.(null), [set]);
}

/** Whether a console map is here to claim (a story or a test outside one has none). */
export function useHasMapTool(): boolean {
  return useContext(SetClaimContext) !== null;
}
