import { describe, expect, it } from 'vitest'
import { parseMapSelection } from './mapSelection'

describe('parseMapSelection', () => {
  it('parses a water-body path', () => {
    expect(parseMapSelection('/water/abc123')).toEqual({ kind: 'water', waterBodyId: 'abc123' })
  })

  it('parses a report path', () => {
    expect(parseMapSelection('/report/rep_9')).toEqual({ kind: 'report', reportId: 'rep_9' })
  })

  it('tolerates a trailing slash', () => {
    expect(parseMapSelection('/water/abc123/')).toEqual({ kind: 'water', waterBodyId: 'abc123' })
  })

  it('decodes an encoded id segment', () => {
    expect(parseMapSelection('/water/a%2Fb')).toEqual({ kind: 'water', waterBodyId: 'a/b' })
  })

  it('returns none for the map root and unrelated routes', () => {
    expect(parseMapSelection('/')).toEqual({ kind: 'none' })
    expect(parseMapSelection('/feed')).toEqual({ kind: 'none' })
    expect(parseMapSelection('/water')).toEqual({ kind: 'none' })
    expect(parseMapSelection('/water/a/b')).toEqual({ kind: 'none' })
  })
})
