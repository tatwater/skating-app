import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AVATAR_ACCEPT } from '@/lib/photo';

import { ProfilePhoto, type ProfilePhotoProps } from './ProfilePhoto';

function photo(over: Partial<ProfilePhotoProps> = {}) {
  const props: ProfilePhotoProps = {
    name: 'Kate Donovan',
    imageUrl: 'https://img.clerk.com/kate.jpg',
    busy: null,
    error: null,
    offline: false,
    onChange: vi.fn(),
    onRemove: vi.fn().mockResolvedValue(true),
    ...over,
  };
  return { props, ...render(<ProfilePhoto {...props} />) };
}

const change = () => screen.getByRole('button', { name: 'Change photo' });
const remove = () => screen.queryByRole('button', { name: 'Remove photo' });
const picker = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="file"]');

describe('ProfilePhoto', () => {
  it('shows the circle with both controls, tagged for analytics', () => {
    photo();
    expect(screen.getByRole('img', { name: 'Your photo' })).toBeInTheDocument();
    expect(change()).toHaveAttribute('data-attr', 'settings-photo-change');
    expect(remove()).toHaveAttribute('data-attr', 'settings-photo-remove');
    expect(screen.getByText('JPEG, PNG, WebP, or HEIC.')).toBeInTheDocument();
  });

  it('with no photo: the initials, and nothing to remove', () => {
    photo({ imageUrl: undefined });
    expect(screen.getByRole('img', { name: 'Your photo' })).toHaveTextContent('KD');
    expect(remove()).toBeNull();
  });

  it('Change photo opens the picker, which offers the pipeline’s formats', () => {
    const { container } = photo();
    const input = picker(container);
    expect(input).toHaveAttribute('accept', AVATAR_ACCEPT);
    const click = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(change());
    expect(click).toHaveBeenCalled();
  });

  it('hands the picked file up once, and clears the picker so the same file can be picked again', () => {
    const { container, props } = photo();
    const input = picker(container) as HTMLInputElement;
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.onChange).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { files: [] } });
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });

  it('uploading: Change photo is busy and Remove photo waits', () => {
    photo({ busy: 'uploading' });
    expect(change()).toHaveAttribute('aria-busy', 'true');
    expect(remove()).toBeDisabled();
    expect(screen.getByRole('img', { name: 'Your photo' })).toHaveAttribute('aria-busy', 'true');
  });

  it('offline: both wait, and the note says why', () => {
    photo({ offline: true, error: 'stale' });
    expect(change()).toBeDisabled();
    expect(remove()).toBeDisabled();
    expect(screen.getByText(/You’re offline/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failure reads as a plain alert under the controls', () => {
    photo({ error: 'Your photo wasn’t saved. Try again in a moment.' });
    expect(screen.getByRole('alert')).toHaveTextContent('wasn’t saved');
  });

  it('Remove photo asks first; Cancel keeps the photo', async () => {
    const { props } = photo();
    fireEvent.click(remove() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove your photo?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it('confirming removes, and the confirm closes once it’s gone', async () => {
    const { props } = photo();
    fireEvent.click(remove() as HTMLElement);
    await screen.findByRole('alertdialog');
    const confirm = screen
      .getAllByRole('button', { name: /Remove photo/ })
      .find((b) => b.getAttribute('data-slot') === 'alert-dialog-action') as HTMLElement;
    await act(async () => fireEvent.click(confirm));
    expect(props.onRemove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a refused removal stays open, with the reason inside the confirm', async () => {
    const onRemove = vi.fn().mockResolvedValue(false);
    const { rerender, props } = photo({ onRemove });
    fireEvent.click(remove() as HTMLElement);
    await screen.findByRole('alertdialog');
    const confirm = screen
      .getAllByRole('button', { name: /Remove photo/ })
      .find((b) => b.getAttribute('data-slot') === 'alert-dialog-action') as HTMLElement;
    await act(async () => fireEvent.click(confirm));
    rerender(<ProfilePhoto {...props} error="Your photo wasn’t removed." />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Not removed.');
    // The reason is in the confirm, not repeated under the controls behind it.
    expect(screen.getAllByText('Your photo wasn’t removed.')).toHaveLength(1);
  });
});
