import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LockBanner } from './note';

/**
 * The decided banner is announced: its live region is in the page before its words are — the
 * words go into the region's reader-only slot a frame after it mounts (a region mounted already
 * holding its text is often skipped), while the line is drawn at once for the eye.
 */
describe('LockBanner', () => {
  it('announces the words alone: its buttons are outside the live region', async () => {
    render(
      <LockBanner actions={<button type="button">Back to the queue</button>}>
        <strong>Decided by Sarah</strong> · 14:42 · approved
      </LockBanner>,
    );
    const region = screen.getByRole('status');
    const banner = region.closest('[data-slot="lock-banner"]');
    // The banner itself is no live region; the region is the words' slot inside it.
    expect(banner).not.toHaveAttribute('role');
    expect(banner).not.toHaveAttribute('aria-live');
    expect(region).toHaveAttribute('data-slot', 'lock-banner-said');
    expect(region).not.toContainElement(screen.getByRole('button', { name: 'Back to the queue' }));
    await waitFor(() => expect(region).toHaveTextContent('Decided by Sarah · 14:42 · approved'));
    expect(region.querySelector('button')).toBeNull();
  });

  it('mounts its live region empty for a reader, then puts the words into it', async () => {
    render(
      <LockBanner>
        <strong>Decided by Sarah</strong> · 14:42 · approved
      </LockBanner>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    const said = region;
    // In the page, before its words: nothing a reader hears yet…
    expect(said).toBeEmptyDOMElement();
    // …while the line is drawn at once for the eye, kept from the reader.
    const line = region.parentElement?.querySelector('[data-slot="lock-banner-line"]');
    expect(line).toHaveTextContent('Decided by Sarah · 14:42 · approved');
    expect(line).toHaveAttribute('aria-hidden', 'true');
    // Then the words arrive in the same region: the change that is announced.
    await waitFor(() => expect(said).toHaveTextContent('Decided by Sarah · 14:42 · approved'));
    expect(screen.getByRole('status')).toBe(region);
  });
});
