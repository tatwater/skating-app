import {
  detectPlatform,
  HotkeysProvider,
  type HotkeysProviderProps,
  hasNonModifierKey,
  parseHotkey,
  type UseHotkeyDefinition,
  useHotkey,
  useHotkeys,
  validateHotkey,
} from '@tanstack/react-hotkeys';
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * The console's keyboard layer — the **one** module that imports `@tanstack/react-hotkeys`. The
 * library is a beta, pinned to an exact version; everything else (the shell, panes, the kit's
 * `GoBar`) talks to this file, so swapping it for the named fallback (`tinykeys`) touches nothing
 * else. `keys.test.ts` fails if any other file imports the package.
 *
 * The founder's rules, as the API enforces them:
 *
 * - **Tab between panes, ↑↓ within one, typing jumps.** Those are the panes' and composites' own
 *   keys (a list's roving cursor, a Select's popup), never bindings here — the API refuses arrows,
 *   Tab, Home/End and Page keys.
 * - **Letters act only in the focused pane.** `usePaneKeys` binds to a pane's element: a key fires
 *   only while focus is inside that pane, and never while focus is in a text field or a control
 *   that uses the key itself (a list's type-ahead, a menu, a button's Enter).
 * - **⌘K and `?` work anywhere** (`useGlobalKey`); nothing else is global.
 * - **`G` then a letter goes anywhere** (`useGoTarget`, `useGoMode`): `G` opens go-mode, the next
 *   letter goes there, Esc or any other key leaves. It is the only sequence.
 * - **No J/K, no number keys** — not in a pane, not globally, not as a go letter, with any
 *   modifier. Registering one throws, at render, so it can't ship.
 */

// ── What may be bound ──────────────────────────────────────────────────────────────────────────

type Letter =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z';

/** A letter a pane or go-mode may use: never J or K, and never G (go-mode's own key). */
export type BindableLetter = Exclude<Letter, 'G' | 'J' | 'K'>;

/** A key a pane may bind. Letters act only while that pane has focus. */
export type PaneKey =
  | BindableLetter
  | `Shift+${BindableLetter}`
  | 'Enter'
  | 'Shift+Enter'
  | 'Mod+Enter'
  | 'Escape'
  | 'Delete'
  | 'Backspace';

/** The only keys that work from anywhere. */
export type GlobalKey = 'Mod+K' | '?';

/** Go-mode's second key. */
export type GoLetter = BindableLetter;

/** A binding the keyboard rules don't allow. Thrown at registration, so it fails in a test. */
export class KeyBindingError extends Error {
  override name = 'KeyBindingError';
}

/** Keys that belong to focus movement and composites, never to a binding. */
const COMPOSITE_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab',
]);

const DIGIT = /^(?:Numpad)?[0-9]$/;
const LETTER = /^[A-Z]$/;
const GLOBAL_KEYS: ReadonlySet<string> = new Set<GlobalKey>(['Mod+K', '?']);

/** Where a binding is being registered. */
export type KeyScope = 'pane' | 'global' | 'go';

/**
 * Throws a `KeyBindingError` unless `hotkey` may be bound in `scope`. The types already narrow
 * every call site; this is the runtime half, for a cast, a key from data, or a future refactor.
 */
export function assertBindable(hotkey: string, scope: KeyScope): void {
  if (!validateHotkey(hotkey).valid) throw new KeyBindingError(`"${hotkey}" is not a key.`);
  if (!hasNonModifierKey(hotkey)) {
    throw new KeyBindingError(`"${hotkey}" is only modifiers, not a key.`);
  }
  const parsed = parseHotkey(hotkey);
  // A valid hotkey with a non-modifier key always parses to one; the cast is for the type.
  const key = parsed.key as string;
  if (key === 'J' || key === 'K') {
    // ⌘K is the palette, the one exception.
    if (!(scope === 'global' && hotkey === 'Mod+K')) {
      throw new KeyBindingError(
        `"${hotkey}" is refused: J and K never move a list — ↑↓ do, in the focused pane.`,
      );
    }
  }
  if (DIGIT.test(key)) {
    throw new KeyBindingError(
      `"${hotkey}" is refused: number keys are never bound — Tab and ↑↓ move between lanes, and G then a letter goes anywhere.`,
    );
  }
  if (scope === 'global') {
    if (!GLOBAL_KEYS.has(hotkey)) {
      throw new KeyBindingError(
        `"${hotkey}" is refused: only ⌘K and ? work from anywhere; letters act in the focused pane.`,
      );
    }
    return;
  }
  if (COMPOSITE_KEYS.has(key)) {
    throw new KeyBindingError(
      `"${hotkey}" is refused: arrows, Tab, Home/End and Page keys belong to the pane's own list or control.`,
    );
  }
  if (key === 'G' && parsed.modifiers.length === 0) {
    throw new KeyBindingError(`"${hotkey}" is refused: G starts go-mode everywhere.`);
  }
  if (scope === 'go') {
    if (!LETTER.test(key) || parsed.modifiers.length > 0) {
      throw new KeyBindingError(`"${hotkey}" is refused: a go key is one plain letter.`);
    }
    return;
  }
  if (hotkey === '?' || key === '/') {
    throw new KeyBindingError(`"${hotkey}" is refused: ? opens the key sheet from anywhere.`);
  }
}

