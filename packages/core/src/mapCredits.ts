/**
 * Who has to be credited for what is currently on the map (N6e §A4).
 *
 * ## Three sources, three different obligations — which is what decides the design
 *
 * | Source | Obligation | Drawer-only? |
 * | --- | --- | --- |
 * | **USGS / NAIP** | **None.** Public-domain federal work | Yes — courtesy only |
 * | **Copernicus** | Attribution required, **placement flexible** | Yes |
 * | **OSM / ODbL** | *"reasonably calculated to make users aware"* | ⚠ **The binding one** |
 *
 * > **Founder, 2026-08-21b:** *"can we keep all attribution strings in the sidebar/drawer, instead of
 * > over the map itself? Or is that against ToS"*
 *
 * **Mostly yes.** OSM is the constraint: its guidance for a browsable map wants the credit in the map
 * corner or — where that is impractical — reachable through a *clearly-labelled affordance on the map
 * itself*. Credits living only in a drawer with no on-map path is the configuration that risks
 * non-compliance. So the answer is a small **ⓘ on the map that opens the drawer's credits panel**:
 * clean map, compliant attribution, and one place that composes the whole list instead of a control
 * that grows a string per layer.
 *
 * ## Why this is a function of what is showing
 *
 * A credit for a layer nobody has turned on is noise, and worse, it is noise that makes the *required*
 * credits harder to find. So the list is derived from the current view rather than being a constant —
 * and `required` is carried per entry so a renderer can never quietly drop the one that matters.
 *
 * Wording is verbatim from each source's own terms, never paraphrased — the discipline `lakeDepth`
 * and `contourLayer` already keep one module over.
 */

/** One line in the credits panel. */
export interface MapCredit {
  /** The credit exactly as the source's terms require it. Never paraphrased. */
  credit: string;
  /**
   * Whether a licence compels this, as opposed to our crediting someone who did not ask.
   *
   * ⚠ **Not a styling hint.** A renderer may reorder or de-emphasise a courtesy line; it may not
   * drop a required one, and the distinction is here so that stays checkable rather than remembered.
   */
  required: boolean;
  /** A separate obligation some terms carry — stored apart so a reader checking one finds it. */
  notice?: string;
}

/** The basemap's credit. Always present, because the basemap always is. */
export const OSM_CREDIT = '© OpenStreetMap contributors';

/** NAIP, per The National Map. Public-domain federal work, so this is courtesy. */
export const AERIAL_CREDIT =
  'USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024.';

/**
 * Copernicus' required form, with the years the frames were actually taken in.
 *
 * ESA's terms ask for *"Copernicus Sentinel data [year]"*. A winter spans two calendar years and the
 * archive is keyed by season, so both are named rather than picking one and being wrong for half the
 * frames.
 */
export function copernicusCredit(season: string): string {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(season);
  if (!match) return 'Copernicus Sentinel data';
  const start = Number(match[1]);
  return `Copernicus Sentinel data ${start}–${start + 1}`;
}

export interface MapCreditContext {
  /** The Tier 1 aerial reveal is showing. */
  aerial?: boolean;
  /** A freeze-up frame is showing, and which season it came from. */
  freezeUpSeason?: string | null;
  /**
   * The bathymetry layer's own credit, read back off the drawn tiles.
   *
   * Passed in rather than derived because the *tile* is the authority on who surveyed a given lake —
   * see `contourLayer`, which is where that decision and its five-source registry live.
   */
  contourCredit?: string | null;
}

/**
 * The credits for what is on screen right now, in the order they should be read.
 *
 * OSM first, always, because it is the one with a placement obligation and the one a compliance
 * reader is looking for. The rest follow in the order they were layered on.
 */
export function mapCreditsFor(context: MapCreditContext = {}): MapCredit[] {
  const credits: MapCredit[] = [{ credit: OSM_CREDIT, required: true }];

  if (context.aerial) {
    credits.push({ credit: AERIAL_CREDIT, required: false });
  }
  if (context.freezeUpSeason) {
    credits.push({ credit: copernicusCredit(context.freezeUpSeason), required: true });
  }
  if (context.contourCredit) {
    credits.push({ credit: context.contourCredit, required: true });
  }

  return credits;
}
