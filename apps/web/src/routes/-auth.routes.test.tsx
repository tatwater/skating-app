import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RISK_ACK_COPY, RISK_ACK_VERSION } from '../lib/riskAck';
import { Route as CallbackRoute } from './google-photos.callback';
import { Route as OnboardingRoute } from './onboarding';
import { Route as ReackRoute } from './reack';
import { Route as SignInRoute } from './sign-in';
import { Route as SignUpRoute } from './sign-up';

/** The row-8 routes' own wiring: which mutation each calls, with what, and what it does with a no. */
const m = vi.hoisted(() => ({
  mutation: vi.fn(),
  signOut: vi.fn(async () => undefined),
  capture: vi.fn(),
  user: { primaryEmailAddress: { emailAddress: 'kate.donovan@gmail.com' } } as unknown,
}));

vi.mock('convex/react', () => ({
  useMutation: () => m.mutation,
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: true, isAuthenticated: false }),
}));
vi.mock('@clerk/tanstack-react-start', () => ({
  useUser: () => ({ user: m.user }),
  useSignIn: () => ({ signIn: {} }),
  useSignUp: () => ({ signUp: {} }),
}));
vi.mock('../lib/sheetOwner', () => ({ useSignOut: () => m.signOut }));
vi.mock('../lib/analytics', () => ({ useAnalytics: () => ({ capture: m.capture }) }));
vi.mock('@tanstack/react-router', async (actual) => ({
  ...(await actual<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const page = (route: { options: { component?: unknown } }) => {
  const Page = route.options.component as ComponentType;
  return render(<Page />);
};

beforeEach(() => {
  vi.clearAllMocks();
  m.user = { primaryEmailAddress: { emailAddress: 'kate.donovan@gmail.com' } };
});

describe('/onboarding', () => {
  async function submitReady(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole('textbox', { name: 'Your full name' }), 'Kate Donovan');
    await user.type(screen.getByRole('textbox', { name: 'Username' }), 'kdonovan');
    await user.type(screen.getByRole('textbox', { name: 'Date of birth' }), '1988-11-02');
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    await user.click(screen.getByRole('button', { name: 'Start skating' }));
  }

  it('sends the profile and the current acknowledgment to upsertFromClerk, and counts it', async () => {
    const user = userEvent.setup();
    m.mutation.mockResolvedValue('profile-id');
    page(OnboardingRoute);
    expect(screen.getByText('kate.donovan@gmail.com')).toBeInTheDocument();
    await submitReady(user);
    await waitFor(() =>
      expect(m.mutation).toHaveBeenCalledWith({
        displayName: 'Kate Donovan',
        username: 'kdonovan',
        dateOfBirth: Date.UTC(1988, 10, 2),
        riskAckVersion: RISK_ACK_VERSION,
      }),
    );
    expect(m.capture).toHaveBeenCalledWith('onboarding_completed');
  });

  it('turns a taken username into the field’s state', async () => {
    const user = userEvent.setup();
    m.mutation.mockRejectedValue(new ConvexError('Username is already taken'));
    page(OnboardingRoute);
    await submitReady(user);
    expect(await screen.findByText(/@kdonovan is taken/)).toBeInTheDocument();
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('signs out, and copes without a Clerk user', async () => {
    const user = userEvent.setup();
    m.user = null;
    page(OnboardingRoute);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(m.signOut).toHaveBeenCalledOnce();
    expect(screen.getByText('your account')).toBeInTheDocument();
  });
});

describe('/reack', () => {
  async function accept(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('checkbox', { name: RISK_ACK_COPY }));
    await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
  }

  it('accepts the current version', async () => {
    const user = userEvent.setup();
    m.mutation.mockResolvedValue(null);
    page(ReackRoute);
    await accept(user);
    await waitFor(() =>
      expect(m.mutation).toHaveBeenCalledWith({ riskAckVersion: RISK_ACK_VERSION }),
    );
  });

  it.each([
    [new ConvexError('Account suspended'), 'Account suspended'],
    [new Error('[CONVEX] Server Error'), 'Could not save your acknowledgment'],
  ])('says a refusal (%s)', async (error, line) => {
    const user = userEvent.setup();
    m.mutation.mockRejectedValue(error);
    page(ReackRoute);
    await accept(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
  });

  it('signs out instead', async () => {
    const user = userEvent.setup();
    page(ReackRoute);
    await user.click(screen.getByRole('button', { name: 'Not now — sign out' }));
    expect(m.signOut).toHaveBeenCalledOnce();
  });
});

describe('/sign-in and /sign-up', () => {
  it('link to each other and to About, over the region', () => {
    const { unmount } = page(SignInRoute);
    expect(screen.getByRole('link', { name: /Create an account/ })).toHaveAttribute(
      'href',
      '/sign-up',
    );
    expect(screen.getByRole('link', { name: /About Gli/ })).toHaveAttribute('href', '/about');
    unmount();
    page(SignUpRoute);
    expect(screen.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/sign-in');
    expect(screen.getByText('Join Gli')).toBeInTheDocument();
  });
});

describe('/google-photos/callback', () => {
  it('renders the pop-up', () => {
    page(CallbackRoute);
    expect(screen.getByRole('status')).toHaveTextContent('Opening Google Photos…');
  });
});
