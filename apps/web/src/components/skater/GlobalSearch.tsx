import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useRouter } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { bucketQueryLength, type SearchOpenSurface, useAnalytics } from '@/lib/analytics';
import { useChromeStore } from '@/stores/chromeStore';
import { type RecentPick, useSearchStore } from '@/stores/searchStore';

import { useChromeKeys, useChromeOverlay } from './chrome';
import { GlobalSearchView } from './GlobalSearchView';
import { markWaterBodyOpenSource } from './lake/openSource';
import { PhoneSearchView } from './phone/PhoneSearchView';
import {
  buildRecentGroup,
  buildResultGroups,
  cardBodyIds,
  MAX_SEARCH_ROWS,
  parseBayPickId,
  pickKey,
  type RecentCard,
  type ResolvedPick,
  rankOf,
  recentBodyIds,
  type SearchGroup,
  type SearchRow,
} from './searchModel';

/**
 * Global search, wired (boards 3.17–3.20): the two server searches (`waterBodies.searchByName` with
 * its bays, `profiles.searchProfiles`), the recent-report lines (`reports.recentCardsForBodies`),
 * the owner-bound recents (one `search.resolveRecents` read), `/` from any page, and the three search events — none of which ever
 * carries the query's text, only its length bucket.
 */

/** The same debounce as the old lake box: quick enough to feel live, slow enough to spare queries. */
const DEBOUNCE_MS = 150;

/**
 * Binds the recents to the signed-in account (mirrors `lib/sheetOwner`'s binding): one account's
 * search history must never surface for the next one on a shared browser. Waits for Clerk to load,
 * so a page load never reads as a sign-out.
 */
export function useSearchOwnerBinding(): void {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const bindOwner = useSearchStore((s) => s.bindOwner);
  useEffect(() => {
    if (!isLoaded) return;
    bindOwner(isSignedIn ? (userId ?? null) : null);
  }, [isLoaded, isSignedIn, userId, bindOwner]);
}

