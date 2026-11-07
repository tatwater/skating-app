import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsProvider } from './Analytics';

const mocks = vi.hoisted(() => ({
  configured: { posthog: true },
  provider: vi.fn(),
}));

vi.mock('../lib/env', () => ({
  env: { posthogKey: 'phc_test_token', posthogHost: '/rink' },
  isConfigured: mocks.configured,
}));

vi.mock('../lib/posthogOptions', () => ({
  posthogOptions: { api_host: '/rink', disable_session_recording: true },
}));

vi.mock('@posthog/react', () => ({
  PostHogProvider: (props: { apiKey: string; options: unknown; children: React.ReactNode }) => {
    mocks.provider(props.apiKey, props.options);
    return props.children;
  },
}));

beforeEach(() => {
  mocks.configured.posthog = true;
  mocks.provider.mockClear();
});

describe('AnalyticsProvider', () => {
  it('mounts PostHog with the project token and the shared options', () => {
    render(
      <AnalyticsProvider>
        <p>the app</p>
      </AnalyticsProvider>,
    );

    expect(mocks.provider).toHaveBeenCalledWith('phc_test_token', {
      api_host: '/rink',
      disable_session_recording: true,
    });
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  /**
   * Unconfigured means absent, not broken: no provider, no init, no network — and crucially the app
   * still renders. The generated version of this threw in development instead, which would have
   * made a missing analytics key a blank page on a field app. `lib/env.ts` takes the same posture
   * for the basemap and the imagery archive.
   */
  it('renders the app untouched, with no PostHog at all, when unconfigured', () => {
    mocks.configured.posthog = false;

    render(
      <AnalyticsProvider>
        <p>the app</p>
      </AnalyticsProvider>,
    );

    expect(mocks.provider).not.toHaveBeenCalled();
    expect(screen.getByText('the app')).toBeInTheDocument();
  });
});
