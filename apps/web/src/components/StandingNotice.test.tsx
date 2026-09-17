import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StandingNotice } from './StandingNotice';

const T = Date.parse('2026-09-16T12:00:00Z');

describe('StandingNotice (A07b)', () => {
  it('renders nothing on an active body', () => {
    const { container } = render(<StandingNotice body={{ dedupStatus: 'clean' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('badges a dormant body Inactive and says why, in the shared sentence', () => {
    render(
      <StandingNotice body={{ dedupStatus: 'clean', dormant: { since: T, reason: 'inactive' } }} />,
    );
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No one has reported skating here in the last 3 seasons, so it isn’t on the active map.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a moderator’s note verbatim', () => {
    render(
      <StandingNotice
        body={{
          dedupStatus: 'clean',
          dormant: { since: T, reason: 'moderator', note: 'Drained for dam work' },
        }}
      />,
    );
    expect(
      screen.getByText('A moderator set this lake inactive: Drained for dam work'),
    ).toBeInTheDocument();
  });

  it('badges a removed body Removed and names the reason — including a landowner request', () => {
    render(
      <StandingNotice
        body={{ dedupStatus: 'clean', removedAt: T, removalReason: 'landowner_request' }}
      />,
    );
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(
      screen.getByText('Removed from the map at the landowner’s request.'),
    ).toBeInTheDocument();
  });

  it('a `none` ruling reads as dormancy here; the dated review line is the access section’s', () => {
    render(
      <StandingNotice
        body={{ dedupStatus: 'clean', publicAccess: { verdict: 'none', decidedAt: T } }}
      />,
    );
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(
      screen.getByText('A moderator found no public access, so it isn’t on the active map.'),
    ).toBeInTheDocument();
  });
});
