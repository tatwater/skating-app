import { describe, expect, it } from 'vitest';
import { BODY_TABS } from './bodySearch';
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
