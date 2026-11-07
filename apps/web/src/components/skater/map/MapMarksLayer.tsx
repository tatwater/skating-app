import { HAZARD_TYPE_LABELS, type HazardType } from '@skating/core';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MapHoverPlate } from '@/components/kit/map-controls';
import { layoutLakeLabels, type Rect } from '@/lib/lakeLabelLayout';
import { cn } from '@/lib/utils';
import { LakeLabel } from './LakeLabel';
import { HazardMark, MARK_BOX, PutInMark } from './MapMarks';
import { type HazardMarkModel, type LakeLabelModel, markObstacle } from './mapDerive';

/**
 * The DOM half of the map: put-in and hazard marks and the lake labels, kept on their points as the
 * camera moves. React renders the bounded set once; each camera frame re-projects and writes
 * transforms straight to the nodes, so a pan is a few dozen style writes and no React render.
 *
 * Marks are placed first, and every hazard mark is an obstacle for the labels: a label that would
 * cover one gives way (D3). Labels then lay out in priority order (`layoutLakeLabels`).
 *
 * Over a satellite picture the hazard marks stay on and at full strength (founder, 2026-11-07), and
 * the one a mouse rests on fades so the ice under it shows — a peek the skater asked for by pointing
 * at that very mark, gone on pointer-out. Keyboard focus never fades one (focus is inspecting the mark
 * itself), nor does a touch (a tap opens it).
 */

/** What this layer needs of a map: projection, size and camera events. Faked in tests. */
export interface ProjectingMap {
  project(lngLat: [number, number]): { x: number; y: number };
  getContainer(): HTMLElement;
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
}

export interface PutInMarkModel {
  id: string;
  lng: number;
  lat: number;
  name?: string;
}

export interface MapMarksLayerProps {
  map: ProjectingMap;
  labels: readonly LakeLabelModel[];
  putIns: readonly PutInMarkModel[];
  hazards: readonly HazardMarkModel[];
  selectedHazardId?: string | null;
  onOpenHazard: (hazardId: string) => void;
  /** Screen boxes no label may cover beyond the marks (the dock), in map px. */
  reserved?: () => readonly Rect[];
  /** A satellite picture is up: the hazard mark under the mouse fades to show the ice beneath. */
  imagery?: boolean;
}

const HALF = MARK_BOX / 2;

/** The hovered hazard over imagery: faint enough to see the ice through, still there. */
const PEEK = 'opacity-35';

function hazardName(type: string): string {
  return HAZARD_TYPE_LABELS[type as HazardType] ?? 'Hazard';
}

/**
 * The hazard plate's line — what the mark's own `aria-label` says, so pointing at a pin and hearing
 * about it give the same answer. Never softened: an unconfirmed hazard is still a hazard, and the
 * plate says only that nobody has confirmed it, never that it is probably fine (D3).
 */
function hazardPlateBody(h: HazardMarkModel): string {
  return h.provisional
    ? `${hazardName(h.hazardType)} · Not yet confirmed`
    : hazardName(h.hazardType);
}

