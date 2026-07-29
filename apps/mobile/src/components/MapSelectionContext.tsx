import type { BBox, HazardDraft, HazardType } from '@skating/core';
import type { LineString } from 'geojson';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/**
 * Shared selection state for the persistent native map (Phase 2 §F), the mobile mirror of web's
 * `MapSelectionContext`. The `(map)` layout keeps one `<MapView>` mounted beside a bottom-sheet
 * `<Slot />`; the detail drawers rendered into that slot are *siblings* of the map, so they push
 * what the map should show — the highlighted body, where to fly, photo pins — up through this
 * context rather than remounting the map per navigation. The layout owns the highlight-clear on
 * route change; the drawers set focus/pins from the data they fetch (see `MapView`).
 */

/** A geotagged report photo (D42) to drop on the lake when viewing a report with `placeOnMap`. */
export interface PhotoPin {
  photoId: string;
  coord: { lat: number; lng: number };
}

/**
 * Where the map should recenter. `bounds` (a lake's bbox) is preferred — the map fits it into the
 * area *not* covered by the drawer (zoom-to-fit); `lat`/`lng` + optional `zoom` are the point
 * fallback (e.g. a report put-in) when there's no area to fit.
 */
export interface MapFocus {
  lat: number;
  lng: number;
  zoom?: number;
  bounds?: BBox;
}

interface MapSelectionValue {
  highlightWaterBodyId: string | null;
  setHighlightWaterBodyId: (id: string | null) => void;
  focus: MapFocus | null;
  setFocus: (focus: MapFocus | null) => void;
  photoPins: PhotoPin[];
  /**
   * The recorded GPS track behind the open report (Phase 8) — display-only. A path only ever comes
   * from a track someone actually skated; there is no draw action anywhere in the app.
   */
  trackPath: LineString | null;
  setTrackPath: (path: LineString | null) => void;
  setPhotoPins: (pins: PhotoPin[]) => void;
  /** The put-in pin the report form is placing (§E) — the access point → `reports.point`. */
  putInPin: { lat: number; lng: number } | null;
  setPutInPin: (pin: { lat: number; lng: number } | null) => void;
  /** True while the report form has armed map-tap pin placement; the next map tap sets the pin. */
  pinDropMode: boolean;
  setPinDropMode: (on: boolean) => void;
  /**
   * Fraction of the screen the drawer currently covers (0 closed → ~0.94 near-full). The map fits
   * the selected lake into the *uncovered* area by padding its camera by this much at the bottom,
   * and re-fits when the drawer settles at a new snap point.
   */
  drawerCoveredFraction: number;
  setDrawerCoveredFraction: (fraction: number) => void;
  /**
   * The hazard being captured (Phase 9, D51) — the shared `@skating/core` draft, so the map previews
   * the *real* buffered footprint (the same shape the proximity evaluator measures) and mobile
   * inherits web's authoring transitions rather than reimplementing them.
   */
  hazardDraft: HazardDraft | null;
  setHazardDraft: (draft: HazardDraft | null) => void;
  /** What's being captured — the map needs it so a `ridge_crossing` previews as a passage, not a danger. */
  hazardDraftType: HazardType | null;
  setHazardDraftType: (type: HazardType | null) => void;
  /**
   * True while capture has armed map-tap placement. A circle disarms on the tap that moves it; a
   * polyline **stays armed**, taking one vertex per tap until Done.
   */
  hazardDropMode: boolean;
  setHazardDropMode: (on: boolean) => void;
  /**
   * The two taps that become a shore band (N5b), or `null` when not snapping.
   *
   * `[]` means "armed, waiting for the first tap" — a state the map must be able to hold, since the
   * affordance is two taps and the adjust bar can't count them. Same split as web: the map collects
   * them, and capture (which holds the body polygon) turns them into geometry.
   */
  hazardShoreTaps: { lat: number; lng: number }[] | null;
  setHazardShoreTaps: (taps: { lat: number; lng: number }[] | null) => void;
  /**
   * The lake the skater's own GPS resolved to, if any (§Mobile "the on-ice state"). Resolved through
   * the offline body cache, so it works with no signal. On app-open it auto-selects that lake (the
   * layout navigates to its detail); thereafter it drives the flag affordance and the proximity
   * banner — but **not** the hazard *layer*, which follows the selected lake so closing the sheet and
   * panning away lets the hazards fall off naturally.
   */
  onIceWaterBodyId: string | null;
  setOnIceWaterBodyId: (id: string | null) => void;
  /**
   * The device's latest GPS fix while on the map, published by the layout's single watcher so the
   * proximity banner can evaluate it without running a *second* watcher (two GPS subscriptions on a
   * cold phone is exactly the battery cost this feature can't afford). `null` until the first fix.
   */
  onIceCoord: { lat: number; lng: number } | null;
  setOnIceCoord: (coord: { lat: number; lng: number } | null) => void;
  /**
   * The past season being browsed on the open lake (D63), or `null` for **this** season — the map's
   * only default state, and the one it snaps back to when the sheet closes.
   *
   * Shared rather than sheet-local because the selector sits in the lake sheet while two of the three
   * things it governs (hazard pins, aggregate tracks) are drawn by the map behind it. Split state
   * would show last December in the list over this winter's ice on the map.
   *
   * ⚠ **The on-ice surfaces must ignore this.** `HazardBanner` and the proximity alerts answer "what
   * is near me *right now*", which is never a browsing question — see the note there.
   */
  browseSeason: number | null;
  setBrowseSeason: (season: number | null) => void;
}

