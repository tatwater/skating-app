import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { stubJsdomAnimations } from '@/components/admin/body/tabs/jsdomStubs';
import { AuditFeed } from './AuditFeed';
import type { FeedRow } from './overviewData';

// The feed scrolls in the kit's ScrollArea, whose viewport asks for the Web Animations jsdom lacks
// (`getAnimations`, from a timer after the render): without the shared stub that timer throws.
beforeAll(stubJsdomAnimations);

const row = (over: Partial<FeedRow>): FeedRow => ({
  id: 'a',
  at: 1_000,
  actor: 'Teagan',
  action: 'Boosted body',
  target: { type: 'waterbody', id: 'w1', label: 'Body' },
  ...over,
});

describe('AuditFeed — who acted', () => {
  it('a write made through a script reads "Teagan via seed-destinations", the name in mono', () => {
    render(<AuditFeed rows={[row({ via: 'seed-destinations' })]} now={2_000} />);
    const via = screen.getByText('seed-destinations');
    expect(via).toHaveAttribute('data-slot', 'feed-via');
    expect(via.className).toMatch(/family-mono/);
    expect(via.parentElement).toHaveTextContent(/^Teagan via seed-destinations$/);
  });

  it('a write from the console names the person alone, and the machine as system', () => {
    render(<AuditFeed rows={[row({}), row({ id: 'b', actor: null })]} now={2_000} />);
    expect(document.querySelector('[data-slot="feed-via"]')).toBeNull();
    expect(screen.getByText('Teagan')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
  });
});
