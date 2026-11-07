import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_HAZARD_DRAFT, type HazardDraft } from '@/stores/hazardDraftStore';

import { HazardFlowView, type HazardFlowViewProps } from './HazardFlowView';
import { ringCorners } from './useHazardMap';

vi.mock('../../photoPipeline', () => ({
  processPhoto: vi.fn(async (file: File) => ({ full: file, thumb: file })),
  uploadToStorage: vi.fn(async () => 'storage_1'),
}));

import { uploadHazardPhotos } from './hazardPhotos';

function props(draft: Partial<HazardDraft> = {}): HazardFlowViewProps {
  const noop = vi.fn();
  return {
    draft: { ...EMPTY_HAZARD_DRAFT, waterBodyId: 'mascoma', ...draft },
    photos: [],
    lostPhotos: 0,
    nudge: null,
    error: null,
    submitting: false,
    onChooseType: vi.fn(),
    onClearType: noop,
    onChooseDrawKind: noop,
    onStopPlacing: noop,
    onUndo: noop,
    onFlipShore: noop,
    onResize: noop,
    onNoteChange: noop,
    onAddPhotos: noop,
    onRemovePhoto: noop,
    onConfirmNearby: noop,
    onFileDistinct: noop,
    onPost: vi.fn(),
    onCancel: noop,
  };
}

describe('the type picker (3.1)', () => {
  it('every danger and the one crossing are pickable; Post sleeps with its reason', () => {
    const p = props();
    render(<HazardFlowView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drain hole' }));
    expect(p.onChooseType).toHaveBeenCalledWith('drain_hole');
    fireEvent.click(screen.getByRole('button', { name: /Ridge crossing/ }));
    expect(p.onChooseType).toHaveBeenCalledWith('ridge_crossing');
    expect(screen.getByText('A place you got across — not a danger')).toBeInTheDocument();
    const post = screen.getByRole('button', { name: 'Post hazard' });
    fireEvent.click(post);
    expect(p.onPost).not.toHaveBeenCalled();
  });

  it('Cancel and Post sit in the named foot, the last thing in the flow', () => {
    render(<HazardFlowView {...props()} />);
    const flow = document.querySelector('[data-slot="hazard-flow"]');
    const foot = document.querySelector('[data-slot="hazard-flow-foot"]');
    expect(foot).not.toBeNull();
    expect(flow?.lastElementChild).toBe(foot);
    const inFoot = within(foot as HTMLElement);
    expect(inFoot.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(inFoot.getByRole('button', { name: 'Post hazard' })).toBeInTheDocument();
  });

  it('the optional questions fold until opened', () => {
    render(<HazardFlowView {...props()} />);
    const folded = screen.getByRole('button', { name: /Photos/ });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(folded);
    expect(screen.getByRole('heading', { name: /Photos/ })).toBeInTheDocument();
  });

  it('Add opens the file picker', () => {
    render(<HazardFlowView {...props({ note: 'x' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Photos/ }));
    const input = screen.getByTestId('hazard-photo-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(click).toHaveBeenCalled();
  });

  it('no size question until there is something to size', () => {
    render(
      <HazardFlowView {...props({ hazardType: 'thin_ice', drawKind: 'line', shape: null })} />,
    );
    expect(screen.queryByRole('heading', { name: /Roughly/ })).toBeNull();
  });
});

describe('the pieces under it', () => {
  it('a ring with nothing in it has no corners; an open ring keeps them all', () => {
    expect(ringCorners(null)).toBeNull();
    expect(ringCorners({ type: 'Polygon', coordinates: [[[0, 0]]] })).toBeNull();
    expect(
      ringCorners({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      }),
    ).toHaveLength(3);
  });

  it('a failed photo upload deletes the rows already made, then fails', async () => {
    const deletePhoto = vi.fn().mockResolvedValue(null);
    const createPhoto = vi.fn().mockResolvedValueOnce('p1').mockRejectedValueOnce(new Error('x'));
    await expect(
      uploadHazardPhotos([new File(['a'], 'a.jpg'), new File(['b'], 'b.jpg')], {
        generateUploadUrl: vi.fn().mockResolvedValue('https://upload'),
        createPhoto,
        deletePhoto,
      }),
    ).rejects.toThrow('x');
    expect(deletePhoto).toHaveBeenCalledWith({ photoId: 'p1' });
  });
});
