import { render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as CallbackRoute } from './google-photos.callback';
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
