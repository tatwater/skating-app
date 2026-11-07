import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useRouter } from '@tanstack/react-router';
import { type RequestForQueries, useQueries, useQuery } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { bucketQueryLength, type SearchOpenSurface, useAnalytics } from '@/lib/analytics';
import { useChromeStore } from '@/stores/chromeStore';
import { type RecentPick, useSearchStore } from '@/stores/searchStore';

import { useChromeKeys, useChromeOverlay } from './chrome';
import { GlobalSearchView } from './GlobalSearchView';
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
 * the owner-bound recents, `/` from any page, and the three search events — none of which ever
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

/** Each recent pick's query: a lake by id, a bay through its lake's list, a skater by username. */
function recentQuerySpec(picks: readonly RecentPick[]) {
  const spec: RequestForQueries = {};
  for (const pick of picks.slice(0, MAX_SEARCH_ROWS)) {
    if (pick.kind === 'water_body') {
      spec[`water:${pick.id}`] = {
        query: api.waterBodies.get,
        args: { waterBodyId: pick.id as Id<'waterBodies'> },
      };
    } else if (pick.kind === 'sub_area') {
      const bay = parseBayPickId(pick.id);
      if (!bay) continue;
      spec[`water:${bay.waterBodyId}`] = {
        query: api.waterBodies.get,
        args: { waterBodyId: bay.waterBodyId as Id<'waterBodies'> },
      };
      spec[`bays:${bay.waterBodyId}`] = {
        query: api.subAreas.listForBody,
        args: { waterBodyId: bay.waterBodyId as Id<'waterBodies'> },
      };
    } else {
      spec[`skater:${pick.id}`] = {
        query: api.profiles.getPublicProfile,
        args: { username: pick.id },
      };
    }
  }
  return spec;
}

type BodyResult = { available: false } | { available: true; body: WaterBody } | null;
type WaterBody = { name: string; type: string; states?: string[]; standing?: unknown };
type BayList = { _id: string; name: string }[];
type Profile = { username: string; displayName: string; profileImageUrl?: string } | null;

/** The answered queries, as the model's resolved picks. A failed or missing answer resolves nothing. */
export function resolvePicks(
  picks: readonly RecentPick[],
  results: Record<string, unknown>,
): Map<string, ResolvedPick> {
  const out = new Map<string, ResolvedPick>();
  const body = (id: string): WaterBody | null => {
    const r = results[`water:${id}`] as BodyResult | Error | undefined;
    if (!r || r instanceof Error || !r.available) return null;
    return r.body;
  };
  for (const pick of picks) {
    if (pick.kind === 'water_body') {
      const b = body(pick.id);
      if (b) {
        out.set(pickKey(pick), {
          kind: 'water_body',
          name: b.name,
          type: b.type,
          states: b.states ?? [],
        });
      }
    } else if (pick.kind === 'sub_area') {
      const bay = parseBayPickId(pick.id);
      const lake = bay ? body(bay.waterBodyId) : null;
      const list = bay
        ? (results[`bays:${bay.waterBodyId}`] as BayList | Error | undefined)
        : undefined;
      const row = Array.isArray(list) ? list.find((b) => b._id === bay?.subAreaId) : undefined;
      if (lake && row) {
        out.set(pickKey(pick), { kind: 'sub_area', name: row.name, parentName: lake.name });
      }
    } else {
      const p = results[`skater:${pick.id}`] as Profile | Error | undefined;
      if (p && !(p instanceof Error)) {
        out.set(pickKey(pick), {
          kind: 'skater',
          displayName: p.displayName,
          username: p.username,
          ...(p.profileImageUrl ? { imageUrl: p.profileImageUrl } : {}),
        });
      }
    }
  }
  return out;
}

export function GlobalSearch({ container }: { container?: HTMLElement | null } = {}) {
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
  const recentResults = useQueries(showRecents ? recentQuerySpec(recents) : {});

  const ids = term ? cardBodyIds(water ?? []) : showRecents ? recentBodyIds(recents) : [];
  const cards = useQuery(
    api.reports.recentCardsForBodies,
    ids.length > 0 ? { waterBodyIds: ids as Id<'waterBodies'>[] } : 'skip',
  ) as RecentCard[] | undefined;

  const now = Date.now();
  const settled = term !== null && water !== undefined && skaters !== undefined;
  const fresh: SearchGroup[] | null = showRecents
    ? buildRecentGroup(recents, resolvePicks(recents, recentResults), cards ?? [], now)
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
      query_length_bucket: bucketQueryLength(text.trim().length),
    });
    addRecent(row.pick);
    onOpenChange(false);
    router.history.push(row.href);
  };

  return (
    <GlobalSearchView
      open={open}
      onOpenChange={(next) => (next ? openSearch('top_bar') : onOpenChange(false))}
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
