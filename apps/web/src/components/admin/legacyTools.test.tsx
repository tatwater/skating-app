import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The old editor's two cards that wrote less than they asked for, or more than they meant
 * (B01-3o): the Standing card's removal took a note and dropped it, and the Put-ins card could make
 * a mapped launch official only by placing a second official row on top of it. Mocked at the Convex
 * hook boundary, each mutation by its name.
 */

const mocks = vi.hoisted(() => ({
  /** Each mutation's calls, by the function's name. */
  calls: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      let fn = mocks.calls.get(name);
      if (fn === undefined) {
        fn = vi.fn(async () => undefined);
        mocks.calls.set(name, fn);
      }
      return fn;
    },
    useQuery: () => undefined,
  };
});
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: () => {},
}));

import type { Doc, Id } from '@skating/convex/dataModel';
import { AUDIT_REASON_MAX } from '@skating/core';
import { PutInTool } from './PutInTool';
import { RemovalTool } from './RemovalTool';

const BODY = 'j57mascoma0000000000000000000000' as Id<'waterBodies'>;
const called = (name: string) => mocks.calls.get(name) ?? vi.fn();

beforeEach(() => mocks.calls.clear());

describe('the old editor’s Standing card', () => {
  const body = {
    _id: BODY,
    name: 'Mascoma Lake',
    standing: 'active',
  } as unknown as Doc<'waterBodies'>;

  it('sends the removal’s note — the one its dialog asks for — beside the reason', async () => {
    render(<RemovalTool body={body} onResult={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Take off the map' }));
    const dialog = await screen.findByRole('dialog');
    const note = within(dialog).getByRole('textbox', { name: 'Reason' });
    // Held to the audit cap where it is typed (D261), the number the server refuses past.
    expect(note).toHaveAttribute('maxLength', String(AUDIT_REASON_MAX));
    await userEvent.type(note, '  The owner called  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(called('waterBodies:remove')).toHaveBeenCalledWith({
        waterBodyId: BODY,
        reason: 'landowner_request',
        note: 'The owner called',
      }),
    );
  });

  it('sends no note when none was typed', async () => {
    render(<RemovalTool body={body} onResult={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Take off the map' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(called('waterBodies:remove')).toHaveBeenCalledWith({
        waterBodyId: BODY,
        reason: 'landowner_request',
      }),
    );
  });
});

describe('the old editor’s Put-ins card', () => {
  const LAUNCHES = [
    { id: 'p-osm', coord: { lat: 43.63, lng: -72.15 }, source: 'osm', name: 'Town Ramp' },
    { id: 'p-off', coord: { lat: 43.64, lng: -72.16 }, source: 'official', name: 'Shaker Beach' },
    // A stored derived launch (a departed skater's, written down): a row, so it can be promoted.
    { id: 'p-der', coord: { lat: 43.66, lng: -72.18 }, source: 'derived' },
    // A live cluster of report points has no row to make official.
    { cluster: true, coord: { lat: 43.65, lng: -72.17 }, source: 'derived' },
  ] as const;
  const tool = (onResult = vi.fn()) => (
    <PutInTool
      waterBodyId={BODY}
      putIns={LAUNCHES}
      armed={false}
      onArm={() => {}}
      point={null}
      onClearPoint={() => {}}
      onResult={onResult}
    />
  );

  it('makes a mapped launch official on its own row — never a second row placed on it', async () => {
    const onResult = vi.fn();
    render(tool(onResult));
    const row = screen.getByText(/Town Ramp/).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Make official' }));
    await waitFor(() =>
      expect(called('putIns:promote')).toHaveBeenCalledWith({ putInId: 'p-osm' }),
    );
    expect(called('putIns:setOfficial')).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({ tone: 'ok', text: 'Made official, on its own row.' });
  });

  it('offers it on every stored launch not official yet — a stored derived one too', async () => {
    render(tool());
    expect(screen.getAllByRole('button', { name: 'Make official' })).toHaveLength(2);
    const official = screen.getByText(/Shaker Beach/).closest('li') as HTMLElement;
    expect(within(official).queryByRole('button', { name: 'Make official' })).toBeNull();
    const rows = screen.getAllByRole('listitem');
    const stored = rows.find(
      (r) =>
        r.textContent?.startsWith('Unnamed launch — derived') &&
        within(r).queryByRole('button', { name: 'Make official' }),
    ) as HTMLElement;
    await userEvent.click(within(stored).getByRole('button', { name: 'Make official' }));
    await waitFor(() =>
      expect(called('putIns:promote')).toHaveBeenCalledWith({ putInId: 'p-der' }),
    );
    expect(called('putIns:setOfficial')).not.toHaveBeenCalled();
  });

  it('a live cluster offers no button, and says why and what to do instead', () => {
    render(tool());
    const cluster = screen
      .getByText('From reports, with no row: place an official point here to make it official')
      .closest('li') as HTMLElement;
    expect(within(cluster).queryByRole('button', { name: 'Make official' })).toBeNull();
    // The place-a-point path stands, as before.
    expect(screen.getByRole('button', { name: 'Place an official put-in' })).toBeInTheDocument();
  });

  it('one at a time: a second press while the first is out sends nothing more', async () => {
    let land: () => void = () => {};
    mocks.calls.set(
      'putIns:promote',
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            land = resolve;
          }),
      ),
    );
    render(tool());
    const button = screen.getAllByRole('button', { name: 'Make official' })[0] as HTMLElement;
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(called('putIns:promote')).toHaveBeenCalledTimes(1);
    land();
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
