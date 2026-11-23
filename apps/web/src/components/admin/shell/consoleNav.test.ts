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

  it('draws the old sidebar’s admin-only line: tuning, imports and seasons are admin', () => {
    const adminOnly = LEGACY_PAGES.filter((p) => CAPABILITIES[p.capability].role === 'admin').map(
      (p) => p.to,
    );
    expect(adminOnly.sort()).toEqual(['/admin/imports', '/admin/seasons', '/admin/tuning'].sort());
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
    expect(modeAt('/admin/inbox')?.id).toBe('inbox');
    expect(modeAt('/')).toBeUndefined();
  });

  it('finds the Inbox at its page, second on the rail, gated on reading the inbox, on G then I', () => {
    expect(modeAt('/admin/inbox')?.id).toBe('inbox');
    expect(modeAt('/admin/inbox/')?.id).toBe('inbox');
    expect(modeAt('/admin/inboxes')).toBeUndefined();
    expect(CONSOLE_MODES.map((m) => m.id).slice(0, 3)).toEqual(['overview', 'inbox', 'corpus']);
    const inbox = CONSOLE_MODES.find((m) => m.id === 'inbox');
    expect(inbox).toMatchObject({ to: '/admin/inbox', goKey: 'I', capability: 'inbox.read' });
    expect(CAPABILITIES['inbox.read'].role).toBe('moderator');
    // The old Flags page retired with B01-5e: its path redirects into the Inbox, never the old shell.
    expect(usesOldShell('/admin/inbox')).toBe(false);
    expect(usesOldShell('/admin/flags')).toBe(false);
  });

  it('finds Corpus at the library and inside every body’s console, and nowhere that only shares a prefix', () => {
    expect(modeAt('/admin/corpus')?.id).toBe('corpus');
    expect(modeAt('/admin/corpus/')?.id).toBe('corpus');
    expect(modeAt('/admin/body/abc123')?.id).toBe('corpus');
    expect(modeAt('/admin/body')?.id).toBe('corpus');
    expect(modeAt('/admin/bodyguard')).toBeUndefined();
    expect(modeAt('/admin/corpusx')).toBeUndefined();
    // The section's old name is gone, not redirected: no mode claims it.
    expect(modeAt('/admin/bodies')).toBeUndefined();
  });

  it('gates Corpus on reading a body, a moderator line', () => {
    const corpus = CONSOLE_MODES.find((m) => m.id === 'corpus');
    expect(corpus).toMatchObject({
      name: 'Corpus',
      to: '/admin/corpus',
      goKey: 'C',
      capability: 'body.read',
    });
    expect(CAPABILITIES['body.read'].role).toBe('moderator');
  });

  it('finds People at the list and on every person’s page, and nowhere that only shares a prefix', () => {
    expect(modeAt('/admin/people')?.id).toBe('people');
    expect(modeAt('/admin/people/')?.id).toBe('people');
    expect(modeAt('/admin/people/k17abc')?.id).toBe('people');
    expect(modeAt('/admin/peoplex')).toBeUndefined();
    expect(modeAt('/admin/users')).toBeUndefined();
  });

  it('gates People on reading people, a moderator line, and goes there on G then P', () => {
    const people = CONSOLE_MODES.find((m) => m.id === 'people');
    expect(people).toMatchObject({ to: '/admin/people', goKey: 'P', capability: 'people.read' });
    expect(CAPABILITIES['people.read'].role).toBe('moderator');
  });

  it('retired the old user pages: no old shell, no Legacy line', () => {
    expect(usesOldShell('/admin/users')).toBe(false);
    expect(usesOldShell('/admin/users/k17abc')).toBe(false);
    expect(LEGACY_PAGES.some((p) => p.to.startsWith('/admin/users'))).toBe(false);
  });

  it('never sends a tree a mode owns to the old shell', () => {
    for (const mode of CONSOLE_MODES) {
      for (const tree of mode.also ?? []) expect(usesOldShell(`${tree}/x`)).toBe(false);
    }
  });
});
