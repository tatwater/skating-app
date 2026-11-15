import { render } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';

import { BodyBindingProvider, sendFor, useBodyBound } from './currentBody';

/** A subtree that is *not* keyed by its body: the missed reset the second layer exists for. */
function Probe({ seen }: { seen: (here: () => boolean) => void }) {
  seen(useBodyBound());
  return null;
}

describe('useBodyBound — one console, one body, one lifetime', () => {
  const holder = () => {
    let here: () => boolean = () => true;
    return { seen: (h: () => boolean) => void (here = h), here: () => here() };
  };

  it('holds the binding it mounted under: a missed reset, now under another body, sends nothing', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.here()).toBe(true);
    rerender(
      <BodyBindingProvider bodyId="wb2">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.here()).toBe(false);
  });

  it('dies when its console goes away — a loading state for another body, a route left (Greptile’s P1)', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    // An uncached body: the page draws its loading state, and the console with its provider is gone.
    rerender(<p>Loading</p>);
    expect(h.here()).toBe(false);
  });

  it('coming back to the same body is a new console: the old binding never revives', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    rerender(<p>Away</p>);
    // Back to the same body: a new console, a new binding; the first console's stays dead.
    rerender(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={() => {}} />
      </BodyBindingProvider>,
    );
    expect(h.here()).toBe(false);
  });

  it('outside a frame there is no other console to move to', () => {
    const h = holder();
    render(<Probe seen={h.seen} />);
    expect(h.here()).toBe(true);
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
