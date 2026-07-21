import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { HazardView, type HazardViewData } from './HazardDetail'
import { Sheet, SheetContent } from './ui/sheet'

/**
 * Renders `ui` inside the two contexts `HazardView` needs: an open `Sheet` (its header uses the
 * Base UI dialog Title/Description) and a router (the lake Link). Mirrors `ReportDetail.test.tsx`.
 */
function renderWithRouter(ui: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <Sheet open>
        <SheetContent>{ui}</SheetContent>
      </Sheet>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const waterRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/water/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, waterRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  // biome-ignore lint/suspicious/noExplicitAny: the test router isn't the app's registered router.
  return render(<RouterProvider router={router as any} />)
}

function data(overrides: Partial<HazardViewData> = {}): HazardViewData {
  return {
    hazardId: 'h1',
    waterBodyId: 'wb1',
    bodyName: 'Shelburne Pond',
    type: 'open_water',
    freshness: 'fresh',
    provisional: false,
    healing: false,
    archived: false,
    firstReportedAt: Date.now() - 2 * 3_600_000,
    lastConfirmedAt: Date.now() - 2 * 3_600_000,
    confirmCount: 2,
    photos: [],
    ...overrides,
  }
}

describe('HazardView', () => {
  it('shows the hazard type label, not the raw enum key', async () => {
    renderWithRouter(<HazardView data={data()} />)
    expect(await screen.findByText('Open water / lead')).toBeInTheDocument()
  })

  it('offers all three verdicts', async () => {
    renderWithRouter(<HazardView data={data()} onConfirm={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /Still here/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Healing — still unsafe/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fully healed & safe/ })).toBeInTheDocument()
  })

  it('confirms "still here" in one click', async () => {
    const onConfirm = vi.fn()
    renderWithRouter(<HazardView data={data()} onConfirm={onConfirm} />)
    fireEvent.click(await screen.findByRole('button', { name: /Still here/ }))
    expect(onConfirm).toHaveBeenCalledWith('still_there')
  })

  it('keeps "healing but unsafe" a single click too — it is not destructive', async () => {
    const onConfirm = vi.fn()
    renderWithRouter(<HazardView data={data()} onConfirm={onConfirm} />)
    fireEvent.click(await screen.findByRole('button', { name: /Healing — still unsafe/ }))
    expect(onConfirm).toHaveBeenCalledWith('healing_unsafe')
  })

  // The only destructive verdict gets a deliberate second step: a mis-tap that clears a real hazard
  // is the worst outcome this screen can produce (D3).
  it('requires a second confirmation before reporting a hazard fully healed', async () => {
    const onConfirm = vi.fn()
    renderWithRouter(<HazardView data={data()} onConfirm={onConfirm} />)

    fireEvent.click(await screen.findByRole('button', { name: /Fully healed & safe/ }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText(/retires the marker for everyone/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: "Yes, it's fully healed" }))
    expect(onConfirm).toHaveBeenCalledWith('fully_healed')
  })

  it('lets the skater back out of the destructive verdict', async () => {
    const onConfirm = vi.fn()
    renderWithRouter(<HazardView data={data()} onConfirm={onConfirm} />)
    fireEvent.click(await screen.findByRole('button', { name: /Fully healed & safe/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Fully healed & safe/ })).toBeInTheDocument()
  })

  it('relabels the verdicts for a ridge crossing', async () => {
    renderWithRouter(<HazardView data={data({ type: 'ridge_crossing' })} onConfirm={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /Still crossable/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Crossing looks dicey now/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Still here/ })).not.toBeInTheDocument()
  })

  // The sentence that has to do the work of not sounding like an all-clear.
  it('warns that a stale open-water report may now be thin ice', async () => {
    renderWithRouter(<HazardView data={data({ freshness: 'stale' })} />)
    expect(await screen.findByText(/refrozen lead is thin ice/)).toBeInTheDocument()
  })

  it('does not show a staleness caveat on a fresh report', async () => {
    renderWithRouter(<HazardView data={data({ freshness: 'fresh' })} />)
    // Wait for the drawer to actually render before asserting an absence, else this passes vacuously.
    await screen.findByText('Open water / lead')
    expect(screen.queryByText(/refrozen lead is thin ice/)).not.toBeInTheDocument()
  })

  it('names what a healed ridge becomes', async () => {
    renderWithRouter(<HazardView data={data({ type: 'pressure_ridge', healing: true })} />)
    expect(await screen.findByText(/ice sharks/)).toBeInTheDocument()
  })

  it('marks an unconfirmed hazard as such', async () => {
    renderWithRouter(<HazardView data={data({ provisional: true, confirmCount: 0 })} />)
    expect(await screen.findByText('Unconfirmed')).toBeInTheDocument()
    expect(screen.getByText(/nobody else has confirmed it yet/)).toBeInTheDocument()
  })

  it('always states that the footprint is approximate', async () => {
    renderWithRouter(<HazardView data={data()} />)
    expect(await screen.findByText(/approximation, not a surveyed boundary/)).toBeInTheDocument()
  })

  it('hides the confirm control on a retired hazard', async () => {
    renderWithRouter(<HazardView data={data({ archived: true })} onConfirm={vi.fn()} />)
    expect(await screen.findByText('Retired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Still here/ })).not.toBeInTheDocument()
  })

  it('disables the verdicts while a confirmation is in flight', async () => {
    renderWithRouter(<HazardView data={data()} onConfirm={vi.fn()} confirming />)
    expect(await screen.findByRole('button', { name: /Still here/ })).toBeDisabled()
  })
})
