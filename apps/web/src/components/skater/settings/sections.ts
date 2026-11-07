import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBan,
  faBell,
  faDownload,
  faHouse,
  faLifeRing,
  faPen,
  faRoute,
  faUser,
} from '@fortawesome/sharp-light-svg-icons';
import { z } from 'zod';

/**
 * The settings sections (board row 7): one path segment each, `/settings/<key>` (D242). The order
 * is the left list's, top to bottom. A key is the URL's, so renaming one breaks links — the label
 * is free to change.
 */
export const SETTINGS_SECTIONS = [
  { key: 'account', label: 'Account', icon: faUser },
  { key: 'profile', label: 'Your profile', icon: faPen },
  { key: 'home', label: 'Home and drive time', icon: faHouse },
  { key: 'notifications', label: 'Notifications', icon: faBell },
  { key: 'reporting', label: 'Reports and tracks', icon: faRoute },
  { key: 'blocked', label: 'Blocked people', icon: faBan },
  { key: 'support', label: 'Contact support', icon: faLifeRing },
  { key: 'data', label: 'Data and account', icon: faDownload },
] as const satisfies readonly { key: string; label: string; icon: IconDefinition }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['key'];

const KEYS = SETTINGS_SECTIONS.map((s) => s.key) as [SettingsSection, ...SettingsSection[]];

/** The `$section` param: one of the keys, or the route's not-found. */
export const settingsSectionSchema = z.enum(KEYS);

export function isSettingsSection(value: string): value is SettingsSection {
  return settingsSectionSchema.safeParse(value).success;
}

/** Where `/settings` lands. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'account';

/**
 * `/settings/home`'s views (7.18 change home, 7.19 traveling): views, so the URL holds them; a
 * bad value degrades to the home summary rather than an error (D242).
 */
export const homeSearchSchema = z.object({
  edit: z
    .boolean()
    .optional()
    .catch(() => undefined),
  travel: z
    .boolean()
    .optional()
    .catch(() => undefined),
});

export type HomeSearch = z.infer<typeof homeSearchSchema>;

/**
 * While a deletion is pending the profile is cleared and can't be edited (D62), so its section
 * leaves the list; the data section carries the pending mark.
 */
export function visibleSections(leaving: boolean) {
  return SETTINGS_SECTIONS.filter((s) => !(leaving && s.key === 'profile'));
}
