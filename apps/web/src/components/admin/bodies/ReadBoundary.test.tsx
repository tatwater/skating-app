import { render, screen } from '@testing-library/react';
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

import { ReadBoundary } from './ReadBoundary';

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

const at = (resetKey: string, when: boolean) => (
  <ReadBoundary resetKey={resetKey} fallback={<p>Couldn’t read this list</p>}>
    <Throws when={when} />
  </ReadBoundary>
);

describe('ReadBoundary', () => {
  it('draws its fallback for a failed read, reports it, and tries again at a new place', () => {
    const { rerender } = render(at('a', true));
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    expect(captured.exceptions).toEqual([boom]);
    // The same place stays failed; another place reads again.
    rerender(at('a', false));
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    rerender(at('b', false));
    expect(screen.getByText('The list')).toBeInTheDocument();
  });

  it('reports nothing without a DSN', () => {
    captured.sentry = false;
    render(at('a', true));
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    expect(captured.exceptions).toEqual([]);
  });
});
