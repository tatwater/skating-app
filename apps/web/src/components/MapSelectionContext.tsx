import type { HazardDraft, HazardType } from '@skating/core';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/**
 * Shared selection state for the persistent map (Phase 2 §D). The `_map` layout keeps one `MapView`
 * mounted under an `<Outlet />`; the detail drawers rendered into that outlet are *siblings* of the
 * map, so they push what the map should show — the highlighted body, where to fly, photo pins —
 * up through this context rather than remounting the map per navigation. The layout owns the
 * highlight-from-URL sync; the drawers set focus/pins from the data they fetch (see `MapView`).
 */

/** A geotagged report photo (D42) to drop on the lake when viewing a report with `placeOnMap`. */
export interface PhotoPin {
  photoId: string;
  coord: { lat: number; lng: number };
  thumbUrl?: string | null;
}

/** Where the map should recenter; `zoom` optional (keep current when framing an existing view). */
export interface MapFocus {
  lat: number;
  lng: number;
  zoom?: number;
}

interface MapSelectionValue {
  highlightWaterBodyId: string | null;
  setHighlightWaterBodyId: (id: string | null) => void;
  focus: MapFocus | null;
  setFocus: (focus: MapFocus | null) => void;
  photoPins: PhotoPin[];
  setPhotoPins: (pins: PhotoPin[]) => void;
  /** The put-in pin the report form is placing (§E) — the access point → `reports.point`. */
  putInPin: { lat: number; lng: number } | null;
  setPutInPin: (pin: { lat: number; lng: number } | null) => void;
  /** True while the report form has armed map-tap pin placement; the next map tap sets the pin. */
  pinDropMode: boolean;
  setPinDropMode: (on: boolean) => void;
  /**
   * The hazard being authored (Phase 9, D51) — a circle awaiting a centre, or a polyline collecting
   * vertices. Held as the shared `@skating/core` draft rather than web-local state so the map can
   * preview the *real* buffered footprint (the same math the server stores and the proximity
   * evaluator measures), and so mobile's capture flow inherits the identical transitions.
   */
  hazardDraft: HazardDraft | null;
  setHazardDraft: (draft: HazardDraft | null) => void;
  /**
   * What's being drawn. The map needs it to colour the preview honestly — a `ridge_crossing` draft
   * must not render as a danger halo while you're marking a way *across*.
   */
  hazardDraftType: HazardType | null;
  setHazardDraftType: (type: HazardType | null) => void;
  /**
   * True while the hazard form has armed map-click placement. A circle disarms on the click that
   * sets its centre; a polyline **stays armed**, taking one vertex per click until Done.
   */
  hazardDropMode: boolean;
  setHazardDropMode: (on: boolean) => void;
}

const MapSelectionContext = createContext<MapSelectionValue | null>(null);

export function MapSelectionProvider({ children }: { children: ReactNode }) {
  const [highlightWaterBodyId, setHighlightWaterBodyId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [photoPins, setPhotoPins] = useState<PhotoPin[]>([]);
  const [putInPin, setPutInPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinDropMode, setPinDropMode] = useState(false);
  const [hazardDraft, setHazardDraft] = useState<HazardDraft | null>(null);
  const [hazardDraftType, setHazardDraftType] = useState<HazardType | null>(null);
  const [hazardDropMode, setHazardDropMode] = useState(false);

  const value = useMemo(
    () => ({
      highlightWaterBodyId,
      setHighlightWaterBodyId,
      focus,
      setFocus,
      photoPins,
      setPhotoPins,
      putInPin,
      setPutInPin,
      pinDropMode,
      setPinDropMode,
      hazardDraft,
      setHazardDraft,
      hazardDraftType,
      setHazardDraftType,
      hazardDropMode,
      setHazardDropMode,
    }),
    [
      highlightWaterBodyId,
      focus,
      photoPins,
      putInPin,
      pinDropMode,
      hazardDraft,
      hazardDraftType,
      hazardDropMode,
    ],
  );

  return <MapSelectionContext.Provider value={value}>{children}</MapSelectionContext.Provider>;
}

export function useMapSelection(): MapSelectionValue {
  const value = useContext(MapSelectionContext);
  if (!value) throw new Error('useMapSelection must be used within a MapSelectionProvider');
  return value;
}
