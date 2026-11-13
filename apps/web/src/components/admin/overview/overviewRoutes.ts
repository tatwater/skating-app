import type { FeedTarget } from './overviewData';
import type { OverviewTarget } from './overviewLinks';

/**
 * Where Home's links go in the app as it stands: the old pages, until each target's mode lands
 * (the same rule as the palette, which opens a body in the old lake editor and a person in the
 * old user page). `overviewHref` names the console's own routes; this names the pages that exist.
 *
 * Every Inbox lane, Corpus task and People list lands on the old page that does that work; the old
 * pages take no filter, so the lane or list is the page, not a preset on it. `null` is a target
 * with no page yet — the caller draws it as text, never a link to a page that 404s.
 */
export function consolePathFor(to: OverviewTarget): string | null {
  switch (to.kind) {
    case 'inbox':
      switch (to.lane) {
        case 'requests':
        case 'placesAsked':
          return '/admin/water/requests';
        case 'drawnBodies':
          return '/admin/water';
        case 'support':
          return '/admin/support';
        default:
          // Safety, access reports and content flags are all flags.
          return '/admin/flags';
      }
    case 'corpus':
      switch (to.task) {
        case 'placeNames':
          return '/admin/water/place-names';
        case 'preIcePass':
          return '/admin/water/standing';
        default:
          return '/admin/water/review';
      }
    case 'machinery':
      return '/admin/imports';
    case 'people':
      return '/admin/users';
    case 'ledger':
      // No page holds the ledger until Machinery lands; Home draws no link to it while cost is unread.
      return null;
    case 'audit':
      return auditPath(to.type, to.id);
  }
}

/**
 * A feed row's target: the thing's own old page where one opens it by id (a body, a person), else
 * the old page where that kind of thing is worked — a hidden report on the flag queue, a landmark
 * or a put-in from the water bodies, whose editor holds them. Every type the audit trail writes has
 * one; `null` only for a type it doesn't write.
 */
function auditPath(type: string, id: string): string | null {
  switch (type) {
    case 'waterbody':
      return `/admin/water/${encodeURIComponent(id)}`;
    case 'user':
      return `/admin/users/${encodeURIComponent(id)}`;
    case 'report':
    case 'post':
    case 'comment':
    case 'photo':
    case 'contentFlag':
    case 'hazard':
      return '/admin/flags';
    case 'bodyFeature':
      return '/admin/features';
    case 'hazardRecurrence':
      return '/admin/recurrence';
    case 'waterBodyRequest':
      return '/admin/water/requests';
    case 'corpusPlaceName':
      return '/admin/water/place-names';
    case 'waterBodySubArea':
    case 'putIn':
    case 'parkingArea':
    case 'accessAlert':
    case 'bodyLandmark':
      return '/admin/water';
    default:
      return null;
  }
}

/** Where a feed row opens, or `null` when no page holds its target yet. */
export function feedTargetPath(target: FeedTarget): string | null {
  return auditPath(target.type, target.id);
}
