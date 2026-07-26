import { AGGREGATE_OPT_OUT_EXPLAINER, AGGREGATE_OPT_OUT_LABEL } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AggregateTracksSettingView } from './AggregateTracksSetting';

/** Drives the view with the same state the container holds, so the checkbox reflects a real flip. */
function renderSetting(initial: boolean) {
  const onToggle = vi.fn();
  function Wrapper() {
    const [excluded, setExcluded] = useState(initial);
    return (
      <AggregateTracksSettingView
        excluded={excluded}
        onToggle={(next) => {
          onToggle(next);
          setExcluded(next);
        }}
      />
    );
  }
  render(<Wrapper />);
  return { onToggle, checkbox: () => screen.getByRole('checkbox') };
}

describe('AggregateTracksSettingView (D58 opt-out)', () => {
  it('renders unchecked when the person has not opted out', () => {
    const { checkbox } = renderSetting(false);
    expect(checkbox()).not.toBeChecked();
  });

  it('renders checked when the person has opted out', () => {
    const { checkbox } = renderSetting(true);
    expect(checkbox()).toBeChecked();
  });

  it('opts out on the first click and back in on the second — no save step', () => {
    const { onToggle, checkbox } = renderSetting(false);
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('states the retroactive effect and what the toggle leaves alone', () => {
    renderSetting(false);
    // The promise itself is the feature here: someone deciding whether to flip this needs to know it
    // reaches already-posted paths, and that it doesn't quietly disable recording or Strava.
    expect(screen.getByText(AGGREGATE_OPT_OUT_EXPLAINER)).toBeInTheDocument();
    expect(screen.getByText(AGGREGATE_OPT_OUT_EXPLAINER).textContent).toMatch(
      /already posted[\s\S]*Strava uploads are unaffected/,
    );
  });

  it('labels the checkbox so clicking the text toggles it', () => {
    const { onToggle } = renderSetting(false);
    fireEvent.click(screen.getByText(AGGREGATE_OPT_OUT_LABEL));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
