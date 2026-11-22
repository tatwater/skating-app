import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LockBanner } from './note';

/**
 * The decided banner is announced: its live region is in the page before its words are — the
 * words go into the region's reader-only slot a frame after it mounts (a region mounted already
 * holding its text is often skipped), while the line is drawn at once for the eye.
 */
describe('LockBanner', () => {
  it('mounts its live region empty for a reader, then puts the words into it', async () => {
    render(
      <LockBanner>
        <strong>Decided by Sarah</strong> · 14:42 · approved
      </LockBanner>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    const said = region.querySelector('[data-slot="lock-banner-said"]');
    // In the page, before its words: nothing a reader hears yet…
    expect(said).toBeEmptyDOMElement();
    // …while the line is drawn at once for the eye, kept from the reader.
    const line = region.querySelector('[data-slot="lock-banner-line"]');
    expect(line).toHaveTextContent('Decided by Sarah · 14:42 · approved');
    expect(line).toHaveAttribute('aria-hidden', 'true');
    // Then the words arrive in the same region: the change that is announced.
    await waitFor(() => expect(said).toHaveTextContent('Decided by Sarah · 14:42 · approved'));
    expect(screen.getByRole('status')).toBe(region);
  });
});
