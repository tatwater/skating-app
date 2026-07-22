import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canViewComment,
  canViewReport,
  isAuthorBlocked,
  isModerationVisible,
  type ModerationStatus,
  type ViewerRelationship,
} from './visibility';

const NO_BLOCKS: ReadonlySet<string> = new Set();
const BLOCKS_A: ReadonlySet<string> = new Set(['a']);

describe('isModerationVisible', () => {
  it('is true only for the `visible` status', () => {
    expect(isModerationVisible('visible')).toBe(true);
    expect(isModerationVisible('hidden')).toBe(false);
    expect(isModerationVisible('removed')).toBe(false);
  });
});

describe('isAuthorBlocked', () => {
  it('reports a blocked author from a non-author viewer', () => {
    expect(isAuthorBlocked('v', 'a', BLOCKS_A)).toBe(true);
    expect(isAuthorBlocked('v', 'b', BLOCKS_A)).toBe(false);
  });

  it('never blocks a viewer from their own content', () => {
    expect(isAuthorBlocked('a', 'a', BLOCKS_A)).toBe(false);
  });
});

describe('canViewReport (moderation-only — blocks NEVER hide a report, D3)', () => {
  const rel: ViewerRelationship = { viewerId: 'v', authorId: 'a', blockedAuthorIds: BLOCKS_A };

  it('is visible iff moderation-visible, regardless of relationship', () => {
    expect(canViewReport('visible')).toBe(true);
    expect(canViewReport('hidden')).toBe(false);
    expect(canViewReport('removed')).toBe(false);
    // A block on the author does not change the report gate.
    expect(canViewReport('visible', rel)).toBe(true);
  });
});

describe('canViewComment (moderation AND not-blocked, D21/D32)', () => {
  it('hides a blocked author’s comment', () => {
    expect(canViewComment('v', 'a', 'visible', NO_BLOCKS)).toBe(true);
    expect(canViewComment('v', 'a', 'visible', BLOCKS_A)).toBe(false);
  });

  it('hides a moderated comment even from an unblocked author', () => {
    expect(canViewComment('v', 'b', 'hidden', NO_BLOCKS)).toBe(false);
    expect(canViewComment('v', 'b', 'removed', NO_BLOCKS)).toBe(false);
  });

  it('lets the author see their own visible comment even inside their own block set', () => {
    expect(canViewComment('a', 'a', 'visible', BLOCKS_A)).toBe(true);
  });
});

describe('invariants (property)', () => {
  const arbStatus: fc.Arbitrary<ModerationStatus> = fc.constantFrom('visible', 'hidden', 'removed');
  const arbId = fc.string({ minLength: 1, maxLength: 6 });
  const arbBlockedSet = fc.array(arbId).map((ids) => new Set(ids) as ReadonlySet<string>);

  it('a block NEVER changes whether a report is viewable (D3)', () => {
    fc.assert(
      fc.property(arbStatus, arbId, arbId, arbBlockedSet, (status, viewerId, authorId, blocked) => {
        const rel: ViewerRelationship = { viewerId, authorId, blockedAuthorIds: blocked };
        // For any relationship, the report gate equals moderation visibility alone.
        expect(canViewReport(status, rel)).toBe(isModerationVisible(status));
      }),
    );
  });

  it('a comment is viewable iff moderation-visible and the author is not blocked', () => {
    fc.assert(
      fc.property(arbStatus, arbId, arbId, arbBlockedSet, (status, viewerId, authorId, blocked) => {
        expect(canViewComment(viewerId, authorId, status, blocked)).toBe(
          isModerationVisible(status) && !isAuthorBlocked(viewerId, authorId, blocked),
        );
      }),
    );
  });
});
