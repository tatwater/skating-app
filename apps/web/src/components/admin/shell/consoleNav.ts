import type { Capability } from '@skating/core';
import type { GoLetter } from '@/lib/keys';

/**
 * Where the console's two shells meet while the old admin pages retire one mode at a time (B01,
 * the founder's transition call: rail option (a)).
 *
 * **One predicate decides three things** (`usesOldShell`): which shell `routes/admin.tsx` draws
 * (the old gate and sidebar, or the console), whether `AuthGate` wraps the page in the old
 * `AppShell`, and whether `<html>` carries `data-surface="admin"` — `lib/theme.ts`'s init script
 * keeps its own copy of {@link OLD_SHELL_TREES}, since a string constant can't import it, and
 * `oldShellPredicate.test.tsx` holds the two copies and all three behaviors to one answer.
 *
 * **Narrowing it is how a mode lands.** When a mode replaces old pages, its trees leave
 * {@link OLD_SHELL_TREES} (and the init script's copy), their entries leave {@link LEGACY_PAGES},
 * and the old routes become redirects; the old components are deleted at the phase's close, not
 * before. The list empties with the last old page, and the whole mechanism — this predicate, the
 * init script's removal, the `.dark` sync — goes with it.
 */

/** The old admin pages still standing: each the root of a tree that draws in the old shell. */
export const OLD_SHELL_TREES = [
  '/admin/flags',
  '/admin/users',
  '/admin/water',
  '/admin/features',
  '/admin/recurrence',
  '/admin/ice-calibration',
  '/admin/seasons',
  '/admin/support',
  '/admin/tuning',
  '/admin/imports',
] as const;

/** Whether `path` is `tree` or under it — `/administer` is not under `/admin`. */
function under(path: string, tree: string): boolean {
  return path === tree || path.startsWith(`${tree}/`);
}

/** Whether `path` is anywhere in the console's tree, old pages and new. */
export function isConsolePath(path: string): boolean {
  return under(path, '/admin');
}

/** Whether `path` is an old admin page still standing: the old gate, sidebar and `AppShell`. */
export function usesOldShell(path: string): boolean {
  return OLD_SHELL_TREES.some((tree) => under(path, tree));
}

// ── The rail ─────────────────────────────────────────────────────────────────────────────────

/** A mode the console has built: one rail item, one letter after G. */
export type ConsoleMode = {
  id: 'overview';
  /** The rail's name for it, capitalized. */
  name: string;
  to: string;
  /** Matched exactly, not as a tree (Overview is `/admin`, which every mode sits under). */
  exact?: boolean;
  goKey: GoLetter;
  /** The capability the mode's page reads with; without it the item isn't drawn. */
  capability: Capability;
};

/**
 * The modes built so far, in the rail's order. The rail lists a mode only once it exists — never
 * a placeholder for one still to come.
 */
export const CONSOLE_MODES: readonly ConsoleMode[] = [
  {
    id: 'overview',
    name: 'Overview',
    to: '/admin',
    exact: true,
    goKey: 'O',
    capability: 'inbox.read',
  },
];

/** The mode `path` is in, if it's one the console has built. */
export function modeAt(path: string): ConsoleMode | undefined {
  const bare = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return CONSOLE_MODES.find((m) => (m.exact ? bare === m.to : under(bare, m.to)));
}

/** An old page, linked from the rail's Legacy menu until its mode lands. */
export type LegacyPage = {
  label: string;
  to: string;
  /** The capability its old route reads with — the same line its old sidebar drew. */
  capability: Capability;
};

/**
 * The Legacy menu: every old page still standing, in the old sidebar's order, so nothing the old
 * console could do is out of reach while the new one fills in. Each is under exactly one of
 * {@link OLD_SHELL_TREES}, and every tree has at least one (`consoleNav.test.ts`).
 */
export const LEGACY_PAGES: readonly LegacyPage[] = [
  { label: 'Flags', to: '/admin/flags', capability: 'inbox.read' },
  { label: 'Users', to: '/admin/users', capability: 'people.read' },
  { label: 'Water bodies', to: '/admin/water', capability: 'body.read' },
  { label: 'Intake review', to: '/admin/water/review', capability: 'corpus.read' },
  { label: 'Standing', to: '/admin/water/standing', capability: 'corpus.read' },
  { label: 'Requests', to: '/admin/water/requests', capability: 'inbox.read' },
  { label: 'Place names', to: '/admin/water/place-names', capability: 'corpus.read' },
  { label: 'Body features', to: '/admin/features', capability: 'corpus.read' },
  { label: 'Hazard identity', to: '/admin/recurrence', capability: 'corpus.read' },
  { label: 'Ice calibration', to: '/admin/ice-calibration', capability: 'instruments.calibration' },
  { label: 'Seasons', to: '/admin/seasons', capability: 'season.read' },
  { label: 'Support', to: '/admin/support', capability: 'inbox.support.read' },
  { label: 'Tuning', to: '/admin/tuning', capability: 'instruments.tuning' },
  { label: 'Imports', to: '/admin/imports', capability: 'machinery.read' },
];
