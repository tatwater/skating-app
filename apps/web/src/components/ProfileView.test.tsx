import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfileView, type ProfileViewData } from './ProfileView';

const PUBLIC: ProfileViewData = {
  username: 'ada',
  displayName: 'Ada Lovelace',
  isSelf: false,
  isPrivate: false,
  homeTownLabel: 'Norwich, VT',
  bio: 'Loves black ice',
  trustClass: 'trusted',
  badges: ['trusted_reporter'],
  reportCount: 3,
  commentCount: 5,
};

describe('ProfileView', () => {
  it('renders the full public payload: bio, town, stats, trust chip, and badges', () => {
    render(<ProfileView data={PUBLIC} reportHistory={<div>history</div>} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Norwich, VT')).toBeInTheDocument();
    expect(screen.getByText('Loves black ice')).toBeInTheDocument();
    // The cosmetic class chip (D50) replaces the raw trust number.
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.getByText('Trusted Reporter')).toBeInTheDocument();
    expect(screen.getByText('Reports')).toBeInTheDocument();
    expect(screen.getByText('history')).toBeInTheDocument();
  });

  it('never shows the raw trust number to an ordinary viewer (D50)', () => {
    render(<ProfileView data={PUBLIC} />);
    expect(screen.queryByText(/trust score:/)).not.toBeInTheDocument();
  });

  it('shows the raw trust number only when the admin score is passed', () => {
    render(<ProfileView data={{ ...PUBLIC, adminReputationPoints: 42 }} />);
    expect(screen.getByText(/trust score: 42/)).toBeInTheDocument();
  });

  it('renders no chip when the trust class is null (never "Not trusted")', () => {
    render(<ProfileView data={{ ...PUBLIC, trustClass: null }} />);
    expect(screen.queryByText('Trusted')).not.toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('a private profile shows name only — no bio, stats, town, or history', () => {
    render(
      <ProfileView data={{ ...PUBLIC, isPrivate: true }} reportHistory={<div>history</div>} />,
    );
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('This profile is private.')).toBeInTheDocument();
    expect(screen.queryByText('Loves black ice')).not.toBeInTheDocument();
    expect(screen.queryByText('Norwich, VT')).not.toBeInTheDocument();
    expect(screen.queryByText('history')).not.toBeInTheDocument();
  });

  it('renders the actions slot', () => {
    render(<ProfileView data={PUBLIC} actions={<button type="button">Block</button>} />);
    expect(screen.getByRole('button', { name: 'Block' })).toBeInTheDocument();
  });
});
