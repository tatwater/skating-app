import { render } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(
  () => [] as { title: string; description?: string; tone?: string; timeout?: number }[],
);
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
  let hold: BodyHold = { body: null, subject: undefined };
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
    rerender(
      <BodyBindingProvider bodyId="wb2" name="Crystal Lake">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    // The subtree missed its reset: it still holds wb1's binding.
    expect(h.get()).toMatchObject({ body: 'wb1', subject: 'Mascoma Lake' });
  });

  it('takes its body’s name when it lands, and keeps it while the same console reloads', () => {
    const h = holder();
    const { rerender } = render(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.get().subject).toBeUndefined();
    rerender(
      <BodyBindingProvider bodyId="wb1" name="Mascoma Lake">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.get().subject).toBe('Mascoma Lake');
    // The same body's console reloads or fails: no name is given, and the landed one stands.
    rerender(
      <BodyBindingProvider bodyId="wb1">
        <Probe seen={h.seen} />
      </BodyBindingProvider>,
    );
    expect(h.get().subject).toBe('Mascoma Lake');
  });

  it('outside a frame there is no other console', () => {
    const h = holder();
    render(<Probe seen={h.seen} />);
    expect(h.get()).toMatchObject({ body: null, subject: undefined });
  });
});

describe('sendFor — the one write path', () => {
  const hold = (body: string | null = 'wb1'): BodyHold => ({ body, subject: 'Mascoma Lake' });
  const send = (h: BodyHold, write: () => Promise<unknown>, receipt = vi.fn(async () => {})) =>
    sendFor(h, { body: 'wb1', write, receipt, what: 'The links' });

  it('a pressed write is sent, and its receipt names its body', async () => {
    const write = vi.fn(async () => {});
    const receipt = vi.fn(async () => {});
    await expect(send(hold(), write, receipt)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith('Mascoma Lake');
  });

  /**
   * **Always a toast** (D268): one refusal, one toast naming the body and what failed, held until
   * dismissed — and the caller is told only `false`, never the words.
   */
  it.each([
    ['refused', new ConvexError('Water body not found'), 'Water body not found'],
    ['a server error', new ConvexError({ code: 'internal' }), 'That write was rejected.'],
    [
      'a failed send',
      new TypeError('Failed to fetch'),
      'Something went wrong — check your connection and try again.',
    ],
  ])(
    '%s: one toast naming the body and what failed; the caller hears only false',
    async (_, err, words) => {
      toasts.length = 0;
      await expect(
        send(hold(), async () => {
          throw err;
        }),
      ).resolves.toBe(false);
      expect(toasts).toEqual([
        {
          title: 'Not saved · Mascoma Lake',
          description: `The links: ${words}`,
          tone: 'bad',
          timeout: 0,
        },
      ]);
    },
  );

  it('a list that moved underneath goes back as it came, for its queue to re-apply, unsaid', async () => {
    toasts.length = 0;
    const moved = new ConvexError({ code: 'list_changed', message: 'moved', current: ['a'] });
    await expect(
      send(hold(), async () => {
        throw moved;
      }),
    ).rejects.toBe(moved);
    expect(toasts).toEqual([]);
    expect(listChanged(moved)).toEqual(['a']);
    expect(listChanged(new Error('x'))).toBeNull();
  });

  it('a write naming another body than its console’s own (a missed reset) is refused, in a toast', async () => {
    toasts.length = 0;
    const write = vi.fn(async () => {});
    await expect(
      sendFor(hold('wb2'), {
        body: 'wb1',
        write,
        receipt: async () => {},
        what: 'The links',
      }),
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(toasts).toEqual([expect.objectContaining({ description: OTHER_BODY, tone: 'bad' })]);
  });

  it('a landed write whose receipt fails is never a refusal', async () => {
    await expect(
      send(
        hold(),
        async () => {},
        vi.fn(async () => {
          throw new Error('the toast queue is gone');
        }),
      ),
    ).resolves.toBe(true);
  });
});
