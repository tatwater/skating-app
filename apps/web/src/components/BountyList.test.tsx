import { describe, expect, it } from 'vitest';
import { expiryLabel } from './BountyList';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('expiryLabel', () => {
  it('renders remaining days when more than a day out', () => {
    expect(expiryLabel(1000 + 2 * DAY, 1000)).toBe('expires in 2d');
  });

  it('renders remaining hours when under a day out', () => {
    expect(expiryLabel(1000 + 3 * HOUR, 1000)).toBe('expires in 3h');
  });

  it('collapses an already-passed expiry to "expiring"', () => {
    expect(expiryLabel(1000 - HOUR, 1000)).toBe('expiring');
  });
});
