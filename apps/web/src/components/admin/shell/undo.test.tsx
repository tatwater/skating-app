import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastManager, Toaster } from '@/components/kit/toast';
import { type Receipt, UndoProvider, type UndoServer, useUndo } from './undo';

vi.mock('convex/react', () => ({ useConvex: () => ({}) }));

const TARGET = { targetType: 'report', targetId: 'r1' } as const;

// jsdom draws no animations; the kit toast's time bar asks for one (the browser suite runs the
// real thing in `UndoToast.stories.tsx`).
beforeAll(() => {
  if (typeof Element.prototype.animate !== 'function') {
    Element.prototype.animate = function animate() {
      return {
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      } as unknown as Animation;
    };
  }
});

function Harness({ server, receipt }: { server: UndoServer; receipt: Receipt }) {
  const [manager] = useState(createToastManager);
  return (
    <Toaster manager={manager}>
      <UndoProvider server={server} manager={manager}>
        <Act receipt={receipt} />
      </UndoProvider>
    </Toaster>
  );
}

function Act({ receipt }: { receipt: Receipt }) {
  const { announce, undo } = useUndo();
  return (
    <>
      <button type="button" onClick={() => void announce(receipt)}>
        Hide it
      </button>
      <button
        type="button"
        onClick={() => undo({ actionId: 'a9', needsReason: true, what: 'Hid a report' })}
      >
        History row
      </button>
    </>
  );
}

const receipt: Receipt = {
  title: 'Hidden · “Black ice at the beach”',
  description: 'The flag stays open',
  target: TARGET,
};

let server: UndoServer & { run: ReturnType<typeof vi.fn>; latestOwn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  server = {
    latestOwn: vi.fn(async () => ({
      actionId: 'a1',
      undo: { state: 'available', needsReason: false },
    })),
    run: vi.fn(async () => {}),
  };
});

const toastNamed = (text: string | RegExp) => screen.findByText(text);

describe('the receipt toast', () => {
  it('offers Undo while the server does, and undoes the caller’s own action', async () => {
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide it' }));
    await toastNamed('Hidden · “Black ice at the beach”');
    expect(server.latestOwn).toHaveBeenCalledWith(TARGET);
    await userEvent.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(server.run).toHaveBeenCalledWith({ actionId: 'a1' });
    await toastNamed('Undone');
    expect(screen.getByText('Both rows stay in the audit log')).toBeInTheDocument();
  });

  it.each([
    ['the server offers no undo for the action', null],
    [
      'someone acted on it since',
      { actionId: 'a1', undo: { state: 'overtaken', byActionId: 'a2' } },
    ],
  ])('draws no Undo when %s', async (_, latest) => {
    server.latestOwn.mockResolvedValue(latest);
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide it' }));
    await toastNamed('Hidden · “Black ice at the beach”');
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('still shows the receipt when the undo lookup fails', async () => {
    server.latestOwn.mockRejectedValue(new Error('offline'));
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide it' }));
    await toastNamed('Hidden · “Black ice at the beach”');
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('says the server’s own refusal when a later write beat the undo', async () => {
    server.run.mockRejectedValue(
      new ConvexError('Something changed this since; open its history to see what'),
    );
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide it' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Undo/ }));
    // A failure is announced at once (Base UI repeats a high-priority toast for the reader).
    expect((await screen.findAllByText('Not undone')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Something changed this since; open its history to see what').length,
    ).toBeGreaterThan(0);
  });

  it('asks the reason first when undoing takes something away', async () => {
    server.latestOwn.mockResolvedValue({
      actionId: 'a1',
      undo: { state: 'available', needsReason: true },
    });
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide it' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Undo/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(server.run).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Hidden · “Black ice at the beach”/)).toBeInTheDocument();
  });
});

describe('the reason dialog', () => {
  it('waits for a reason, then undoes with it', async () => {
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'History row' }));
    const dialog = await screen.findByRole('alertdialog');
    const go = within(dialog).getByRole('button', { name: /^Undo/ });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), '  The author asked  ');
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(server.run).toHaveBeenCalledWith({ actionId: 'a9', reason: 'The author asked' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await toastNamed('Undone');
  });

  it('keeps the reason and says the server’s refusal over it', async () => {
    server.run.mockRejectedValue(new ConvexError('That action has already been undone'));
    render(<Harness server={server} receipt={receipt} />);
    await userEvent.click(screen.getByRole('button', { name: 'History row' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Asked by email');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Undo/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Not undone. That action has already been undone',
    );
    expect(within(dialog).getByRole('textbox')).toHaveValue('Asked by email');
  });
});

describe('useUndo', () => {
  it('says what it needs outside the provider', () => {
    const Orphan = () => {
      useUndo();
      return null;
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Orphan />)).toThrow('useUndo needs an <UndoProvider> above it.');
    } finally {
      quiet.mockRestore();
    }
  });
});
