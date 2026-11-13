import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  type Capability,
  can,
  canUse,
  GRANTS,
  grantFor,
  type HeldGrants,
  ROLE_RANK,
  roleMeets,
} from './capabilities';

const ALL = Object.keys(CAPABILITIES) as Capability[];
const EVERY_GRANT: HeldGrants = Object.fromEntries(GRANTS.map((g) => [g, true]));

describe('the capability map (D217)', () => {
  it('ranks the three roles in order', () => {
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.moderator);
    expect(ROLE_RANK.moderator).toBeLessThan(ROLE_RANK.admin);
  });

  it('never grants a capability to a member', () => {
    for (const cap of ALL) expect(can('member', cap)).toBe(false);
  });

  it('gives an admin every capability that needs no grant, and the rest with the grant', () => {
    for (const cap of ALL) {
      expect(can('admin', cap)).toBe(grantFor(cap) === undefined);
      expect(can('admin', cap, EVERY_GRANT)).toBe(true);
    }
  });

  it('gives a moderator exactly the moderator rows, grants or not', () => {
    for (const cap of ALL) {
      expect(can('moderator', cap)).toBe(CAPABILITIES[cap].role === 'moderator');
      expect(can('moderator', cap, EVERY_GRANT)).toBe(CAPABILITIES[cap].role === 'moderator');
    }
  });

  it('a grant row needs the role and the grant, set to true (D227)', () => {
    expect(grantFor('machinery.ledger')).toBe('canEditLedger');
    expect(grantFor('people.role')).toBeUndefined();
    expect(can('admin', 'machinery.ledger', { canEditLedger: true })).toBe(true);
    expect(can('admin', 'machinery.ledger', { canEditLedger: false })).toBe(false);
    expect(can('admin', 'machinery.ledger', {})).toBe(false);
    // The grant on a non-admin is inert: the role is still necessary.
    expect(can('moderator', 'machinery.ledger', { canEditLedger: true })).toBe(false);
    expect(can('member', 'machinery.ledger', { canEditLedger: true })).toBe(false);
    // A grant row is a write: an editor on their way out loses it like any other write.
    expect(canUse('admin', false, 'machinery.ledger', { canEditLedger: true })).toBe(true);
    expect(canUse('admin', true, 'machinery.ledger', { canEditLedger: true })).toBe(false);
  });

  it('every grant a row names is a known grant, and every grant is used', () => {
    const named = new Set(ALL.map(grantFor).filter((g) => g !== undefined));
    expect([...named].sort()).toEqual([...GRANTS].sort());
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
      'machinery.ledger',
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
