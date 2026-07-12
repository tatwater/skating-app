import { describe, expect, it } from 'vitest'
import { isCurrentRiskAckVersion, RISK_ACK_VERSION } from './riskAck'

describe('isCurrentRiskAckVersion', () => {
  it('accepts the current version', () => {
    expect(isCurrentRiskAckVersion(RISK_ACK_VERSION)).toBe(true)
  })

  it('rejects an older/unknown version', () => {
    expect(isCurrentRiskAckVersion('1970-01-01')).toBe(false)
    expect(isCurrentRiskAckVersion('')).toBe(false)
  })

  it('rejects a missing acknowledgment', () => {
    expect(isCurrentRiskAckVersion(undefined)).toBe(false)
    expect(isCurrentRiskAckVersion(null)).toBe(false)
  })
})
