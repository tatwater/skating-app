import { describe, expect, it } from 'vitest';
import {
  resolveShowPutInDefault,
  SHOW_PUT_IN_EXPLAINER,
  SHOW_PUT_IN_LABEL,
  SHOW_PUT_IN_SETTING_EXPLAINER,
} from './putInPrivacy';

describe('resolveShowPutInDefault', () => {
  it('reads an unset profile field as shown — the same default the stored report field has', () => {
    expect(resolveShowPutInDefault(undefined)).toBe(true);
    expect(resolveShowPutInDefault(true)).toBe(true);
    expect(resolveShowPutInDefault(false)).toBe(false);
  });
});

describe('the copy', () => {
  it('never claims the report or the water body is hidden — only the spot (D13: reports are public)', () => {
    for (const text of [SHOW_PUT_IN_LABEL, SHOW_PUT_IN_EXPLAINER, SHOW_PUT_IN_SETTING_EXPLAINER]) {
      expect(text).not.toMatch(/hide (your|the) report|private report|anonymous/i);
    }
    expect(SHOW_PUT_IN_EXPLAINER).toMatch(/still names the water body/);
  });
});
