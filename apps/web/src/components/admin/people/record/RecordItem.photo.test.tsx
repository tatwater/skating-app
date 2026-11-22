import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecordItem } from './RecordItem';
import { ITEM_PHOTO, ITEM_PHOTO_NONE, NOW, SUBJECT } from './recordFixtures';
import { itemView } from './recordModel';

/**
 * **A photo verdict on the record sheet** (B01-5e): the item's plate is the photo's thumbnail,
 * pixelated as the Inbox's stage is — no image element and no address in the page until *Show* — or a
 * plain line when the server served none.
 */

const draw = (item: typeof ITEM_PHOTO) =>
  render(
    <RecordItem
      item={item}
      subject={SUBJECT}
      now={NOW}
      narrow={false}
      keys={false}
      busy={null}
      note={null}
      onLever={vi.fn()}
      onUndoEnd={vi.fn()}
    />,
  );

const thumbOf = (item: typeof ITEM_PHOTO) =>
  (item.content as unknown as { thumbUrl: string | null }).thumbUrl;

describe('a photo on the record', () => {
  it('reads as a photo plate with the content’s thumbnail', () => {
    const view = itemView(ITEM_PHOTO, SUBJECT, NOW);
    expect(view.plate).toMatchObject({ kind: 'photo', thumbUrl: thumbOf(ITEM_PHOTO) });
    expect(view.kicker).toMatch(/^Photo · /);
  });

  it('is pixelated until Show: no image, and its address nowhere in the page', () => {
    const { container } = draw(ITEM_PHOTO);
    const address = thumbOf(ITEM_PHOTO) as string;
    expect(container.querySelector('img')).toBeNull();
    expect(
      [...container.querySelectorAll('*')].some((el) =>
        [...el.attributes].some((a) => a.value.includes(address)),
      ),
    ).toBe(false);
    expect(container.querySelector('[data-slot="photo-mosaic"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(address);
    fireEvent.click(screen.getByRole('button', { name: 'Pixelate again' }));
    expect(container.querySelector('img')).toBeNull();
  });

  it('with no address served: a line, no image and no Show', () => {
    const { container } = draw(ITEM_PHOTO_NONE);
    expect(container.querySelector('img, canvas')).toBeNull();
    expect(screen.getByText('No photo to show')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });
});