// ── Platform ─────────────────────────────────────────────────────────────────────────────────

/** The modifier `Mod` means here: ⌘ on a Mac, Ctrl elsewhere — as a `KeyboardEvent.key` name. */
export function modKey(): 'Meta' | 'Control' {
  return detectPlatform() === 'mac' ? 'Meta' : 'Control';
}

// ── Focus that owns the key ──────────────────────────────────────────────────────────────────

/**
 * Marks an element whose own type-ahead lets `G` and `?` through: the kit's middle list. Every
 * other listbox, menu, grid or combobox keeps every printable key for itself (#56).
 */
export const KEYS_PASS_THROUGH = 'data-keys-pass-through';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

const TYPE_AHEAD_COMPOSITES =
  '[role="listbox"],[role="menu"],[role="menubar"],[role="tree"],[role="grid"],[role="treegrid"],[role="combobox"]';

/** The focused element, through open shadow roots. */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** A field that types text: inputs of a text type, textarea, select, contenteditable, ARIA text. */
export function isTextEntry(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * Whether the focused control keeps a printable key for itself: a text field, or a composite that
 * types ahead (an open Select or Menu) unless it is marked `KEYS_PASS_THROUGH`.
 */
export function focusOwnsPrintableKeys(): boolean {
  const el = deepActiveElement();
  // Only a document without a body has no active element; not a case worth a test.
  /* v8 ignore next */
  if (el === null) return false;
  if (isTextEntry(el)) return true;
  const composite = el.closest(TYPE_AHEAD_COMPOSITES);
  return composite !== null && !composite.hasAttribute(KEYS_PASS_THROUGH);
}

/**
 * Options for a printable key that works from anywhere (`G`, `?`). The library's own input guard
 * would also swallow it inside the middle list (a listbox owns type-ahead), so it is off, and the
 * callback asks `focusOwnsPrintableKeys` instead. The default is prevented only when the key acts,
 * so a text field still types it; a key a list already used for type-ahead (prevented) is skipped.
 */
const ANYWHERE_PRINTABLE = {
  ignoreInputs: false,
  preventDefault: false,
  stopPropagation: false,
  ignoreDefaultPrevented: true,
} as const;

// ── Panes ────────────────────────────────────────────────────────────────────────────────────

export type PaneBinding = {
  key: PaneKey;
  run: () => void;
  /** Off keeps the key listed but inert (a disabled button's key). Default on. */
  enabled?: boolean;
  /** What it does, for the key sheet. */
  label?: string;
};

/**
 * Binds keys to a pane: each fires only while focus is inside `pane`, and never while focus is in
 * a text field or a control that uses the key (a list's type-ahead, a button's Enter). A pane's
 * keys are registered and released with the pane.
 */
export function usePaneKeys(
  pane: RefObject<HTMLElement | null>,
  bindings: readonly PaneBinding[],
): void {
  for (const b of bindings) assertBindable(b.key, 'pane');
  const definitions: UseHotkeyDefinition[] = bindings.map((b) => ({
    hotkey: b.key,
    callback: () => b.run(),
    options: {
      target: pane,
      enabled: b.enabled ?? true,
      ignoreInputs: 'auto',
      meta: b.label === undefined ? undefined : { name: b.label },
    },
  }));
  useHotkeys(definitions);
}

// ── Global ───────────────────────────────────────────────────────────────────────────────────

/** ⌘K or `?`, from anywhere. ⌘K works even in a text field; `?` types there instead. */
export function useGlobalKey(
  key: GlobalKey,
  run: () => void,
  options: { enabled?: boolean } = {},
): void {
  assertBindable(key, 'global');
  const printable = key === '?';
  useHotkey(
    key,
    (event) => {
      if (printable) {
        if (focusOwnsPrintableKeys()) return;
        event.preventDefault();
      }
      run();
    },
    printable
      ? { ...ANYWHERE_PRINTABLE, enabled: options.enabled ?? true }
      : { enabled: options.enabled ?? true },
  );
}

// ── Go-mode ──────────────────────────────────────────────────────────────────────────────────

export type GoTarget = {
  /** The letter after G. */
  key: GoLetter;
  /** Where it goes, as the go bar's example reads it ("Inbox" → "like I to open Inbox"). */
  label: string;
  run: () => void;
};

type GoState = {
  /** G was pressed; the next letter goes. */
  active: boolean;
  /** Every place go-mode can reach, in registration order. */
  targets: readonly GoTarget[];
  open: () => void;
  cancel: () => void;
  register: (id: string, target: GoTarget) => () => void;
};

const GoContext = createContext<GoState | null>(null);

function useGoContext(): GoState {
  const go = useContext(GoContext);
  if (go === null) throw new Error('Keys need a <KeysProvider> above them.');
  return go;
}

const CLOSED: Pick<GoState, 'active' | 'targets' | 'open' | 'cancel'> = {
  active: false,
  targets: [],
  open: () => {},
  cancel: () => {},
};

/**
 * Go-mode's state, for the go bar and the rail's ice caps (the page dims itself on `active`).
 * Outside a `KeysProvider` go-mode is simply closed, so a static board can draw the bar.
 */
export function useGoMode(): Pick<GoState, 'active' | 'targets' | 'open' | 'cancel'> {
  const go = useContext(GoContext);
  if (go === null) return CLOSED;
  const { active, targets, open, cancel } = go;
  return { active, targets, open, cancel };
}

/** Makes a place reachable by G then `target.key`, while the caller is mounted. */
export function useGoTarget(target: GoTarget): void {
  assertBindable(target.key, 'go');
  const { register } = useGoContext();
  const id = useId();
  const latest = useRef(target);
  latest.current = target;
  const { key, label } = target;
  useEffect(
    () => register(id, { key, label, run: () => latest.current.run() }),
    [register, id, key, label],
  );
}

/** `G`: opens go-mode from anywhere a printable key isn't someone else's. */
function GoKey({ open, active }: { open: () => void; active: boolean }) {
  useHotkey(
    'G',
    (event) => {
      if (focusOwnsPrintableKeys()) return;
      event.preventDefault();
      open();
    },
    { ...ANYWHERE_PRINTABLE, requireReset: true, enabled: !active },
  );
  return null;
}

/** Keys a stray press may hold without leaving go-mode. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/**
 * Go-mode's letters, in a scope of their own that suspends every other (an exclusive scope): no
 * pane letter or global key fires while it's open. A stray key leaves go-mode and is swallowed, so
 * it doesn't land in a list's type-ahead; a press anywhere leaves too.
 */
function GoLetters({ targets, done }: { targets: readonly GoTarget[]; done: () => void }) {
  const definitions: UseHotkeyDefinition[] = [
    ...targets.map((t) => ({
      hotkey: t.key,
      callback: () => {
        done();
        t.run();
      },
      options: { capture: true, ignoreInputs: false },
    })),
    { hotkey: 'Escape', callback: done, options: { capture: true, ignoreInputs: false } },
  ];
  useHotkeys(definitions);

  const letters = useMemo(() => new Set(targets.map((t) => t.key.toLowerCase())), [targets]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || MODIFIERS.has(event.key)) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (plain && (letters.has(event.key.toLowerCase()) || event.key === 'Escape')) return;
      if (plain) {
        event.preventDefault();
        event.stopPropagation();
      }
      done();
    };
    const onPointer = () => done();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onPointer);
    };
  }, [letters, done]);
  return null;
}

