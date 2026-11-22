import { describe, expect, test } from 'vitest';

import { NOW, ROB, SARAH_PAGE } from '../../people/person/personFixtures';
import { registrations } from '../handlers/Flag/register';
import { menuLevers } from './AuthorMenu';
import { buildRegistry } from './handlerRegistry';

describe('the author menu’s levers are People’s', () => {
  test('the discipline rows only, each with the buttons `can` allows', () => {
    const levers = menuLevers(ROB, NOW);
    const keys = levers.map((l) => l.row.key);
    for (const k of keys)
      expect(['reports', 'hazards', 'comments', 'flagging', 'suspension', 'ban']).toContain(k);
    expect(keys).not.toContain('role');
    expect(keys).not.toContain('ledger');
    expect(keys).not.toContain('bounties');
    for (const l of levers) {
      expect(l.buttons.length).toBeGreaterThan(0);
      for (const b of l.buttons) expect(['now', 'reason', 'suspend']).toContain(b.opens.kind);
    }
  });
  test('a refused lever is never in the menu', () => {
    // Every answer in `can`, however deep, refused.
    const refuse = (v: unknown): unknown =>
      v !== null && typeof v === 'object'
        ? 'ok' in v
          ? { ok: false, why: 'No' }
          : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refuse(x)]))
        : v;
    const none = { ...ROB, can: refuse(ROB.can) } as typeof ROB;
    expect(menuLevers(ROB, NOW).length).toBeGreaterThan(0);
    expect(menuLevers(none, NOW)).toEqual([]);
  });
  test('a staff page draws the same rule', () => {
    expect(() => menuLevers(SARAH_PAGE, NOW)).not.toThrow();
  });
});

describe('registration', () => {
  test('every flag subject, a photo included (2.7), and nothing else', () => {
    const keys = registrations.flatMap((r) => r.keys);
    expect([...keys].sort()).toEqual(
      [
        'flag:accessAlert',
        'flag:comment',
        'flag:hazard',
        'flag:photo',
        'flag:post',
        'flag:report',
        'flag:user',
        'flag:waterbody',
      ].sort(),
    );
    expect(() => buildRegistry({ 'handlers/Flag/register.tsx': { registrations } })).not.toThrow();
  });
});
