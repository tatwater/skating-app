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

  /**
   * The ghost card (D62 amendment). What's asserted is *absence* — and the sharpest check is the
   * stats, because a "3 Reports" counter next to "Deleted skater" would read as data that survived a
   * scrub that has, in fact, already happened. The fixture deliberately keeps every field populated:
   * a real ghost's row is empty, so passing a *full* one proves the card ignores its data rather than
   * happening to render blanks.
   */
  describe('once the owner has asked to be deleted', () => {
    const GHOST: ProfileViewData = { ...PUBLIC, isSelf: true, isLeaving: true };

    it('renders the tombstone in place of the profile card', () => {
      render(<ProfileView data={GHOST} reportHistory={<div>history</div>} />);
      expect(screen.getByText('Deleted skater')).toBeInTheDocument();
      expect(screen.getByText(/your profile has been cleared/i)).toBeInTheDocument();
    });

    it('shows none of what finalization scrubs', () => {
      render(<ProfileView data={GHOST} />);
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
      expect(screen.queryByText('@ada')).not.toBeInTheDocument();
      expect(screen.queryByText('Norwich, VT')).not.toBeInTheDocument();
      expect(screen.queryByText('Loves black ice')).not.toBeInTheDocument();
      expect(screen.queryByText('Trusted')).not.toBeInTheDocument();
      expect(screen.queryByText('Trusted Reporter')).not.toBeInTheDocument();
      expect(screen.queryByText('Reports')).not.toBeInTheDocument();
    });

    it('keeps the actions slot — the way back is the one thing still worth offering', () => {
      render(<ProfileView data={GHOST} actions={<button type="button">Cancel deletion</button>} />);
      expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeInTheDocument();
    });

    // Owner-only by construction: the flag is set by the container solely when `isSelf`, and a
    // reversible decision is not news the rest of the app gets told.
    it('is not what a visitor sees', () => {
      render(<ProfileView data={{ ...PUBLIC, isLeaving: false }} />);
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByText('Deleted skater')).not.toBeInTheDocument();
    });
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
