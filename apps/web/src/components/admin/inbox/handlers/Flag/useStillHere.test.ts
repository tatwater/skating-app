import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useStillHere } from './useStillHere';

test('here while the item is open; not once another is, nor once the handler has gone', () => {
  const { result, rerender, unmount } = renderHook(({ id }) => useStillHere(id), {
    initialProps: { id: 'i_one' },
  });
  const first = result.current;
  expect(first()).toBe(true);
  rerender({ id: 'i_two' });
  expect(first()).toBe(false);
  const second = result.current;
  expect(second()).toBe(true);
  unmount();
  // The answer for i_two lands after the handler went: no receipt over whatever stands there now.
  expect(second()).toBe(false);
});

test('under StrictMode (an effect set up, torn down and set up again) it is here after mount', () => {
  const { result } = renderHook(({ id }) => useStillHere(id), {
    initialProps: { id: 'i_one' },
    reactStrictMode: true,
  });
  expect(result.current()).toBe(true);
});
