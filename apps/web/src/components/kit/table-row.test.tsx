import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Table, TableBody, TableCell, TableRow } from './table';

/**
 * A clickable row is a keyboard control: with a click and no focus plan of its caller's, it is a
 * Tab stop, ⏎ and Space press it, and ↑↓ Home End move between the clickable rows beside it. A
 * caller that plans focus itself (a `tabIndex`, its own keys) keeps it.
 */

function Rows({ onPick, plan }: { onPick: (id: string) => void; plan?: boolean }) {
  return (
    <Table>
      <TableBody>
        {['a', 'b', 'c'].map((id) => (
          <TableRow
            key={id}
            clickable
            data-id={id}
            onClick={() => onPick(id)}
            {...(plan && { tabIndex: -1 })}
          >
            <TableCell>
              Row {id}
              <a href={`#${id}`}>link {id}</a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`) as HTMLElement;

describe('TableRow, clickable', () => {
  it('is a Tab stop that ⏎ and Space press', () => {
    const onPick = vi.fn();
    render(<Rows onPick={onPick} />);
    expect(row('b')).toHaveAttribute('tabindex', '0');
    row('b').focus();
    fireEvent.keyDown(row('b'), { key: 'Enter' });
    fireEvent.keyDown(row('b'), { key: ' ' });
    expect(onPick.mock.calls).toEqual([['b'], ['b']]);
  });

  it('moves between its clickable siblings with ↑↓ Home End', () => {
    render(<Rows onPick={() => {}} />);
    row('a').focus();
    fireEvent.keyDown(row('a'), { key: 'ArrowDown' });
    expect(row('b')).toHaveFocus();
    fireEvent.keyDown(row('b'), { key: 'End' });
    expect(row('c')).toHaveFocus();
    fireEvent.keyDown(row('c'), { key: 'ArrowDown' });
    expect(row('c')).toHaveFocus();
    fireEvent.keyDown(row('c'), { key: 'Home' });
    expect(row('a')).toHaveFocus();
    fireEvent.keyDown(row('a'), { key: 'ArrowUp' });
    expect(row('a')).toHaveFocus();
  });

  it('leaves a key from a control in a cell to that control', () => {
    const onPick = vi.fn();
    render(<Rows onPick={onPick} />);
    const link = screen.getByText('link a');
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps a caller’s own focus plan: no Tab stop, no keys of its own', () => {
    const onPick = vi.fn();
    render(<Rows onPick={onPick} plan />);
    expect(row('a')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(row('a'), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a row that isn’t clickable takes no focus', () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-id="x">
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(row('x')).not.toHaveAttribute('tabindex');
  });
});
