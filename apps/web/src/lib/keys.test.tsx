import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasonAsk } from '@/components/admin/body/tabs/access/ReasonAsk';
import { AskDialog } from '@/components/admin/people/person/AskDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/kit/popover';
import { Sheet, SheetContent, SheetTitle } from '@/components/kit/sheet';

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
  releaseHeldKeys,
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

describe('a held key', () => {
  /** A key held down: its press, the browser's key-repeat presses, then its release. */
  function hold(target: Element, init: KeyboardEventInit, repeats: number) {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
      for (let i = 0; i < repeats; i++) {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { ...init, repeat: true, bubbles: true }),
        );
      }
      target.dispatchEvent(new KeyboardEvent('keyup', { ...init, bubbles: true }));
    });
  }

  function Pane({
    onAct,
    onBack,
    onPalette,
  }: {
    onAct: () => void;
    onBack: () => void;
    onPalette: () => void;
  }) {
    const pane = useRef<HTMLElement>(null);
    const [at, setAt] = useState(0);
    usePaneKeys(pane, [
      { key: 'H', run: onAct, label: 'Hide' },
      { key: 'Shift+Enter', run: onBack, label: 'Back' },
    ]);
    useGlobalKey('Mod+K', onPalette);
    const rows = ['Mascoma', 'Crystal', 'Morey', 'Sunapee', 'Newfound'];
    return (
      <section ref={pane} aria-label="Detail">
        <button type="button">Hide</button>
        {/* A list's own ↑↓ (its roving cursor), as the kit's lists keep them. */}
        <div
          role="listbox"
          tabIndex={0}
          aria-label="Bodies"
          aria-activedescendant={`row-${at}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setAt((n) => Math.min(n + 1, rows.length - 1));
          }}
        >
          {rows.map((r, i) => (
            <div key={r} id={`row-${i}`} role="option" tabIndex={-1} aria-selected={i === at}>
              {r}
            </div>
          ))}
        </div>
      </section>
    );
  }

  function setup() {
    const calls = { act: 0, back: 0, palette: 0 };
    render(
      <KeysProvider>
        <Pane
          onAct={() => calls.act++}
          onBack={() => calls.back++}
          onPalette={() => calls.palette++}
        />
      </KeysProvider>,
    );
    const list = screen.getByRole('listbox', { name: 'Bodies' });
    act(() => list.focus());
    return { calls, list };
  }

  it('an action letter acts once however long it is held, and again on the next press', () => {
    const { calls } = setup();
    // (On a button in the pane: a listbox keeps printable keys for its own type-ahead.)
    const button = screen.getByRole('button', { name: 'Hide' });
    act(() => button.focus());
    hold(button, { key: 'h', code: 'KeyH' }, 6);
    expect(calls.act).toBe(1);
    hold(button, { key: 'h', code: 'KeyH' }, 6);
    expect(calls.act).toBe(2);
  });

  it('⏎ as an action and ⌘K act once per press too', () => {
    const { calls, list } = setup();
    hold(list, { key: 'Enter', code: 'Enter', shiftKey: true }, 5);
    expect(calls.back).toBe(1);
    const mod = modKey() === 'Meta' ? { metaKey: true } : { ctrlKey: true };
    hold(list, { key: 'k', code: 'KeyK', ...mod }, 5);
    expect(calls.palette).toBe(1);
  });

  it('a held ↓ still walks the list, a row per repeat', () => {
    const { list } = setup();
    hold(list, { key: 'ArrowDown', code: 'ArrowDown' }, 3);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Newfound');
  });
});

describe('a held key does not type into what it opened', () => {
  /** A key pressed (fresh): its keydown at whatever has focus. */
  const press = (init: KeyboardEventInit) =>
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
      );
    });
  /** Its key-repeat keydowns, at whatever has focus by then; each, whether it was swallowed. */
  const repeat = (init: KeyboardEventInit, n = 4) =>
    Array.from({ length: n }, () => {
      const e = new KeyboardEvent('keydown', {
        ...init,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        (document.activeElement ?? document.body).dispatchEvent(e);
      });
      return e.defaultPrevented;
    });
  const release = (init: KeyboardEventInit) =>
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keyup', { ...init, bubbles: true }),
      );
    });

  type Dialog = 'field' | 'reason-ask' | 'ask-dialog' | 'popover' | 'sheet';
  function Opener({ dialog, typed }: { dialog: Dialog; typed: (key: string) => void }) {
    const pane = useRef<HTMLElement>(null);
    const [open, setOpen] = useState(false);
    usePaneKeys(pane, [
      { key: 'D', run: () => setOpen(true), label: 'Dismiss' },
      { key: 'Shift+Enter', run: () => typed('back'), label: 'Back' },
    ]);
    return (
      <section ref={pane} aria-label="Detail">
        <button type="button">Dismiss</button>
        {open && dialog === 'field' && (
          // biome-ignore lint/a11y/noAutofocus: a dialog's field takes focus as it opens
          <input aria-label="Reason" autoFocus onKeyDown={(e) => typed(e.key)} />
        )}
        {dialog === 'reason-ask' && (
          <ReasonAsk
            open={open}
            onOpenChange={setOpen}
            title="Dismiss the flag"
            confirm="Dismiss"
            optional
            maxLength={500}
            onConfirm={async () => true}
          />
        )}
        {dialog === 'popover' && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger render={<button type="button" />}>Filter</PopoverTrigger>
            <PopoverContent>
              {/* biome-ignore lint/a11y/noAutofocus: the popover's field takes focus as it opens */}
              <input aria-label="Body" autoFocus />
            </PopoverContent>
          </Popover>
        )}
        {dialog === 'sheet' && (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent>
              <SheetTitle>Reports around it</SheetTitle>
              {/* biome-ignore lint/a11y/noAutofocus: the sheet's field takes focus as it opens */}
              <input aria-label="Note" autoFocus />
            </SheetContent>
          </Sheet>
        )}
        {dialog === 'ask-dialog' && (
          <AskDialog
            open={open}
            onOpenChange={setOpen}
            title="Dismiss the flag"
            description="The flag closes."
            confirm="Dismiss"
            reason="optional"
            onConfirm={async () => 'done' as never}
          />
        )}
      </section>
    );
  }

  function setup(dialog: Dialog) {
    const typed: string[] = [];
    render(
      <KeysProvider>
        <Opener dialog={dialog} typed={(k) => typed.push(k)} />
      </KeysProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    return typed;
  }
  const D = { key: 'd', code: 'KeyD' };

  afterEach(() => releaseHeldKeys());

  it('held D opens the reason once; its repeats never reach the field, and are kept from typing', () => {
    const typed = setup('field');
    press(D);
    const field = screen.getByRole('textbox', { name: 'Reason' });
    expect(field).toHaveFocus();
    expect(repeat(D)).toEqual([true, true, true, true]);
    expect(typed).toEqual([]);
    expect(field).toHaveValue('');
  });

  it('released, the same letter typed into the field types', async () => {
    setup('field');
    press(D);
    repeat(D);
    release(D);
    // Let go: nothing of the hold is left listening.
    expect(repeat(D, 1)).toEqual([false]);
    await userEvent.keyboard('d');
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('d');
  });

  it.each([
    ['ReasonAsk', 'reason-ask'],
    ['AskDialog', 'ask-dialog'],
    ['the kit popover', 'popover'],
    ['the kit sheet', 'sheet'],
  ] as const)(
    '%s: the held key’s repeats are swallowed in the field it focuses',
    async (_, dialog) => {
      setup(dialog);
      press(D);
      const field = await screen.findByRole('textbox');
      await waitFor(() => expect(field).toHaveFocus());
      expect(repeat(D)).toEqual([true, true, true, true]);
      release(D);
      await userEvent.keyboard('d');
      expect(field).toHaveValue('d');
    },
  );

  it('a fresh press ends a hold whose release was missed', () => {
    setup('field');
    press(D);
    // No keyup came (the window lost it): the next press is fresh, and is let through.
    const fresh = new KeyboardEvent('keydown', { ...D, bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole('textbox', { name: 'Reason' }).dispatchEvent(fresh);
    });
    expect(repeat(D, 1)).toEqual([false]);
  });

  it('leaves an IME composition, other keys and a held modifier alone; a held ⇧⏎ acts once', () => {
    const typed = setup('field');
    press(D);
    expect(repeat({ ...D, isComposing: true }, 2)).toEqual([false, false]);
    expect(repeat({ key: 'e', code: 'KeyE' }, 1)).toEqual([false]);
    release(D);
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    const enter = { key: 'Enter', code: 'Enter', shiftKey: true };
    press(enter);
    expect(repeat(enter)).toEqual([true, true, true, true]);
    // ⇧ itself, held through the chord, repeats as it would.
    expect(repeat({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, 2)).toEqual([false, false]);
    release(enter);
    expect(typed.filter((t) => t === 'back')).toEqual(['back']);
  });

  it('a window blur lets go of a hold', () => {
    setup('field');
    press(D);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(repeat(D, 1)).toEqual([false]);
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
