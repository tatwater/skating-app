import { emptyReportForm, type ReportFormState } from '@skating/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type PhotoDraftView, ReportFormFields } from './ReportForm'

const FIXED_NOW = Date.UTC(2026, 0, 5, 12, 0)

function renderFields(
  opts: { putInPin?: { lat: number; lng: number } | null; photos?: PhotoDraftView[] } = {},
) {
  const spies = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onRequestPin: vi.fn(),
    onClearPin: vi.fn(),
    onAddFiles: vi.fn(),
    onRemovePhoto: vi.fn(),
    onTogglePlaceOnMap: vi.fn(),
  }
  let latest: ReportFormState | undefined
  function Wrapper() {
    const [form, setForm] = useState(() => emptyReportForm(FIXED_NOW))
    latest = form
    return (
      <ReportFormFields
        form={form}
        onFormChange={setForm}
        putInPin={opts.putInPin ?? null}
        photos={opts.photos ?? []}
        submitting={false}
        error={null}
        {...spies}
      />
    )
  }
  render(<Wrapper />)
  return { spies, getForm: () => latest as ReportFormState }
}

describe('ReportFormFields', () => {
  it('has no visibility control — all reports are public (D13)', () => {
    renderFields()
    expect(screen.queryByRole('button', { name: 'Public' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Only me' })).not.toBeInTheDocument()
  })

  it('adds and removes thickness readings, toggling value ↔ range inputs (XOR)', () => {
    renderFields()
    expect(screen.queryByLabelText('Thickness (inches)')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add a thickness reading' }))
    expect(screen.getByLabelText('Thickness (inches)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Minimum thickness (inches)')).not.toBeInTheDocument()

    // Switch this reading to a range — the single value input is replaced by min/max (never both).
    fireEvent.click(screen.getByRole('button', { name: 'Range' }))
    expect(screen.queryByLabelText('Thickness (inches)')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Minimum thickness (inches)')).toBeInTheDocument()
    expect(screen.getByLabelText('Maximum thickness (inches)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByLabelText('Minimum thickness (inches)')).not.toBeInTheDocument()
  })

  it('records typed ice descriptions and notes into form state', () => {
    const { getForm } = renderFields()
    fireEvent.click(screen.getByRole('button', { name: 'Black ice' }))
    fireEvent.change(screen.getByPlaceholderText(/Anything else/), {
      target: { value: 'Great glass.' },
    })
    expect(getForm().iceTypes).toEqual(['black_ice'])
    expect(getForm().notes).toBe('Great glass.')
  })

  it('arms map pin placement, and shows/clears a set put-in pin', () => {
    const { spies } = renderFields({ putInPin: null })
    fireEvent.click(screen.getByRole('button', { name: 'Set access point on the map' }))
    expect(spies.onRequestPin).toHaveBeenCalledOnce()
  })

  it('shows a set put-in pin with a clear control', () => {
    const { spies } = renderFields({ putInPin: { lat: 44.4, lng: -73.2 } })
    expect(screen.getByText(/Pin set at 44\.4000, -73\.2000/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear pin' }))
    expect(spies.onClearPin).toHaveBeenCalledOnce()
  })

  it('offers the geotag opt-in only for a photo that carries a location (D42)', () => {
    const { spies } = renderFields({
      photos: [
        { id: 'p1', previewUrl: 'blob:a', coord: { lat: 44, lng: -73 }, placeOnMap: false },
        { id: 'p2', previewUrl: 'blob:b', placeOnMap: false },
      ],
    })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1) // only the geotagged photo gets the toggle
    expect(screen.getByText('No location in this photo.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(spies.onTogglePlaceOnMap).toHaveBeenCalledWith('p1', true)
  })

  it('submits and cancels', () => {
    const { spies } = renderFields()
    fireEvent.click(screen.getByRole('button', { name: 'Post report' }))
    expect(spies.onSubmit).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(spies.onCancel).toHaveBeenCalledOnce()
  })
})
