import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/kit/button';

import { RecordRow, RecordRowQuote } from './record-row';

/** The record row (kit candidate): one button that opens the item, its own control beside it. */

const draw = (props: Partial<Parameters<typeof RecordRow>[0]> = {}) =>
  render(
    <ul>
      <RecordRow
        chips={[{ label: 'report' }, { label: 'hidden' }]}
        title="Thin by the inlet"
        lines={['Lake Morey · 4 Oct', 'Reason: “Second unsafe claim”']}
        {...props}
      />
    </ul>,
  );
const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

describe('RecordRow (kit candidate)', () => {
  it('is one button holding its chips, its words and its lines, in order, that opens on a press', async () => {
    const onClick = vi.fn();
    draw({ onClick, meta: '4 d' });
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('aria-current');
    expect([...button.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent)).toEqual([
      'report',
      'hidden',
    ]);
    expect(slot('record-row-meta')).toHaveTextContent('4 d');
    expect(slot('record-row-title')).toHaveTextContent('Thin by the inlet');
    const lines = [...button.querySelectorAll<HTMLElement>('[data-slot="record-row-line"]')];
    expect(lines.map((l) => l.textContent)).toEqual([
      'Lake Morey · 4 Oct',
      'Reason: “Second unsafe claim”',
    ]);
    // Positional: the place on the third grid row, the reason on the fourth.
    expect(lines.map((l) => l.style.gridRowStart)).toEqual(['3', '4']);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('says it is open, on the row and its button', () => {
    draw({ selected: true });
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
    expect(slot('record-row')).toHaveAttribute('data-selected');
    expect(screen.getByRole('button')).toHaveAttribute('data-selected');
  });

  it('lights a chip that is lit, and draws no chips or age it wasn’t given', () => {
    draw({ chips: [{ label: 'Restored · Ana', lit: true }] });
    expect(slot('badge')).toHaveAttribute('data-tone', 'lit');
    document.body.innerHTML = '';
    draw({ chips: [] });
    expect(slot('record-row-chips')).toBeNull();
    expect(slot('record-row-meta')).toBeNull();
  });

  it('puts its own control beside the button, never in it, and its lines stop short of it', () => {
    draw({ back: true, action: <Button size="xs">Undo</Button> });
    const undo = screen.getByRole('button', { name: 'Undo' });
    const row = slot('record-row-button') as HTMLElement;
    expect(row.contains(undo)).toBe(false);
    expect(slot('record-row-action')?.contains(undo)).toBe(true);
    expect(slot('record-row')).toHaveAttribute('data-back');
    for (const line of row.querySelectorAll('[data-slot="record-row-line"]')) {
      expect(line).toHaveClass('pe-[5rem]');
    }
    expect(slot('record-row-title')).toHaveClass('text-fg2');
  });

  it('reads words that are gone in italics, a tone down', () => {
    draw({ gone: true, title: 'The words were erased', lines: [] });
    expect(slot('record-row-title')).toHaveClass('italic', 'text-fg3');
    expect(slot('record-row-line')).toBeNull();
  });

  it('quotes a reason a tone up from its line', () => {
    render(<RecordRowQuote>Hostile tone</RecordRowQuote>);
    expect(slot('record-row-quote')).toHaveTextContent('“Hostile tone”');
    expect(within(document.body).getByText('“Hostile tone”')).toHaveClass('text-fg1');
  });
});
