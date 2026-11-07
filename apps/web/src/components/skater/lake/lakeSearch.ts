import { z } from 'zod';

/**
 * The Explore routes' search params (D242). Every field `.catch()`es to its default, so a stale or
 * hand-edited link degrades to the default view instead of an error page: the grammar's contract
 * is "old links keep working". The root params (`?post=`, `?postBody=`) are the skater layout's,
 * not these.
 */

/** `/` — nothing chosen. `act=request` is the request-a-lake flow (agent J's). */
export const exploreSearchSchema = z.object({
  act: z
    .literal('request')
    .optional()
    .catch(() => undefined),
});

export type ExploreSearch = z.infer<typeof exploreSearchSchema>;

export const LAKE_TABS = ['reports', 'weather', 'access', 'about'] as const;
export type LakeTab = (typeof LAKE_TABS)[number];

/** The tab row's words. "Getting there" is the access tab's name on every board. */
export const LAKE_TAB_LABELS: Readonly<Record<LakeTab, string>> = {
  reports: 'Reports',
  weather: 'Weather',
  access: 'Getting there',
  about: 'About',
};

export const LAKE_ACTS = ['hazard', 'bounty', 'imagery', 'access-problem'] as const;
export type LakeAct = (typeof LAKE_ACTS)[number];

/**
 * `/water/$id`. `tab` defaults to Reports (the report is the center of the app); `sub` frames a
 * bay (1.10); `act` opens an action over the sidebar (row 3); `band` and `frame` belong to the
 * imagery action. `frame` is a calendar day — anything else drops to the latest frame.
 *
 * **`?hazard` is the old link, kept** (D242): the report console's *mark one here* hand-off and any
 * link minted before the grammar changed say `?hazard=true`; it folds into `act=hazard` and never
 * reaches the page as its own param.
 */
export const lakeSearchSchema = z
  .object({
    tab: z.enum(LAKE_TABS).default('reports').catch('reports'),
    sub: z
      .string()
      .min(1)
      .optional()
      .catch(() => undefined),
    act: z
      .enum(LAKE_ACTS)
      .optional()
      .catch(() => undefined),
    band: z
      .enum(['tc', 'vh'])
      .optional()
      .catch(() => undefined),
    frame: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .catch(() => undefined),
    hazard: z
      .union([z.literal(true), z.literal('true')])
      .optional()
      .catch(() => undefined),
  })
  .transform(({ hazard, ...search }) =>
    search.act === undefined && hazard !== undefined
      ? { ...search, act: 'hazard' as const }
      : search,
  );

export type LakeSearch = z.infer<typeof lakeSearchSchema>;
