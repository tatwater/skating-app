import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { drawsOn, SurfaceToaster } from './AppToaster';
import { createToastManager, toast } from './kit/toast';

beforeAll(() => {
  // jsdom has no Web Animations: the toast's motion asks for one it can play and finish.
  Element.prototype.animate = function animate() {
    return {
      cancel() {},
      pause() {},
      play() {},
      currentTime: 0,
      finished: Promise.resolve(),
    } as unknown as Animation;
  };
});

/**
 * **The app's one dock** draws an answer wherever the viewer is when it comes — the console, its
 * loading splash, or the skater app after leaving or being turned away — and the skater surface's
 * own toasts sit behind one switch.
 */
describe('the app’s one dock', () => {
  it('draws a console refusal on a skater page: the answer arrives after the viewer has left', async () => {
    const manager = createToastManager();
    render(<SurfaceToaster pathname="/" manager={manager} />);
    act(() => {
      toast(
        { title: 'Not saved · Mascoma Lake', description: 'The ruling: Not allowed', tone: 'bad' },
        manager,
      );
    });
    expect((await screen.findAllByText('Not saved · Mascoma Lake')).length).toBeGreaterThan(0);
  });

  it('sits past the rail in the console and in from the corner elsewhere', () => {
    const { rerender } = render(
      <SurfaceToaster pathname="/admin/body/x" manager={createToastManager()} />,
    );
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveAttribute(
      'data-placement',
      'rail',
    );
    rerender(<SurfaceToaster pathname="/water/x" manager={createToastManager()} />);
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveAttribute(
      'data-placement',
      'edge',
    );
  });

  it('the switch: the console draws every toast; the skater surface all, only refusals, or none', () => {
    expect(drawsOn('console', 'none')).toBeUndefined();
    expect(drawsOn('skater', 'all')).toBeUndefined();
    expect(drawsOn('skater', 'refusals')?.('bad')).toBe(true);
    expect(drawsOn('skater', 'refusals')?.('default')).toBe(false);
    expect(drawsOn('skater', 'none')?.('bad')).toBe(false);
  });

  it('with only refusals on the skater surface, a skater app toast isn’t drawn and a refusal is', async () => {
    const manager = createToastManager();
    render(<SurfaceToaster pathname="/" manager={manager} policy="refusals" />);
    act(() => {
      toast({ title: 'Couldn’t get your location.' }, manager);
      toast({ title: 'Not saved · Mascoma Lake', tone: 'bad' }, manager);
    });
    expect((await screen.findAllByText('Not saved · Mascoma Lake')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Couldn’t get your location.')).toHaveLength(0);
  });
});
