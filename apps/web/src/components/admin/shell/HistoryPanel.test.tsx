import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_NOW_NH } from '../../../test/boardNow';
import { HISTORY_ROWS } from './historyFixtures';

const mocks = vi.hoisted(() => ({
  rows: undefined as unknown,
  args: undefined as unknown,
  undo: vi.fn(),
}));

vi.mock('convex/react', () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    mocks.args = args;
    return mocks.rows;
  },
}));
vi.mock('./undo', () => ({ useUndo: () => ({ undo: mocks.undo, announce: vi.fn() }) }));

const { HistoryPanel, HistoryPanelView } = await import('./HistoryPanel');

const NY = 'America/New_York';

beforeEach(() => {
  mocks.rows = HISTORY_ROWS;
  mocks.undo = vi.fn();
});

const rowOf = (text: string | RegExp) => {
  const row = screen.getByText(text).closest('li');
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
};

describe('HistoryPanelView', () => {
  const draw = (onUndo = vi.fn()) =>
    render(
      <HistoryPanelView rows={HISTORY_ROWS} now={BOARD_NOW_NH} timeZone={NY} onUndo={onUndo} />,
    );

  it('reads each row from the operator’s side, newest first, with its count', () => {
    draw();
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByText(String(HISTORY_ROWS.length))).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Hid a report');
    expect(items[0]).toHaveTextContent('“Second unsafe claim at the beach”');
    expect(items[0]).toHaveTextContent('11:41');
  });

  it('puts whoever acted on their own line — a person, or System', () => {
    draw();
    expect(
      within(rowOf('Hid a report')).getByRole('img', { name: 'Teagan Atwater' }),
    ).toBeInTheDocument();
    expect(within(rowOf('Activated a body')).getByText('System')).toBeInTheDocument();
  });

  it('names a person with a blank display name by their handle, here and in "Undone"', () => {
    const blank = (a: (typeof HISTORY_ROWS)[number]) =>
      a.actor === null ? a : { ...a, actor: { ...a.actor, displayName: '  ' } };
    render(
      <HistoryPanelView
        rows={HISTORY_ROWS.map(blank)}
        now={BOARD_NOW_NH}
        timeZone={NY}
        onUndo={vi.fn()}
      />,
    );
    expect(within(rowOf('Hid a report')).getByText('teagan')).toBeInTheDocument();
    // a6 was undone by a5, Sarah's.
    expect(within(rowOf('Hid a comment')).getByText('Undone · sarah')).toBeInTheDocument();
  });

  it('offers Undo only where the server does', async () => {
    const onUndo = vi.fn();
    draw(onUndo);
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(HISTORY_ROWS.filter((r) => r.undo.state === 'available').length);
    await userEvent.click(within(rowOf('Hid a report')).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith(HISTORY_ROWS[0]);
    expect(within(rowOf('Activated a body')).queryByRole('button')).toBeNull();
  });

  it('says who undid a row instead of offering Undo', () => {
    draw();
    expect(within(rowOf('Hid a comment')).getByText('Undone · Sarah')).toBeInTheDocument();
  });

  it('says a row was changed since, and takes the reader to the row that did', async () => {
    draw();
    const since = within(rowOf('Set the curated boost')).getByRole('button', {
      name: /Changed since: Renamed a body/,
    });
    const later = rowOf('Renamed a body');
    later.scrollIntoView = vi.fn();
    await userEvent.click(since);
    expect(later).toHaveFocus();
  });

  it('marks the row an undo wrote', () => {
    draw();
    expect(rowOf(/Restored a comment/)).toHaveTextContent('· an undo');
  });

  it('holds its place while loading, and counts an empty trail as 0', () => {
    const { rerender } = render(
      <HistoryPanelView rows={undefined} now={BOARD_NOW_NH} onUndo={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'History' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('list')).toBeNull();
    rerender(<HistoryPanelView rows={[]} now={BOARD_NOW_NH} onUndo={vi.fn()} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('HistoryPanel', () => {
  it('reads one target’s trail and undoes through the console’s undo', async () => {
    render(<HistoryPanel target={{ targetType: 'report', targetId: 'r1' }} limit={20} />);
    expect(mocks.args).toEqual({ targetType: 'report', targetId: 'r1', limit: 20 });
    await userEvent.click(within(rowOf('Hid a report')).getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith({
      actionId: HISTORY_ROWS[0]?.id,
      needsReason: false,
      what: 'Hid a report',
    });
  });

  it('asks the reason for an undo the server says takes something away', async () => {
    render(<HistoryPanel />);
    expect(mocks.args).toEqual({});
    await userEvent.click(within(rowOf('Restored a report')).getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(expect.objectContaining({ needsReason: true }));
  });
});
