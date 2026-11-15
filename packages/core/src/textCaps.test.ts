import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  externalIdFits,
  MAX_APPROACH_PATH_POINTS,
  MAX_EXTERNAL_ID_CHARS,
  MAX_PLACE_NAME_CHARS,
  nameTooLong,
  thinPath,
} from './textCaps';

describe('the text caps (B01-3h)', () => {
  it('a name at the cap passes; one past it says what and how long', () => {
    expect(nameTooLong('x'.repeat(MAX_PLACE_NAME_CHARS), 'A bay’s name')).toBeNull();
    expect(nameTooLong(` ${'x'.repeat(MAX_PLACE_NAME_CHARS)} `, 'A bay’s name')).toBeNull();
    expect(nameTooLong('x'.repeat(MAX_PLACE_NAME_CHARS + 1), 'A bay’s name')).toBe(
      `A bay’s name is ${MAX_PLACE_NAME_CHARS + 1} characters; keep it to ${MAX_PLACE_NAME_CHARS}.`,
    );
  });

  it('an id at the cap fits; one past it does not', () => {
    expect(externalIdFits('n'.repeat(MAX_EXTERNAL_ID_CHARS))).toBe(true);
    expect(externalIdFits('n'.repeat(MAX_EXTERNAL_ID_CHARS + 1))).toBe(false);
  });

  it('a thinned walk keeps its ends and at most the cap, and a short one is untouched', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 2_000 }), (path) => {
        const thin = thinPath(path);
        expect(thin.length).toBeLessThanOrEqual(MAX_APPROACH_PATH_POINTS);
        expect(thin[0]).toBe(path[0]);
        expect(thin.at(-1)).toBe(path.at(-1));
        if (path.length <= MAX_APPROACH_PATH_POINTS) expect(thin).toEqual(path);
      }),
    );
  });
});
