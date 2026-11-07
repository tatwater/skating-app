import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  assertBindable,
  focusOwnsPrintableKeys,
  type GlobalKey,
  type GoLetter,
  isTextEntry,
  KEYS_PASS_THROUGH,
  KeyBindingError,
  KeysProvider,
  modKey,
  type PaneKey,
  useGlobalKey,
  useGoMode,
  useGoTarget,
  usePaneKeys,
} from './keys';

// The behavior in a real layout engine (focus, composites, go-mode over a list) is the Storybook
// suite's: `components/kit/hotkeys.stories.tsx`. This file pins the rules and the fence.

const SCOPES = ['pane', 'global', 'go'] as const;

describe('the keys nothing may bind', () => {
  const refused = [
    'J',
    'K',
    'j',
    'k',
    'Shift+J',
    'Shift+K',
    'Mod+J',
    'Alt+K',
    '0',
    '1',
    '9',
    'Numpad1',
    'Numpad0',
    'Shift+1',
    'Mod+1',
    'Control+Alt+5',
  ];
  for (const scope of SCOPES) {
    for (const key of refused) {
      it(`refuses ${key} as a ${scope} key`, () => {
        expect(() => assertBindable(key, scope)).toThrow(KeyBindingError);
      });
    }
  }

  it('says why, in words the builder can act on', () => {
    expect(() => assertBindable('J', 'pane')).toThrow(/J and K never move a list/);
    expect(() => assertBindable('3', 'pane')).toThrow(/number keys are never bound/);
  });

  it('refuses something that is only modifiers', () => {
    expect(() => assertBindable('Shift', 'pane')).toThrow(/only modifiers/);
  });

  it('refuses something that is not a key at all', () => {
    expect(() => assertBindable('', 'pane')).toThrow(/not a key/);
  });
});

describe('pane keys', () => {
  it.each<PaneKey>(['R', 'H', 'Shift+D', 'Enter', 'Shift+Enter', 'Mod+Enter', 'Escape', 'Delete'])(
    'allows %s',
    (key) => {
      expect(() => assertBindable(key, 'pane')).not.toThrow();
    },
  );

  it.each([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Tab',
  ])('leaves %s to the pane’s own list or control', (key) => {
    expect(() => assertBindable(key, 'pane')).toThrow(/belong to the pane/);
  });

  it('keeps G for go-mode', () => {
    expect(() => assertBindable('G', 'pane')).toThrow(/G starts go-mode/);
  });

  it('keeps ? for the key sheet', () => {
    expect(() => assertBindable('?', 'pane')).toThrow(/opens the key sheet/);
    expect(() => assertBindable('Shift+/', 'pane')).toThrow(/opens the key sheet/);
  });
});

describe('global keys', () => {
  it.each<GlobalKey>(['Mod+K', '?'])('allows %s', (key) => {
    expect(() => assertBindable(key, 'global')).not.toThrow();
  });

  it.each(['R', 'Shift+R', 'Escape', 'Enter', 'Mod+S', 'G'])('refuses %s anywhere', (key) => {
    expect(() => assertBindable(key, 'global')).toThrow(/only ⌘K and \?/);
  });
});

describe('go keys', () => {
  it.each<GoLetter>(['A', 'I', 'B', 'R'])('allows G then %s', (key) => {
    expect(() => assertBindable(key, 'go')).not.toThrow();
  });

  it.each(['Shift+I', 'Enter', '?', 'Escape'])('refuses %s as a go key', (key) => {
    expect(() => assertBindable(key, 'go')).toThrow(/one plain letter/);
  });

  it('refuses G G', () => {
    expect(() => assertBindable('G', 'go')).toThrow(/G starts go-mode/);
  });
});

