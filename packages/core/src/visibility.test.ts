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

const NONE: ViewerRelationship = { blocked: false }
const BLOCKED: ViewerRelationship = { blocked: true }

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

  it('just_me is visible to no one but the author', () => {
    expect(canViewReport('v', 'a', 'just_me', NONE)).toBe(false)
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
      expect(canViewComment('v', 'a', v, NONE)).toBe(canViewReport('v', 'a', v, NONE))
    }
  })
})

describe('deriveDefaultVisibility (D41)', () => {
  it('adult → public; minor → just_me', () => {
    expect(deriveDefaultVisibility({ isMinor: false })).toBe('public')
    expect(deriveDefaultVisibility({ isMinor: true })).toBe('just_me')
  })
})

describe('maxVisibilityForProfile (D41 ceiling)', () => {
  it('a minor is capped at just_me; an adult may reach public', () => {
    expect(maxVisibilityForProfile({ isMinor: false })).toBe('public')
    expect(maxVisibilityForProfile({ isMinor: true })).toBe('just_me')
  })
  it('never returns a level narrower than its default (default is always allowed)', () => {
    for (const isMinor of [true, false]) {
      const max = maxVisibilityForProfile({ isMinor })
      const dflt = deriveDefaultVisibility({ isMinor })
      expect(VISIBILITY_LEVELS.indexOf(max)).toBeGreaterThanOrEqual(VISIBILITY_LEVELS.indexOf(dflt))
    }
  })
})

describe('visibility invariants (property)', () => {
  const arbVisibility = fc.constantFrom(...VISIBILITY_LEVELS)
  const arbRel: fc.Arbitrary<ViewerRelationship> = fc.record({ blocked: fc.boolean() })

  it('a block always hides content from non-authors', () => {
    fc.assert(
      fc.property(arbVisibility, arbRel, (v, rel) => {
        if (!rel.blocked) return
        expect(canViewReport('v', 'a', v, rel)).toBe(false)
      }),
    )
  })

  it('just_me is never viewable by a non-author, regardless of relationship', () => {
    fc.assert(
      fc.property(arbRel, (rel) => {
        expect(canViewReport('v', 'a', 'just_me', rel)).toBe(false)
      }),
    )
  })

  it('public is viewable by any non-blocked non-author', () => {
    fc.assert(
      fc.property(arbRel, (rel) => {
        expect(canViewReport('v', 'a', 'public', rel)).toBe(!rel.blocked)
      }),
    )
  })

  it('the default visibility is always one of the two valid levels', () => {
    fc.assert(
      fc.property(fc.boolean(), (isMinor) => {
        const d: Visibility = deriveDefaultVisibility({ isMinor })
        expect(d === 'public' || d === 'just_me').toBe(true)
      }),
    )
  })
})
