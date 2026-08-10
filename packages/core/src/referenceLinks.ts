/**
 * Per-body reference links (N6c Workstream B) — derived, never stored.
 *
 * **P2 (D71): a link is not an integration.** Every link here is a pure function of
 * `(coordinate, name, states[])`, all already on the row, so the whole corpus is covered the day
 * this ships and a provider changing its query-param format is one function to fix rather than
 * 24,953 stored strings to migrate. Storing a derivable string 24,953 times would be the expensive
 * way to get a worse result.
 *
 * The one exception is B7 — a lake association's URL, which no algorithm produces from a lake's
 * name. That is stored on the row as `referenceLinks` and merged in by {@link allReferenceLinks}.
 *
 * **Satellite imagery is deliberately absent.** B3's Copernicus Browser deep link moved to
 * [N6e](../../../plans/phase-N6e-satellite-imagery.md) at the founder's ask (2026-08-09), so the
 * link, the `satelliteImagery` per-row override and `SATELLITE_MIN_AREA_SQM` all land together with
 * the in-app tier rather than shipping a deep link now and a layer later.
 */

import type { LatLng } from './geometry';
import { isKnownStateCode } from './regions';

/** A link the lake drawer can render. `id` is stable so a client can key or order on it. */
export interface ReferenceLink {
  /** Stable identifier — `windy`, `community`, or `stored:<index>` for an operator-entered link. */
  id: string;
  label: string;
  url: string;
  /**
   * One short line of context, rendered beside the label. Present only where the destination is
   * not self-evident from its name — a skater knows what Windy is; they do not necessarily know
   * that `VTNordicskating` is a searchable twenty-year email archive.
   */
  note?: string;
}

/** The subset of a water body reference links read. Structural, so both clients' `Doc`s satisfy it. */
export interface ReferenceLinkBody {
  name?: string;
  states?: string[];
  /**
   * The on-water sample point (N6c-1 finding 2). **Prefer this over `representativePoint`** — see
   * {@link linkCoordinate}.
   */
  interiorPoint?: LatLng;
  representativePoint?: LatLng;
  /** Pre-rename alias for `representativePoint`, still on every row until the stage-2 sweep. */
  centroid?: LatLng;
  /** Operator-entered links (B7), preserved across re-import like `curatedBoost`. */
  referenceLinks?: readonly { label: string; url: string }[];
}

/**
 * Zoom for the Windy deep link.
 *
 * **Deliberately regional rather than framed to the lake.** The instinct is to derive zoom from
 * surface area so every body fills the viewport, and for an imagery link that would be right. Wind
 * is synoptic: the thing a skater is trying to see is the pressure system and where the wind is
 * coming from across the *region*, and a Windy view zoomed hard into a 40-acre pond shows a
 * near-uniform field with no context to read it against. One number, and it is not per-body.
 */
export const WINDY_ZOOM = 9;

/**
 * The coordinate every link is built from.
 *
 * **`interiorPoint` first, and this is a correction rather than a preference.** The Workstream B
 * text specified these links as "a pure function of `(centroid, name, states[])`", which was written
 * before N6c-1 measured what `centroid` actually is: Turf's `pointOnFeature`, which returns a point
 * on the **shoreline** whenever the bbox centre falls outside the polygon. Lake Willoughby's is ring
 * vertex 199; Lake Champlain's sits 30.7 km from mid-lake. A Windy link centred on that is 30 km
 * from the lake it claims to describe, and — exactly like the fetch profile before it — nothing
 * would have caught it, because a shoreline coordinate is a perfectly valid coordinate.
 *
 * The fallback chain still ends at `centroid` because a shoreline point is far better than no link,
 * and it is what pre-N6c-1 rows carry.
 */
export function linkCoordinate(body: ReferenceLinkBody): LatLng | undefined {
  return body.interiorPoint ?? body.representativePoint ?? body.centroid;
}

/** Windy's documented deep-link form: `?lat,lng,zoom`. Coordinates are `lat,lng`. */
export function windyUrl(coord: LatLng, zoom: number = WINDY_ZOOM): string {
  return `https://www.windy.com/?${coord.lat.toFixed(4)},${coord.lng.toFixed(4)},${zoom}`;
}

/** How a region's skaters are reached, and whether the destination can be searched by lake name. */
interface Community {
  label: string;
  /** A Google Group's slug — its archive is public and searchable, so the body name goes in the URL. */
  groupSlug?: string;
  /** A plain URL, for destinations whose search is neither stable nor reliably public. */
  url?: string;
  note: string;
}

/**
 * State → regional skating community (B6, from the plan's Appendix B).
 *
 * **Google Groups get a *search* URL carrying the body name; Facebook groups get a plain group
 * link.** The archives are public and their search is a stable query param, so a skater lands on
 * "everything anyone has written about this lake" rather than on a group's front page. Facebook's
 * in-group search is neither stable nor reliably public to a logged-out visitor, so pointing at it
 * would produce a dead end that looks like our bug.
 *
 * **MA falls back to the New England regional group** because it has no state-level community in
 * Appendix B — which is a real gap in the list rather than an omission here.
 */
