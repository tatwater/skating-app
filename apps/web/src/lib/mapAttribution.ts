/**
 * The map's credits, folded behind an ⓘ from the moment they exist.
 *
 * **Compact: the credits live behind an ⓘ rather than across the map** (A06e §1.4, founder ask:
 * *"can we keep all attribution strings in the sidebar/drawer, instead of over the map itself?"*;
 * again 2026-11-07: *collapsed by default*).
 *
 * MapLibre's own compact mode *is* that affordance, and using it beats hand-rolling one for a reason
 * that outlives any phase: the control unions the `attribution` of every **active source**, so the
 * aerial credit appears the moment the reveal adds its source and disappears when it removes it,
 * with nothing to remember. A hand-composed string is the version that goes stale the first time
 * someone adds a layer.
 *
 * It also settles the ODbL question rather than skirting it. OSM's guidance wants the credit in the
 * corner of a browsable map *or* behind a clearly-labeled affordance on the map itself — an ⓘ that
 * stays on the map is the second of those. Credits reachable only from a drawer, on a map that
 * renders perfectly well with no drawer open, would be the configuration that risks it.
 *
 * ⚠ **`compact` does not mean *collapsed*, and MapLibre only decides it late.** The control mounts
 * before any source has loaded, so its first pass finds no credits, marks itself
 * `maplibregl-attrib-empty`, and *skips* compacting. The first source's metadata then re-runs
 * `_updateCompact`, which adds `maplibregl-compact` **and** `maplibregl-compact-show` — expanded —
 * and only a `drag` ever folds it again (not a zoom, not a click, not a fly-to). So a map that is
 * read rather than dragged wore *"© OpenStreetMap contributors | Copernicus Sentinel data 2025–2026"*
 * across its foot all session. The earlier fix removed the show class at mount, which was a no-op:
 * at mount there was nothing compact to fold yet.
 *
 * So the fold happens at the one moment MapLibre compacts the control, whenever that is: the first
 * `_updateCompact` that leaves it compact also drops `compact-show` and the `<details>`' `open` —
 * exactly what MapLibre's own minimize path and its toggle leave behind, so its toggle keeps working
 * from there (it reads the show class, and the native `<summary>` flips `open`). Once only: after
 * that the ⓘ is the skater's, and a source arriving later never re-folds what they opened.
 */

import maplibregl from 'maplibre-gl';

export class FoldedAttributionControl extends maplibregl.AttributionControl {
  constructor() {
    super({ compact: true });
    // MapLibre's `_updateCompact` is an arrow-function field, so it is wrapped here rather than
    // overridden; `onAdd` reads the field when it subscribes to `resize`, after this has run.
    const updateCompact = this._updateCompact;
    let folded = false;
    this._updateCompact = () => {
      updateCompact();
      const container = this._container;
      if (folded || !container.classList.contains('maplibregl-compact')) return;
      folded = true;
      container.classList.remove('maplibregl-compact-show');
      container.removeAttribute('open');
    };
    // MapLibre's own fold, on the first `drag` after the skater opened the credits, drops the show
    // class but leaves `open`, so the `<summary>` would go on announcing *expanded* over a folded
    // plate. Closing the `<details>` with it keeps the two in step for assistive tech.
    const minimize = this._updateCompactMinimize;
    this._updateCompactMinimize = () => {
      const wasShown = this._container.classList.contains('maplibregl-compact-show');
      minimize();
      if (wasShown && !this._container.classList.contains('maplibregl-compact-show')) {
        this._container.removeAttribute('open');
      }
    };
  }
}
