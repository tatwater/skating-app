import { waterBodyClassLabel, waterBodyDisplayName } from '@skating/core';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from 'react';

import { ActionBar } from '@/components/kit/action-bar';
import { Tag } from '@/components/kit/badge';
import { DisplayWord } from '@/components/kit/display-word';
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
import { ChoiceRows } from '../ChoiceRows';
import { attachedWords, neighborsWords, queuedWords } from '../taskFacts';
import { InTheApp } from './InTheApp';
import {
  bodyLine,
  catalogRun,
  catalogsWords,
  defaultPick,
  elsewhereWords,
  fromWords,
  leverOf,
  type NameLever,
  type NamesItem,
  onceRows,
  pickable,
  raisedAgainNote,
  refusalSaid,
  tagOf,
  typedFor,
} from './namesModel';
import { NAME_WORDS as W } from './nameWords';

/**
 * **Board 4.2, drawn from props** — the Name conflicts inspector inside the shared frame:
 *
 * - **Head**: *Name conflict*, the conflict's kind in the tabs' words, *Open in Body →*.
 * - **Top**: the body (where, what, how big; its shown name set as the column's word) and what
 *   the decision touches — search, attachments, the catalogs, the neighbors, the campaign that
 *   queued it — beside the square head map.
 * - **The names**: one card per spelling (`ChoiceRows`), each with its catalogs (every one
 *   recorded, or the top one alone), *From*, the catalog's rank in words and how many other bodies
 *   carry the name. *Shown now* on the displayed name; *Suggested* only where the item says so,
 *   which no name does until the emails arrive (D307) — so the pick opens on the shown name.
 * - **Once … shows** and **In the app**: what the pick does, as facts and as pictures.
 * - **The bar**: one button naming the pick (*Display “Lake Auburn” instead*, *Keep “The
 *   Basin”*), ⏎ in the pane. Drawn only where the item's `can` allows the pick's verb.
 *
 * No reads, no writes: the container binds them. A refusal is the shell's toast (D268).
 */

