import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TabBoundary } from './TabBoundary';

let throws = true;
function Tab(): ReactNode {
  if (throws) throw new Error('tab down');
  return <p>The tab</p>;
}

beforeEach(() => {
  throws = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const at = (bodyId: string, tab: string) => (
  <TabBoundary bodyId={bodyId} tab={tab} label="Hazards">
    <Tab />
  </TabBoundary>
);

describe('TabBoundary', () => {
  it('says a tab that crashed couldn’t be shown, and draws it again on Try again', async () => {
    render(at('b1', 'hazards'));
    expect(screen.getByText('Hazards couldn’t be shown')).toBeInTheDocument();
    throws = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('The tab')).toBeInTheDocument();
  });

  it('starts clean for another tab or another body', () => {
    const { rerender } = render(at('b1', 'hazards'));
    expect(screen.getByText('Hazards couldn’t be shown')).toBeInTheDocument();
    throws = false;
    rerender(at('b1', 'hazards'));
    expect(screen.getByText('Hazards couldn’t be shown')).toBeInTheDocument();
    rerender(at('b1', 'links'));
    expect(screen.getByText('The tab')).toBeInTheDocument();
    throws = true;
    rerender(at('b2', 'links'));
    expect(screen.getByText('Hazards couldn’t be shown')).toBeInTheDocument();
    throws = false;
    rerender(at('b3', 'links'));
    expect(screen.getByText('The tab')).toBeInTheDocument();
  });
});
