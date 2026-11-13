import { createContext, type ReactElement, type ReactNode, useContext } from 'react';

import type { CorpusTask, InboxLane } from './overviewData';

/**
 * Where a Home block can send the operator. Routing is the integrator's: the page is handed a
 * `linkTo` that turns a target into the router's link element (`<Link to=… search=… />`), and every
 * link on Home renders through it. Without one, a plain `<a>` to the console's documented route.
 */
export type OverviewTarget =
  | { kind: 'inbox'; lane?: InboxLane }
  | { kind: 'corpus'; task?: CorpusTask }
  | { kind: 'machinery' }
  | { kind: 'people'; list?: 'staff' | 'new' | 'suspended' | 'banned' | 'leaving' }
  | { kind: 'ledger' }
  | { kind: 'body'; id: string }
  | { kind: 'audit'; type: string; id: string };

/** Turns a target into the element a link renders as (its props and children are merged in). */
export type LinkTo = (to: OverviewTarget) => ReactElement;

/** The console's routes (the phase plan's table), for a page that isn't handed a router. */
export function overviewHref(to: OverviewTarget): string {
  switch (to.kind) {
    case 'inbox':
      return to.lane ? `/admin/inbox?lane=${to.lane}` : '/admin/inbox';
    case 'corpus':
      return to.task ? `/admin/corpus?task=${to.task}` : '/admin/corpus';
    case 'machinery':
      return '/admin/machinery';
    case 'people':
      return to.list ? `/admin/people?list=${to.list}` : '/admin/people';
    case 'ledger':
      return '/admin/machinery/ledger';
    case 'body':
      return `/admin/body/${encodeURIComponent(to.id)}`;
    case 'audit':
      return auditHref(to.type, to.id);
  }
}

/** A feed row's target: the page that holds its history. */
function auditHref(type: string, id: string): string {
  const enc = encodeURIComponent(id);
  switch (type) {
    case 'waterbody':
      return `/admin/body/${enc}`;
    case 'user':
      return `/admin/people/${enc}`;
    case 'report':
    case 'post':
    case 'comment':
    case 'photo':
      return `/admin/reports?item=${enc}`;
    default:
      return `/admin/inbox?item=${enc}`;
  }
}

// A template: the link's content and look are cloned into it by whatever renders through it.
// biome-ignore lint/a11y/useAnchorContent: the content is cloned in
const defaultLinkTo: LinkTo = (to) => <a href={overviewHref(to)} />;

const LinkContext = createContext<LinkTo>(defaultLinkTo);

/** Hands every link under it the page's router. */
export function OverviewLinkProvider({
  linkTo,
  children,
}: {
  linkTo?: LinkTo | undefined;
  children: ReactNode;
}) {
  return <LinkContext.Provider value={linkTo ?? defaultLinkTo}>{children}</LinkContext.Provider>;
}

/** The element a target renders as, through the page's router. */
export function useLinkTo(): LinkTo {
  return useContext(LinkContext);
}
