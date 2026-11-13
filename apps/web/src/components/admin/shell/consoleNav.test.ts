import { CAPABILITIES } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_MODES,
  isConsolePath,
  LEGACY_PAGES,
  modeAt,
  OLD_SHELL_TREES,
  usesOldShell,
} from './consoleNav';

describe('the console tree', () => {
  it.each(['/admin', '/admin/', '/admin/inbox', '/admin/water/abc'])('holds %s', (path) => {
    expect(isConsolePath(path)).toBe(true);
  });

  it.each(['/', '/administer', '/latest', '/water/admin'])('does not hold %s', (path) => {
    expect(isConsolePath(path)).toBe(false);
  });

  it('keeps an old page and everything under it in the old shell, and nothing that only shares a prefix', () => {
    expect(usesOldShell('/admin/water')).toBe(true);
    expect(usesOldShell('/admin/water/review')).toBe(true);
    expect(usesOldShell('/admin/water-bodies')).toBe(false);
    expect(usesOldShell('/admin')).toBe(false);
  });

  it('keeps the old dashboard in the old shell at its new home, and the Overview out of it', () => {
    expect(usesOldShell('/admin/dashboard')).toBe(true);
    expect(usesOldShell('/admin/dashboards')).toBe(false);
    expect(usesOldShell('/admin/')).toBe(false);
    expect(LEGACY_PAGES[0]).toMatchObject({ label: 'Dashboard', to: '/admin/dashboard' });
  });
});

describe('the Legacy menu and the old shell agree', () => {
  it('links only to old pages still standing', () => {
    for (const page of LEGACY_PAGES) expect(usesOldShell(page.to)).toBe(true);
  });

  it('reaches every old tree, so no old page is out of reach', () => {
    for (const tree of OLD_SHELL_TREES) {
      expect(LEGACY_PAGES.some((p) => p.to === tree || p.to.startsWith(`${tree}/`))).toBe(true);
    }
  });

  it('draws the old sidebar’s admin-only line: support, tuning, imports and seasons are admin', () => {
    const adminOnly = LEGACY_PAGES.filter((p) => CAPABILITIES[p.capability].role === 'admin').map(
      (p) => p.to,
    );
    expect(adminOnly.sort()).toEqual(
      ['/admin/imports', '/admin/seasons', '/admin/support', '/admin/tuning'].sort(),
    );
  });
});

describe('the built modes', () => {
  it('never sends a built mode to the old shell', () => {
    for (const mode of CONSOLE_MODES) expect(usesOldShell(mode.to)).toBe(false);
  });

  it('gives every mode its own go letter, and none of Legacy’s or the app’s', () => {
    const letters = CONSOLE_MODES.map((m) => m.goKey);
    expect(new Set(letters).size).toBe(letters.length);
    expect(letters).not.toContain('L');
    expect(letters).not.toContain('A');
  });

  it('finds the Overview at /admin, with or without the slash, and only there', () => {
    expect(modeAt('/admin')?.id).toBe('overview');
    expect(modeAt('/admin/')?.id).toBe('overview');
    expect(modeAt('/admin/inbox')).toBeUndefined();
    expect(modeAt('/')).toBeUndefined();
  });
});
