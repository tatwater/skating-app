import { inchesToCm } from '@skating/core'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ReportView, type ReportViewData } from './ReportDetail'
import { Sheet, SheetContent } from './ui/sheet'

/**
 * Renders `ui` inside the two contexts `ReportView` needs: an open `Sheet` (its header uses the
 * Base UI dialog Title/Description) and a router (the "View the lake" Link). A tiny memory router
 * with the `/water/$id` route it links to is enough — we're asserting rendered output, not routing.
 */
function renderInDrawer(ui: ReactNode) {
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

const FIXTURE: ReportViewData = {
  waterBodyId: 'wb1',
  bodyName: 'Lake Morey',
  authorName: 'Ada',
  skateEndTime: Date.UTC(2026, 0, 5, 19, 30),
  skateQuality: 'great',
  iceTypes: ['black_ice'],
  surfaceTags: ['orange_peel'],
  iceThickness: { readings: [{ valueCm: inchesToCm(4), method: 'measured' }] },
  snowCoverCm: inchesToCm(1.5),
  conditions: { airTempC: 0, windSpeedKph: 16.09344, windDir: 'NW', source: 'user' },
  notes: 'Best ice of the year.',
  photos: [
    {
      photoId: 'p1',
      url: 'https://cdn/full.jpg',
      thumbUrl: 'https://cdn/thumb.jpg',
      caption: 'view',
    },
  ],
}

describe('ReportView', () => {
  it('renders the lake name, author, and skate time', async () => {
    renderInDrawer(<ReportView data={FIXTURE} />)
    expect(await screen.findByText('Lake Morey')).toBeInTheDocument()
    expect(screen.getByText(/by Ada/)).toBeInTheDocument()
    expect(screen.getByText(/Jan 5, 2026/)).toBeInTheDocument()
  })

  it('shows ice description with humanized community vocabulary and quality', async () => {
    renderInDrawer(<ReportView data={FIXTURE} />)
    expect(await screen.findByText('Black ice')).toBeInTheDocument()
    expect(screen.getByText('Orange peel')).toBeInTheDocument()
    expect(screen.getByText('Great')).toBeInTheDocument()
  })

  it('renders measurements in imperial (D25)', async () => {
    renderInDrawer(<ReportView data={FIXTURE} />)
    expect(await screen.findByText('4″ (measured)')).toBeInTheDocument()
    expect(screen.getByText('1.5″')).toBeInTheDocument() // snow cover
    expect(screen.getByText('32°F')).toBeInTheDocument()
    expect(screen.getByText('10 mph NW')).toBeInTheDocument()
  })

  it('renders notes, a photo thumbnail linking to the full image, and a lake back-link', async () => {
    renderInDrawer(<ReportView data={FIXTURE} />)
    expect(await screen.findByText('Best ice of the year.')).toBeInTheDocument()
    const thumb = screen.getByRole('img', { name: 'view' })
    expect(thumb).toHaveAttribute('src', 'https://cdn/thumb.jpg')
    expect(thumb.closest('a')).toHaveAttribute('href', 'https://cdn/full.jpg')
    expect(screen.getByRole('link', { name: 'View the lake' })).toBeInTheDocument()
  })

  it('omits sections with no data (a notes-only report is valid, D3)', async () => {
    renderInDrawer(
      <ReportView
        data={{
          waterBodyId: 'wb2',
          skateEndTime: Date.UTC(2026, 0, 5, 19, 30),
          iceTypes: [],
          surfaceTags: [],
          notes: 'Did not skate — too much slush.',
          photos: [],
        }}
      />,
    )
    expect(await screen.findByText('Did not skate — too much slush.')).toBeInTheDocument()
    expect(screen.queryByText('Ice types')).not.toBeInTheDocument()
    expect(screen.queryByText('Thickness')).not.toBeInTheDocument()
  })

  it('shows a "Blocked" chip on a blocked author’s report — content still renders (D3)', async () => {
    renderInDrawer(<ReportView data={{ ...FIXTURE, authorBlocked: true }} />)
    // The report content is unaffected by the block…
    expect(await screen.findByText('Lake Morey')).toBeInTheDocument()
    expect(screen.getByText('Best ice of the year.')).toBeInTheDocument()
    // …but the author line carries the chip so the viewer sees the block is working.
    expect(screen.getByText('Blocked')).toBeInTheDocument()
  })

  it('shows no "Blocked" chip for a normal author', async () => {
    renderInDrawer(<ReportView data={FIXTURE} />)
    await screen.findByText('Lake Morey')
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument()
  })
})
