import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { type HazardListItem, HazardListView } from './HazardList'

function renderWithRouter(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const hazardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/hazard/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, hazardRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  // biome-ignore lint/suspicious/noExplicitAny: the test router isn't the app's registered router.
  return render(<RouterProvider router={router as any} />)
}

function hazard(overrides: Partial<HazardListItem> = {}): HazardListItem {
  return { _id: 'h1', type: 'open_water', freshness: 'fresh', provisional: false, ...overrides }
}

describe('HazardListView', () => {
  it('lists current hazards by label', async () => {
    renderWithRouter(<HazardListView hazards={[hazard()]} knownFeatures={[]} />)
    expect(await screen.findByText('Open water / lead')).toBeInTheDocument()
  })

  // The distinction between "nobody has checked lately" and "it's gone" has to survive to the screen.
  it('collapses stale hazards behind a toggle instead of dropping them', async () => {
    renderWithRouter(
      <HazardListView
        hazards={[hazard({ _id: 'fresh1' }), hazard({ _id: 'old1', freshness: 'stale' })]}
        knownFeatures={[]}
      />,
    )
    const toggle = await screen.findByRole('button', { name: /Show 1 older marker/ })
    expect(screen.getAllByText('Open water / lead')).toHaveLength(1)

    fireEvent.click(toggle)
    expect(screen.getAllByText('Open water / lead')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Hide older markers' })).toBeInTheDocument()
  })

  it('says so when everything reported is old, rather than looking empty', async () => {
    renderWithRouter(
      <HazardListView hazards={[hazard({ freshness: 'stale' })]} knownFeatures={[]} />,
    )
    expect(await screen.findByText(/only older, unverified markers/)).toBeInTheDocument()
  })

  it('shows known seasonal features with their permanence caveat', async () => {
    renderWithRouter(
      <HazardListView hazards={[]} knownFeatures={[{ _id: 'bf1', type: 'spring_current' }]} />,
    )
    expect(await screen.findByText('Spring current')).toBeInTheDocument()
    expect(screen.getByText(/weak every season/)).toBeInTheDocument()
  })

  it('marks unconfirmed, healing and crossing states', async () => {
    renderWithRouter(
      <HazardListView
        hazards={[
          hazard({ _id: 'a', provisional: true }),
          hazard({ _id: 'b', healingState: 'healing_unsafe' }),
          hazard({ _id: 'c', type: 'ridge_crossing' }),
        ]}
        knownFeatures={[]}
      />,
    )
    expect(await screen.findByText('Unconfirmed')).toBeInTheDocument()
    expect(screen.getByText('Healing')).toBeInTheDocument()
    expect(screen.getByText('Crossing')).toBeInTheDocument()
  })

  // Non-negotiable: the absence of a marker is not information (D3/D54).
  it('states that no alert does not mean the ice is safe', async () => {
    renderWithRouter(<HazardListView hazards={[hazard()]} knownFeatures={[]} />)
    expect(await screen.findByText(/does not mean the ice is safe/)).toBeInTheDocument()
  })

  it('renders nothing at all when a lake has no hazards or known features', () => {
    const { container } = renderWithRouter(<HazardListView hazards={[]} knownFeatures={[]} />)
    expect(container.textContent).toBe('')
  })
})
