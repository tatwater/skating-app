import { describe, expect, it } from 'vitest'
import { authZoneTarget } from './authZone'

describe('authZoneTarget', () => {
  it('never redirects while loading', () => {
    expect(authZoneTarget('loading', '/')).toBeNull()
    expect(authZoneTarget('loading', '/sign-in')).toBeNull()
  })

  it('sends signed-out users to sign-in from protected paths, but leaves auth/about alone', () => {
    expect(authZoneTarget('auth', '/')).toBe('/sign-in')
    expect(authZoneTarget('auth', '/feed')).toBe('/sign-in')
    expect(authZoneTarget('auth', '/sign-in')).toBeNull()
    expect(authZoneTarget('auth', '/sign-up')).toBeNull()
    expect(authZoneTarget('auth', '/about')).toBeNull()
  })

  it('pins unprovisioned users to onboarding', () => {
    expect(authZoneTarget('onboarding', '/')).toBe('/onboarding')
    expect(authZoneTarget('onboarding', '/sign-in')).toBe('/onboarding')
    expect(authZoneTarget('onboarding', '/onboarding')).toBeNull()
  })

  it('pins stale-acknowledgment users to re-ack', () => {
    expect(authZoneTarget('reack', '/')).toBe('/reack')
    expect(authZoneTarget('reack', '/reack')).toBeNull()
  })

  it('bounces provisioned users off the auth/onboarding/reack pages, else allows', () => {
    expect(authZoneTarget('app', '/sign-in')).toBe('/')
    expect(authZoneTarget('app', '/onboarding')).toBe('/')
    expect(authZoneTarget('app', '/reack')).toBe('/')
    expect(authZoneTarget('app', '/')).toBeNull()
    expect(authZoneTarget('app', '/feed')).toBeNull()
    expect(authZoneTarget('app', '/u/ada')).toBeNull()
  })
})
