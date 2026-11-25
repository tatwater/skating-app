import { type WaterBodyClass, waterBodyClassLabel } from '@skating/core';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from 'react';

import { ActionBar } from '@/components/kit/action-bar';
import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { ToolbarKeyButton } from '@/components/kit/toolbar';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { LinkChip } from '../../../inbox/blocks/LinkChip';
import {
  type DecidedState,
  InspectorFrame,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../../inspector/InspectorFrame';
import { ConsequenceLadder } from '../ConsequenceLadder';
import { attachedWords } from '../taskFacts';
import {
  type ClassesItem,
  type ClassLever,
  catalogColumns,
  catalogRows,
  defaultPick,
  depthWords,
  headLine,
  leverOf,
  NOT_RECORDED,
  nameWords,
  nearestWords,
  pickable,
  raisedAgainNote,
  refusalSaid,
  rungMarks,
  tagOf,
} from './classesModel';
import { CLASS_WORDS as W } from './classWords';

/**
 * **Board 4.3, drawn from props** — the Class conflicts inspector inside the shared frame:
 *
 * - **Head**: *Class conflict*, the body (name, place, acres), *Open in Body →*.
 * - **The map**: a band across the inspector over the body's outline, its legend naming whose
 *   drawing it is.
 * - **What each class would do** (`ConsequenceLadder`): every class a person may choose, *Now* on
 *   the body's, *Suggested* only where the item says so, each catalog's token in its column, and
 *   what choosing it does (the server's words). Before the campaign that records the claims the
 *   ladder draws without catalog columns.
 * - **The catalogs** (each claim's class, token and acres, or *not recorded*) and **The body**.
 * - **The bar**: one button naming the pick (*Set as Wetland*, *Keep as Lake or pond*), ⏎ in the
 *   pane; drawn only where the item's `can` allows the pick's verb.
 *
 * No reads, no writes: the container binds them. A refusal is the shell's toast (D268).
 */

export type ClassesInspectorProps = {
  item: ClassesItem;
  locked: DecidedState | null;
  now: number;
  /** The map band: `CorpusHeadMap` in the app, a still in a story; `null` draws none. */
  map: ReactNode;
  bodyLink: ReactElement;
  onDecide: (lever: ClassLever) => Promise<boolean>;
  pending: ClassLever['verb'] | null;
  pane?: RefObject<HTMLElement | null>;
  timeZone?: string;
};

/** The map band's height (the board's 250 px). */
export const CLASSES_MAP_HEIGHT = 250;

const MICRO =
  'text-kick leading-none font-medium tracking-kick uppercase text-fg2 truncate min-w-0';

function Part({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-(--space-5) pt-(--space-5_5)', className)} {...props} />;
}

export function ClassesInspector({
  item,
  locked,
  now: _now,
  map,
  bodyLink,
  onDecide,
  pending,
  pane,
  timeZone,
}: ClassesInspectorProps) {
  const [picked, setPicked] = useState<{ task: string; value: WaterBodyClass } | null>(null);
  const decided = locked !== null || item.decided !== null;
  const ownPick = picked !== null && picked.task === item.taskId ? picked.value : defaultPick(item);
  const pick = decided ? null : ownPick;
  const lever = decided ? null : leverOf(item, pick);
  const busy = pending !== null;
  const apply = () => {
    if (lever !== null && !busy) void onDecide(lever);
  };
  const unbound = useRef<HTMLElement | null>(null);
  usePaneKeys(pane ?? unbound, [
    {
      key: 'Enter',
      run: apply,
      enabled: pane !== undefined && lever !== null && !busy,
      label: lever?.label,
    },
  ]);

  const again = raisedAgainNote(item, timeZone);
  const refused = refusalSaid(item);
  const columns = catalogColumns(item);
  const catalogs = catalogRows(item.claims);

  const head = (
    <>
      <InspectorHeadTitle>{W.title}</InspectorHeadTitle>
      <span data-slot="classes-head-line" className={MICRO}>
        {headLine(item.body)}
      </span>
      <InspectorHeadEnd>
        <LinkChip link={bodyLink} label={W.openInBody} slot="open-in-body" />
      </InspectorHeadEnd>
    </>
  );

  const actions =
    lever === null ? null : (
      <ActionBar
        data-slot="classes-actions"
        aria-label={W.bar}
        groups={[
          {
            id: 'class',
            items: [
              {
                kind: 'control',
                id: 'apply',
                control: (
                  <ToolbarKeyButton
                    data-bar-item="apply"
                    className="w-full"
                    label={lever.label}
                    hotkey="⏎"
                    what={lever.verb === 'keepClass' ? W.whatKeep : W.whatSet}
                    loading={pending !== null}
                    disabled={busy}
                    onClick={apply}
                  />
                ),
              },
            ],
          },
        ]}
      />
    );

  return (
    <InspectorFrame head={head} actions={actions} locked={locked}>
      <div data-slot="classes-handler" className="@container">
        <div
          data-slot="classes-map"
          className="min-w-0 border-0 border-b-(length:--stroke-hair) border-solid border-line empty:hidden"
        >
          {map}
        </div>
        {(again !== null || refused !== null) && (
          <Part className="flex flex-col gap-(--space-2)">
            {again !== null && <Note data-slot="classes-raised-again">{again}</Note>}
            {refused !== null && <Note data-slot="classes-refusal">{refused}</Note>}
          </Part>
        )}
        <Part>
          <Section title={W.ladder} data-slot="classes-ladder">
            <ConsequenceLadder
              aria-label={W.pickAClass}
              valueHead={W.classHead}
              consequenceHead={W.consequenceHead}
              nowLabel={W.now}
              suggestedLabel={W.suggested}
              value={pick}
              readOnly={decided}
              onValueChange={(value) => setPicked({ task: item.taskId, value })}
              columns={columns.map((s) => ({ key: s, label: tagOf(s) }))}
              rungs={item.ladder.map((r) => ({
                value: r.cls,
                label: waterBodyClassLabel(r.cls),
                now: r.now,
                suggested: r.suggested,
                disabled: !decided && !pickable(item, r),
                marks: rungMarks(r),
                consequence: r.consequence.words,
                emphasis: r.consequence.kind === 'leaves',
              }))}
            />
          </Section>
        </Part>
        <Part className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5_5) @[40rem]:grid-cols-2">
          <Section title={W.theCatalogs} data-slot="classes-catalogs">
            {catalogs === null ? (
              <p data-slot="classes-not-recorded" className="m-0 text-row leading-snug text-fg2">
                {NOT_RECORDED}
              </p>
            ) : (
              <FactList rows={catalogs} />
            )}
          </Section>
          <Section title={W.theBody} data-slot="classes-body">
            <FactList
              rows={[
                { label: W.name, value: nameWords(item.body) },
                { label: W.depth, value: depthWords(item.depth) },
                { label: W.attached, value: attachedWords(item.attached) },
                { label: W.nearest, value: nearestWords(item.neighbors) },
              ]}
            />
          </Section>
        </Part>
      </div>
    </InspectorFrame>
  );
}