/**
 * The library's provider, typed for `createElement` with positional children (this file is `.ts`,
 * so it builds elements without JSX).
 */
const Provider = HotkeysProvider as (
  props: Omit<HotkeysProviderProps, 'children'> & { children?: ReactNode },
) => ReactElement;

/**
 * The keyboard layer's root: once, around the console. It holds go-mode — `G` from anywhere, the
 * targets places register, the letter that follows — and the library's provider underneath.
 * Go-mode doesn't time out: it waits for a letter, Esc, another key or a press (no timing to
 * beat, WCAG 2.2.1).
 */
export function KeysProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [registry, setRegistry] = useState<ReadonlyMap<string, GoTarget>>(new Map());
  const open = useCallback(() => setActive(true), []);
  const cancel = useCallback(() => setActive(false), []);
  const register = useCallback((id: string, target: GoTarget) => {
    setRegistry((prev) => new Map(prev).set(id, target));
    return () =>
      setRegistry((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
  }, []);
  // One place per letter: the first to register keeps it, and a second is a bug worth hearing about.
  const targets = useMemo(() => {
    const byKey = new Map<string, GoTarget>();
    for (const t of registry.values()) {
      if (byKey.has(t.key)) {
        console.warn(
          `Go-mode: G then ${t.key} already goes to ${byKey.get(t.key)?.label}; ${t.label} is not reachable.`,
        );
      } else byKey.set(t.key, t);
    }
    return [...byKey.values()];
  }, [registry]);
  const value = useMemo<GoState>(
    () => ({ active, targets, open, cancel, register }),
    [active, targets, open, cancel, register],
  );
  const letters =
    active &&
    createElement(
      Provider,
      { scope: 'go', exclusive: true },
      createElement(GoLetters, { targets, done: cancel }),
    );
  return createElement(
    Provider,
    null,
    createElement(
      GoContext.Provider,
      { value },
      createElement(GoKey, { open, active }),
      letters,
      children,
    ),
  );
}
