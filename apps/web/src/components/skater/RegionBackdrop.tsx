import regionDark from '@/assets/basemap/region-dark.png';
import regionLight from '@/assets/basemap/region-light.png';
import { cn } from '@/lib/utils';

/**
 * The ground of every sign-in and system screen: the region, never one lake (Review 4). One picture
 * per theme, `object-fit: cover`, anchored to its bottom edge — each picture is cropped so the line
 * along the bottom of New York and most of Massachusetts sits just below the canvas, so that edge is
 * the one that must stay put when the viewport crops the rest. It runs past the other three.
 *
 * **Which picture shows follows the token sheet's contract (D241), not `.dark`:** `data-mode` on the
 * root states an override, and its absence means follow the OS. `.dark` is the legacy class that
 * retires with the old `/admin` UI, and this has to outlive it. Both images are `loading="lazy"`, so
 * the one that stays `display: none` is never fetched.
 *
 * Absolutely positioned against its parent by default; `className` moves it (`fixed`, or under a top
 * bar: `-top-14 h-[calc(100%+3.5rem)]`, so the map doesn't shift between screens).
 */
export function RegionBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-slot="region-backdrop"
      className={cn('pointer-events-none absolute inset-0 select-none overflow-hidden', className)}
    >
      <img
        src={regionDark}
        alt=""
        loading="lazy"
        decoding="async"
        data-theme-picture="dark"
        className="hidden size-full object-cover object-bottom [:root:not([data-mode])_&]:[@media(prefers-color-scheme:dark)]:block [:root[data-mode=dark]_&]:block"
      />
      <img
        src={regionLight}
        alt=""
        loading="lazy"
        decoding="async"
        data-theme-picture="light"
        className="hidden size-full object-cover object-bottom [:root:not([data-mode])_&]:[@media(prefers-color-scheme:light)]:block [:root[data-mode=light]_&]:block"
      />
    </div>
  );
}

/**
 * The picture's attribution, on its own plate so it stays legible over the water. It travels with
 * {@link RegionBackdrop}: wherever the region is the ground, this sits in a corner of it.
 */
export function RegionCredit({ className }: { className?: string }) {
  return (
    <div data-slot="region-credit" className={cn('bg-bg px-[0.5625rem] py-[0.375rem]', className)}>
      <span className="text-kick text-fg3 leading-none">
        State lines: U.S. Census Bureau · Water: OpenStreetMap contributors
      </span>
    </div>
  );
}
