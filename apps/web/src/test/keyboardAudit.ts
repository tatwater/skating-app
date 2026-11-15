import { fireEvent } from '@testing-library/react';

/**
 * **Everything that answers a click answers the keyboard.** Finds every element in `root` that
 * React gave an `onClick`, and holds each to the rule:
 *
 * - **native controls** (a button, a link with an href, a form control, a summary) are reached and
 *   pressed by the browser itself;
 * - **an option inside a listbox** (or a row inside a grid) that owns an active descendant is reached
 *   through its owner, which must take focus — only the items the owner's cursor walks, never any
 *   other element that happens to sit inside it;
 * - **a widget of the kit's primitives** (a switch, a tab, a radio, a slider's thumb — an ARIA widget
 *   role and a tab stop) is pressed by its library, which owns its keys; and a **label** (an element
 *   another names with `aria-labelledby`, or a `<label>`) only hands its click to its control;
 * - **anything else** — a hand-rolled `role="button"` or `role="link"` included — must be reached
 *   from the keyboard (a tab stop, or one of a roving set whose current stop is a sibling) and,
 *   focused, answer ⏎ and Space (a link: ⏎) by doing what its click does.
 *
 * Its click handler is found on React's own props record. **"Does what its click does" is proven
 * by the action running**, never by the key's default being prevented (a handler that only
 * prevents ⏎ and Space, or a no-op under an ancestor that prevents them, would pass that and do
 * nothing): the element's own click handler is wrapped for the press, and the key must run it — or,
 * where a control's key runs its action without a click (its own key handler calling it straight),
 * the effect the calling test names (`ran`: how many times the element's action has run, read
 * before and after the key) must move.
 * Returns the elements it checked, so a test can say it checked something.
 */
export function expectKeyboardOperable(
  root: HTMLElement,
  {
    ran,
  }: {
    /**
     * How many times `el`'s action has run so far (a mock's call count, a state the click sets), or
     * `undefined` for an element the test names no effect for (then its click handler must run).
     */
    ran?: (el: HTMLElement) => number | undefined;
  } = {},
): HTMLElement[] {
  const checked: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const props = reactProps(el);
    if (typeof props?.onClick !== 'function') continue;
    checked.push(el);
    if (isNativeControl(el) || isLabel(el, root)) continue;
    const role = el.getAttribute('role') ?? '';
    if (CURSOR_ITEMS.has(role)) {
      const owner = el.parentElement?.closest<HTMLElement>(
        '[aria-activedescendant],[role="listbox"],[role="grid"],[role="treegrid"],[role="tree"]',
      );
      if (owner != null) {
        if (owner.tabIndex < 0) throw new Error(`${nameOf(el)}: its owner takes no focus`);
        continue;
      }
    }
    if (LIBRARY_WIDGETS.has(role)) {
      if (!el.hasAttribute('tabindex')) {
        throw new Error(`${nameOf(el)}: a widget with no tab stop`);
      }
      continue;
    }
    if (!reachable(el)) {
      throw new Error(`${nameOf(el)} answers a click but takes no focus`);
    }
    for (const key of role === 'link' ? ['Enter'] : ['Enter', ' ']) {
      if (!pressRuns(el, key, ran)) {
        throw new Error(
          `${nameOf(el)} answers a click but ${key === ' ' ? 'Space' : key} doesn’t run its action`,
        );
      }
    }
  }
  return checked;
}

/**
 * Does `key`, pressed on the focused `el`, run its action? Its click handler is wrapped on React's
 * props record for the press (React reads that record when it dispatches, so a click the key causes
 * runs the wrapper); the test's own effect, when it names one, counts too.
 */
function pressRuns(
  el: HTMLElement,
  key: string,
  ran: ((el: HTMLElement) => number | undefined) | undefined,
): boolean {
  // React freezes a props record, so each event gets a copy with the click wrapped, put where React
  // reads it; the record goes back after, unless a render during the event already replaced it. The
  // wrap is put in place per event, not once for the press: a render flushed after ⏎/Space goes down
  // (a pressed face) replaces the record, and a click the key's release causes must still count.
  const node = el as unknown as Record<string, Record<string, unknown>>;
  const slot = Object.keys(el).find((k) => k.startsWith('__reactProps$')) as string;
  let clicked = 0;
  const wrappedFor = (fire: () => void) => {
    const record = node[slot];
    const original = record?.onClick;
    if (record === undefined || typeof original !== 'function') {
      fire();
      return;
    }
    const wrapped = {
      ...record,
      onClick: (...args: unknown[]) => {
        clicked++;
        return original(...args);
      },
    };
    node[slot] = wrapped;
    try {
      fire();
    } finally {
      if (node[slot] === wrapped) node[slot] = record;
    }
  };
  const before = ran?.(el);
  el.focus();
  wrappedFor(() => fireEvent.keyDown(el, { key }));
  wrappedFor(() => fireEvent.keyUp(el, { key }));
  const after = ran?.(el);
  return clicked > 0 || (before !== undefined && after !== undefined && after > before);
}

/** React's props record on a DOM node (`__reactProps$…`), which its event system reads. */
function reactProps(el: Element): Record<string, unknown> | undefined {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return key === undefined
    ? undefined
    : (el as unknown as Record<string, Record<string, unknown>>)[key];
}

/** The items an owner's cursor walks (`aria-activedescendant`): its own keys press them. */
const CURSOR_ITEMS = new Set(['option', 'row', 'gridcell', 'treeitem']);

/**
 * Roles the kit's primitives give the elements they draw, with their keys: a hand-rolled
 * `button` or `link` role is not one of them — nothing presses it but its own handler.
 */
const LIBRARY_WIDGETS = new Set([
  'checkbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'slider',
  'switch',
  'tab',
]);

/** A tab stop, or a roving stop at -1 beside a sibling that holds the set's one tab stop. */
function reachable(el: HTMLElement): boolean {
  if (!el.hasAttribute('tabindex')) return false;
  if (el.tabIndex >= 0) return true;
  const siblings = el.parentElement?.children ?? [];
  return [...siblings].some(
    (s) => s !== el && s.tagName === el.tagName && s.getAttribute('tabindex') === '0',
  );
}

function isLabel(el: HTMLElement, root: HTMLElement): boolean {
  if (el.tagName === 'LABEL') return true;
  return el.id !== '' && root.querySelector(`[aria-labelledby~="${CSS.escape(el.id)}"]`) !== null;
}

function isNativeControl(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement) return true;
  if (el instanceof HTMLAnchorElement) return el.hasAttribute('href');
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  return el.tagName === 'SUMMARY';
}

function nameOf(el: HTMLElement): string {
  const slot = el.getAttribute('data-slot');
  const text = (el.textContent ?? '').trim().slice(0, 40);
  return `<${el.tagName.toLowerCase()}${slot ? ` data-slot="${slot}"` : ''}> “${text}”`;
}
