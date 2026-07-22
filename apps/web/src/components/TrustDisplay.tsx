import { TRUST_CLASS_COLORS, TRUST_CLASS_LABELS, type TrustClass } from '@skating/core';
import { Avatar } from './Avatar';

/**
 * Trust display primitives (D50 decision 5) — the cosmetic, boost-only reputation signal rendered as a
 * **class**, never a raw number (except to admins, elsewhere). One shared `TrustAvatar` (a colored ring +
 * corner dot around the author avatar) is used *everywhere* an author appears (feed cards, comments,
 * report/hazard/bounty authors); the `TrustClassChip` is the labelled pill shown on the profile page.
 *
 * A `null` class is a real state — a below-`trusted` account past the New window — and renders **no** ring
 * and **no** chip (we never render "Not trusted"). Colors/labels are single-sourced in `@skating/core` so
 * web (CSS) and mobile (RN) stay in lockstep.
 */

/** A ringed avatar: the base `Avatar` wrapped in the class color (ring + corner dot). `null` ⇒ plain avatar. */
export function TrustAvatar({
  displayName,
  imageUrl,
  trustClass,
  size = 40,
}: {
  displayName: string;
  imageUrl?: string;
  trustClass?: TrustClass | null;
  size?: number;
}) {
  const color = trustClass ? TRUST_CLASS_COLORS[trustClass] : undefined;
  const label = trustClass ? TRUST_CLASS_LABELS[trustClass] : undefined;
  const dot = Math.max(8, Math.round(size / 4));
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        // A 2px gap ring: inner ring is the page surface so the color reads as a ring, not a fill.
        boxShadow: color ? `0 0 0 2px var(--color-surface, #fff), 0 0 0 4px ${color}` : undefined,
      }}
      title={label ? `${label} skater` : undefined}
    >
      <Avatar displayName={displayName} imageUrl={imageUrl} size={size} />
      {color ? (
        <span
          aria-hidden
          className="absolute right-0 bottom-0 rounded-full ring-2 ring-[var(--color-surface,#fff)]"
          style={{ width: dot, height: dot, backgroundColor: color }}
        />
      ) : null}
      {label ? <span className="sr-only">{label} skater</span> : null}
    </div>
  );
}

/** The labelled class pill for the profile page. `null` ⇒ renders nothing (no "Not trusted", D50). */
export function TrustClassChip({ trustClass }: { trustClass: TrustClass | null }) {
  if (!trustClass) return null;
  const color = TRUST_CLASS_COLORS[trustClass];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium text-xs"
      style={{ color, backgroundColor: `${color}1a`, border: `1px solid ${color}66` }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {TRUST_CLASS_LABELS[trustClass]}
    </span>
  );
}
