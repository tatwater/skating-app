import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFakes } from '../testMocks';
import { panelFakes, panelRouter, resetPanelFakes } from './panelTestMocks';

const captured = vi.hoisted(() => ({ exceptions: [] as unknown[], sentry: true }));
vi.mock('@tanstack/react-router', () => panelRouter);
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

import { PanelCrash } from './PanelCrash';

beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  captured.exceptions = [];
  captured.sentry = true;
});

describe('PanelCrash', () => {
  it('keeps a crash inside the card, reports it once, and retries', async () => {
    const error = new Error('boom');
    const reset = vi.fn();
    render(<PanelCrash error={error} reset={reset} info={undefined} />);
    expect(await screen.findByRole('dialog', { name: 'Something broke' })).toBeInTheDocument();
    expect(captured.exceptions).toEqual([error]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: /Back to Explore/ }));
    expect(panelFakes.navigate).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('reports nothing without a DSN', async () => {
    captured.sentry = false;
    render(<PanelCrash error={new Error('boom')} reset={vi.fn()} info={undefined} />);
    await screen.findByRole('dialog');
    expect(captured.exceptions).toEqual([]);
  });
});
