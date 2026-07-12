import { describe, expect, it } from 'vitest'
import {
  DISPLAY_NAME_MAX_LENGTH,
  isValidDisplayName,
  isValidUsername,
  normalizeDisplayName,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from './profile'

describe('normalizeUsername', () => {
  it('trims and lowercases so handles are case-insensitive', () => {
    expect(normalizeUsername('  Ada  ')).toBe('ada')
    expect(normalizeUsername('ADA_99')).toBe('ada_99')
  })
})

describe('isValidUsername', () => {
  it('accepts a well-formed normalized handle', () => {
    expect(isValidUsername('ada')).toBe(true)
    expect(isValidUsername('ada_lovelace99')).toBe(true)
    expect(isValidUsername('a'.repeat(USERNAME_MIN_LENGTH))).toBe(true)
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true)
  })

  it('rejects out-of-bounds lengths', () => {
    expect(isValidUsername('ab')).toBe(false)
    expect(isValidUsername('')).toBe(false)
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false)
  })

  it('rejects disallowed characters and edge underscores', () => {
    expect(isValidUsername('ada lovelace')).toBe(false) // space
    expect(isValidUsername('adá')).toBe(false) // non-ascii
    expect(isValidUsername('Ada')).toBe(false) // uppercase (not normalized)
    expect(isValidUsername('_ada')).toBe(false) // leading underscore
    expect(isValidUsername('ada_')).toBe(false) // trailing underscore
    expect(isValidUsername('___')).toBe(false) // all underscores
  })
})

describe('normalizeDisplayName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeDisplayName('  Ada   Lovelace ')).toBe('Ada Lovelace')
    expect(normalizeDisplayName('Ada')).toBe('Ada')
  })
})

describe('isValidDisplayName', () => {
  it('accepts any non-empty name within bounds', () => {
    expect(isValidDisplayName('A')).toBe(true)
    expect(isValidDisplayName('Ada Lovelace')).toBe(true)
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH))).toBe(true)
  })

  it('rejects an empty name or one past the length bound', () => {
    expect(isValidDisplayName('')).toBe(false)
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false)
  })
})