const COMMUNITIES: Record<string, Community> = {
  VT: {
    label: 'VTNordicskating',
    groupSlug: 'vtnordicskating',
    note: 'Vermont’s Google Group — a searchable archive of skater reports',
  },
  NH: {
    label: 'NHNordicSkating',
    groupSlug: 'nhnordicskating',
    note: 'New Hampshire’s Google Group — a searchable archive of skater reports',
  },
  NY: {
    label: 'ADKNordicSkating',
    groupSlug: 'adknordicskating',
    note: 'The Adirondacks Google Group — a searchable archive of skater reports',
  },
  ME: {
    label: 'Maine and NH Skating and Ice Report',
    url: 'https://www.facebook.com/groups/maineandnhskatingandicereport',
    note: 'A Facebook group for Maine and New Hampshire reports and photos',
  },
  MA: {
    label: 'New England Nordic Skaters',
    url: 'https://www.facebook.com/groups/newenglandnordicskaters',
    note: 'The regional Facebook group — New England wide',
  },
};

/**
 * Which community a body points at.
 *
 * **The first of its `states` that has one**, which is alphabetical because `importCanonical` sorts
 * the union — the same rule and the same reasoning as `captionStateFor`. A border-spanning body
 * genuinely belongs to two communities and there is no principled way to pick from the row alone;
 * stable beats correct-in-one-direction, because the alternative is a link that moves between
 * renders.
 */
export function communityFor(body: ReferenceLinkBody): Community | undefined {
  const code = body.states?.find((s) => isKnownStateCode(s) && COMMUNITIES[s] !== undefined);
  return code ? COMMUNITIES[code] : undefined;
}

/**
 * The community link, searched by body name where the destination supports it.
 *
 * An unnamed body still gets the group's front page: "here is where the people who skate your
 * region talk" is useful even when we have nothing to search for.
 */
export function communityUrl(body: ReferenceLinkBody): string | undefined {
  const community = communityFor(body);
  if (!community) return undefined;
  if (community.url) return community.url;
  if (!community.groupSlug) return undefined;
  const base = `https://groups.google.com/g/${community.groupSlug}`;
  return body.name ? `${base}/search?q=${encodeURIComponent(body.name)}` : base;
}

/** How long an operator-entered label may be. Long enough for an association's real name. */
export const MAX_REFERENCE_LINK_LABEL = 80;
/** How many operator-entered links a body may carry. B7 expects one or two, never a directory. */
export const MAX_REFERENCE_LINKS = 8;

/**
 * Why an operator-entered link was refused, or `null` when it is fine.
 *
 * **The scheme check is a security boundary, not tidiness.** These strings are rendered as `href`s
 * on both clients, and `javascript:` in an `href` executes on click — so an operator (or anyone who
 * reached a moderator account) could otherwise store script that runs for every visitor to a lake
 * page. Allow-list `http`/`https` rather than deny-listing `javascript:`, because the deny list is
 * never finished: `data:`, `vbscript:` and `blob:` are all live in some renderer somewhere.
 *
 * Validated in `@skating/core` so the lake editor can refuse it before the round trip and the
 * mutation can refuse it again at the trust boundary. The client check is courtesy; the server one
 * is the guarantee.
 */
export function referenceLinkError(link: { label: string; url: string }): string | null {
  const label = link.label.trim();
  if (label.length === 0) return 'A link needs a label.';
  if (label.length > MAX_REFERENCE_LINK_LABEL) {
    return `A label is at most ${MAX_REFERENCE_LINK_LABEL} characters.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(link.url.trim());
  } catch {
    return 'That is not a valid URL. Include https://.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'A link must be http:// or https://.';
  }
  return null;
}

/**
 * Every link for a body — derived first, then the operator-entered ones (B7).
 *
 * **Stored links go last and are never deduplicated against the derived set.** An operator who
 * pasted a second Windy link meant to; silently dropping it would be us overruling the one part of
 * this surface a human curates.
 *
 * Returns `[]` rather than a nullish value when there is nothing: the drawer's rule is that a
 * section with no content renders nothing at all, and an empty array is the cheapest way to say so.
 */
export function allReferenceLinks(body: ReferenceLinkBody | null | undefined): ReferenceLink[] {
  if (!body) return [];
  const links: ReferenceLink[] = [];

  const coord = linkCoordinate(body);
  if (coord) {
    links.push({
      id: 'windy',
      label: 'Wind and weather on Windy',
      url: windyUrl(coord),
      note: 'Animated wind, temperature and precipitation for the region',
    });
  }

  const community = communityFor(body);
  const communityHref = communityUrl(body);
  if (community && communityHref) {
    links.push({
      id: 'community',
      label: body.name ? `Search ${community.label} for ${body.name}` : community.label,
      url: communityHref,
      note: community.note,
    });
  }

  body.referenceLinks?.forEach((link, index) => {
    links.push({ id: `stored:${index}`, label: link.label, url: link.url });
  });

  return links;
}
