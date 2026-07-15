import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canViewComment, canViewReport, type ViewerRelationship } from './visibility'

const NONE: ViewerRelationship = { blocked: false }
const BLOCKED: ViewerRelationship = { blocked: true }

describe('canViewReport (all reports public, D13 — block-only gate)', () => {
  it('the author always sees their own content, even if blocked', () => {
    expect(canViewReport('a', 'a', NONE)).toBe(true)
    expect(canViewReport('a', 'a', BLOCKED)).toBe(true)
  })

  it('any non-blocked viewer sees a public report', () => {
    expect(canViewReport('v', 'a', NONE)).toBe(true)
  })

  it('a block hides content from a non-author', () => {
    expect(canViewReport('v', 'a', BLOCKED)).toBe(false)
  })
})

describe('canViewComment', () => {
  it('mirrors canViewReport (D21)', () => {
    expect(canViewComment('v', 'a', NONE)).toBe(canViewReport('v', 'a', NONE))
    expect(canViewComment('v', 'a', BLOCKED)).toBe(canViewReport('v', 'a', BLOCKED))
  })
})

describe('access invariants (property)', () => {
  const arbRel: fc.Arbitrary<ViewerRelationship> = fc.record({ blocked: fc.boolean() })

  it('a non-author viewer sees a report iff not blocked', () => {
    fc.assert(
      fc.property(arbRel, (rel) => {
        expect(canViewReport('v', 'a', rel)).toBe(!rel.blocked)
      }),
    )
  })

  it('the author is never hidden from their own content', () => {
    fc.assert(
      fc.property(arbRel, (rel) => {
        expect(canViewReport('a', 'a', rel)).toBe(true)
      }),
    )
  })
})
