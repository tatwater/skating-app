import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { BootScreen } from './BootScreen';

/**
 * The hold a returning load shows (`lib/boot.ts`). Two things are worth pinning: it draws the
 * shape of the page the pathname names, and it reads nothing — no Clerk, no Convex, no map store.
 * The second is what this file proves by construction: nothing here is mocked, so a query added to
 * this screen would fail these tests rather than fire before the Convex client has its token.
 */

beforeAll(() => {
  // jsdom has no Web Animations: the kit's skeleton shimmers, and Base UI's scroll area asks for them.
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.getAnimations ??= () => [];
});

const shape = () => {
  for (const slot of ['boot-sidebar', 'boot-latest', 'boot-column']) {
    if (document.querySelector(`[data-slot="${slot}"]`)) return slot;
  }
  return null;
};

describe('BootScreen', () => {
  it('says it is loading, once, where a reader will hear it', () => {
    render(<BootScreen pathname="/" />);
    const status = screen.getByRole('status', { name: 'Loading' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    // The bar is chrome with nothing in it yet; the skeletons are never announced on their own.
    expect(document.querySelector('[data-slot="boot-top-bar"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it.each([
    ['Explore', '/'],
    ['a lake', '/water/abc'],
    ['a report over the map', '/report/r1'],
    ['a hazard over the map', '/hazard/h1'],
    ['a bounty over the map', '/bounty/b1'],
  ])('draws the sidebar beside the map for %s', (_, pathname) => {
    render(<BootScreen pathname={pathname} />);
    expect(shape()).toBe('boot-sidebar');
  });

  it("draws Explore's own In view skeleton when nothing is chosen", () => {
    render(<BootScreen pathname="/" />);
    // `InViewListView` with no rows: the same markup the page itself shows while the map reads.
    expect(screen.getByRole('complementary', { name: 'Lakes in view' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it("draws the lake sidebar's own skeleton when one is chosen", () => {
    render(<BootScreen pathname="/water/abc" />);
    expect(screen.getByRole('complementary', { name: 'Loading the lake' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="lake-header-skeleton"]')).toBeInTheDocument();
  });

  it.each(['/latest', '/latest/'])('draws the three columns for %s', (pathname) => {
    render(<BootScreen pathname={pathname} />);
    expect(shape()).toBe('boot-latest');
  });

  it.each(['/settings/account', '/u/skater', '/about', '/nowhere'])(
    'draws a plain column for %s',
    (pathname) => {
      render(<BootScreen pathname={pathname} />);
      expect(shape()).toBe('boot-column');
    },
  );

  it('never names a lake, a report or anything about ice — it knows none of it', () => {
    render(<BootScreen pathname="/water/abc" />);
    expect(document.body.textContent).not.toMatch(/abc/);
  });
});
