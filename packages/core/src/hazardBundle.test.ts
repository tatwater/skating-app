import { describe, expect, it } from 'vitest';
import { bundledHazardIds, toggleBundleOptOut } from './hazardBundle';

describe('bundledHazardIds', () => {
  it('includes every candidate by default (D55: pre-checked)', () => {
    expect(bundledHazardIds(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('drops the ones the author deselected', () => {
    expect(bundledHazardIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  // The candidate list is a live query. Storing the *selection* positively would mean a hazard that
  // finished syncing after the form opened arrives unchecked and is silently dropped from the
  // report — the exact thing storing opt-outs prevents.
  it('includes a candidate that appears after the author has already deselected another', () => {
    const optedOut = toggleBundleOptOut([], 'a', false);
    expect(bundledHazardIds(['a', 'b', 'late'], optedOut)).toEqual(['b', 'late']);
  });

  it('ignores an opt-out for a hazard that is no longer a candidate', () => {
    expect(bundledHazardIds(['a'], ['gone'])).toEqual(['a']);
  });

  it('preserves candidate order, so attachment matches what the prompt itemises', () => {
    expect(bundledHazardIds(['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b']);
  });

  it('bundles nothing when there are no candidates', () => {
    expect(bundledHazardIds([], ['a'])).toEqual([]);
  });
});

describe('toggleBundleOptOut', () => {
  it('deselecting records an opt-out; re-selecting removes it', () => {
    const off = toggleBundleOptOut([], 'a', false);
    expect(off).toEqual(['a']);
    expect(toggleBundleOptOut(off, 'a', true)).toEqual([]);
  });

  it('is idempotent — a double-fire from a jittery tap adds the id once', () => {
    const once = toggleBundleOptOut([], 'a', false);
    expect(toggleBundleOptOut(once, 'a', false)).toEqual(['a']);
  });

  it('re-selecting something never deselected is a no-op', () => {
    expect(toggleBundleOptOut(['b'], 'a', true)).toEqual(['b']);
  });

  it('does not mutate the array it was given', () => {
    const before = ['a'];
    toggleBundleOptOut(before, 'b', false);
    expect(before).toEqual(['a']);
  });
});
