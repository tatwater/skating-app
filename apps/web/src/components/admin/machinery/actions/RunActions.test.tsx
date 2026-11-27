import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { LOAD_ID } from '../corpus/runFixtures';
import type { LivenessView } from '../corpus/runViews';
import { RunActions } from './RunActions';
import type { RunWrites } from './useRunWrites';

const TARGET = { runId: LOAD_ID, title: 'load' };
const live = (state: 'running' | 'late' | 'stalled' | 'waiting'): LivenessView => ({
  state,
  quietMs: 0,
  expectedMs: 180_000,
  waitUntil: null,
});

function fakeWrites(landed = true): RunWrites & Record<keyof RunWrites, ReturnType<typeof vi.fn>> {
  return {
    markFailed: vi.fn(async () => landed),
    wait: vi.fn(async () => landed),
    stop: vi.fn(async () => landed),
  };
}

const bar = () => document.querySelector('[data-slot="run-actions"]');

describe("a run's action bar", () => {
  test('nothing while on time, nothing for a viewer who cannot write', () => {
    const { rerender } = render(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('running')}
        marked={false}
        writes={fakeWrites()}
      />,
    );
    expect(bar()).toBeNull();
    rerender(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('stalled')}
        marked={false}
        writes={null}
      />,
    );
    expect(bar()).toBeNull();
  });

  test('late: Mark failed only; stalled: Wait too; never a Stop', () => {
    const { rerender } = render(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('late')}
        marked={false}
        writes={fakeWrites()}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Mark failed/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Wait 30 minutes/ })).toBeNull();
    rerender(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('stalled')}
        marked={false}
        writes={fakeWrites()}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Wait 30 minutes/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull();
  });

  test('Wait sends at once; Stop, with its switch on, too', async () => {
    const writes = fakeWrites();
    render(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('stalled')}
        marked={false}
        writes={writes}
        stopDrawn
      />,
    );
    const [wait] = screen.getAllByRole('button', { name: /Wait 30 minutes/ });
    await act(async () => fireEvent.click(wait as HTMLElement));
    expect(writes.wait).toHaveBeenCalledWith(TARGET);
    const [stop] = screen.getAllByRole('button', { name: /^Stop/ });
    await act(async () => fireEvent.click(stop as HTMLElement));
    expect(writes.stop).toHaveBeenCalledWith(TARGET);
  });

  test('Mark failed asks why; the reason is required; a landing closes, a refusal keeps the reason', async () => {
    const writes = fakeWrites(false);
    render(
      <RunActions
        target={TARGET}
        status="running"
        liveness={live('late')}
        marked={false}
        writes={writes}
      />,
    );
    const [mark] = screen.getAllByRole('button', { name: /Mark failed/ });
    fireEvent.click(mark as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    const confirm = () =>
      dialog.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]');
    expect(confirm()).toHaveAttribute('data-disabled');
    fireEvent.click(confirm() as HTMLElement);
    expect(writes.markFailed).not.toHaveBeenCalled();
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(confirm()).toHaveAttribute('data-disabled');
    fireEvent.change(field, { target: { value: ' Laptop slept ' } });
    expect(confirm()).not.toHaveAttribute('data-disabled');
    await act(async () => fireEvent.click(confirm() as HTMLElement));
    expect(writes.markFailed).toHaveBeenCalledWith(TARGET, 'Laptop slept');
    // Refused: still open over the kept reason (the toast is the write path's).
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(' Laptop slept ');
    writes.markFailed.mockResolvedValueOnce(true);
    await act(async () => fireEvent.click(confirm() as HTMLElement));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
