// biome-ignore-all lint/a11y: the audit's own test draws the very markup the audit exists to catch
import { render } from '@testing-library/react';
import { type KeyboardEvent, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { expectKeyboardOperable } from './keyboardAudit';

/**
 * The audit holds the line only if it fails where the line is crossed: each way an element can
 * answer a click and not the keyboard is caught, and each way of answering it passes.
 */

const press = (e: KeyboardEvent<HTMLElement>) => {
  if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
};

describe('expectKeyboardOperable', () => {
  it('passes native controls, labels, an owned option and a pressable element', () => {
    const { container } = render(
      <div>
        <button type="button" onClick={() => {}}>
          Go
        </button>
        <a href="#x" onClick={() => {}}>
          Link
        </a>
        <label onClick={() => {}}>Name</label>
        <div role="listbox" tabIndex={0} aria-label="List">
          <div role="option" aria-selected={false} onClick={() => {}}>
            One
          </div>
        </div>
        <div role="button" tabIndex={0} onClick={() => {}} onKeyDown={press}>
          Custom
        </div>
        <span role="link" tabIndex={0} onClick={() => {}} onKeyDown={press}>
          Custom link
        </span>
      </div>,
    );
    expect(expectKeyboardOperable(container)).toHaveLength(6);
  });

  it('passes an element whose own handler takes ⏎ and Space (their default prevented)', () => {
    const take = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    const { container } = render(
      <div role="group" tabIndex={0} onClick={() => {}} onKeyDown={take}>
        Taken
      </div>,
    );
    expect(expectKeyboardOperable(container)).toHaveLength(1);
  });

  it('never counts a key a container took as the element’s own', () => {
    const take = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    const { container } = render(
      <div onKeyDown={take}>
        <div tabIndex={0} onClick={() => {}}>
          Mute
        </div>
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('not Enter');
  });

  it('fails an element that takes no focus', () => {
    const { container } = render(<div onClick={() => {}}>Bare</div>);
    expect(() => expectKeyboardOperable(container)).toThrow('answers a click but takes no focus');
  });

  it('fails a focusable element that answers neither ⏎ nor Space', () => {
    const { container } = render(
      <div tabIndex={0} onClick={() => {}}>
        Mute
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('not Enter');
  });

  it('fails a hand-rolled role="button" that answers no key, as it would any element', () => {
    const { container } = render(
      <div role="button" tabIndex={0} onClick={() => {}}>
        Custom
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('not Enter');
  });

  it('fails an element that answers ⏎ but not Space', () => {
    const enterOnly = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter') e.currentTarget.click();
    };
    const { container } = render(
      <div tabIndex={0} onClick={() => {}} onKeyDown={enterOnly}>
        Half
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('not Space');
  });

  it('fails an element no Tab reaches: tabindex -1 with no roving stop beside it', () => {
    const { container } = render(
      <div tabIndex={-1} onClick={() => {}} onKeyDown={press}>
        Hidden stop
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('takes no focus');
  });

  it('passes a roving set: one stop at 0, the rest at -1', () => {
    const { container } = render(
      <ul>
        {['a', 'b'].map((id, i) => (
          <li key={id} tabIndex={i === 0 ? 0 : -1} onClick={() => {}} onKeyDown={press}>
            {id}
          </li>
        ))}
      </ul>,
    );
    expect(expectKeyboardOperable(container)).toHaveLength(2);
  });

  it('fails an owner that takes no focus', () => {
    const { container } = render(
      <div role="listbox" aria-label="List">
        <div role="option" aria-selected={false} onClick={() => {}}>
          One
        </div>
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('its owner takes no focus');
  });

  it('never lets a clickable element inside a focusable grid pass as the grid’s own', () => {
    const { container } = render(
      <div role="grid" tabIndex={0} aria-label="Grid">
        <div role="row">
          <div role="gridcell">
            <span onClick={() => {}}>Inner</span>
          </div>
        </div>
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('takes no focus');
  });

  it('fails a widget role with no tab stop', () => {
    const { container } = render(
      <div role="switch" aria-checked={false} onClick={() => {}}>
        Toggle
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('a widget with no tab stop');
  });

  it('skips an element an earlier press took out of the page (React drops its props record)', () => {
    function Vanishing() {
      const [shown, setShown] = useState(true);
      return (
        <div>
          <div tabIndex={0} onClick={() => setShown(false)} onKeyDown={press}>
            Hide the next
          </div>
          {shown && <div onClick={() => {}}>Gone before it is checked</div>}
        </div>
      );
    }
    const { container } = render(<Vanishing />);
    expect(expectKeyboardOperable(container)).toHaveLength(1);
  });
});