export type NamesInspectorProps = {
  item: NamesItem;
  locked: DecidedState | null;
  now: number;
  /** The head map: `CorpusHeadMap` in the app, a still in a story; `null` draws none. */
  map: ReactNode;
  /** The body's Names tab: an anchor element (the router's link), unstyled. */
  bodyLink: ReactElement;
  onDecide: (lever: NameLever) => Promise<boolean>;
  pending: NameLever['verb'] | null;
  /** The inspector pane: ⏎ and the bar act only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
  timeZone?: string;
};

/** The head map's side (the board's 248 px square). */
export const NAMES_MAP_SIZE = 248;

const KICK = 'text-kick leading-none font-semibold tracking-kick uppercase text-fg3';

function Part({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-(--space-5) pt-(--space-5_5)', className)} {...props} />;
}

/** A run of catalog tags, each boxed as the board's card head draws them. */
function CatalogBoxes({ choice }: { choice: NamesItem['names'][number] }) {
  return (
    <span data-slot="name-catalogs" className="flex items-center gap-(--space-1)">
      {catalogRun(choice).map((s) => (
        <Tag key={s} className="h-(--size-pill) px-[0.5em] inset-ring inset-ring-line2 text-fg2">
          {tagOf(s)}
        </Tag>
      ))}
    </span>
  );
}

export function NamesInspector({
  item,
  locked,
  now: _now,
  map,
  bodyLink,
  onDecide,
  pending,
  pane,
  timeZone,
}: NamesInspectorProps) {
  // The pick is this task's: another task opens on its own default.
  const [picked, setPicked] = useState<{ task: string; value: string } | null>(null);
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

  const name = waterBodyDisplayName(item.body.name);
  const shown = item.names.find((n) => n.shown);
  // What “Once … shows” and *In the app* describe: the pick's future, else (decided, or nothing
  // pickable) the name shown now.
  const future: Pick<NameLever, 'verb' | 'name'> = lever ?? {
    verb: 'keepName',
    name: shown?.value ?? name,
  };
  const alias = item.names.find((n) => n.value !== future.name)?.value ?? null;
  const again = raisedAgainNote(item, timeZone);
  const refused = refusalSaid(item);

  const head = (
    <>
      <InspectorHeadTitle>{W.title}</InspectorHeadTitle>
      <span data-slot="names-kind" className={KICK}>
        {W.kind}
        <span className="ms-(--space-1_5) font-medium text-fg1">{W.split[item.split]}</span>
      </span>
      <InspectorHeadEnd>
        <LinkChip link={bodyLink} label={W.openInBody} slot="open-in-body" />
      </InspectorHeadEnd>
    </>
  );

  const actions =
    lever === null ? null : (
      <ActionBar
        data-slot="names-actions"
        aria-label={W.bar}
        groups={[
          {
            id: 'name',
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
                    what={lever.verb === 'keepName' ? W.whatKeep : W.whatDisplay}
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
      <div data-slot="names-handler" className="@container">
        <div className="grid grid-cols-1 border-0 border-b-(length:--stroke-hair) border-solid border-line @[36rem]:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 flex-col gap-(--space-4) px-(--space-5) pt-(--space-4_5) pb-(--space-5)">
            <div className="flex min-w-0 flex-col gap-(--space-2)">
              <span data-slot="names-body-line" className={KICK}>
                {bodyLine(item.body)}
              </span>
              <h2 className="m-0 min-w-0">
                <DisplayWord className="block truncate">{name}</DisplayWord>
              </h2>
            </div>
            <FactList
              data-slot="names-facts"
              rows={[
                { label: W.search, value: W.searchFinds },
                { label: W.attached, value: attachedWords(item.attached) },
                { label: W.catalogs, value: catalogsWords(item) },
                { label: W.neighbors, value: neighborsWords(item.neighbors) },
                { label: W.queued, value: queuedWords(item.raisedBy, timeZone) },
              ]}
            />
          </div>
          <div
            data-slot="names-map"
            className="min-w-0 border-0 border-t-(length:--stroke-hair) border-solid border-line empty:hidden @[36rem]:border-t-0 @[36rem]:border-l-(length:--stroke-hair)"
          >
            {map}
          </div>
        </div>
        {(again !== null || refused !== null) && (
          <Part className="flex flex-col gap-(--space-2)">
            {again !== null && <Note data-slot="names-raised-again">{again}</Note>}
            {refused !== null && <Note data-slot="names-refusal">{refused}</Note>}
          </Part>
        )}
        <Part>
          <Section title={W.theNames} data-slot="names-choices">
            <ChoiceRows
              aria-label={W.pickAName}
              value={pick}
              readOnly={decided}
              onValueChange={(value) => setPicked({ task: item.taskId, value })}
              nowLabel={W.shownNow}
              suggestedLabel={W.suggested}
              choices={item.names.map((n) => ({
                value: n.value,
                label: n.value,
                name: n.value,
                now: n.shown,
                suggested: n.suggested,
                disabled: !decided && !pickable(item, n),
                aside: <CatalogBoxes choice={n} />,
                // 6c adds an *Emails* row and the strip by winter under these (D307).
                children: (
                  <FactList
                    rows={[
                      { label: W.from, value: fromWords(n) },
                      { label: W.rank, value: n.rankWords },
                      { label: W.elsewhere, value: elsewhereWords(n.namesakes) },
                    ]}
                  />
                ),
              }))}
            />
          </Section>
        </Part>
        <Part className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-5_5) @[40rem]:grid-cols-[19.5rem_minmax(0,1fr)]">
          <Section
            title={future.verb === 'keepName' ? W.onceKept(future.name) : W.onceShows(future.name)}
            data-slot="names-once"
          >
            <FactList
              rows={onceRows(item, future).map((r) => ({
                label: r.label,
                value: r.strong ? (
                  <strong className="font-medium text-fg">{r.value}</strong>
                ) : (
                  r.value
                ),
              }))}
            />
          </Section>
          <Section title={W.inTheApp} data-slot="names-in-app">
            <InTheApp
              name={future.name}
              place={[item.body.place, waterBodyClassLabel(item.body.cls)]
                .filter((p) => p !== '')
                .join(' · ')}
              alias={alias}
              typed={alias === null ? '' : typedFor(alias)}
            />
          </Section>
        </Part>
      </div>
    </InspectorFrame>
  );
}
