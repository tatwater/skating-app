import { type InboxQuery, inboxHref } from '../inbox/inboxSearch';
import type { FeedTarget } from './overviewData';
import { type OverviewTarget, PEOPLE_LANE_OF } from './overviewLinks';

/** The Inbox at a place: a lane, or one item by its source ref (`request:<id>`). */
function inboxPath(place: Partial<Pick<InboxQuery, 'lane' | 'item'>>): string {
  return inboxHref({ lane: 'all', facet: 'all', filter: null, item: null, from: null, ...place });
}

/** A body's console: the Bodies mode's page for one body. */
function bodyConsolePath(id: string): string {
  return `/admin/body/${encodeURIComponent(id)}`;
}

/**
 * Where Home's links go in the app as it stands: the old pages, until each target's mode lands
 * (the same rule as the palette, which opens a body in its Body console and a person in People).
 * Bodies has landed, so a body opens in its Body console. `overviewHref` names the console's own routes; this names the pages that exist.
 *
 * Every Inbox lane and Corpus task lands on the old page that does that work; the old pages take no
 * filter, so the lane is the page, not a preset on it. People has landed, so its lists open as its
 * lanes and a person on their own page. `null` is a target with no page yet — the caller draws it
 * as text, never a link to a page that 404s.
 */
export function consolePathFor(to: OverviewTarget): string | null {
  switch (to.kind) {
    case 'inbox':
      switch (to.lane) {
        // Requests, places asked and drawn bodies are decided in the Inbox (B01-5c): their old pages
        // retire with it (the requests page redirects, the water list loses its pending card).
        case 'requests':
        case 'placesAsked':
        case 'drawnBodies':
          return inboxPath({ lane: to.lane });
        // Support tickets are answered in the Inbox (B01-5f): the old page redirects there.
        case 'support':
          return inboxPath({ lane: 'support' });
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
      // People has landed: its lanes are the lists, the default (Everyone) written as no param.
      return to.list === undefined
        ? '/admin/people'
        : `/admin/people?lane=${PEOPLE_LANE_OF[to.list]}`;
    case 'body':
      // A most-reported row opens that body's Body console (the governor's ruling at B01-2).
      return bodyConsolePath(to.id);
    case 'ledger':
      // No page holds the ledger until Machinery lands; Home draws no link to it while cost is unread.
      return null;
    case 'audit':
      return auditPath(to.type, to.id);
  }
}

/**
 * A feed row's target: the thing's own page where one opens it by id (a body, a person), else
 * the old page where that kind of thing is worked — a hidden report on the flag queue, a landmark
 * or a put-in from the water bodies, whose editor holds them. Every type the audit trail writes has
 * one; `null` only for a type it doesn't write.
 */
function auditPath(type: string, id: string): string | null {
  switch (type) {
    case 'waterbody':
      return bodyConsolePath(id);
    case 'user':
      return `/admin/people/${encodeURIComponent(id)}`;
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
      // The ask's own item in the Inbox (`inbox.item` resolves a `request:` ref).
      return inboxPath({ item: `request:${id}` });
    case 'supportTicket':
      // The ticket's own item in the Inbox (`inbox.item` resolves a `ticket:` ref).
      return inboxPath({ item: `ticket:${id}` });
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
