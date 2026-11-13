import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { HazardMark, KEY_GLYPH, LotMark, PhotoMark, PutInMark } from './map-marks';

/**
 * The map's key, on both surfaces: a slim bar along the map's bottom edge, each kind the map is
 * drawing as its own mark at 12 px (`map-marks`' glyphs) and a name. A map lists only what it
 * shows, and a name is a noun for what the mark *is* — never a word about the ice.
 */

type MapKeyKind =
  | 'putIn'
  | 'lot'
  | 'hazard'
  | 'healing'
  | 'passage'
  | 'photo'
  | 'track'
  | 'yourTrack';

/**
 * The room a map's foot controls leave for the key, on the element over both: `--map-foot` is the
 * key's height while one is drawn, so the plates and the credits that sit on the bottom edge rise
 * above it instead of under it.
 */
const MAP_FOOT_ROOM = 'has-[[data-slot=map-key]]:[--map-foot:1.875rem]';

/** A line's glyph, as the GL layer draws it: the track's ice, solid or dashed. */
function LineGlyph({ dashed }: { dashed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-kind={dashed ? 'your-track' : 'track'}
      width={KEY_GLYPH + 4}
      height={KEY_GLYPH}
      viewBox="0 0 16 12"
      className="block shrink-0"
    >
      <path
        d="M1 6 H15"
        strokeWidth={2}
        strokeDasharray={dashed ? '2.5 2' : undefined}
        className="stroke-acc"
      />
    </svg>
  );
}

const ENTRIES: Record<MapKeyKind, { label: string; glyph: () => ReactNode }> = {
  putIn: { label: 'Put-in', glyph: () => <PutInMark glyph /> },
  lot: { label: 'Lot', glyph: () => <LotMark glyph /> },
  hazard: { label: 'Hazard', glyph: () => <HazardMark glyph /> },
  healing: { label: 'Healing hazard', glyph: () => <HazardMark glyph tone="healing" /> },
  passage: { label: 'Ridge crossing', glyph: () => <HazardMark glyph tone="passage" /> },
  photo: { label: 'Photo', glyph: () => <PhotoMark glyph /> },
  track: { label: 'Track', glyph: () => <LineGlyph dashed={false} /> },
  yourTrack: { label: 'Your track', glyph: () => <LineGlyph dashed /> },
};

/** The key's order, whatever order a map hands its kinds in. */
const MAP_KEY_ORDER = Object.keys(ENTRIES) as MapKeyKind[];

function MapKey({
  kinds,
  dim = false,
  className,
}: {
  kinds: readonly MapKeyKind[];
  /** A mode has the map: the key steps back with the rest of the pane. */
  dim?: boolean;
  className?: string;
}) {
  const shown = MAP_KEY_ORDER.filter((kind) => kinds.includes(kind));
  if (shown.length === 0) return null;
  return (
    <ul
      data-slot="map-key"
      // biome-ignore lint/a11y/noRedundantRoles: `list-none` strips the implied list role in Safari/VoiceOver; saying it back keeps the key a named list there.
      role="list"
      aria-label="Map key"
      className={cn(
        'absolute inset-x-0 bottom-0 z-(--z-map-control) m-0 flex h-7.5 list-none items-center gap-(--space-3) px-(--space-3)',
        'border-0 border-t border-solid border-line bg-map-plate',
        'text-kick leading-none font-medium tracking-rail whitespace-nowrap text-fg2 uppercase',
        // A phone's width scrolls the row rather than wrapping it.
        'overflow-x-auto [scrollbar-width:none]',
        'transition-opacity duration-(--duration-base) ease-standard',
        dim && 'opacity-30',
        className,
      )}
    >
      {shown.map((kind) => (
        <li
          key={kind}
          data-key={kind}
          className="inline-flex shrink-0 items-center gap-(--space-1_5)"
        >
          {ENTRIES[kind].glyph()}
          {ENTRIES[kind].label}
        </li>
      ))}
    </ul>
  );
}

export { MAP_FOOT_ROOM, MAP_KEY_ORDER, MapKey, type MapKeyKind };
