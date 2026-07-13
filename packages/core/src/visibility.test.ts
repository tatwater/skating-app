import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { VISIBILITY_LEVELS, type Visibility } from './types'
import {
  canViewComment,
  canViewReport,
  deriveDefaultVisibility,
  maxVisibilityForProfile,
  type ViewerRelationship,
} from './visibility'

const NONE: ViewerRelationship = {
  viewerFollowsAuthor: false,
  authorFollowsViewer: false,
  blocked: false,
}
const FOLLOWER: ViewerRelationship = { ...NONE, viewerFollowsAuthor: true }
const MUTUAL: ViewerRelationship = {
  viewerFollowsAuthor: true,
  authorFollowsViewer: true,
  blocked: false,
}
const BLOCKED: ViewerRelationship = { ...MUTUAL, blocked: true }

describe('canViewReport', () => {
  it('the author always sees their own content, even just_me and even if blocked', () => {
    for (const v of VISIBILITY_LEVELS) {
      expect(canViewReport('a', 'a', v, NONE)).toBe(true)
      expect(canViewReport('a', 'a', v, BLOCKED)).toBe(true)
    }
  })

  it('public is visible to any non-blocked viewer', () => {
    expect(canViewReport('v', 'a', 'public', NONE)).toBe(true)
  })

  it('followers requires the viewer to follow the author', () => {
    expect(canViewReport('v', 'a', 'followers', NONE)).toBe(false)
    expect(canViewReport('v', 'a', 'followers', FOLLOWER)).toBe(true)
  })

  it('friends requires a mutual follow', () => {
    expect(canViewReport('v', 'a', 'friends', FOLLOWER)).toBe(false)
    expect(canViewReport('v', 'a', 'friends', MUTUAL)).toBe(true)
  })

  it('just_me is visible to no one but the author', () => {
    expect(canViewReport('v', 'a', 'just_me', MUTUAL)).toBe(false)
  })

  it('a block hides everything (for non-authors), at every level', () => {
    for (const v of VISIBILITY_LEVELS) {
      expect(canViewReport('v', 'a', v, BLOCKED)).toBe(false)
    }
  })
})

describe('canViewComment', () => {
  it('inherits the parent report exactly (D21)', () => {
    for (const v of VISIBILITY_LEVELS) {
      expect(canViewComment('v', 'a', v, MUTUAL)).toBe(canViewReport('v', 'a', v, MUTUAL))
    }
  })
})

describe('deriveDefaultVisibility (D41)', () => {
  it('public profile → public; locked/private profile → followers', () => {
    expect(deriveDefaultVisibility({ profilePublic: true })).toBe('public')
    expect(deriveDefaultVisibility({ profilePublic: false })).toBe('followers')
  })
  it('depends only on the stored privacy setting, so it never changes on a birthday', () => {
    // There is no age input to pass: minor protection is the persisted `requireFollowApproval`
    // (locked) setting seeded at signup, not a live check here. Turning 18 leaves the
    // profile locked → the default stays `followers` until the user unlocks.
    for (const profilePublic of [true, false]) {
      expect(deriveDefaultVisibility({ profilePublic })).toBe(
        profilePublic ? 'public' : 'followers',
      )
    }
  })
})

describe('maxVisibilityForProfile (D41 ceiling)', () => {
  it('a locked/private profile is capped below public; a public profile is not', () => {
    expect(maxVisibilityForProfile({ profilePublic: true })).toBe('public')
    expect(maxVisibilityForProfile({ profilePublic: false })).toBe('followers')
  })
  it('never returns a level narrower than its default (default is always allowed)', () => {
    for (const profilePublic of [true, false]) {
      const max = maxVisibilityForProfile({ profilePublic })
      const dflt = deriveDefaultVisibility({ profilePublic })
      expect(VISIBILITY_LEVELS.indexOf(max)).toBeGreaterThanOrEqual(VISIBILITY_LEVELS.indexOf(dflt))
    }
  })
})

describe('visibility invariants (property)', () => {
  const arbVisibility = fc.constantFrom(...VISIBILITY_LEVELS)
  const arbRel: fc.Arbitrary<ViewerRelationship> = fc.record({
    viewerFollowsAuthor: fc.boolean(),
    authorFollowsViewer: fc.boolean(),
    blocked: fc.boolean(),
  })

  it('a block always hides content from non-authors', () => {
    fc.assert(
      fc.property(arbVisibility, arbRel, (v, rel) => {
        if (!rel.blocked) return
        expect(canViewReport('v', 'a', v, rel)).toBe(false)
      }),
    )
  })

  it('friends visibility never exposes more than followers visibility', () => {
    fc.assert(
      fc.property(arbRel, (rel) => {
        // For the same viewer/author/relationship, if a friends-report is viewable
        // then a followers-report must be too (friends ⊆ followers).
        if (canViewReport('v', 'a', 'friends', rel)) {
          expect(canViewReport('v', 'a', 'followers', rel)).toBe(true)
        }
      }),
    )
  })

  it('the default visibility is never wider than public and never just_me', () => {
    fc.assert(
      fc.property(fc.boolean(), (profilePublic) => {
        const d: Visibility = deriveDefaultVisibility({ profilePublic })
        expect(d === 'public' || d === 'followers').toBe(true)
      }),
    )
  })
})