export function MapMarksLayer({
  map,
  labels,
  putIns,
  hazards,
  selectedHazardId = null,
  onOpenHazard,
  reserved,
  imagery = false,
}: MapMarksLayerProps) {
  const labelNodes = useRef(new Map<string, HTMLDivElement>());
  const lockupNodes = useRef(new Map<string, HTMLDivElement>());
  const markNodes = useRef(new Map<string, HTMLElement>());
  const widths = useRef(new Map<string, number>());
  const [hover, setHover] = useState<{ x: number; y: number; title: string; body: string } | null>(
    null,
  );
  // One id, so never more than one mark faded; kept while imagery is off and simply not drawn then.
  const [peekId, setPeekId] = useState<string | null>(null);

  /**
   * Every mark answers a hover, not just the named ones. A pin you can point at and get nothing
   * from reads as broken rather than as nameless — and the hazard marks, which are the pins that
   * most need a word before you commit to a click, had no plate at all.
   */
  const showPlate = (event: { currentTarget: Element }, title: string, body: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const host = map.getContainer().getBoundingClientRect();
    setHover({ x: rect.left - host.left + HALF, y: rect.top - host.top + HALF, title, body });
  };

  const measure = useCallback(() => {
    for (const [id, node] of lockupNodes.current) widths.current.set(id, node.offsetWidth);
  }, []);

  const frame = useCallback(() => {
    const container = map.getContainer();
    const size = { width: container.clientWidth, height: container.clientHeight };
    const obstacles: Rect[] = [...(reserved?.() ?? [])];
    const place = (key: string, lng: number, lat: number) => {
      const node = markNodes.current.get(key);
      const p = map.project([lng, lat]);
      if (node) node.style.transform = `translate(${p.x - HALF}px, ${p.y - HALF}px)`;
      return p;
    };
    for (const m of putIns) place(`p:${m.id}`, m.lng, m.lat);
    for (const h of hazards) {
      const p = place(`h:${h.id}`, h.lng, h.lat);
      obstacles.push(markObstacle(p.x, p.y));
    }

    const candidates = labels.map((label) => ({
      id: label.id,
      anchor: map.project([label.anchor.lng, label.anchor.lat]),
      width: widths.current.get(label.id) ?? 0,
      hasSlug: label.slug !== null,
      priority: label.priority,
    }));
    const placed = layoutLakeLabels(candidates, size, { obstacles });
    for (const label of labels) {
      const node = labelNodes.current.get(label.id);
      if (!node) continue;
      const placement = placed.get(label.id);
      if (!placement) {
        node.style.visibility = 'hidden';
        continue;
      }
      node.style.visibility = '';
      node.style.transform = `translate(${placement.anchor.x}px, ${placement.anchor.y}px)`;
      // Mirroring is the node's data attribute and the lockup's offset side, set here so a pan never
      // re-renders React: the CSS follows `data-mirrored`.
      const lockup = lockupNodes.current.get(label.id);
      if (placement.mirrored) node.setAttribute('data-mirrored', '');
      else node.removeAttribute('data-mirrored');
      if (lockup) {
        lockup.style.left = placement.mirrored ? '' : '18px';
        lockup.style.right = placement.mirrored ? '18px' : '';
        lockup.style.alignItems = placement.mirrored ? 'flex-end' : 'flex-start';
      }
    }
  }, [map, labels, putIns, hazards, reserved]);

  // Measure after every render that changed the set, then lay out; and again once the fonts land
  // (a lockup measured in the fallback face is the wrong width — the mock's Review 4 note).
  useLayoutEffect(() => {
    measure();
    frame();
  }, [measure, frame]);

  useLayoutEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => {
      if (!live) return;
      measure();
      frame();
    });
    return () => {
      live = false;
    };
  }, [measure, frame]);

  useLayoutEffect(() => {
    map.on('move', frame);
    map.on('resize', frame);
    return () => {
      map.off('move', frame);
      map.off('resize', frame);
    };
  }, [map, frame]);

  const ref =
    (store: Map<string, HTMLElement | HTMLDivElement>, key: string) =>
    (node: HTMLElement | null) => {
      if (node) store.set(key, node as HTMLDivElement);
      else store.delete(key);
    };

  return (
    <div
      data-slot="map-marks"
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
    >
      {putIns.map((m) => (
        <span
          key={m.id}
          ref={ref(markNodes.current, `p:${m.id}`)}
          role="img"
          aria-label={m.name ? `Put-in: ${m.name}` : 'Put-in'}
          data-slot="put-in"
          data-pin={m.id}
          className="pointer-events-auto absolute top-0 left-0"
          // `name` is already core's resolver's answer (`resolvePutInName`), so it is OSM's name or
          // the deterministic compass label; it is only missing when the lake has no interior point
          // to take a bearing from, and then the plate says the one true thing left.
          // No focus pair: a put-in mark is a `span`, not a control — the hazard marks are the
          // buttons, and they carry one.
          onPointerEnter={(e) => showPlate(e, 'Put-in', m.name ?? 'Unnamed')}
          onPointerLeave={() => setHover(null)}
        >
          <PutInMark />
        </span>
      ))}
      {hazards.map((h) => {
        const selected = h.id === selectedHazardId;
        const peeking = imagery && peekId === h.id;
        return (
          <button
            key={h.id}
            ref={ref(markNodes.current, `h:${h.id}`)}
            type="button"
            data-slot="hazard"
            data-pin={h.id}
            aria-label={`Hazard: ${hazardName(h.hazardType)}${h.provisional ? ', not yet confirmed' : ''}`}
            aria-current={selected ? 'true' : undefined}
            data-peek={peeking ? '' : undefined}
            onClick={() => onOpenHazard(h.id)}
            onPointerEnter={(e) => {
              if (e.pointerType !== 'touch') setPeekId(h.id);
              showPlate(e, 'Hazard', hazardPlateBody(h));
            }}
            onPointerLeave={() => {
              setPeekId((current) => (current === h.id ? null : current));
              setHover(null);
            }}
            onFocus={(e) => showPlate(e, 'Hazard', hazardPlateBody(h))}
            onBlur={() => setHover(null)}
            className={cn(
              'pointer-events-auto absolute top-0 left-0 cursor-pointer rounded-control outline-none focus-visible:shadow-focus',
              'transition-opacity duration-(--duration-base) ease-standard',
              peeking && PEEK,
            )}
          >
            <HazardMark
              tone={h.tone}
              selected={selected}
              dim={selectedHazardId !== null && !selected}
            />
          </button>
        );
      })}
      {labels.map((label) => (
        <LakeLabel
          key={label.id}
          ref={ref(labelNodes.current, label.id)}
          lockupRef={ref(lockupNodes.current, label.id)}
          name={label.name}
          slug={label.slug}
          favorite={label.favorite}
          openBounties={label.openBounties}
          inactive={label.inactive}
          dim={label.dim}
          style={{ visibility: 'hidden' }}
        />
      ))}
      <MapHoverPlate at={hover} title={hover?.title}>
        {hover?.body}
      </MapHoverPlate>
    </div>
  );
}
