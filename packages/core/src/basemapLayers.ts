/**
 * How the two basemap archives and the region mask stack up into one style.
 *
 * The map draws from **two** Protomaps archives, not one. A whole-planet overview at z0–6 (45 MB)
 * gives the world its oceans, its landmasses, its country lines and a few names, at every zoom,
 * everywhere. A regional archive clipped to the five states gives detail — towns, roads, water — and
 * only where we have anything to say. Between them sits the mask: the neighbourhood around us that
 * is not ours — sea, then land over it, then the big lakes — painted flat, which is what stops
 * Connecticut from rendering in full just because it shares a tile with New York.
 *
 * This module owns the *ordering and zoom policy* of that stack and nothing else. It is generic over
 * the layer type on purpose: `@protomaps/basemaps` is an app dependency, not a core one, so the apps
 * call `layers()` themselves and hand the results here. What is left is pure list arithmetic, which
 * is the part worth testing and the part that must not drift between web and native.
 *
 * The draw order, bottom to top:
 *
 *   1. **world base** — background, earth, water. The floor: ocean everywhere, land everywhere.
 *   2. **region** — the full basemap flavour, from z6 up, over the floor and inside our states.
 *   3. **mask** — flat fill over the whole neighbourhood, hiding the region archive's tile bleed.
 *      Water as well as land, because a label anchored on the Connecticut shore overhangs the Sound,
 *      and just short of opaque, because MapLibre draws opaque fills in a pass that runs *before*
 *      every symbol. See `maskLayers` in either app.
 *   4. **region labels** — the regional archive's symbol layers, above the mask and filtered to the
 *      region. See `REGION_LABEL_FILTER_NOTE`.
 *   5. **world overlay** — boundary lines and country/state names, on top of the mask so a masked
 *      state still shows its border and its name.
 *
 * App layers (water bodies, hazards, tracks) go above all four.
 */

/**
 * The zoom the regional archive starts drawing at.
 *
 * Below this you are looking at the world, and the world is the overview archive's job: countries and
 * coastlines, no towns anywhere, ours included. It is also the number the mask's own coverage is
 * derived from — bleed cannot reach further than one tile at the lowest zoom the region draws, so
 * raising this would shrink the mask's necessary extent and lowering it would widen it. See
 * `BLEED_BOX` in `scripts/admin-areas/src/buildRegion.ts`.
 */
export const REGION_MIN_ZOOM = 6;

/**
 * The zoom admin lines and admin labels stop at.
 *
 * They come from the z0–6 overview, so past its native zoom they are drawn from overzoomed tiles and
 * carry that generalisation with them — a state line good to a few hundred metres. At low zoom that
 * is invisible. Past z10 it is not: the line would visibly part company with the mask's edge, which
 * is cut from TIGER and accurate to tens of metres, and would wander across Lake Champlain rather
 * than down it. So they fade out, and past z10 the border is shown by where the flat fill stops —
 * which is the more accurate of the two lines anyway.
 */
export const ADMIN_MAX_ZOOM = 10;

/** Prefix for the overview archive's layers, so they cannot collide with the regional archive's. */
export const WORLD_LAYER_PREFIX = 'world_';

/**
 * The overview layers that draw *beneath* the regional detail — the floor the whole map sits on.
 *
 * `background` is here and deliberately excluded from the regional set below: a background layer
 * ignores its source and paints the entire viewport, so a second one drawn later would erase
 * everything under it.
 */
export const WORLD_BASE_LAYER_IDS = ['background', 'earth', 'water'] as const;

/**
 * The overview layers that draw *above* the mask, with the zoom each stops at.
 *
 * This list is the whole of what a user sees outside the five states: a border, a name, and the
 * ocean's name. No towns, no roads, no landuse — not because they are masked out, but because the
 * overview archive is the only thing drawing out there and it is never asked for them.
 */
export const WORLD_OVERLAY_LAYERS: readonly { id: string; maxZoom?: number }[] = [
  { id: 'water_label_ocean' },
  { id: 'boundaries_country', maxZoom: ADMIN_MAX_ZOOM },
  { id: 'boundaries', maxZoom: ADMIN_MAX_ZOOM },
  { id: 'places_country', maxZoom: ADMIN_MAX_ZOOM },
  { id: 'places_region', maxZoom: ADMIN_MAX_ZOOM },
];

/**
 * Regional layers the overview owns instead, and which would otherwise be drawn twice.
 *
 * Boundaries and admin labels are the interesting entries: the regional archive has crisper versions
 * of both, but it has them only where it has tiles, so keeping them would mean a state line that is
 * sharp inside Vermont, sharp for one bleeding tile into Québec, and absent past that. One
 * consistent line from one source beats a sharp line that stops at an invisible seam.
 */
export const REGION_EXCLUDED_LAYER_IDS = [
  'background',
  'boundaries',
  'boundaries_country',
  'places_country',
  'places_region',
  'water_label_ocean',
] as const;

