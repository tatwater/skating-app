import { describe, expect, it } from 'vitest';
import {
  AROUND_IT_DAYS,
  AROUND_IT_DEFAULT_DAYS,
  INBOX_FACETS,
  INBOX_LANE_ORDER,
  INBOX_LANES,
  INBOX_LIST_LANES,
  isInboxFacet,
  NOTIFICATION_TYPES_EVERY_BUILD_KNOWS,
} from './inbox';
import { NOTIFICATION_TYPES } from './notifications';

describe('the Inbox lanes', () => {
  it('reads "All open" in the lanes’ own order, safety first and support last', () => {
    expect(INBOX_LANES.map((lane) => INBOX_LANE_ORDER[lane])).toEqual(INBOX_LANES.map((_, i) => i));
    expect(INBOX_LANE_ORDER.safety).toBe(0);
    expect(INBOX_LANE_ORDER.support).toBe(Math.max(...Object.values(INBOX_LANE_ORDER)));
  });

  it('gives every lane its tabs, `all` first and none twice', () => {
    for (const lane of INBOX_LANES) {
      const tabs = INBOX_FACETS[lane];
      expect(tabs[0]).toBe('all');
      expect(new Set(tabs).size).toBe(tabs.length);
    }
    expect(Object.keys(INBOX_FACETS).sort()).toEqual([...INBOX_LANES].sort());
  });

  it('knows a lane’s own tabs and no other lane’s', () => {
    expect(isInboxFacet('placesAsked', 'bays')).toBe(true);
    expect(isInboxFacet('safety', 'bays')).toBe(false);
  });
});

describe('what a list may ask for', () => {
  it('is every lane, then All open and Decided, none twice', () => {
    expect(INBOX_LIST_LANES).toEqual([...INBOX_LANES, 'all', 'decided']);
    expect(new Set(INBOX_LIST_LANES).size).toBe(INBOX_LIST_LANES.length);
  });

  it('reaches around a report by one of the drawer’s spans, three days by default', () => {
    expect(AROUND_IT_DAYS).toContain(AROUND_IT_DEFAULT_DAYS);
  });
});

describe('the notification types every installed build words', () => {
  it('are all real types, frozen at the list before the Inbox wave', () => {
    for (const type of NOTIFICATION_TYPES_EVERY_BUILD_KNOWS) {
      expect(NOTIFICATION_TYPES as readonly string[]).toContain(type);
    }
    expect(NOTIFICATION_TYPES_EVERY_BUILD_KNOWS).toHaveLength(10);
  });
});
