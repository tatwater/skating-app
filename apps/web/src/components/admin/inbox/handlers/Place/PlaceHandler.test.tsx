import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactElement, useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { PlaceActions, PlaceBody, type PlaceHandlerProps, PlaceHead } from './PlaceHandlerView';
import {
  BAY_DRAWN,
  BAY_UNDRAWN,
  LANDMARK_ALONE,
  LANDMARK_PROPOSAL,
  MANY_LANDMARK_ASKS,
  NARROWS,
  PLACE_BY_VIEWER,
  PLACE_NOW,
  UNCOUNTED_ASKER,
} from './placeFixtures';
import { landmarkLookalike, type PlaceItem } from './placeModel';
import { type PlaceServer, usePlaceWrites } from './usePlaceWrites';

/**
 * The place handler's slots and its writes: the board's blocks for a landmark ask, the shared ask
 * list for several askers, the bar drawn only where `can` allows, S and D acting only in the pane,
 * Decline asking the asker's note, a refusal said in a toast, a landed decision announced with
 * Undo on the ask the write answered with, one write at a time.
 */

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () =>
      ({
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      }) as unknown as Animation,
  });
  stubJsdomAnimations();
});

const undoServer = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => null),
  run: vi.fn(async () => {}),
});

function Pane({
  item,
  onSamePlace = vi.fn(async () => true),
  onApprove = vi.fn(async () => true),
  onDecline = vi.fn(async () => true),
}: {
  item: PlaceItem;
  onSamePlace?: PlaceHandlerProps['onSamePlace'];
  onApprove?: PlaceHandlerProps['onApprove'];
  onDecline?: PlaceHandlerProps['onDecline'];
}) {
  const pane = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={pane} tabIndex={-1} data-testid="pane">
      <PlaceHead item={item} now={PLACE_NOW} bodyLink={<a href="/admin/body/wb">x</a>} />
      <PlaceBody item={item} now={PLACE_NOW} map={null} timeZone="America/New_York" />
      <PlaceActions
        item={item}
        editorHref="/admin/water/wb"
        onSamePlace={onSamePlace}
        onApprove={onApprove}
        onDecline={onDecline}
        pending={null}
        pane={pane}
      />
    </div>
  );
}

const inShell = (ui: ReactElement, s: UndoServer = undoServer()) =>
  render(
    <Toaster>
      <UndoProvider server={s}>{ui}</UndoProvider>
    </Toaster>,
  );