/** Opens search and records from where: the top bar's field, `/`, or (later) the phone's button. */
export function useOpenSearch(): (surface: SearchOpenSurface) => void {
  const { capture } = useAnalytics();
  return useCallback(
    (surface) => {
      if (useChromeStore.getState().overlay === 'search') return;
      useChromeStore.getState().setOverlay('search');
      capture('search_opened', { surface });
    },
    [capture],
  );
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** A pick as `search.resolveRecents` takes it: a bay by its own sub-area id. */
type RecentArg = { kind: RecentPick['kind']; id: string };

/**
 * The picks to resolve, at most a plate's worth, with the arg each sends. A bay pick whose stored
 * pair no longer parses is left out — it could only resolve to nothing.
 */
export function recentArgs(picks: readonly RecentPick[]): {
  sent: RecentPick[];
  args: RecentArg[];
} {
  const sent: RecentPick[] = [];
  const args: RecentArg[] = [];
  for (const pick of picks.slice(0, MAX_SEARCH_ROWS)) {
    if (pick.kind === 'sub_area') {
      const bay = parseBayPickId(pick.id);
      if (!bay) continue;
      args.push({ kind: 'sub_area', id: bay.subAreaId });
    } else {
      args.push({ kind: pick.kind, id: pick.id });
    }
    sent.push(pick);
  }
  return { sent, args };
}

type RecentRow = FunctionReturnType<typeof api.search.resolveRecents>[number];

/**
 * `resolveRecents`' rows, in the order sent, as the model's resolved picks. A `null` row (a removed
 * lake, a deleted bay, a skater you can no longer see) resolves nothing, and its pick drops.
 */
export function resolvePicks(
  sent: readonly RecentPick[],
  rows: readonly (RecentRow | null)[] | undefined,
): Map<string, ResolvedPick> {
  const out = new Map<string, ResolvedPick>();
  sent.forEach((pick, i) => {
    const row = rows?.[i];
    if (!row || row.kind !== pick.kind) return;
    if (row.kind === 'water_body') {
      out.set(pickKey(pick), {
        kind: 'water_body',
        name: row.name,
        type: row.type,
        states: row.states,
        ...(row.inactive ? { inactive: true } : {}),
        ...(row.outline ? { outline: row.outline } : {}),
      });
    } else if (row.kind === 'sub_area') {
      out.set(pickKey(pick), { kind: 'sub_area', name: row.name, parentName: row.parentName });
    } else {
      out.set(pickKey(pick), {
        kind: 'skater',
        displayName: row.displayName,
        username: row.username,
        ...(row.profileImageUrl ? { imageUrl: row.profileImageUrl } : {}),
      });
    }
  });
  return out;
}

export function GlobalSearch({
  container,
  layout = 'bar',
}: {
  container?: HTMLElement | null;
  /** `phone`: the phone's field and full-screen results (board 9.6), recorded as surface `phone`. */
  layout?: 'bar' | 'phone';
} = {}) {
  const router = useRouter();
  const { capture } = useAnalytics();
  const { open, onOpenChange } = useChromeOverlay('search');
  const openSearch = useOpenSearch();
  useChromeKeys(useCallback(() => openSearch('hotkey'), [openSearch]));
  const recents = useSearchStore((s) => s.recents);
  const addRecent = useSearchStore((s) => s.addRecent);

  const [text, setText] = useState('');
  // Each opening starts fresh.
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  const debounced = useDebounced(text.trim(), DEBOUNCE_MS);
  const term = open && debounced.length >= 2 ? debounced : null;

  const water = useQuery(
    api.waterBodies.searchByName,
    term ? { query: term, limit: MAX_SEARCH_ROWS } : 'skip',
  );
  const skaters = useQuery(api.profiles.searchProfiles, term ? { query: term } : 'skip');

  const showRecents = open && term === null;
  // One read for every recent pick (B03 §11), not one per pick.
  const { sent, args: recentPicks } = useMemo(() => recentArgs(recents), [recents]);
  const recentRows = useQuery(
    api.search.resolveRecents,
    showRecents && recentPicks.length > 0 ? { picks: recentPicks } : 'skip',
  );

  const ids = term ? cardBodyIds(water ?? []) : showRecents ? recentBodyIds(recents) : [];
  const cards = useQuery(
    api.reports.recentCardsForBodies,
    ids.length > 0 ? { waterBodyIds: ids as Id<'waterBodies'>[] } : 'skip',
  ) as RecentCard[] | undefined;

  const now = Date.now();
  const settled = term !== null && water !== undefined && skaters !== undefined;
  const fresh: SearchGroup[] | null = showRecents
    ? buildRecentGroup(sent, resolvePicks(sent, recentRows), cards ?? [], now)
    : settled
      ? buildResultGroups(water ?? [], skaters ?? [], cards ?? [], now)
      : null;

  // Stale while loading: the last answer stays up until the next one lands, so the plate never
  // flashes empty (or "nothing found") between keystrokes.
  const last = useRef<SearchGroup[]>([]);
  if (fresh !== null) last.current = fresh;
  if (!open) last.current = [];
  const groups = fresh ?? last.current;

  const typing = text.trim() !== debounced;
  const loading = open && text.trim().length >= 2 && (typing || !settled);
  const noResults = settled && !typing && groups.length === 0;

  useEffect(() => {
    if (noResults && term)
      capture('search_no_results', { query_length_bucket: bucketQueryLength(term.length) });
  }, [noResults, term, capture]);

  const onPick = (row: SearchRow) => {
    capture('search_result_opened', {
      result_kind: row.kind,
      rank: rankOf(groups, row.key),
      // A Recent pick is not a search: no query was asked, so no length is reported (D240).
      query_length_bucket: showRecents ? 'recent' : bucketQueryLength(text.trim().length),
    });
    addRecent(row.pick);
    onOpenChange(false);
    markWaterBodyOpenSource('search', row.href);
    router.history.push(row.href);
  };

  const View = layout === 'phone' ? PhoneSearchView : GlobalSearchView;
  return (
    <View
      open={open}
      onOpenChange={(next) =>
        next ? openSearch(layout === 'phone' ? 'phone' : 'top_bar') : onOpenChange(false)
      }
      query={text}
      onQueryChange={setText}
      groups={groups}
      loading={loading}
      noResultsFor={noResults ? text.trim() : null}
      onPick={onPick}
      {...(container !== undefined ? { container } : {})}
    />
  );
}
