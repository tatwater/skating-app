/**
 * What the skater compositions' stories share (story-only; nothing in the app imports it): the
 * skater dark / light pair, fixtures drawn from the boards, and a stand-in for the region picture.
 *
 * **The pair, not the four-up.** The kit's four-up renders all four maps because a kit piece must
 * hold on both surfaces; a skater composition only ever renders on the skater surface, so its
 * stories put dark and light side by side and leave the admin maps to the kit (B03 §5).
 */
import regionDark from '@/assets/basemap/region-dark.png';
import regionLight from '@/assets/basemap/region-light.png';
import { cn } from '@/lib/utils';

import { ThemePair, type ThemePairProps } from '../../../.storybook/theme';
import type { NotificationRowModel } from './notificationRows';
import type { SearchGroup } from './searchModel';

export type { Mode } from '../../../.storybook/theme';

/**
 * The bench's pair on the skater surface: dark and light side by side. With a `height`, each quad
 * is a fixed stage (a screen, an overlay's frame); without one, a padded column under its own
 * heading if `heading` asks for it.
 */
export function SkaterPair(props: Omit<ThemePairProps, 'surface'>) {
  return <ThemePair surface="skater" {...props} />;
}

/**
 * A pair's two quads, dark then light — and a failed test, never a loop over nothing, when the
 * story didn't render the pair.
 */
export function pairQuads(root: ParentNode): HTMLElement[] {
  const quads = [...root.querySelectorAll<HTMLElement>('[data-theme-pair] > section')];
  if (quads.length !== 2) throw new Error(`Expected the pair's two quads; found ${quads.length}.`);
  return quads;
}

/** The region picture, as `RegionBackdrop` will draw it: one per theme, chosen at paint. */
export function StoryRegion({ className }: { className?: string }) {
  return (
    <>
      <img src={regionLight} alt="" className={cn(className, 'dark:hidden')} />
      <img src={regionDark} alt="" className={cn(className, 'hidden dark:block')} />
    </>
  );
}

// ── Fixtures, from the boards (people, reports and times are invented) ─────────────────────

export const KATE = { name: 'Kate Donovan', username: 'kdonovan' };

const box = { minLat: 43.62, minLng: -72.36, maxLat: 43.68, maxLng: -72.28 };
const mascomaRings: [number, number][][] = [
  [
    [-72.355, 43.664],
    [-72.33, 43.676],
    [-72.305, 43.672],
    [-72.29, 43.655],
    [-72.3, 43.635],
    [-72.325, 43.625],
    [-72.345, 43.638],
    [-72.355, 43.664],
  ],
];

export const RESULTS: SearchGroup[] = [
  {
    id: 'lakes',
    label: 'Lakes',
    items: [
      {
        key: 'water_body:mascoma',
        kind: 'water_body',
        name: 'Mascoma Lake',
        sub: 'Reservoir · NH',
        meta: '3 reports today',
        href: '/water/mascoma',
        pick: { kind: 'water_body', id: 'mascoma' },
        silhouette: { rings: mascomaRings, bbox: box },
      },
    ],
  },
  {
    id: 'bays',
    label: 'Bays',
    items: [
      {
        key: 'sub_area:north',
        kind: 'sub_area',
        name: 'Mascoma North',
        sub: 'In Mascoma Lake',
        meta: '1 report Thu',
        href: '/water/mascoma?sub=north',
        pick: { kind: 'sub_area', id: 'mascoma/north' },
      },
      {
        key: 'sub_area:south',
        kind: 'sub_area',
        name: 'Mascoma South',
        sub: 'In Mascoma Lake',
        meta: '2 reports today',
        href: '/water/mascoma?sub=south',
        pick: { kind: 'sub_area', id: 'mascoma/south' },
      },
    ],
  },
  {
    id: 'skaters',
    label: 'Skaters',
    items: [
      {
        key: 'skater:mochs',
        kind: 'skater',
        name: 'Matt Ochs',
        sub: '@mochs',
        href: '/u/mochs',
        pick: { kind: 'skater', id: 'mochs' },
      },
    ],
  },
];

export const RECENTS: SearchGroup[] = [
  {
    id: 'recent',
    label: 'Recent',
    items: [
      { ...(RESULTS[0]?.items[0] as SearchGroup['items'][number]), sub: 'Reservoir · NH' },
      {
        key: 'water_body:crystal',
        kind: 'water_body',
        name: 'Crystal Lake',
        sub: 'Reservoir · NH',
        meta: '1 report Tue',
        href: '/water/crystal',
        pick: { kind: 'water_body', id: 'crystal' },
      },
      {
        key: 'skater:placasse',
        kind: 'skater',
        name: 'Pat Lacasse',
        sub: '@placasse',
        href: '/u/placasse',
        pick: { kind: 'skater', id: 'placasse' },
      },
    ],
  },
];

/** The board's rows, filtered like a server would, for the harness's typed queries. */
export function fixtureSearch(query: string): SearchGroup[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return RECENTS;
  return RESULTS.map((g) => ({
    ...g,
    items: g.items.filter((r) => r.name.toLowerCase().includes(q)),
  })).filter((g) => g.items.length > 0);
}

export const NOTIFICATIONS: NotificationRowModel[] = [
  {
    id: 'n1',
    title: 'Sarah Berman commented on your report on Mascoma Lake',
    detail: '2 new comments',
    when: '12 m',
    unread: true,
    mark: { kind: 'person', name: 'Sarah Berman' },
    href: '/report/r1',
    kind: 'report_commented',
  },
  {
    id: 'n2',
    title: 'Another skater confirmed your hazard on Mascoma Lake is still there',
    when: '1 h',
    unread: true,
    mark: { kind: 'icon', icon: 'hazard', tone: 'bad' },
    href: '/hazard/h1',
    kind: 'hazard_confirmation',
  },
  {
    id: 'n3',
    title: 'You skated on Crystal Lake. Add a report?',
    detail: 'Today · 7:50–8:40 AM',
    when: '2 h',
    unread: true,
    mark: { kind: 'icon', icon: 'clock' },
    href: '/water/crystal?post=new&postBody=crystal',
    kind: 'activity_detected',
  },
  {
    id: 'n4',
    title: '3 new reports near you across 2 lakes',
    detail: 'Mascoma Lake · Crystal Lake',
    when: 'Fri',
    unread: false,
    mark: { kind: 'icon', icon: 'report' },
    href: '/water/mascoma',
    kind: 'nearby_report_digest',
  },
  {
    id: 'n5',
    title: 'Pat Lacasse found your report on Mascoma Lake helpful',
    when: 'Wed',
    unread: false,
    mark: { kind: 'person', name: 'Pat Lacasse' },
    href: '/report/r2',
    kind: 'report_rated',
  },
  {
    id: 'n6',
    title: 'Someone’s looking for a report on Smith Pond',
    detail: 'You reported there recently — could you take another look?',
    when: 'Mon',
    unread: false,
    mark: { kind: 'icon', icon: 'bounty' },
    href: '/bounty/b1',
    kind: 'bounty_request',
  },
  {
    id: 'n7',
    title: 'A moderator reviewed something you flagged and left it up',
    when: '9 Jan',
    unread: false,
    mark: { kind: 'icon', icon: 'flag' },
    href: null,
    kind: 'content_flag_resolved',
  },
];
