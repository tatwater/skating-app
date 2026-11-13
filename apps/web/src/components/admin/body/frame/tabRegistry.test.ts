import { describe, expect, it } from 'vitest';
import { BODY_TABS } from './bodySearch';
import { nextFolded } from './kit-candidates/record-lockup';
import { BODY_TAB_LABELS, isBuilt, registerBodyTabs } from './tabRegistry';

describe('the tab registry', () => {
  it('holds nine slots in the grid’s order, each a word', () => {
    const registry = registerBodyTabs({});
    expect(Object.keys(registry)).toEqual([...BODY_TABS]);
    expect(Object.values(registry).map((s) => s.label)).toEqual([
      'Shape',
      'Names',
      'Places',
      'Access',
      'Water',
      'Imagery',
      'Hazards',
      'Standing',
      'Links',
    ]);
    expect(Object.values(registry).some(isBuilt)).toBe(false);
  });

  it('fills a slot with a registered tab and leaves the rest not built', () => {
    const Wiring = () => null;
    const registry = registerBodyTabs({ names: { Wiring } });
    expect(isBuilt(registry.names)).toBe(true);
    expect(registry.names).toMatchObject({ key: 'names', label: BODY_TAB_LABELS.names, Wiring });
    expect(isBuilt(registry.shape)).toBe(false);
  });
});

describe('the lockup’s fold', () => {
  it('folds past a few pixels and unfolds only back at the top', () => {
    expect(nextFolded(false, 10)).toBe(false);
    expect(nextFolded(false, 25)).toBe(true);
    expect(nextFolded(true, 10)).toBe(true);
    expect(nextFolded(true, 2)).toBe(false);
    expect(nextFolded(true, 0)).toBe(false);
  });
});
