import { bundledHazardIds, toggleBundleOptOut } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { type BundleCandidate, HazardBundlePromptView } from './HazardBundlePrompt';

const CANDIDATES: BundleCandidate[] = [
  { _id: 'h1', type: 'open_water', firstReportedAt: 1 },
  { _id: 'h2', type: 'pressure_ridge', firstReportedAt: 2 },
];

/** Drives the view with the same opt-out state the report form holds. */
function renderPrompt(candidates: BundleCandidate[] = CANDIDATES) {
  let selected: string[] = [];
  function Wrapper() {
    const [optedOut, setOptedOut] = useState<string[]>([]);
    selected = bundledHazardIds(
      candidates.map((c) => c._id),
      optedOut,
    );
    return (
      <HazardBundlePromptView
        candidates={candidates}
        selectedIds={selected}
        onToggle={(id, checked) => setOptedOut((prev) => toggleBundleOptOut(prev, id, checked))}
      />
    );
  }
  render(<Wrapper />);
  return { getSelected: () => selected };
}

describe('HazardBundlePromptView', () => {
  // Attaching changes how an observation is attributed and how it presents in the feed, so every
  // hazard about to be bundled is named on screen — nothing is ever attached invisibly (D55).
  it('itemises every candidate rather than just counting them', () => {
    renderPrompt();
    expect(screen.getByText('Open water / lead')).toBeInTheDocument();
    expect(screen.getByText('Pressure ridge')).toBeInTheDocument();
  });

  it('starts pre-checked', () => {
    const { getSelected } = renderPrompt();
    expect(getSelected()).toEqual(['h1', 'h2']);
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeChecked();
    }
  });

  it('drops just the one the author unchecks', () => {
    const { getSelected } = renderPrompt();
    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    expect(getSelected()).toEqual(['h2']);
  });

  it('re-checking puts it back', () => {
    const { getSelected } = renderPrompt();
    const first = screen.getAllByRole('checkbox')[0] as HTMLElement;
    fireEvent.click(first);
    fireEvent.click(first);
    expect(getSelected()).toEqual(['h1', 'h2']);
  });

  // Declining must not read as discarding — the hazard is already on the map and stays there.
  it('says the hazards stay on the map either way', () => {
    renderPrompt();
    expect(screen.getByText(/stay on the map either way/)).toBeInTheDocument();
  });

  it('renders nothing when the skater flagged nothing here', () => {
    const { container } = render(
      <HazardBundlePromptView candidates={[]} selectedIds={[]} onToggle={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
