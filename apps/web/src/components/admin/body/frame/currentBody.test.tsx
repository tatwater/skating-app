import { render } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';

import { CurrentBodyProvider, sendFor, useBodyBound } from './currentBody';

/** A subtree that is *not* keyed by its body: the missed reset the second layer exists for. */
function Unkeyed({ bodyId, seen }: { bodyId: string; seen: (here: () => boolean) => void }) {
  seen(useBodyBound(bodyId));
  return null;
}

describe('useBodyBound', () => {
  it('holds the body its subtree was mounted for: a missed reset, now reading another body, sends nothing', () => {
    let here: () => boolean = () => true;
    const seen = (h: () => boolean) => {
      here = h;
    };
    const { rerender } = render(
      <CurrentBodyProvider bodyId="wb1">
        <Unkeyed bodyId="wb1" seen={seen} />
      </CurrentBodyProvider>,
    );
    expect(here()).toBe(true);
    // The page and the subtree's own prop both move to wb2, but the subtree (and its draft) is wb1's.
    rerender(
      <CurrentBodyProvider bodyId="wb2">
        <Unkeyed bodyId="wb2" seen={seen} />
      </CurrentBodyProvider>,
    );
    expect(here()).toBe(false);
  });

  it('outside a frame there is no other body to move to', () => {
    let here: () => boolean = () => false;
    render(
      <Unkeyed
        bodyId="wb1"
        seen={(h) => {
          here = h;
        }}
      />,
    );
    expect(here()).toBe(true);
  });
});

describe('sendFor', () => {
  it('sends nothing once the page has moved on', async () => {
    const write = vi.fn(async () => {});
    const receipt = vi.fn(async () => {});
    await sendFor(() => false, write, receipt);
    expect(write).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });

  it('says a refusal in the server’s words while the page is still there, and drops it after', async () => {
    const refuse = async () => {
      throw new ConvexError('Water body not found');
    };
    await expect(
      sendFor(
        () => true,
        refuse,
        async () => {},
      ),
    ).rejects.toThrow('Water body not found');
    let still = true;
    const refuseLate = async () => {
      still = false;
      throw new ConvexError('Water body not found');
    };
    await expect(
      sendFor(
        () => still,
        refuseLate,
        async () => {},
      ),
    ).resolves.toBeUndefined();
  });

  it('a landed write whose receipt fails is never a refusal', async () => {
    const write = vi.fn(async () => {});
    const receipt = async () => {
      throw new Error('the toast queue is gone');
    };
    await expect(sendFor(() => true, write, receipt)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
