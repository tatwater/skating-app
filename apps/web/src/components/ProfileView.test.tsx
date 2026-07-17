import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProfileView, type ProfileViewData } from './ProfileView'

const PUBLIC: ProfileViewData = {
  username: 'ada',
  displayName: 'Ada Lovelace',
  isSelf: false,
  isPrivate: false,
  homeTownLabel: 'Norwich, VT',
  bio: 'Loves black ice',
  reputationPoints: 0,
  reportCount: 3,
  commentCount: 5,
}

describe('ProfileView', () => {
  it('renders the full public payload: bio, town, stats, and the trust widget', () => {
    render(<ProfileView data={PUBLIC} reportHistory={<div>history</div>} />)
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Norwich, VT')).toBeInTheDocument()
    expect(screen.getByText('Loves black ice')).toBeInTheDocument()
    expect(screen.getByText('Trust score')).toBeInTheDocument()
    expect(screen.getByText('Reports')).toBeInTheDocument()
    expect(screen.getByText('history')).toBeInTheDocument()
  })

  it('shows the trust score value (0 until Phase 6)', () => {
    render(<ProfileView data={PUBLIC} />)
    // Trust score + comment count both render as text; assert the trust label sits by a 0.
    expect(screen.getByText('Trust score').previousSibling).toHaveTextContent('0')
  })

  it('a private profile shows name only — no bio, stats, town, or history', () => {
    render(<ProfileView data={{ ...PUBLIC, isPrivate: true }} reportHistory={<div>history</div>} />)
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('This profile is private.')).toBeInTheDocument()
    expect(screen.queryByText('Loves black ice')).not.toBeInTheDocument()
    expect(screen.queryByText('Norwich, VT')).not.toBeInTheDocument()
    expect(screen.queryByText('Trust score')).not.toBeInTheDocument()
    expect(screen.queryByText('history')).not.toBeInTheDocument()
  })

  it('renders the actions slot', () => {
    render(<ProfileView data={PUBLIC} actions={<button type="button">Block</button>} />)
    expect(screen.getByRole('button', { name: 'Block' })).toBeInTheDocument()
  })
})
