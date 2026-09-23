import { describe, expect, test } from 'vitest';
import {
  POST_BODY_MAX_CHARS,
  POST_TITLE_MAX_CHARS,
  postPhotoIds,
  validatePostInput,
  visiblePostReports,
} from './post';

describe('validatePostInput (A10 / D186)', () => {
  test('nothing is required — a legacy Post has neither title nor body', () => {
    expect(validatePostInput({})).toEqual({ ok: true, normalized: {} });
  });

  test('trims, and drops an empty title or body rather than storing whitespace', () => {
    expect(validatePostInput({ title: '  Crystal Lake, Enfield 12/6 ', body: '   ' })).toEqual({
      ok: true,
      normalized: { title: 'Crystal Lake, Enfield 12/6' },
    });
  });

  test('bounds both, measured after the trim', () => {
    const title = 'x'.repeat(POST_TITLE_MAX_CHARS);
    expect(validatePostInput({ title: ` ${title} ` })).toEqual({ ok: true, normalized: { title } });
    const over = validatePostInput({
      title: 'x'.repeat(POST_TITLE_MAX_CHARS + 1),
      body: 'y'.repeat(POST_BODY_MAX_CHARS + 1),
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.map((e) => e.field)).toEqual(['title', 'body']);
  });

  test('refuses a non-string at the trust boundary', () => {
    const r = validatePostInput({ title: 3 as unknown as string, body: {} as unknown as string });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});

describe('postPhotoIds', () => {
  test('is the ordered union of the members, first mention wins', () => {
    expect(
      postPhotoIds([{ photoIds: ['a', 'b'] }, { photoIds: [] }, { photoIds: ['b', 'c', 'a'] }]),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('visiblePostReports', () => {
  const visible = { moderationStatus: 'visible' } as const;
  const hidden = { moderationStatus: 'hidden' } as const;
  test('a hidden Post hides every member', () => {
    expect(visiblePostReports(hidden, [visible, visible])).toEqual([]);
  });
  test('one hidden Report leaves; the rest stay', () => {
    expect(visiblePostReports(visible, [visible, hidden, visible])).toHaveLength(2);
  });
  test('zero visible members ⇒ nothing to show', () => {
    expect(visiblePostReports(visible, [hidden])).toEqual([]);
  });
});
