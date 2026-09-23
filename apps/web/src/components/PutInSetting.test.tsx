import { SHOW_PUT_IN_LABEL, SHOW_PUT_IN_SETTING_EXPLAINER } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PutInSettingView } from './PutInSetting';

function renderSetting(initial: boolean) {
  const onToggle = vi.fn();
  function Wrapper() {
    const [shown, setShown] = useState(initial);
    return (
      <PutInSettingView
        shown={shown}
        onToggle={(next) => {
          onToggle(next);
          setShown(next);
        }}
      />
    );
  }
  render(<Wrapper />);
  return { onToggle, checkbox: () => screen.getByRole('checkbox') };
}

describe('PutInSettingView (the remembered put-in default, Phase 04 #7)', () => {
  it('renders checked when the next report will show the put-in', () => {
    expect(renderSetting(true).checkbox()).toBeChecked();
    expect(screen.getByText(SHOW_PUT_IN_LABEL)).toBeInTheDocument();
    expect(screen.getByText(SHOW_PUT_IN_SETTING_EXPLAINER)).toBeInTheDocument();
  });

  it('renders unchecked when the default is off', () => {
    expect(renderSetting(false).checkbox()).not.toBeChecked();
  });

  it('flips on click with no save step, in both directions', () => {
    const { onToggle, checkbox } = renderSetting(true);
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(checkbox()).not.toBeChecked();
    fireEvent.click(checkbox());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(checkbox()).toBeChecked();
  });
});
