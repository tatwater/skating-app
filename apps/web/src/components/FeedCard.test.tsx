import type { FeedCardData } from '@skating/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeedCard } from './FeedCard'

const NOW = Date.UTC(2026, 0, 5, 12, 0)

const DATA: FeedCardData = {
  reportId: 'r1',
  waterBodyId: 'wb1',
  bodyName: 'Lake Champlain',
  place: { town: 'Burlington', county: 'Chittenden County', state: 'VT' },
  skateEndTime: Date.UTC(2026, 0, 5, 11, 0),
  skateStartTime: Date.UTC(2026, 0, 5, 9, 30),
  iceTypes: ['black_ice'],
  surfaceTags: ['glass'],
  skateQuality: 'great',
  photoThumbUrls: ['https://x/a.jpg', 'https://x/b.jpg'],
  author: { displayName: 'Ada Skater', username: 'ada' },
  blocked: false,
}

describe('FeedCard', () => {
  it('renders body name, point-derived location, relative time, duration, quality, and chips', () => {
    render(<FeedCard data={DATA} now={NOW} onOpen={() => {}} />)
    expect(screen.getByText('Lake Champlain')).toBeInTheDocument()
    expect(screen.getByText('Burlington, VT')).toBeInTheDocument()
    expect(screen.getByText('1h ago')).toBeInTheDocument()
    expect(screen.getByText(/skated 1h 30m/)).toBeInTheDocument()
    expect(screen.getByText('Great')).toBeInTheDocument()
    expect(screen.getByText('Black ice')).toBeInTheDocument()
    expect(screen.getByText('Glass')).toBeInTheDocument()
  })

  it('renders a photo thumbnail carousel', () => {
    render(<FeedCard data={DATA} now={NOW} onOpen={() => {}} />)
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('shows the "Blocked" chip for a blocked author but still renders the report (D3)', () => {
    render(<FeedCard data={{ ...DATA, blocked: true }} now={NOW} onOpen={() => {}} />)
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(screen.getByText('Ada Skater')).toBeInTheDocument()
    expect(screen.getByText('Lake Champlain')).toBeInTheDocument()
  })

  it('omits the location line when the point resolved nowhere', () => {
    render(<FeedCard data={{ ...DATA, place: undefined }} now={NOW} onOpen={() => {}} />)
    expect(screen.queryByText('Burlington, VT')).not.toBeInTheDocument()
  })

  it('fires onOpen when the card is clicked (tap → drawer)', () => {
    const onOpen = vi.fn()
    render(<FeedCard data={DATA} now={NOW} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