describe('the hooks refuse at render', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <KeysProvider>{children}</KeysProvider>
  );
  // A refused key fails the render; React logs the thrown error, which is the point.
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('usePaneKeys throws on J', () => {
    const spy = quiet();
    expect(() =>
      renderHook(
        () => {
          const ref = useRef<HTMLElement>(null);
          usePaneKeys(ref, [{ key: 'J' as PaneKey, run: () => {} }]);
        },
        { wrapper },
      ),
    ).toThrow(KeyBindingError);
    spy.mockRestore();
  });

  it('usePaneKeys throws on a digit', () => {
    const spy = quiet();
    expect(() =>
      renderHook(
        () => {
          const ref = useRef<HTMLElement>(null);
          usePaneKeys(ref, [{ key: '2' as PaneKey, run: () => {} }]);
        },
        { wrapper },
      ),
    ).toThrow(/number keys/);
    spy.mockRestore();
  });

  it('useGlobalKey throws on a plain letter', () => {
    const spy = quiet();
    expect(() => renderHook(() => useGlobalKey('R' as GlobalKey, () => {}), { wrapper })).toThrow(
      KeyBindingError,
    );
    spy.mockRestore();
  });

  it('useGoTarget throws on K', () => {
    const spy = quiet();
    expect(() =>
      renderHook(() => useGoTarget({ key: 'K' as GoLetter, label: 'Nowhere', run: () => {} }), {
        wrapper,
      }),
    ).toThrow(KeyBindingError);
    spy.mockRestore();
  });

  it('useGoTarget needs a KeysProvider', () => {
    const spy = quiet();
    expect(() =>
      renderHook(() => useGoTarget({ key: 'I', label: 'Inbox', run: () => {} })),
    ).toThrow(/KeysProvider/);
    spy.mockRestore();
  });

  it('useGoMode outside a provider is simply closed', () => {
    const { result } = renderHook(() => useGoMode());
    expect(result.current.active).toBe(false);
    expect(result.current.targets).toEqual([]);
    // Inert, not throwing: a static board draws the go bar without a provider.
    result.current.open();
    result.current.cancel();
  });
});

/** The element, or a failed test that says it's missing. */
function must<T>(el: T | null | undefined): T {
  if (el == null) throw new Error('The fixture did not render the element under test.');
  return el;
}

