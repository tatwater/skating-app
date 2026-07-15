import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type LakeHit, LakeSearchBox } from './LakeSearch'

const HITS: LakeHit[] = [
  { _id: 'a', name: 'Lake George', type: 'lake', centroid: { lat: 43.6, lng: -73.5 } },
  { _id: 'b', name: 'Sebago Lake', type: 'reservoir', centroid: { lat: 43.8, lng: -70.5 } },
]

function renderBox(overrides: Partial<React.ComponentProps<typeof LakeSearchBox>> = {}) {
  const onSelect = vi.fn()
  const onInputValueChange = vi.fn()
  render(
    <LakeSearchBox
      items={HITS}
      inputValue="lake"
      onInputValueChange={onInputValueChange}
      onSelect={onSelect}
      emptyVisible={false}
      open
      {...overrides}
    />,
  )
  return { onSelect, onInputValueChange }
}

describe('LakeSearchBox', () => {
  it('renders result rows with a humanized type label', () => {
    renderBox()
    expect(screen.getByText('Lake George')).toBeInTheDocument()
    expect(screen.getByText('Sebago Lake')).toBeInTheDocument()
    expect(screen.getByText('Reservoir')).toBeInTheDocument()
  })

  it('calls onSelect with the chosen hit when a result is clicked', () => {
    const { onSelect } = renderBox({ inputValue: 'george' })
    fireEvent.click(screen.getByRole('option', { name: /Lake George/ }))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'a', name: 'Lake George' }),
    )
  })

  it('reports typing through onInputValueChange', () => {
    const { onInputValueChange } = renderBox({ items: [], inputValue: '', open: false })
    fireEvent.change(screen.getByLabelText('Search lakes by name'), { target: { value: 'morey' } })
    // Base UI passes (value, eventDetails); the container's setText ignores the second arg.
    expect(onInputValueChange.mock.calls[0]?.[0]).toBe('morey')
  })

  it('shows the empty state when emptyVisible', () => {
    renderBox({ items: [], inputValue: 'zzzz', emptyVisible: true })
    expect(screen.getByText('No lakes found.')).toBeInTheDocument()
  })
})
