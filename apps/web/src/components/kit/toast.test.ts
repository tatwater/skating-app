import { describe, expect, it } from 'vitest';

import { KeyBindingError } from '@/lib/keys';

import { parseToastKey, toastKeyMatches } from './toast';

const press = (
  key: string,
  code: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('parseToastKey', () => {
  it('reads the caps the console writes', () => {
    expect(parseToastKey('⌘Z')).toEqual({
      key: 'Z',
      mod: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseToastKey('⇧⏎')).toMatchObject({ key: 'Enter', shift: true, mod: false });
    expect(parseToastKey('Ctrl Z')).toMatchObject({ key: 'Z', ctrl: true, mod: false });
    expect(parseToastKey('⌃⌥z')).toMatchObject({ key: 'Z', ctrl: true, alt: true });
    expect(parseToastKey(' Esc ')).toMatchObject({ key: 'Escape' });
    expect(parseToastKey('Del').key).toBe('Delete');
    expect(parseToastKey('⌫').key).toBe('Backspace');
    expect(parseToastKey('?').key).toBe('?');
  });

  it('refuses a cap it cannot bind, so no toast wears a dead key', () => {
    expect(() => parseToastKey('Hold')).toThrow(KeyBindingError);
    expect(() => parseToastKey('⌘')).toThrow(/not a key a toast can bind/);
  });

  it('refuses what the console never binds: J, K and number keys', () => {
    expect(() => parseToastKey('⌘J')).toThrow(/J, K and number keys/);
    expect(() => parseToastKey('K')).toThrow(KeyBindingError);
    expect(() => parseToastKey('⌘1')).toThrow(KeyBindingError);
  });
});

describe('toastKeyMatches', () => {
  const undo = parseToastKey('⌘Z');

  it('reads ⌘ as the platform command key', () => {
    expect(toastKeyMatches(undo, press('z', 'KeyZ', { metaKey: true }), 'Meta')).toBe(true);
    expect(toastKeyMatches(undo, press('z', 'KeyZ', { ctrlKey: true }), 'Control')).toBe(true);
    expect(toastKeyMatches(undo, press('z', 'KeyZ', { ctrlKey: true }), 'Meta')).toBe(false);
  });

  it('wants exactly its modifiers, and a letter by its place on the keyboard', () => {
    expect(toastKeyMatches(undo, press('z', 'KeyZ'), 'Meta')).toBe(false);
    // ⇧⌘Z is redo, not undo.
    expect(
      toastKeyMatches(undo, press('Z', 'KeyZ', { metaKey: true, shiftKey: true }), 'Meta'),
    ).toBe(false);
    expect(toastKeyMatches(undo, press('y', 'KeyY', { metaKey: true }), 'Meta')).toBe(false);
    // ⌥ changes the character, not the code.
    const alt = parseToastKey('⌥Z');
    expect(toastKeyMatches(alt, press('Ω', 'KeyZ', { altKey: true }), 'Meta')).toBe(true);
  });

  it('matches named keys by name and punctuation by its character', () => {
    const enter = parseToastKey('⇧⏎');
    expect(toastKeyMatches(enter, press('Enter', 'Enter', { shiftKey: true }), 'Meta')).toBe(true);
    expect(toastKeyMatches(enter, press('Enter', 'Enter'), 'Meta')).toBe(false);
    const help = parseToastKey('?');
    expect(toastKeyMatches(help, press('?', 'Slash', { shiftKey: true }), 'Meta')).toBe(true);
    expect(toastKeyMatches(help, press('/', 'Slash'), 'Meta')).toBe(false);
  });
});
