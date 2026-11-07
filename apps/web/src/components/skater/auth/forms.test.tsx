import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DOC_URLS } from '../../../lib/links';
import { RISK_ACK_COPY } from '../../../lib/riskAck';
import { RegionBackdrop, RegionCredit } from '../RegionBackdrop';
import { OnboardingForm } from './OnboardingForm';
import type { OnboardingRefusal } from './onboarding';
import { ReackForm } from './ReackForm';
import { RiskAck } from './RiskAck';
import { FormLine, SystemCard, SystemStage } from './SystemStage';

const READY = { displayName: 'Kate Donovan', username: 'kdonovan', dob: '1988-11-02', ack: true };

function renderOnboarding(
  onSubmit = vi.fn(async (): Promise<OnboardingRefusal | null> => null),
  initial?: Parameters<typeof OnboardingForm>[0]['initial'],
) {
  const onSignOut = vi.fn();
  render(
    <OnboardingForm
      email="kate.donovan@gmail.com"
      initial={initial}
      onSubmit={onSubmit}
      onSignOut={onSignOut}
    />,
  );
  return { onSubmit, onSignOut };
}

const field = (name: string) => screen.getByRole('textbox', { name });
const start = () => screen.getByRole('button', { name: 'Start skating' });

describe('RiskAck', () => {
  it('names the checkbox with the legal copy, verbatim, and links both documents in a new tab', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<RiskAck checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    const privacy = screen.getByRole('link', { name: /Privacy notice/ });
    expect(privacy).toHaveAttribute('href', DOC_URLS.privacy);
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: /Terms \(interim\)/ })).toHaveAttribute(
      'href',
      DOC_URLS.terms,
    );
    expect(privacy).toHaveTextContent('(opens in a new tab)');
  });
});

describe('OnboardingForm', () => {
  it('opens on the name and keeps the primary off until every gate passes', async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await waitFor(() => expect(field('Your full name')).toHaveFocus());
    expect(start()).toBeDisabled();
    await user.keyboard('Kate Donovan');
    await user.type(field('Username'), 'KDonovan');
    await user.type(field('Date of birth'), '1988-11-02');
    expect(start()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    expect(start()).toBeEnabled();
    expect(screen.getByText('kate.donovan@gmail.com')).toBeInTheDocument();
  });

  it('submits the normalized values and stays busy while AuthGate moves on', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderOnboarding(undefined, {
      ...READY,
      displayName: '  Kate   Donovan ',
      username: ' KDonovan ',
    });
    await user.click(start());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        displayName: 'Kate Donovan',
        username: 'kdonovan',
        dateOfBirth: Date.UTC(1988, 10, 2),
      }),
    );
    expect(start()).toHaveAttribute('aria-busy', 'true');
  });

  it('holds the 16+ gate in the field, and says a malformed date only once the field is left', async () => {
    const user = userEvent.setup();
    renderOnboarding(undefined, { ...READY, dob: '' });
    await user.type(field('Date of birth'), '2011-03-14');
    expect(screen.getByText('You must be at least 16 to use Gli.')).toBeInTheDocument();
    expect(start()).toBeDisabled();
    await user.clear(field('Date of birth'));
    await user.type(field('Date of birth'), '1988-1');
    expect(screen.queryByText(/valid date/)).toBeNull();
    await user.tab();
    expect(screen.getByText('Enter a valid date as YYYY-MM-DD.')).toBeInTheDocument();
  });

  it('says a taken username in the field with three to try, and one press takes one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (): Promise<OnboardingRefusal | null> => ({ kind: 'taken' }));
    renderOnboarding(onSubmit, READY);
    await user.click(start());
    expect(
      await screen.findByText('@kdonovan is taken. Pick another, or try one of these:'),
    ).toBeInTheDocument();
    await waitFor(() => expect(field('Username')).toHaveFocus());
    expect(start()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '@kate_donovan' }));
    expect(field('Username')).toHaveValue('kate_donovan');
    expect(screen.queryByText(/is taken/)).toBeNull();
    expect(start()).toBeEnabled();
  });

  it('says the username rule when the server refuses one, and as soon as a character can’t be in one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (): Promise<OnboardingRefusal | null> => ({ kind: 'badname' }));
    renderOnboarding(onSubmit, READY);
    await user.click(start());
    expect(await screen.findByText(/Use 3 to 30 letters/)).toBeInTheDocument();
    await user.clear(field('Username'));
    await user.type(field('Username'), 'kate.d');
    expect(screen.getByText(/Use 3 to 30 letters/)).toBeInTheDocument();
  });

  it('says any other refusal on its own line', async () => {
    const user = userEvent.setup();
    renderOnboarding(
      vi.fn(
        async (): Promise<OnboardingRefusal | null> => ({
          kind: 'message',
          message: 'Not authenticated',
        }),
      ),
      READY,
    );
    await user.click(start());
    expect(await screen.findByRole('alert')).toHaveTextContent('Not authenticated');
    expect(start()).toBeEnabled();
  });

  it('signs out from the foot, and names no one when the email is unknown', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(<OnboardingForm email={null} onSubmit={vi.fn()} onSignOut={onSignOut} />);
    expect(screen.getByText('your account')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe('ReackForm', () => {
  it('accepts only once ticked, stays busy on success, and signs out on request', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn(async () => null);
    const onSignOut = vi.fn();
    render(<ReackForm onAccept={onAccept} onSignOut={onSignOut} />);
    const accept = screen.getByRole('button', { name: 'Accept and continue' });
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    await user.click(accept);
    await waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
    expect(accept).toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button', { name: 'Not now — sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('says a failure and lets them try again', async () => {
    const user = userEvent.setup();
    render(
      <ReackForm
        onAccept={vi.fn(async () => 'Could not save your acknowledgment')}
        onSignOut={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save your acknowledgment',
    );
    expect(screen.getByRole('button', { name: 'Accept and continue' })).toBeEnabled();
  });
});

describe('the stage', () => {
  it('states the skater surface, puts the form before the corners, and credits the picture', () => {
    const { container } = render(
      <SystemStage corner={<a href="/about">About Gli</a>}>
        <SystemCard foot={<span>Foot</span>}>
          <FormLine>Something to fix</FormLine>
        </SystemCard>
      </SystemStage>,
    );
    expect(container.firstElementChild).toHaveAttribute('data-surface', 'skater');
    const order = [...container.querySelectorAll('main, a')].map((el) => el.tagName);
    expect(order).toEqual(['MAIN', 'A']);
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something to fix');
    expect(screen.getAllByRole('img', { name: 'Gli' })).toHaveLength(2);
  });
});

describe('RegionBackdrop', () => {
  it('is one hidden-from-readers picture per theme, lazy so the hidden one is never fetched', () => {
    const { container } = render(<RegionBackdrop className="fixed" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.className).toContain('fixed');
    expect(root.className).not.toMatch(/(^| )absolute( |$)/);
    const imgs = [...root.querySelectorAll('img')];
    expect(imgs.map((img) => img.dataset.themePicture)).toEqual(['dark', 'light']);
    for (const img of imgs) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img.getAttribute('src')).toMatch(/region-(dark|light)/);
    }
  });

  it('carries its credit', () => {
    render(<RegionCredit className="absolute" />);
    expect(
      screen.getByText('State lines: U.S. Census Bureau · Water: OpenStreetMap contributors'),
    ).toBeInTheDocument();
  });
});
