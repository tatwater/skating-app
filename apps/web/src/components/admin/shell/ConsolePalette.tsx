import { api } from '@skating/convex/api';
import { type Capability, searchQueryArg } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';
import {
  type CommandGroup,
  type CommandItem,
  CommandPalette,
} from '@/components/kit/command-palette';
import { CONSOLE_MODES, LEGACY_PAGES } from './consoleNav';

/**
 * The console's ⌘K palette, wired: the places the console can go, the bodies and the people,
 * searched on the server as the operator types (nothing is filtered in the browser but the
 * console's own short list of places). Each group shows only what the viewer may open (D217).
 *
 * Until the Body console and People land, a body opens the old lake editor and a person the old
 * user page — the pages that hold them today.
 */

/** How long typing rests before the server is asked. */
const SEARCH_REST_MS = 150;

function useResting(value: string, ms: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return rested;
}

/** Where a chosen row goes. */
export type PaletteTarget = { to: string };

/** The places group: the built modes, then the old pages, matched on their names. */
export function placeItems(query: string, can: (c: Capability) => boolean): CommandItem[] {
  const q = query.trim().toLowerCase();
  const places = [
    ...CONSOLE_MODES.filter((m) => can(m.capability)).map((m) => ({
      id: m.to,
      label: m.name,
      sub: undefined as string | undefined,
    })),
    ...LEGACY_PAGES.filter((p) => can(p.capability)).map((p) => ({
      id: p.to,
      label: p.label,
      sub: 'Legacy',
    })),
  ];
  return places
    .filter((p) => q.length === 0 || p.label.toLowerCase().includes(q))
    .map((p) => ({ id: p.id, label: p.label, verb: 'Go', ...(p.sub ? { sub: p.sub } : {}) }));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ConsolePalette({
  open,
  onOpenChange,
  can,
  onGo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  can: (c: Capability) => boolean;
  onGo: (target: PaletteTarget) => void;
}) {
  const [query, setQuery] = useState('');
  const rested = useResting(query, SEARCH_REST_MS);
  // Closed by any path — Esc, a choice, or the shell's ⌘K toggling `open` without asking — it
  // starts empty next time.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const bodyArg = open && can('body.read') ? searchQueryArg(rested, 6) : 'skip';
  const bodies = useQuery(
    api.waterBodies.searchByName,
    bodyArg === 'skip' ? 'skip' : { ...bodyArg, bodiesOnly: true },
  );
  const personTerm = rested.trim();
  const people = useQuery(
    api.admin.userSearch,
    open && can('people.read') && personTerm.length > 0 ? { query: personTerm } : 'skip',
  );

  const groups = useMemo<CommandGroup[]>(() => {
    const out: CommandGroup[] = [];
    const places = placeItems(query, can);
    if (places.length > 0) out.push({ id: 'places', label: 'Go to', items: places });
    if (bodies !== undefined && bodies.length > 0) {
      out.push({
        id: 'bodies',
        label: 'Bodies',
        items: bodies.map((b) => ({
          id: `body:${b.waterBodyId}`,
          label: b.name,
          sub: [capitalize(b.type), b.states.join(', ')].filter(Boolean).join(' · '),
          verb: 'Open',
        })),
      });
    }
    if (people !== undefined && people.length > 0) {
      out.push({
        id: 'people',
        label: 'People',
        items: people.map((p) => ({
          id: `person:${p.userId}`,
          label: p.displayName,
          sub: `@${p.username}`,
          verb: 'Open',
        })),
      });
    }
    return out;
  }, [query, can, bodies, people]);

  // Typed past what the server has answered: say so with the spinner, keep the rows.
  const loading =
    query !== rested ||
    (bodyArg !== 'skip' && bodies === undefined) ||
    (personTerm.length > 0 && can('people.read') && people === undefined);

  return (
    <CommandPalette
      hotkey={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      loading={loading}
      placeholder="Find a body, a person or a page"
      onSelect={(item) => {
        if (item.id.startsWith('body:')) onGo({ to: `/admin/water/${item.id.slice(5)}` });
        else if (item.id.startsWith('person:')) onGo({ to: `/admin/users/${item.id.slice(7)}` });
        else onGo({ to: item.id });
        setQuery('');
      }}
    />
  );
}
