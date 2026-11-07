import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveMapSpec, useSkaterMapStore } from '@/stores/skaterMapStore';
import { exploreMapSpec, HIDDEN_MAP_SPEC, lakeMapSpec, type MapSpec } from './mapSpec';
import {
  activeMapHandlers,
  type MapSpecHandlers,
  publishMapInstance,
  useMapInstance,
  useMapSpec,
} from './useMapSpec';

const effective = () => effectiveMapSpec(useSkaterMapStore.getState().specs);

beforeEach(() => {
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

function View({ spec, ...handlers }: { spec: MapSpec } & MapSpecHandlers) {
  useMapSpec(spec, handlers);
  return null;
}

function Flow({ spec, ...handlers }: { spec: MapSpec } & MapSpecHandlers) {
  useMapSpec(spec, { ...handlers, slot: 'flow' });
  return null;
}

describe('useMapSpec', () => {
  it('holds a view’s spec from mount to unmount', () => {
    const { unmount } = render(<View spec={exploreMapSpec()} />);
    expect(effective().id).toBe('explore');
    unmount();
    expect(effective()).toBe(HIDDEN_MAP_SPEC);
  });

  it('swaps views in one commit, and the next view’s handlers survive the last one’s cleanup', () => {
    const seen: string[] = [];
    const stop = useSkaterMapStore.subscribe((s) => seen.push(effectiveMapSpec(s.specs).id));
    const { rerender } = render(<View key="a" spec={exploreMapSpec()} />);
    const onOpenImagery = vi.fn();
    rerender(<View key="b" spec={lakeMapSpec('m')} onOpenImagery={onOpenImagery} />);
    stop();
    expect(effective().id).toBe('lake');
    // The next view's handlers survive the last view's cleanup.
    activeMapHandlers().onOpenImagery?.();
    expect(onOpenImagery).toHaveBeenCalledOnce();
    expect(seen.at(-1)).toBe('lake');
  });

  it('lets a flow sit over its view, with its own handlers, and gives the view back', () => {
    const viewCapture = vi.fn();
    const flowCapture = vi.fn();
    const { rerender } = render(
      <>
        <View spec={lakeMapSpec('m')} onCapture={viewCapture} />
        <Flow spec={{ ...lakeMapSpec('m'), id: 'place-hazard' }} onCapture={flowCapture} />
      </>,
    );
    expect(effective().id).toBe('place-hazard');
    activeMapHandlers().onCapture?.({ lng: 1, lat: 2 });
    expect(flowCapture).toHaveBeenCalledWith({ lng: 1, lat: 2 });
    rerender(<View spec={lakeMapSpec('m')} onCapture={viewCapture} />);
    expect(effective().id).toBe('lake');
    activeMapHandlers().onCapture?.({ lng: 3, lat: 4 });
    expect(viewCapture).toHaveBeenCalledWith({ lng: 3, lat: 4 });
  });

  it('reads the latest handler without re-declaring the spec', () => {
    const spec = lakeMapSpec('m');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<View spec={spec} onExitMode={first} />);
    const specs = useSkaterMapStore.getState().specs;
    rerender(<View spec={spec} onExitMode={second} />);
    expect(useSkaterMapStore.getState().specs).toBe(specs);
    activeMapHandlers().onExitMode?.();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it('has no handlers when no view has declared', () => {
    expect(activeMapHandlers()).toEqual({});
  });
});

describe('useMapInstance', () => {
  it('follows the published instance', () => {
    const { result } = renderHook(() => useMapInstance());
    expect(result.current).toEqual({ map: null, loaded: false });
    const map = {} as never;
    act(() => publishMapInstance(map, true));
    expect(result.current).toEqual({ map, loaded: true });
    const snapshot = result.current;
    act(() => publishMapInstance(map, true));
    expect(result.current).toBe(snapshot);
    act(() => publishMapInstance(null, false));
    expect(result.current.map).toBeNull();
  });
});
