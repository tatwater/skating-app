import { tokens } from '@skating/design';
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Tailwind's theme namespaces (as `@skating/design` wires them) → tailwind-merge's theme groups.
 * Without this, tailwind-merge can't tell `text-kick` (a size) from `text-fg1` (a color), treats
 * both as colors, and silently drops whichever comes first.
 */
const NAMESPACE_TO_GROUP = {
  color: 'color',
  text: 'text',
  spacing: 'spacing',
  'font-weight': 'font-weight',
  font: 'font',
  tracking: 'tracking',
  leading: 'leading',
  radius: 'radius',
  shadow: 'shadow',
  ease: 'ease',
  breakpoint: 'breakpoint',
} as const;
type Group = (typeof NAMESPACE_TO_GROUP)[keyof typeof NAMESPACE_TO_GROUP];

/** Every token the design package exposes to Tailwind, grouped as tailwind-merge's theme. */
export function tokenMergeTheme(
  entries: ReadonlyArray<{ readonly tailwindVar?: string }> = tokens.registry,
): Record<Group, string[]> {
  const theme = Object.fromEntries(
    Object.values(NAMESPACE_TO_GROUP).map((group) => [group, [] as string[]]),
  ) as Record<Group, string[]>;
  // Longest namespace first, so `--font-weight-x` isn't read as the `font` namespace.
  const namespaces = Object.keys(NAMESPACE_TO_GROUP).sort((a, b) => b.length - a.length);
  for (const { tailwindVar } of entries) {
    if (tailwindVar === undefined) continue;
    const ns = namespaces.find((n) => tailwindVar.startsWith(`--${n}-`));
    if (ns === undefined) continue;
    theme[NAMESPACE_TO_GROUP[ns as keyof typeof NAMESPACE_TO_GROUP]].push(
      tailwindVar.slice(ns.length + 3),
    );
  }
  return theme;
}

const twMerge = extendTailwindMerge({
  extend: {
    theme: tokenMergeTheme(),
    // kit.css's own utilities: each its own group, so `text-trim` never
    // collides with the `text-*` color/size groups and get dropped.
    classGroups: { 'text-trim': ['text-trim'] },
  },
});

/** Merge conditional class lists, de-duplicating conflicting Tailwind utilities (shadcn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
