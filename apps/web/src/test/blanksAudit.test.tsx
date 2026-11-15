import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoBlanks } from './blanksAudit';

/** The blanks audit fails where a missing value shows, and passes a page that says what it lacks. */

describe('expectNoBlanks', () => {
  it('passes a page that says what it lacks, with separators between words', () => {
    const { container } = render(
      <div>
        <div>
          <span data-slot="key">Last import</span>
          <span data-slot="value">Not recorded yet</span>
        </div>
        <p>Seeded · 2 Sep · Teagan</p>
        <p>
          <span>Live</span>
          <span aria-hidden="true">·</span>
          <span>checked 2 min ago</span>
        </p>
      </div>,
    );
    expect(() => expectNoBlanks(container)).not.toThrow();
  });

  it('finds a missing value’s word even where it sits flush against its label', () => {
    const { container } = render(
      <div>
        <span data-slot="key">Last import</span>
        <span data-slot="value">{String(undefined)}</span>
      </div>,
    );
    expect(container.textContent).toBe('Last importundefined');
    expect(() => expectNoBlanks(container)).toThrow('The page says “undefined”');
  });

  it.each(['null', 'NaN', 'Invalid Date'])('finds “%s”', (word) => {
    const { container } = render(<p>Depth {word}</p>);
    expect(() => expectNoBlanks(container)).toThrow(`The page says “${word}”`);
  });

  it('fails an empty labeled value, and an empty table cell', () => {
    const value = render(
      <div>
        <span data-slot="key">Rings</span>
        <span data-slot="value"> </span>
      </div>,
    );
    expect(() => expectNoBlanks(value.container)).toThrow('“Rings” has an empty value');
    const cell = render(
      <table>
        <tbody>
          <tr>
            <td>Cove</td>
            <td />
          </tr>
        </tbody>
      </table>,
    );
    expect(() => expectNoBlanks(cell.container)).toThrow('A table cell is empty in “Cove”');
  });

  it('passes an empty cell in a skeleton row, and a value drawn as an icon', () => {
    const { container } = render(
      <div>
        <span data-slot="value">
          <svg aria-hidden="true" />
        </span>
        <table>
          <tbody>
            <tr data-skeleton="">
              <td />
            </tr>
          </tbody>
        </table>
      </div>,
    );
    expect(() => expectNoBlanks(container)).not.toThrow();
  });

  it.each([
    ['at the start', <p key="s">· 2 Sep</p>],
    ['at the end', <p key="e">Seeded ·</p>],
    ['doubled', <p key="d">Seeded · · Teagan</p>],
    [
      'drawn as its own element, with nothing after it',
      <p key="o">
        <span>Live</span>
        <span aria-hidden="true">·</span>
        <span />
      </p>,
    ],
  ])('fails a dangling separator %s', (_n, line) => {
    const { container } = render(line);
    expect(() => expectNoBlanks(container)).toThrow('A dangling separator');
  });
});
