import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

const photos = vi.hoisted(() => ({
  drafts: [] as { id: string; previewUrl: string; placeOnMap: boolean }[],
  addFiles: vi.fn(),
  uploadAll: vi.fn(),
  setCommitted: vi.fn(),
  removePhoto: vi.fn(),
  release: vi.fn(),
  error: null as string | null,
}));

vi.mock('convex/react', () => convexReact);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));
vi.mock('../../usePhotoDrafts', async () => {
  const { useState } = await import('react');
  return {
    usePhotoDrafts: () => {
      const [list, setList] = useState(photos.drafts);
      return {
        photos: list,
        error: photos.error,
        clearError: () => {},
        addFiles: async (files: File[]) => {
          const outcome = await photos.addFiles(files);
          if (outcome === 'none') return;
          setList(files.map((f, i) => ({ id: `d${i}`, previewUrl: f.name, placeOnMap: false })));
        },
        removePhoto: photos.removePhoto,
        setPlaceOnMap: () => {},
        uploadAll: photos.uploadAll,
        setCommitted: photos.setCommitted,
        release: photos.release,
      };
    },
  };
});

import { AccessTab } from './AccessTab';
import { ACCESS_NOW, MASCOMA_ACCESS } from './access/accessFixtures';

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ACCESS_NOW);
  resetFakes();
  photos.drafts = [];
  photos.error = null;
  photos.addFiles = vi.fn().mockResolvedValue(undefined);
  photos.uploadAll = vi.fn().mockResolvedValue(['photo1']);
  photos.setCommitted = vi.fn();
  photos.removePhoto = vi.fn();
  photos.release = vi.fn();
  fakes.queries.set('accessPoints:accessForBody', MASCOMA_ACCESS);
  fakes.queries.set('accessPoints:listPhotos', []);
  fakes.queries.set('profiles:current', { role: 'user' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const report = vi.fn();
const tab = (props: Partial<Parameters<typeof AccessTab>[0]> = {}) =>
  render(<AccessTab waterBodyId="mascoma" onReportProblem={report} {...props} />);
const card = (name: string) => screen.getByRole('article', { name });

describe('AccessTab', () => {
  it('draws the loading frame until the access answer arrives', () => {
    fakes.queries.set('accessPoints:accessForBody', undefined);
    const { container } = tab();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('lists the put-ins, the recommended way in first, and asks for the bay when one is in view', () => {
    tab({ subAreaId: 'north' });
    expect(fakes.calls.find((c) => c.name === 'accessPoints:accessForBody')?.args).toEqual({
      waterBodyId: 'mascoma',
      subAreaId: 'north',
    });
    const cards = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(cards[0]).toBe('Mascoma Lake Boat Launch');
    expect(cards).toHaveLength(6);
    expect(card('Mascoma Lake Boat Launch').getAttribute('data-recommended')).toBe('true');
    // No stored launch is missing, so the report-derived spots are never asked for.
    expect(fakes.calls.some((c) => c.name === 'putIns:listForBody')).toBe(false);
    // The lot no launch names gets its own section.
    expect(
      within(screen.getByRole('region', { name: 'Parking' })).getByText('Church lot'),
    ).toBeTruthy();
  });

  it('keeps the hike-in apart, with core’s sentence', () => {
    tab();
    const ramp = card('Mascoma Lakeside Park Boat Ramp');
    expect(within(ramp).getByText('Hike-in')).toBeTruthy();
    expect(
      within(ramp).getByText('Park here, then about 0.3 mi on foot, 39 ft of climb.'),
    ).toBeTruthy();
  });

  it('says what the signs say, in core’s words', () => {
    tab();
    const launch = card('Mascoma Lake Boat Launch');
    expect(within(launch).getByText(/December 1/)).toBeTruthy();
    expect(within(card('By the Knox River')).getByText('No posted rules on file')).toBeTruthy();
    expect(within(card('Shakoma Beach')).getByText(/permit/i)).toBeTruthy();
  });

  it('records directions_opened with the target the link goes to', () => {
    tab();
    fireEvent.click(
      within(card('Mascoma Lake Boat Launch')).getByRole('link', { name: /Directions to parking/ }),
    );
    expect(fakes.capture).toHaveBeenCalledWith('directions_opened', { target: 'parking' });
    const shore = within(card('By the Knox River')).getByRole('link', {
      name: /Directions to the put-in/,
    });
    expect(shore.getAttribute('target')).toBe('_blank');
    fireEvent.click(shore);
    expect(fakes.capture).toHaveBeenCalledWith('directions_opened', { target: 'put_in' });
    fireEvent.click(within(screen.getByRole('region', { name: 'Parking' })).getByRole('link'));
    expect(fakes.capture).toHaveBeenLastCalledWith('directions_opened', { target: 'parking' });
  });

  it('votes on a live alert, and says so when the vote fails', async () => {
    tab();
    const beach = card('Shakoma Beach');
    expect(within(beach).getByText('Snowed in')).toBeTruthy();
    expect(within(beach).queryByRole('button', { name: 'Retract' })).toBeNull();
    fireEvent.click(within(beach).getByRole('button', { name: 'Still blocked' }));
    const vote = fakes.mutations.get('accessAlerts:vote');
    expect(vote).toHaveBeenCalledWith({ accessAlertId: 'alert-snow', verdict: 'still_blocked' });
    vote?.mockRejectedValueOnce(new Error('minor'));
    // The first vote settles before the buttons take another press.
    await act(async () => {});
    fireEvent.click(within(beach).getByRole('button', { name: 'It’s open' }));
    expect(await within(beach).findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not send that. Try again.',
    );
  });

  it('lets a moderator retract an alert', () => {
    fakes.queries.set('profiles:current', { role: 'moderator' });
    tab();
    fireEvent.click(within(card('Shakoma Beach')).getByRole('button', { name: 'Retract' }));
    expect(fakes.mutations.get('accessAlerts:retract')).toHaveBeenCalledWith({
      accessAlertId: 'alert-snow',
    });
  });

  it('reports an access problem from a card’s popover', async () => {
    tab();
    fireEvent.click(
      within(card('Mascoma Lake Boat Launch')).getByRole('button', {
        name: 'Report an access problem at Mascoma Lake Boat Launch',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Mascoma Lake Boat Launch')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Note'), {
      target: { value: '  drifted shut ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    const create = fakes.mutations.get('accessAlerts:create');
    expect(create).toHaveBeenCalledWith({
      targetType: 'put_in',
      putInId: 'launch',
      reason: 'not_plowed',
      note: 'drifted shut',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the popover open with an error when the post fails', async () => {
    fakes.mutations.set('accessAlerts:create', vi.fn().mockRejectedValue(new Error('x')));
    tab();
    fireEvent.click(
      within(card('Shakoma Beach')).getByRole('button', {
        name: 'Report an access problem at Shakoma Beach',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(fakes.mutations.get('accessAlerts:create')).toHaveBeenCalledWith({
      targetType: 'put_in',
      putInId: 'beach',
      reason: 'not_plowed',
    });
  });

  it('falls back to the report-derived spots, with the act pane as the way to report', () => {
    fakes.queries.set('accessPoints:accessForBody', {
      putIns: [],
      parking: [],
      blockedIds: [],
      alerts: [],
    });
    fakes.queries.set('putIns:listForBody', [
      { coord: { lat: 43.6, lng: -72.1 }, source: 'derived', reportCount: 3 },
    ]);
    tab();
    expect(screen.getByRole('article', { name: 'Where skaters put in' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Report an access problem' }));
    expect(report).toHaveBeenCalled();
  });

  it('says so when nothing is on file', () => {
    fakes.queries.set('accessPoints:accessForBody', {
      putIns: [],
      parking: [],
      blockedIds: [],
      alerts: [],
    });
    fakes.queries.set('putIns:listForBody', []);
    tab();
    expect(screen.getByText('No put-ins or parking are on file for this lake yet.')).toBeTruthy();
  });

  it('waits for the derived spots before saying nothing is on file', () => {
    fakes.queries.set('accessPoints:accessForBody', {
      putIns: [],
      parking: [],
      blockedIds: [],
      alerts: [],
    });
    tab();
    expect(screen.queryByText(/on file for this lake/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Report an access problem' })).toBeNull();
  });

  it('draws six cards, then the rest as the list scrolls', () => {
    let reach: () => void = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          reach = () => cb([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const many = {
      ...MASCOMA_ACCESS,
      putIns: Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        coord: { lat: 43 + i / 100, lng: -72 },
        name: `Put-in ${i}`,
        source: 'derived',
      })),
      alerts: [],
    };
    fakes.queries.set('accessPoints:accessForBody', many);
    tab();
    expect(screen.getAllByRole('article')).toHaveLength(6);
    act(() => reach());
    expect(screen.getAllByRole('article')).toHaveLength(8);
  });

  it('shows photos, and adds them from the Add tile', async () => {
    fakes.queries.set('accessPoints:listPhotos', [
      { photoId: 'ph1', accessPhotoId: 'ap1', thumbUrl: 'https://x/1.jpg' },
    ]);
    tab();
    const launch = card('Mascoma Lake Boat Launch');
    expect(within(launch).getByRole('img', { name: 'At Mascoma Lake Boat Launch' })).toBeTruthy();
    fireEvent.click(
      within(launch).getAllByRole('button', { name: 'Remove photo' })[0] as HTMLElement,
    );
    expect(fakes.mutations.get('accessPoints:detachPhoto')).toHaveBeenCalledWith({
      accessPhotoId: 'ap1',
    });

    const file = new File(['x'], 'lot.jpg', { type: 'image/jpeg' });
    fireEvent.change(within(launch).getByLabelText('Add photos of Mascoma Lake Boat Launch'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(fakes.mutations.get('accessPoints:attachPhoto')).toHaveBeenCalledWith({
        targetType: 'put_in',
        putInId: 'launch',
        photoId: 'photo1',
      }),
    );
    expect(photos.setCommitted).toHaveBeenCalledWith(true);
    // The attached photo is handed to the launch, never removed: removing deletes its row and
    // blobs, leaving the attachment pointing at nothing.
    await waitFor(() => expect(photos.release).toHaveBeenCalledWith(['photo1']));
    expect(photos.removePhoto).not.toHaveBeenCalled();
    expect(photos.setCommitted).toHaveBeenLastCalledWith(false);
  });

  it('hands over only the photos that attached when an attach fails part-way', async () => {
    photos.uploadAll = vi.fn().mockResolvedValue(['photo1', 'photo2']);
    const attach = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Could not attach'));
    fakes.mutations.set('accessPoints:attachPhoto', attach);
    tab();
    const launch = card('Mascoma Lake Boat Launch');
    fireEvent.change(within(launch).getByLabelText('Add photos of Mascoma Lake Boat Launch'), {
      target: { files: [new File(['x'], 'a.jpg'), new File(['y'], 'b.jpg')] },
    });
    expect(await within(launch).findByText('Could not attach')).toBeTruthy();
    expect(photos.release.mock.calls).toEqual([[['photo1']]]);
    expect(photos.removePhoto).not.toHaveBeenCalled();
    // The unattached one is a draft again, which the sweep may reclaim.
    expect(photos.setCommitted).toHaveBeenLastCalledWith(false);
  });

  it('says why an upload failed, and frees the drafts for the sweep', async () => {
    photos.uploadAll = vi.fn().mockRejectedValue(new Error('Upload failed'));
    tab();
    const launch = card('Mascoma Lake Boat Launch');
    fireEvent.change(within(launch).getByLabelText('Add photos of Mascoma Lake Boat Launch'), {
      target: { files: [new File(['x'], 'a.jpg')] },
    });
    expect(await within(launch).findByText('Upload failed')).toBeTruthy();
    expect(photos.setCommitted).toHaveBeenLastCalledWith(false);
  });

  it('stops waiting when no picked file could be processed, or the pick fails', async () => {
    photos.addFiles = vi.fn().mockResolvedValue('none');
    tab();
    const launch = card('Mascoma Lake Boat Launch');
    const add = within(launch).getByRole('button', { name: /Add/ });
    const input = within(launch).getByLabelText('Add photos of Mascoma Lake Boat Launch');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(add);
    expect(click).toHaveBeenCalled();
    // An empty pick is ignored outright.
    fireEvent.change(input, { target: { files: [] as File[] } });
    expect(photos.addFiles).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.heic')] } });
    await waitFor(() => expect(add.getAttribute('aria-busy')).toBeNull());
    expect(photos.uploadAll).not.toHaveBeenCalled();
    photos.addFiles = vi.fn().mockRejectedValue(new Error('decode'));
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.heic')] } });
    await waitFor(() => expect(add.getAttribute('aria-busy')).toBeNull());
    expect(photos.uploadAll).not.toHaveBeenCalled();
  });

  it('hides the photo strip on a card with no photos unless it is the recommended one', () => {
    tab();
    expect(within(card('Mascoma Lake Boat Launch')).getByText(/^Photos — /)).toBeTruthy();
    expect(within(card('Shakoma Beach')).queryByText(/^Photos — /)).toBeNull();
  });
});