const MapSelectionContext = createContext<MapSelectionValue | null>(null);

export function MapSelectionProvider({ children }: { children: ReactNode }) {
  const [highlightWaterBodyId, setHighlightWaterBodyId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [photoPins, setPhotoPins] = useState<PhotoPin[]>([]);
  const [trackPath, setTrackPath] = useState<LineString | null>(null);
  const [putInPin, setPutInPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinDropMode, setPinDropMode] = useState(false);
  const [browseSeason, setBrowseSeason] = useState<number | null>(null);
  const [drawerCoveredFraction, setDrawerCoveredFraction] = useState(0);
  const [hazardDraft, setHazardDraft] = useState<HazardDraft | null>(null);
  const [hazardDraftType, setHazardDraftType] = useState<HazardType | null>(null);
  const [hazardDropMode, setHazardDropMode] = useState(false);
  const [hazardShoreTaps, setHazardShoreTaps] = useState<{ lat: number; lng: number }[] | null>(
    null,
  );
  const [onIceWaterBodyId, setOnIceWaterBodyId] = useState<string | null>(null);
  const [onIceCoord, setOnIceCoord] = useState<{ lat: number; lng: number } | null>(null);

  const value = useMemo(
    () => ({
      highlightWaterBodyId,
      setHighlightWaterBodyId,
      focus,
      setFocus,
      photoPins,
      setPhotoPins,
      trackPath,
      setTrackPath,
      putInPin,
      setPutInPin,
      pinDropMode,
      setPinDropMode,
      drawerCoveredFraction,
      setDrawerCoveredFraction,
      hazardDraft,
      setHazardDraft,
      hazardDraftType,
      setHazardDraftType,
      hazardDropMode,
      setHazardDropMode,
      hazardShoreTaps,
      setHazardShoreTaps,
      onIceWaterBodyId,
      setOnIceWaterBodyId,
      onIceCoord,
      setOnIceCoord,
      browseSeason,
      setBrowseSeason,
    }),
    [
      highlightWaterBodyId,
      focus,
      photoPins,
      trackPath,
      putInPin,
      pinDropMode,
      drawerCoveredFraction,
      hazardDraft,
      hazardDraftType,
      hazardDropMode,
      hazardShoreTaps,
      onIceWaterBodyId,
      onIceCoord,
      browseSeason,
    ],
  );

  return <MapSelectionContext.Provider value={value}>{children}</MapSelectionContext.Provider>;
}

export function useMapSelection(): MapSelectionValue {
  const value = useContext(MapSelectionContext);
  if (!value) throw new Error('useMapSelection must be used within a MapSelectionProvider');
  return value;
}

/**
 * Like `useMapSelection` but returns `null` outside a provider instead of throwing — for the report
 * form when it's rendered **off the map** (the F2 offline draft capture/edit routes, which live
 * outside the `(map)` layout). There the map-tap put-in isn't available; the form falls back to
 * "use my current location" (§F2/D42).
 */
export function useMapSelectionOptional(): MapSelectionValue | null {
  return useContext(MapSelectionContext);
}
