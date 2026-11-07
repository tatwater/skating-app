import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GooglePhotosCallback, GooglePhotosStatus } from './GooglePhotosCallback';

const m = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: true },
  complete: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock('convex/react', () => ({
  useConvexAuth: () => m.auth,
  useAction: () => m.complete,
  useMutation: () => m.abandon,
}));

const at = (search: string) =>
  window.history.replaceState(null, '', `/google-photos/callback${search}`);

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = { isLoading: false, isAuthenticated: true };
  m.abandon.mockResolvedValue(null);
});
afterEach(() => window.history.replaceState(null, '', '/'));

const status = () => screen.getByRole('status');

describe('GooglePhotosCallback', () => {
  it('waits while auth loads, then completes the pick and goes on to the picker', async () => {
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, search: '?state=s1&code=c1', replace },
    });
    try {
      m.auth = { isLoading: true, isAuthenticated: false };
      m.complete.mockResolvedValue({ ok: true, pickerUri: 'https://photos.google.com/picker/x' });
      const { rerender } = render(<GooglePhotosCallback />);
      expect(status()).toHaveTextContent('Opening Google Photos…');
      expect(
        screen.getByRole('progressbar', { name: 'Opening Google Photos' }),
      ).toBeInTheDocument();
      m.auth = { isLoading: false, isAuthenticated: true };
      rerender(<GooglePhotosCallback />);
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith('https://photos.google.com/picker/x'),
      );
      expect(m.complete).toHaveBeenCalledWith({ code: 'c1', state: 's1' });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('says signed out in this browser', () => {
    m.auth = { isLoading: false, isAuthenticated: false };
    at('?state=s1&code=c1');
    render(<GooglePhotosCallback />);
    expect(status()).toHaveTextContent('Sign in to Gli in this browser');
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('fails without a state', () => {
    at('?code=c1');
    render(<GooglePhotosCallback />);
    expect(status()).toHaveTextContent('Couldn’t open Google Photos');
  });

  it('abandons a declined consent and says so', async () => {
    at('?state=s1&error=access_denied');
    render(<GooglePhotosCallback />);
    expect(status()).toHaveTextContent('You didn’t allow Gli');
    expect(m.abandon).toHaveBeenCalledWith({ state: 's1' });
  });

  it('abandons a return with no code as a failure, even when abandoning fails', async () => {
    m.abandon.mockRejectedValue(new Error('gone'));
    at('?state=s1');
    render(<GooglePhotosCallback />);
    expect(status()).toHaveTextContent('Couldn’t open Google Photos');
  });

  it('says what the server answered, and fails when the call throws', async () => {
    at('?state=s1&code=c1');
    m.complete.mockResolvedValueOnce({ ok: false, reason: 'declined' });
    const { unmount } = render(<GooglePhotosCallback />);
    await waitFor(() => expect(status()).toHaveTextContent('You didn’t allow Gli'));
    unmount();
    m.complete.mockRejectedValueOnce(new Error('boom'));
    render(<GooglePhotosCallback />);
    await waitFor(() => expect(status()).toHaveTextContent('Couldn’t open Google Photos'));
  });
});

describe('GooglePhotosStatus', () => {
  it('offers to close the window in every state but opening', async () => {
    const user = userEvent.setup();
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<GooglePhotosStatus state="failed" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close this window' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByRole('main')).toHaveAttribute('data-surface', 'skater');
  });
});