/**
 * Why the regional archive's labels are filtered rather than covered.
 *
 * A mask hides whatever it covers, and it cannot tell our labels from anyone else's. "New York" is
 * anchored in Manhattan with half the word lying over New Jersey, so a mask that hides Jersey City
 * eats the city we cover; Seekonk and Rehoboth are Massachusetts towns whose names overhang Rhode
 * Island. Painting over the problem gets both wrong in opposite directions.
 *
 * So the symbol layers come out from under the mask, sit on top of it, and take a `["within", …]`
 * filter against the region outline. Theirs are dropped instead of covered; ours draw over the flat
 * fill, legible. Fills and lines stay beneath the mask, where covering is exactly right.
 *
 * The outline is generated a kilometre *outside* the true border (see `buildRegion.ts`), because the
 * failure modes are not symmetric: too small silently drops Vermont's own town names, too large lets
 * one border town's name show against flat fill.
 */
export const REGION_LABEL_FILTER_NOTE = 'see composeBasemapLayers';

/** The minimum a MapLibre layer needs for this module to place it. */
export interface ZoomableLayer {
  id: string;
  type?: string;
  filter?: unknown;
  minzoom?: number;
  maxzoom?: number;
}

/**
 * Order the two archives' layers around the mask, applying the zoom policy above.
 *
 * Zoom bounds are **narrowed, never widened**: a layer that already starts at z14 keeps z14 rather
 * than being pulled down to the regional floor, and one that already ends at z12 is not extended to
 * the admin cap. The policy is a clamp on the flavour's own judgement, not a replacement for it.
 */
export function composeBasemapLayers<L extends ZoomableLayer>(input: {
  /** `layers()` against the whole-planet overview source. */
  world: readonly L[];
  /** `layers()` against the regional source. */
  region: readonly L[];
  /** The mask fills, already built by the caller (they need the flavour's colours). */
  mask: readonly L[];
  /**
   * The region outline the regional archive's labels are filtered against, plus the style-spec's
   * `convertFilter`. Omitted ⇒ labels stay beneath the mask, which is the pre-filter behaviour:
   * theirs are covered and so are the parts of ours that overhang.
   *
   * **`convertFilter` is not optional plumbing.** The Protomaps flavour writes eight of its symbol
   * filters in *legacy* syntax (`["==", "kind", "locality"]`), and a filter is judged legacy or
   * expression as a whole — so `["all", <legacy>, ["within", …]]` is read as legacy, `within` is not
   * a legacy operator, and MapLibre rejects **the entire style**. Not the layer: the style. The map
   * goes blank. Converting each filter to expression form first is what makes the two combinable.
   */
  regionFilter?: { outline: unknown; convertFilter: (filter: unknown) => unknown };
}): L[] {
  const byId = new Map(input.world.map((layer) => [layer.id, layer]));

  const base = WORLD_BASE_LAYER_IDS.map((id) => byId.get(id))
    .filter((layer): layer is L => layer !== undefined)
    .map((layer) => ({ ...layer, id: `${WORLD_LAYER_PREFIX}${layer.id}` }));

  const overlay = WORLD_OVERLAY_LAYERS.flatMap(({ id, maxZoom }) => {
    const layer = byId.get(id);
    if (!layer) return [];
    const capped =
      maxZoom === undefined
        ? layer.maxzoom
        : Math.min(maxZoom, layer.maxzoom ?? Number.POSITIVE_INFINITY);
    return [
      {
        ...layer,
        id: `${WORLD_LAYER_PREFIX}${layer.id}`,
        ...(capped === undefined ? {} : { maxzoom: capped }),
      },
    ];
  });

  const excluded = new Set<string>(REGION_EXCLUDED_LAYER_IDS);
  const regional = input.region
    .filter((layer) => !excluded.has(layer.id))
    .map((layer) => ({ ...layer, minzoom: Math.max(REGION_MIN_ZOOM, layer.minzoom ?? 0) }));

  // Without an outline to filter against there is nothing to lift, so everything stays under the
  // mask exactly as before — a caller that has not generated one gets the old behaviour, not a
  // broken map.
  if (input.regionFilter === undefined) {
    return [...base, ...regional, ...input.mask, ...overlay] as L[];
  }

  const { outline, convertFilter } = input.regionFilter;
  const labels = regional
    .filter((layer) => layer.type === 'symbol')
    .map((layer) => ({
      ...layer,
      // ANDed rather than replacing: the flavour's own filters are what keep a locality layer from
      // drawing every hamlet, and dropping them would trade one kind of clutter for another. Both
      // sides go through `convertFilter` first — see the note on `regionFilter` for what happens
      // when they don't.
      filter:
        layer.filter === undefined
          ? ['within', outline]
          : ['all', convertFilter(layer.filter), ['within', outline]],
    }));
  const painted = regional.filter((layer) => layer.type !== 'symbol');

  return [...base, ...painted, ...input.mask, ...labels, ...overlay] as L[];
}
