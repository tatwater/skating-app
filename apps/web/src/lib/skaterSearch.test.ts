import { describe, expect, it } from 'vitest';
import { POST_NEW, skaterRootSearchSchema } from './skaterSearch';

/**
 * The root search params degrade, never error (D242): a bad or stale link lands on the default
 * view with the sheet closed.
 */
describe('skaterRootSearchSchema', () => {
  it('passes the sheet params through', () => {
    expect(skaterRootSearchSchema.parse({ post: POST_NEW, postBody: 'body1' })).toEqual({
      post: 'new',
      postBody: 'body1',
    });
    expect(skaterRootSearchSchema.parse({ post: 'report123' })).toEqual({ post: 'report123' });
  });

  it('is empty for an empty search', () => {
    expect(skaterRootSearchSchema.parse({})).toEqual({});
  });

  it('drops junk values instead of throwing', () => {
    expect(skaterRootSearchSchema.parse({ post: 42 })).toEqual({});
    expect(skaterRootSearchSchema.parse({ post: '' })).toEqual({});
    expect(skaterRootSearchSchema.parse({ postBody: ['a'] })).toEqual({});
  });

  it('ignores unknown params so other routes can own their own', () => {
    const parsed = skaterRootSearchSchema.parse({ post: 'new', tab: 'weather' });
    expect(parsed).toEqual({ post: 'new' });
  });
});
