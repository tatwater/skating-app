import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ exceptions: [] as unknown[], sentry: true }));
vi.mock('@sentry/tanstackstart-react', () => ({
  captureException: (e: unknown) => captured.exceptions.push(e),
}));
vi.mock('@/lib/env', () => ({
  isConfigured: {
    get sentry() {
      return captured.sentry;
    },
  },
}));

import { ReadBoundary } from './read-boundary';

const boom = new Error('boom');
function Throws({ when }: { when: boolean }) {
  if (when) throw boom;
  return <p>The list</p>;
}

beforeEach(() => {
  captured.exceptions = [];
  captured.sentry = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const at = (resetKey: string, when: boolean, onRetry?: () => void) => (
  <ReadBoundary
    resetKey={resetKey}
    onRetry={onRetry}
    fallback={(retry) => (
      <p>
        Couldn’t read this list{' '}
        <button type="button" onClick={retry}>
          Try again
        </button>
      </p>
    )}
  >
    <Throws when={when} />
  </ReadBoundary>
);

describe('ReadBoundary', () => {
  it('draws its fallback for a failed read, reports it, and tries again at a new place', () => {
    const { rerender } = render(at('a', true));
    expect(screen.getByText(/Couldn’t read this list/)).toBeInTheDocument();
    expect(captured.exceptions).toEqual([boom]);
    // The same place stays failed; another place reads again.
    rerender(at('a', false));
    expect(screen.getByText(/Couldn’t read this list/)).toBeInTheDocument();
    rerender(at('b', false));
    expect(screen.getByText('The list')).toBeInTheDocument();
  });

  it('reports nothing without a DSN', () => {
    captured.sentry = false;
    render(at('a', true));
    expect(screen.getByText(/Couldn’t read this list/)).toBeInTheDocument();
    expect(captured.exceptions).toEqual([]);
  });

  it('tries again from its fallback: runs onRetry, then draws the children again', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(at('a', true, onRetry));
    // The cause went away (a read that answers now); Try again draws the children.
    rerender(at('a', false, onRetry));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('The list')).toBeInTheDocument();
  });
});
