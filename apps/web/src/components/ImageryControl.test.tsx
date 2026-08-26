import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ImageryControl } from './ImageryControl';

/** Drives `imageryOn` the way `MapView` does, so the button and the X operate one piece of state. */
function Harness({
  initialOn = false,
  hasHazards = false,
  loading = false,
  heading = 'Freeze-up timeline' as string | null,
  // What `MapView` resolves for the slot: the archive's season while a frame is on this lake, the
  // aerial's otherwise. The component is handed the answer, not the question.
  seasonLabel = 'winter 2025–26' as string | null,
}) {
  const [on, setOn] = useState(initialOn);
  return (
    <ImageryControl
      visible
      imageryOn={on}
      onToggleImagery={setOn}
      hazardsOn={false}
      onToggleHazards={vi.fn()}
      heading={heading}
      seasonLabel={seasonLabel}
      loading={loading}
      hasHazards={hasHazards}
    >
      <p>the scrubber</p>
    </ImageryControl>
  );
}

describe('ImageryControl', () => {
  it('grows the button into the scrubber, and the X collapses it back', () => {
    render(<Harness />);

    // Both halves are always in the document — the collapse is animated height, not a mount — so the
    // assertions are about which half is *reachable*, which is what `inert` governs.
    const collapsed = screen.getByRole('button', { name: 'Show imagery' }).closest('[inert]');
    expect(collapsed).toBeNull();
    expect(screen.getByText('the scrubber').closest('[inert]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show imagery' }));

    expect(screen.getByText('the scrubber').closest('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show imagery' }).closest('[inert]')).not.toBeNull();
    expect(screen.getByText('winter 2025–26')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off imagery' }));

    expect(screen.getByText('the scrubber').closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Show imagery' }).closest('[inert]')).toBeNull();
  });

  it('never offers a hazard toggle for a lake with no hazards', () => {
    render(<Harness initialOn />);
    expect(screen.queryByLabelText(/hazards/i)).toBeNull();

    render(<Harness initialOn hasHazards />);
    expect(screen.getByText('Hazards')).toBeTruthy();
  });

  it('renders nothing at all when no lake is open', () => {
    const { container } = render(
      <ImageryControl
        visible={false}
        imageryOn
        onToggleImagery={vi.fn()}
        hazardsOn={false}
        onToggleHazards={vi.fn()}
        heading="Freeze-up timeline"
        seasonLabel="winter 2025–26"
        loading={false}
        hasHazards
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  describe('the heading row', () => {
    it('⚠ carries the title, the season and the way out on ONE line', () => {
      // These were two rows, and the top one — an aerial date — read as the caption of the picture
      // below it. One row, one season slot, and the X beside it.
      render(<Harness initialOn />);
      const row = screen.getByRole('heading', { name: 'Freeze-up timeline' }).parentElement;
      expect(row?.textContent).toContain('winter 2025–26');
      expect(row?.querySelector('[aria-label="Turn off imagery"]')).not.toBeNull();
    });

    it('names the aerial’s own season when the aerial is what this lake is showing', () => {
      // No archive, no passes, or a winter clouded out end to end. Then the lake on screen is a
      // midsummer photograph and D147 says a skater reading it in January has to be told why —
      // in the archive's grammar, because it is the same slot the archive's winters use.
      render(<Harness initialOn seasonLabel="summer 2023 · latest aerial available" />);
      expect(screen.getByText('summer 2023 · latest aerial available')).toBeTruthy();
      expect(screen.queryByText('winter 2025–26')).toBeNull();
    });

    it('drops the heading where there is no timeline to head, keeping the X', () => {
      // An archive that was never configured. The panel is then a bare toggle for the aerial, and a
      // heading over an empty box would promise a control that is not coming.
      render(<Harness initialOn heading={null} seasonLabel="summer 2023" />);
      expect(screen.queryByRole('heading', { name: 'Freeze-up timeline' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Turn off imagery' })).toBeTruthy();
    });

    it('spends the season slot on progress while the aerial is still arriving', () => {
      render(<Harness initialOn loading />);
      expect(screen.getByText('Loading imagery…')).toBeTruthy();
      expect(screen.getByText('Loading aerial imagery')).toBeTruthy();
      expect(screen.queryByText('winter 2025–26')).toBeNull();
    });
  });
});
