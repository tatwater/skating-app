import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type Capability, can, canUse, ROLE_RANK, roleMeets } from './capabilities';

const ALL = Object.keys(CAPABILITIES) as Capability[];

describe('the capability map (D217)', () => {
  it('ranks the three roles in order', () => {
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.moderator);
    expect(ROLE_RANK.moderator).toBeLessThan(ROLE_RANK.admin);
  });

  it('never grants a capability to a member', () => {
    for (const cap of ALL) expect(can('member', cap)).toBe(false);
  });

  it('gives an admin every capability', () => {
    for (const cap of ALL) expect(can('admin', cap)).toBe(true);
  });

  it('gives a moderator exactly the moderator rows', () => {
    for (const cap of ALL)
      expect(can('moderator', cap)).toBe(CAPABILITIES[cap].role === 'moderator');
  });

  it('refuses an unknown role (signed out)', () => {
    expect(can(undefined, 'audit.read')).toBe(false);
  });

  it('names every capability <area>.<thing> and explains it', () => {
    for (const cap of ALL) {
      expect(cap).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      expect(CAPABILITIES[cap].why.length).toBeGreaterThan(20);
    }
  });

  it('keeps the D37 admin-only line: role-granting, PII, the constants, imports and seasons', () => {
    for (const cap of [
      'people.role',
      'people.trustScore',
      'inbox.support',
      'inbox.support.read',
      'instruments.tuning',
      'machinery.read',
      'season.read',
      'season.settings',
      'body.remove',
    ] as const) {
      expect(CAPABILITIES[cap].role).toBe('admin');
    }
  });

  it('roleMeets is reflexive and ordered', () => {
    expect(roleMeets('moderator', 'moderator')).toBe(true);
    expect(roleMeets('moderator', 'admin')).toBe(false);
    expect(roleMeets('admin', 'moderator')).toBe(true);
  });

  it('a leaving operator keeps reads and loses writes, as on the server', () => {
    expect(canUse('moderator', true, 'inbox.read')).toBe(true);
    expect(canUse('moderator', true, 'inbox.flag')).toBe(false);
    expect(canUse('moderator', false, 'inbox.flag')).toBe(true);
    expect(canUse('moderator', false, 'people.role')).toBe(false);
    expect(canUse(undefined, false, 'inbox.read')).toBe(false);
  });
});