describe('the slots', () => {
  it('draws the board: the where, the asker, the compare table, the two futures', () => {
    inShell(<Pane item={NARROWS} />);
    expect(screen.getByText('Name a landmark')).toBeInTheDocument();
    expect(screen.getByText('5 hours ago')).toBeInTheDocument();
    // From a report: Reports, which isn't built (Coming soon).
    expect(screen.getByRole('button', { name: /Open in Reports/ })).toHaveAttribute(
      'data-unavailable-title',
      'Coming soon',
    );
    expect(screen.getByRole('heading', { name: '“the Narrows”' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'From the where of Luc Pelletier’s report, 14 Oct 09:40: “through the Narrows, open water north of it”',
    );
    expect(screen.getByText('43.6702 −71.7588', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Trusted · 63 pts · 2 of 3 landmark asks added')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Same place?' });
    expect(
      within(table).getByRole('columnheader', { name: 'The Narrows · OpenStreetMap' }),
    ).toHaveAttribute('data-tone', 'warn');
    expect(within(table).getByRole('rowheader', { name: 'Kind' })).toBeInTheDocument();
    expect(screen.getByText('same name')).toBeInTheDocument();
    expect(screen.getByText('0.4 mi apart')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'If same place' })).toHaveTextContent(
      'Gains the alias “the Narrows”',
    );
    expect(screen.getByRole('region', { name: 'If drawn' })).toHaveTextContent(
      'The old editor · in a new tab',
    );
  });

  it('draws the asker’s landmark history only where it is served', () => {
    const { unmount } = inShell(<Pane item={MANY_LANDMARK_ASKS} />);
    expect(
      screen.getByText('Trusted · 63 pts · 31+ of 50+ landmark asks added'),
    ).toBeInTheDocument();
    unmount();
    inShell(<Pane item={UNCOUNTED_ASKER} />);
    expect(screen.getByText('Trusted · 63 pts')).toBeInTheDocument();
    expect(screen.queryByText(/landmark asks? /)).toBeNull();
  });

  it('says a landmark ask with nothing like it, and another ask nearby', () => {
    const { unmount } = inShell(<Pane item={LANDMARK_ALONE} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Nothing on this body looks like the same place.')).toBeInTheDocument();
    unmount();
    inShell(<Pane item={LANDMARK_PROPOSAL} />);
    expect(screen.getByText('Another open ask nearby: “The Narrows” · 0.1 mi')).toBeInTheDocument();
  });

  it('draws a bay ask with no compare table, the askers as the shared list, Open in Body live', () => {
    inShell(<Pane item={BAY_UNDRAWN} />);
    expect(screen.getByText('Name a bay')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Same place?' })).toBeNull();
    expect(screen.getByRole('link', { name: /Open in Body/ })).toHaveAttribute(
      'href',
      '/admin/body/wb',
    );
    const asks = screen.getByRole('region', { name: 'Asked by' });
    expect(within(asks).getAllByRole('listitem')).toHaveLength(3);
    // Several askers: no single User row.
    expect(screen.queryByText('User')).toBeNull();
    expect(screen.getByRole('region', { name: 'If declined' })).toHaveTextContent('All 3 asks');
  });

  it('says the refusal once when nothing can be drawn', () => {
    inShell(<Pane item={PLACE_BY_VIEWER} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(
      screen.getByText('You filed this, so another staff member decides it.'),
    ).toBeInTheDocument();
  });
});

describe('the bar', () => {
  it('draws Same place (S), Draw in Body → (B), Decline (D) for the board’s ask', () => {
    inShell(<Pane item={NARROWS} />);
    expect(screen.getByRole('button', { name: 'Same place' })).toHaveAttribute(
      'aria-keyshortcuts',
      'S',
    );
    expect(screen.getByRole('button', { name: 'Draw in Body →' })).toHaveAttribute(
      'aria-keyshortcuts',
      'B',
    );
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveAttribute(
      'aria-keyshortcuts',
      'D',
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('draws Approve (A) in Draw’s place once the bay is drawn', () => {
    inShell(<Pane item={BAY_DRAWN} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute(
      'aria-keyshortcuts',
      'A',
    );
    expect(screen.queryByRole('button', { name: /Draw in Body/ })).toBeNull();
  });

  it('S answers with the lookalike, only while the pane has focus', async () => {
    const user = userEvent.setup();
    const onSamePlace = vi.fn(async () => true);
    inShell(<Pane item={NARROWS} onSamePlace={onSamePlace} />);
    await user.keyboard('s');
    expect(onSamePlace).not.toHaveBeenCalled();
    screen.getByTestId('pane').focus();
    await user.keyboard('s');
    await waitFor(() => expect(onSamePlace).toHaveBeenCalledWith(landmarkLookalike(NARROWS)));
  });

  it('D asks the note the asker reads, capped by core, and sends it', async () => {
    const user = userEvent.setup();
    const onDecline = vi.fn(async () => true);
    inShell(<Pane item={NARROWS} onDecline={onDecline} />);
    screen.getByTestId('pane').focus();
    await user.keyboard('d');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Note · the asker reads it')).toBeInTheDocument();
    const box = within(dialog).getByRole('textbox');
    expect(box).toHaveAttribute('maxlength', '280');
    await user.type(box, 'Already named');
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(onDecline).toHaveBeenCalledWith('Already named'));
  });
});

describe('the writes', () => {
  function Harness({ item, server }: { item: PlaceItem; server: PlaceServer }) {
    const { samePlace, approve, decline, pending } = usePlaceWrites(item, server);
    const l = landmarkLookalike(item);
    return (
      <>
        <button type="button" onClick={() => l && void samePlace(l)}>
          go-same
        </button>
        <button type="button" onClick={() => void approve()}>
          go-approve
        </button>
        <button type="button" onClick={() => void decline('  No  ')}>
          go-decline
        </button>
        <span data-testid="pending">{pending ?? 'none'}</span>
      </>
    );
  }
  // The decision's own row and its undo offer, as the server answers them (`InboxDecisionResult`).
  const answer = { actionId: 'ma_place', undoable: true as const, undoNeedsReason: false };
  const okServer = (): PlaceServer => ({
    approve: vi.fn(async ({ requestId }) => ({ requestId, ...answer })),
    decline: vi.fn(async ({ requestId }) => ({ requestId, ...answer })),
  });
  const ask = (item: PlaceItem) => item.primaryRequestId;

  it('Same place sends sameAs, and announces with Undo from the write’s own answer', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server = okServer();
    inShell(<Harness item={NARROWS} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-same' }));
    await waitFor(() =>
      expect(server.approve).toHaveBeenCalledWith({
        requestId: ask(NARROWS),
        sameAs: {
          landmarkId: landmarkLookalike(NARROWS)?.landmarkId,
          name: 'The Narrows',
          point: { lat: 43.676, lng: -71.7571 },
        },
      }),
    );
    expect(await screen.findByText(/Same place/)).toBeInTheDocument();
    expect(screen.getByText('Closes 1 ask')).toBeInTheDocument();
    // Undo is the answer's row: nothing is looked up.
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('Approve sends the ask the server names alone; Decline its note trimmed', async () => {
    const user = userEvent.setup();
    const server = okServer();
    inShell(<Harness item={BAY_DRAWN} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-approve' }));
    await waitFor(() => expect(server.approve).toHaveBeenCalledWith({ requestId: ask(BAY_DRAWN) }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
    await user.click(screen.getByRole('button', { name: 'go-decline' }));
    await waitFor(() =>
      expect(server.decline).toHaveBeenCalledWith({ requestId: ask(BAY_DRAWN), note: 'No' }),
    );
    expect((await screen.findAllByText('Closes 3 asks')).length).toBeGreaterThan(0);
  });

  it('says a refusal in a toast naming the ask, and announces nothing', async () => {
    const user = userEvent.setup();
    const u = undoServer();
    const server: PlaceServer = {
      approve: vi.fn(async () => {
        throw new ConvexError('This has already been decided.');
      }),
      decline: vi.fn(),
    };
    inShell(<Harness item={NARROWS} server={server} />, u);
    await user.click(screen.getByRole('button', { name: 'go-same' }));
    expect(
      (await screen.findAllByText('Not saved · “the Narrows” · Newfound Lake')).length,
    ).toBeGreaterThan(0);
    expect(u.latestOwn).not.toHaveBeenCalled();
  });

  it('runs one write at a time', async () => {
    const user = userEvent.setup();
    let release: (v: { requestId: never } & typeof answer) => void = () => {};
    const server: PlaceServer = {
      approve: vi.fn(
        () =>
          new Promise((r) => {
            release = r as typeof release;
          }),
      ) as PlaceServer['approve'],
      decline: vi.fn(async ({ requestId }) => ({ requestId, ...answer })),
    };
    inShell(<Harness item={NARROWS} server={server} />);
    await user.click(screen.getByRole('button', { name: 'go-same' }));
    expect(screen.getByTestId('pending')).toHaveTextContent('samePlace');
    await user.click(screen.getByRole('button', { name: 'go-decline' }));
    expect(server.decline).not.toHaveBeenCalled();
    await act(async () => release({ requestId: ask(NARROWS) as never, ...answer }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('none'));
  });
});
