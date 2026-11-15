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

  it('fails an element whose key handler only prevents ⏎ and Space — nothing runs', () => {
    const take = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    const { container } = render(
      <div role="group" tabIndex={0} onClick={() => {}} onKeyDown={take}>
        Taken
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
  });

  it('fails an element whose key handler is a no-op', () => {
    const { container } = render(
      <div role="button" tabIndex={0} onClick={() => {}} onKeyDown={() => {}}>
        Dead
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
  });

  it('fails a no-op key handler under an ancestor that prevents the keys', () => {
    const take = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    const { container } = render(
      <div onKeyDown={take}>
        <div role="button" tabIndex={0} onClick={() => {}} onKeyDown={() => {}}>
          Dead
        </div>
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
  });

  it('passes a control that wears a pressed face on ⏎/Space down and clicks on their release', () => {
    // The key going down renders (a new props record) before the release clicks: the click still
    // counts as the action running.
    function PressedFace() {
      const [down, setDown] = useState(false);
      const keys = (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setDown(true);
        }
      };
      const release = (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          setDown(false);
          e.currentTarget.click();
        }
      };
      return (
        <div
          role="button"
          tabIndex={0}
          data-down={down ? '' : undefined}
          onClick={() => {}}
          onKeyDown={keys}
          onKeyUp={release}
        >
          Released
        </div>
      );
    }
    const { container } = render(<PressedFace />);
    expect(expectKeyboardOperable(container)).toHaveLength(1);
  });

  it('passes a key that runs the action without a click, when the test names its effect', () => {
    let opened = 0;
    const open = () => {
      opened++;
    };
    const keys = (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    };
    const { container } = render(
      <div role="button" tabIndex={0} onClick={open} onKeyDown={keys}>
        Straight
      </div>,
    );
    // Unnamed, the audit can't see the effect, and says so.
    expect(() => expectKeyboardOperable(container)).toThrow('doesn’t run its action');
    expect(expectKeyboardOperable(container, { ran: () => opened })).toHaveLength(1);
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
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
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
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
  });

  it('fails a hand-rolled role="button" that answers no key, as it would any element', () => {
    const { container } = render(
      <div role="button" tabIndex={0} onClick={() => {}}>
        Custom
      </div>,
    );
    expect(() => expectKeyboardOperable(container)).toThrow('Enter doesn’t run its action');
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
    expect(() => expectKeyboardOperable(container)).toThrow('Space doesn’t run its action');
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
