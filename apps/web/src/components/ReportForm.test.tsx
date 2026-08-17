import { emptyReportForm, type ReportFormState } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReportFormFields } from './ReportForm';
import type { PhotoDraftView } from './usePhotoDrafts';

const FIXED_NOW = Date.UTC(2026, 0, 5, 12, 0);

function renderFields(
  opts: {
    putInPin?: { lat: number; lng: number } | null;
    photos?: PhotoDraftView[];
    existingPhotos?: { photoId: string; thumbUrl: string | null }[];
  } = {},
) {
  const spies = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onRequestPin: vi.fn(),
    onClearPin: vi.fn(),
    onAddFiles: vi.fn(),
    onRemovePhoto: vi.fn(),
    onTogglePlaceOnMap: vi.fn(),
    onRemoveExistingPhoto: vi.fn(),
  };
  let latest: ReportFormState | undefined;
  function Wrapper() {
    const [form, setForm] = useState(() => emptyReportForm(FIXED_NOW));
    latest = form;
    return (
      <ReportFormFields
        form={form}
        onFormChange={setForm}
        putInPin={opts.putInPin ?? null}
        photos={opts.photos ?? []}
        existingPhotos={opts.existingPhotos ?? []}
        submitting={false}
        error={null}
        {...spies}
      />
    );
  }
  render(<Wrapper />);
  return { spies, getForm: () => latest as ReportFormState };
}

describe('ReportFormFields', () => {
  it('has no visibility control — all reports are public (D13)', () => {
    renderFields();
    expect(screen.queryByRole('button', { name: 'Public' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Only me' })).not.toBeInTheDocument();
  });

  /**
   * `reports.update` is last-write-wins over `photoIds`, so an edit form that can't see the report's
   * existing photos posts an empty list and detaches every one of them. Rendering them is what makes
   * the submitted array mean "this report's photos" rather than "what was picked in this session".
   */
  describe('photos already on the report (edit path, N6f)', () => {
    const ATTACHED = [{ photoId: 'p1', thumbUrl: 'https://example.test/p1.jpg' }];

    it('shows nothing extra when creating a new report', () => {
      renderFields();
      expect(screen.queryByAltText('Attached to this report')).not.toBeInTheDocument();
    });

    it('renders each attached photo with its own remove control', () => {
      const { spies } = renderFields({ existingPhotos: ATTACHED });
      expect(screen.getByAltText('Attached to this report')).toHaveAttribute(
        'src',
        'https://example.test/p1.jpg',
      );

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      expect(spies.onRemoveExistingPhoto).toHaveBeenCalledWith('p1');
    });

    /** A thumbnail that hasn't loaded (or 404s) must not hide the photo — it's still attached. */
    it('still renders a row when the thumbnail URL is missing', () => {
      renderFields({ existingPhotos: [{ photoId: 'p1', thumbUrl: null }] });
      expect(screen.getByText('Already on this report')).toBeInTheDocument();
    });
  });

  it('adds and removes thickness readings, toggling value ↔ range inputs (XOR)', () => {
    renderFields();
    expect(screen.queryByLabelText('Thickness (inches)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add a thickness reading' }));
    expect(screen.getByLabelText('Thickness (inches)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Minimum thickness (inches)')).not.toBeInTheDocument();

    // Switch this reading to a range — the single value input is replaced by min/max (never both).
    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    expect(screen.queryByLabelText('Thickness (inches)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Minimum thickness (inches)')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum thickness (inches)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByLabelText('Minimum thickness (inches)')).not.toBeInTheDocument();
    // Sub-second on its own, but it renders the whole report form four times over and shares a
    // machine with every other workspace's suite under `turbo run test`. Explicit budget, per the
    // convention the convex suites follow (see `ci-test-timeout-5s`).
  }, 20_000);

  it('records typed ice descriptions and notes into form state', () => {
    const { getForm } = renderFields();
    fireEvent.click(screen.getByRole('button', { name: 'Black ice' }));
    fireEvent.change(screen.getByPlaceholderText(/Anything else/), {
      target: { value: 'Great glass.' },
    });
    expect(getForm().iceTypes).toEqual(['black_ice']);
    expect(getForm().notes).toBe('Great glass.');
  });

  it('arms map pin placement, and shows/clears a set put-in pin', () => {
    const { spies } = renderFields({ putInPin: null });
    fireEvent.click(screen.getByRole('button', { name: 'Set access point on the map' }));
    expect(spies.onRequestPin).toHaveBeenCalledOnce();
  });

  it('shows a set put-in pin with a clear control', () => {
    const { spies } = renderFields({ putInPin: { lat: 44.4, lng: -73.2 } });
    expect(screen.getByText(/Pin set at 44\.4000, -73\.2000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear pin' }));
    expect(spies.onClearPin).toHaveBeenCalledOnce();
  });

  it('offers the geotag opt-in only for a photo that carries a location (D42)', () => {
    const { spies } = renderFields({
      photos: [
        { id: 'p1', previewUrl: 'blob:a', coord: { lat: 44, lng: -73 }, placeOnMap: false },
        { id: 'p2', previewUrl: 'blob:b', placeOnMap: false },
      ],
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1); // only the geotagged photo gets the toggle
    expect(screen.getByText('No location in this photo.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(spies.onTogglePlaceOnMap).toHaveBeenCalledWith('p1', true);
  });

  it('submits and cancels', () => {
    const { spies } = renderFields();
    fireEvent.click(screen.getByRole('button', { name: 'Post report' }));
    expect(spies.onSubmit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(spies.onCancel).toHaveBeenCalledOnce();
  });
});