describe('which focus owns a printable key', () => {
  function mount(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body;
  }

  it('a text field owns it; a checkbox or button does not', () => {
    mount(
      '<input id="t" type="text"><input id="c" type="checkbox"><button id="b">B</button>' +
        '<textarea id="a"></textarea><select id="s"><option>x</option></select>' +
        '<div id="e" contenteditable="true"></div><div id="r" role="searchbox" tabindex="0"></div>',
    );
    const at = (id: string) => document.getElementById(id);
    expect(isTextEntry(at('t'))).toBe(true);
    expect(isTextEntry(at('a'))).toBe(true);
    expect(isTextEntry(at('s'))).toBe(true);
    expect(isTextEntry(at('r'))).toBe(true);
    expect(isTextEntry(at('c'))).toBe(false);
    expect(isTextEntry(at('b'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    // jsdom doesn't compute isContentEditable; set it as a browser would for this element.
    const editable = must(at('e'));
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTextEntry(editable)).toBe(true);
  });

  it('nothing focused owns nothing', () => {
    mount('<p>quiet</p>');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(focusOwnsPrintableKeys()).toBe(false);
  });

  it('a typing composite owns it, unless it lets G and ? through', () => {
    mount(
      `<div role="listbox" tabindex="0" id="sel"></div>` +
        `<div role="listbox" tabindex="0" id="mid" ${KEYS_PASS_THROUGH}=""></div>` +
        `<div role="menu"><div role="menuitem" tabindex="0" id="item">x</div></div>` +
        `<input id="field">`,
    );
    const focus = (id: string) => document.getElementById(id)?.focus();
    focus('sel');
    expect(focusOwnsPrintableKeys()).toBe(true);
    focus('mid');
    expect(focusOwnsPrintableKeys()).toBe(false);
    focus('item');
    expect(focusOwnsPrintableKeys()).toBe(true);
    focus('field');
    expect(focusOwnsPrintableKeys()).toBe(true);
  });
});

describe('platform', () => {
  it('names the modifier Mod means here', () => {
    expect(['Meta', 'Control']).toContain(modKey());
  });
});

describe('the layer, end to end (jsdom)', () => {
  function Console({ onResolve, onGo }: { onResolve: () => void; onGo: (to: string) => void }) {
    const pane = useRef<HTMLElement>(null);
    usePaneKeys(pane, [
      { key: 'R', run: onResolve, label: 'Resolve' },
      // Unlabeled, and off: listed, but inert.
      { key: 'H', run: onResolve, enabled: false },
    ]);
    useGoTarget({ key: 'I', label: 'Inbox', run: () => onGo('inbox') });
    const go = useGoMode();
    return (
      <>
        <button type="button">Outside</button>
        <section ref={pane} aria-label="Detail">
          <button type="button">In the pane</button>
          <input aria-label="Note" />
        </section>
        <output aria-label="Go">{go.active ? 'open' : 'closed'}</output>
      </>
    );
  }

  function Harness() {
    const [log, setLog] = useState<string[]>([]);
    return (
      <KeysProvider>
        <Console
          onResolve={() => setLog((l) => [...l, 'resolve'])}
          onGo={(to) => setLog((l) => [...l, `go:${to}`])}
        />
        <output aria-label="Log">{log.join(',')}</output>
      </KeysProvider>
    );
  }

  it('a pane letter fires only with focus in the pane, and never in its text field', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const log = screen.getByLabelText('Log');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await user.keyboard('r');
    expect(log).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: 'In the pane' }));
    await user.keyboard('r');
    expect(log).toHaveTextContent('resolve');
    await user.keyboard('h');
    expect(log).toHaveTextContent(/^resolve$/);
    await user.click(screen.getByLabelText('Note'));
    await user.keyboard('r');
    expect(log).toHaveTextContent(/^resolve$/);
    expect(screen.getByLabelText('Note')).toHaveValue('r');
  });

  it('G then a letter goes; Esc and a stray key leave', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const log = screen.getByLabelText('Log');
    const go = screen.getByLabelText('Go');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await user.keyboard('g');
    expect(go).toHaveTextContent('open');
    await user.keyboard('i');
    expect(go).toHaveTextContent('closed');
    expect(log).toHaveTextContent('go:inbox');
    await user.keyboard('g');
    await user.keyboard('{Escape}');
    expect(go).toHaveTextContent('closed');
    await user.keyboard('g');
    await user.keyboard('x');
    expect(go).toHaveTextContent('closed');
    // While open, a pane letter is go-mode's, not the pane's.
    await user.click(screen.getByRole('button', { name: 'In the pane' }));
    await user.keyboard('g');
    await user.keyboard('r');
    expect(log).toHaveTextContent(/^go:inbox$/);
    // A press anywhere leaves too.
    await user.keyboard('g');
    expect(go).toHaveTextContent('open');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(go).toHaveTextContent('closed');
    // So does the window losing focus.
    await user.keyboard('g');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(go).toHaveTextContent('closed');
  });

  it('go-mode holds through a modifier or a held key, and a shortcut leaves it unswallowed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const go = screen.getByLabelText('Go');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await user.keyboard('g');
    // A modifier alone, or a key's auto-repeat, doesn't leave.
    await user.keyboard('{Shift}');
    expect(go).toHaveTextContent('open');
    const repeat = new KeyboardEvent('keydown', { key: 'x', repeat: true, bubbles: true });
    act(() => {
      document.activeElement?.dispatchEvent(repeat);
    });
    expect(go).toHaveTextContent('open');
    expect(repeat.defaultPrevented).toBe(false);
    // A shortcut (Ctrl+X) leaves go-mode and goes on to whoever wants it.
    const cut = new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true });
    act(() => {
      document.activeElement?.dispatchEvent(cut);
    });
    expect(go).toHaveTextContent('closed');
    expect(cut.defaultPrevented).toBe(false);
  });

  it('one place per go letter: the first keeps it, and the second is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const went: string[] = [];
    function Twice() {
      useGoTarget({ key: 'I', label: 'Inbox', run: () => went.push('inbox') });
      useGoTarget({ key: 'I', label: 'Imagery', run: () => went.push('imagery') });
      return <button type="button">Here</button>;
    }
    const user = userEvent.setup();
    render(
      <KeysProvider>
        <Twice />
      </KeysProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Here' }));
    await user.keyboard('gi');
    expect(went).toEqual(['inbox']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Imagery is not reachable/));
    warn.mockRestore();
  });

  it('G types in a text field instead of opening go-mode', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('Note'));
    await user.keyboard('g');
    expect(screen.getByLabelText('Go')).toHaveTextContent('closed');
    expect(screen.getByLabelText('Note')).toHaveValue('g');
  });
});

describe('the fence: nothing else imports the hotkeys library', () => {
  it('only lib/keys.ts names @tanstack/react-hotkeys or @tanstack/hotkeys', () => {
    // The package root is the runner's cwd (the Start plugin rewrites import.meta.url in tests).
    const src = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx|mts|cts|js|jsx|mdx)$/.test(name)) continue;
        const rel = relative(src, path);
        if (rel === join('lib', 'keys.ts') || rel === join('lib', 'keys.test.tsx')) continue;
        if (/['"]@tanstack\/(react-)?hotkeys['"/]/.test(readFileSync(path, 'utf8'))) {
          offenders.push(rel);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
