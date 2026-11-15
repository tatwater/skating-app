import { render } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => [] as { title: string; description?: string; tone?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string; tone?: string }) => toasts.push(t),
}));

import { OTHER_BODY } from '../consoleWords';
import {
  BodyBindingProvider,
  type BodyHold,
  listChanged,
  sendFor,
  useBodyHold,
} from './currentBody';

function Probe({ seen }: { seen: (hold: BodyHold) => void }) {
  seen(useBodyHold());
  return null;
}

const holder = () => {
  let hold: BodyHold = { here: () => true, body: null, subject: undefined };
  return {
    seen: (h: BodyHold) => {
      hold = h;
    },
    get: () => hold,
  };
};

describe('useBodyHold — the console a subtree mounted under', () => {
  it('holds the binding it mounted under, its body and its name, never a later one', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1" name="Mascoma Lake">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.get()).toMatchObject({ body: 'wb1', subject: 'Mascoma Lake' });
    expect(h.get().here()).toBe(true);
    rerender(
      <BodyBindingProvider bodyId="wb2" name="Crystal Lake">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    // The subtree missed its reset: it still holds wb1's binding, no longer on screen.
    expect(h.get()).toMatchObject({ body: 'wb1', subject: 'Mascoma Lake' });
    expect(h.get().here()).toBe(false);
  });

  it('is off screen once its console goes, and coming back is a new console', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    const first = h.get();
    rerender(<p>Loading</p>);
    expect(first.here()).toBe(false);
    rerender(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={() => {}} />
      </BodyBindingProvider>,
    );
    expect(first.here()).toBe(false);
  });

  it('outside a frame there is no other console', () => {
    const h = holder();
    render(<Probe seen={h.seen} />);
    expect(h.get()).toMatchObject({ body: null, subject: undefined });
    expect(h.get().here()).toBe(true);
  });
});

describe('sendFor — the one write path', () => {
  const hold = (here: boolean, body: string | null = 'wb1'): BodyHold => ({
    here: () => here,
    body,
    subject: 'Mascoma Lake',
  });
  const send = (h: BodyHold, write: () => Promise<unknown>, receipt = vi.fn(async () => {})) =>
    sendFor(h, { body: 'wb1', write, receipt, what: 'The links' });

  it('a pressed write is sent whether or not its console is still on screen', async () => {
    const write = vi.fn(async () => {});
    await send(hold(false), write);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('its receipt names its body, wherever the page is', async () => {
    const receipt = vi.fn(async () => {});
    await send(hold(false), async () => {}, receipt);
    expect(receipt).toHaveBeenCalledWith('Mascoma Lake');
  });

  it('a refusal is thrown for the console to say in place while it is on screen', async () => {
    toasts.length = 0;
    await expect(
      send(hold(true), async () => {
        throw new ConvexError('Water body not found');
      }),
    ).rejects.toThrow('Water body not found');
    expect(toasts).toEqual([]);
  });

  it('a refusal for a console that has gone is a toast naming the body and what failed', async () => {
    toasts.length = 0;
    // Resolved `false`: said in the toast, and never taken for a landed write by its caller.
    await expect(
      send(hold(false), async () => {
        throw new ConvexError('Water body not found');
      }),
    ).resolves.toBe(false);
    expect(toasts).toEqual([
      {
        title: 'Not saved · Mascoma Lake',
        description: 'The links: Water body not found',
        tone: 'bad',
      },
    ]);
  });

  it('a list that moved underneath goes back as it came, for its queue to re-apply', async () => {
    const moved = new ConvexError({ code: 'list_changed', message: 'moved', current: ['a'] });
    await expect(
      send(hold(false), async () => {
        throw moved;
      }),
    ).rejects.toBe(moved);
    expect(listChanged(moved)).toEqual(['a']);
    expect(listChanged(new Error('x'))).toBeNull();
  });

  it('a write naming another body than its console’s own (a missed reset) is refused, loudly', async () => {
    const write = vi.fn(async () => {});
    await expect(
      sendFor(hold(true, 'wb2'), {
        body: 'wb1',
        write,
        receipt: async () => {},
        what: 'The links',
      }),
    ).rejects.toThrow(OTHER_BODY);
    expect(write).not.toHaveBeenCalled();
  });

  it('a landed write whose receipt fails is never a refusal', async () => {
    await expect(
      send(
        hold(true),
        async () => {},
        vi.fn(async () => {
          throw new Error('the toast queue is gone');
        }),
      ),
    ).resolves.toBe(true);
  });
});
