/**
 * The Body console's search: everything about the page a link, a reload and the back button must
 * keep — which tab is open, which item is lit, and where ⇧⏎ (and the place control) go back to.
 *
 * Validated, never trusted:
 * - **`tab`** — one of the nine; Shape is the default and is written as no param, so
 *   `/admin/body/<id>` is Shape. An unknown tab reads as Shape.
 * - **`lit`** — the addressable highlight (`?lit=ask:<id>`, `bay:<id>`, `landmark:<id>`): a kind,
 *   a colon, an id. Anything else is dropped rather than drawn.
 * - **`from`** — the list the operator came from, **with its own search**, so going back lands on
 *   the list exactly as it was. Only a path under {@link RETURN_PATHS} is kept: a same-origin path,
 *   never a scheme, a host or a protocol-relative `//`, so a crafted link can't send the console
 *   anywhere else.
 */

export const BODY_TABS = [
  'shape',
  'names',
  'places',
  'access',
  'water',
  'imagery',
  'hazards',
  'standing',
  'links',
] as const;
export type BodyTabKey = (typeof BODY_TABS)[number];

/** What the route keeps: a tab other than Shape, a lit item, a return path — each only if valid. */
export type BodyConsoleSearch = {
  tab?: Exclude<BodyTabKey, 'shape'>;
  lit?: string;
  from?: string;
};

/**
 * Where `from` may point. The Bodies list is the console's own home for bodies; the old find-a-lake
 * page still links here while it stands, and a link from there returns there.
 */
export const RETURN_PATHS = ['/admin/bodies', '/admin/water'] as const;

/** Where the place control and ⇧⏎ go when no `from` came with the link: the Bodies list. */
export const DEFAULT_RETURN = '/admin/bodies';

/** A lit address: a lower-camel kind, a colon, an id of word characters, dots and dashes. */
const LIT = /^[a-z][a-zA-Z]{0,31}:[A-Za-z0-9_.-]{1,128}$/;

const MAX_FROM = 2048;

export function isBodyTab(value: unknown): value is BodyTabKey {
  return typeof value === 'string' && (BODY_TABS as readonly string[]).includes(value);
}

export function isLit(value: unknown): value is string {
  return typeof value === 'string' && LIT.test(value);
}

/**
 * A return path the console may navigate to: same-origin, under one of {@link RETURN_PATHS} (the
 * path itself or below it), its search and hash kept. Returns the normalized path, or `null`.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FROM) return null;
  // A path, and only a path: no scheme, no host, no `//` or `\\` that a browser reads as one.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value, 'https://console.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://console.invalid') return null;
  const path = url.pathname;
  const allowed = RETURN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  return allowed ? `${path}${url.search}${url.hash}` : null;
}

/** The route's `validateSearch`: keeps what is valid, drops everything else. */
export function validateBodySearch(raw: Record<string, unknown>): BodyConsoleSearch {
  const out: BodyConsoleSearch = {};
  if (isBodyTab(raw.tab) && raw.tab !== 'shape') out.tab = raw.tab;
  if (isLit(raw.lit)) out.lit = raw.lit;
  const from = safeReturnPath(raw.from);
  if (from !== null) out.from = from;
  return out;
}

/** The open tab. */
export function bodyTabOf(search: BodyConsoleSearch): BodyTabKey {
  return search.tab ?? 'shape';
}

/** Where going back lands. */
export function returnPathOf(search: BodyConsoleSearch): string {
  return search.from ?? DEFAULT_RETURN;
}

/**
 * The search for a new tab and lit item, keeping the return path. Opening a tab drops the old
 * lit item unless a new one is named: a highlight belongs to the tab that drew it.
 */
export function searchFor(
  search: BodyConsoleSearch,
  next: { tab?: BodyTabKey; lit?: string | null },
): BodyConsoleSearch {
  const tab = next.tab ?? bodyTabOf(search);
  const tabChanged = tab !== bodyTabOf(search);
  const lit = next.lit === undefined ? (tabChanged ? null : (search.lit ?? null)) : next.lit;
  return {
    ...(tab !== 'shape' ? { tab } : {}),
    ...(lit !== null && isLit(lit) ? { lit } : {}),
    ...(search.from !== undefined ? { from: search.from } : {}),
  };
}

/** The link that opens a body's console from a list, carrying the list's own address back. */
export function bodyConsoleHref(bodyId: string, from?: string, tab?: BodyTabKey): string {
  const params = new URLSearchParams();
  if (tab !== undefined && tab !== 'shape') params.set('tab', tab);
  const back = from === undefined ? null : safeReturnPath(from);
  if (back !== null) params.set('from', back);
  const q = params.toString();
  return `/admin/body/${encodeURIComponent(bodyId)}${q ? `?${q}` : ''}`;
}
