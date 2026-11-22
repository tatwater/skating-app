import { Fragment, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { type BindableLetter, type PaneBinding, usePaneKeys } from '@/lib/keys';

import {
  Toolbar,
  ToolbarGroup,
  ToolbarKeyButton,
  ToolbarLabel,
  ToolbarOverflow,
  type ToolbarProps,
  ToolbarSeparator,
} from './toolbar';

/**
 * **The action bar, from data** (the Inbox's inspector, every board 2.1–2.8): the kit `Toolbar`
 * floated at its pane's foot, its buttons drawn and their keys bound in one place, so the key a
 * button shows is always the key that does it.
 *
 * - **Floats at the pane's foot**, tight to its buttons, `space-2` clear of the status bar and of
 *   both sides (`Toolbar floating`; the pane is positioned and its scroller leaves room at its end).
 * - **Every button rests alike**: outlined, none primary until focused or armed. A destructive one
 *   (`danger`) is the same hairline box until it is `armed`, then red.
 * - **One action spans the pane** (Resolve, Open in Body): a bar holding one button and no group
 *   label is drawn `full`, the button grown to fill it — decided here, so no page draws it short.
 * - **Each button's key is its label's letter**, shown as a key chip (*Dismiss* `D`, *Hide* `H`);
 *   `hotkey` names another when the first letter is taken or can't be bound (J, K and G never are —
 *   `lib/keys` refuses them), and `null` draws a button with no key (*Clear the accessible
 *   ruling*). Two buttons can't claim one key: the bar throws, so it fails in a test.
 * - **The keys act in the pane** (`pane`): each fires only while focus is inside it, never in a text
 *   field, through `lib/keys`' `usePaneKeys`. A disabled or busy button's key is inert. With no
 *   `pane`, the keys are shown and announced but bound by the page.
 * - **No explaining line**: what a button does is its tooltip (`what`), on hover and on focus.
 * - **Groups** (`label`: *Flag*, *Report*, *Author*) are parted by hairlines; a `control` item is any
 *   other control in the bar's arrow keys (the author's menu — a kit `ToolbarItem`).
 * - **Narrow** (the console's narrow rule, a phone): when the bar as the boards draw it is wider than
 *   its pane's room, it spans the pane instead (the phone board's `.pact`), drops its group kickers
 *   and hairlines, and its buttons share the room — as many as fit, with their keys, the rest folded
 *   into *More*, whose items name their keys (`ToolbarOverflow`); its controls stay at the end. No
 *   breakpoint: the bar measures itself, so wherever the boards' layout fits it is drawn unchanged,
 *   and every key still acts, folded or not.
 */

type ActionBarButton = {
  kind?: 'button';
  /** Stable across renders. */
  id: string;
  /** What the button says ("Dismiss"). */
  label: string;
  /** Its key, when not its label's first letter; `null` for none. */
  hotkey?: BindableLetter | null;
  /** What it does, in a sentence: the tooltip. */
  what: ReactNode;
  onPress: () => void;
  /** Destructive: a hairline box at rest, red only once `armed`. */
  danger?: boolean;
  armed?: boolean;
  /** Its write is out: a spinner over the label, which keeps its width. */
  loading?: boolean;
  disabled?: boolean;
};

type ActionBarControl = {
  kind: 'control';
  id: string;
  /** A control in the bar's arrow keys: a kit `ToolbarItem` (a menu or a Select trigger). */
  control: ReactNode;
};

type ActionBarItem = ActionBarButton | ActionBarControl;

type ActionBarGroup = {
  id: string;
  /** The group's kicker ("Flag", "Report"). */
  label?: string;
  items: readonly ActionBarItem[];
};

type ActionBarProps = Omit<ToolbarProps, 'children' | 'full' | 'aria-label'> & {
  groups: readonly ActionBarGroup[];
  /** The bar's name for a reader ("Flag actions"). */
  'aria-label': string;
  /** The pane the keys act in. Without it the page binds them. */
  pane?: RefObject<HTMLElement | null>;
};

const isButton = (item: ActionBarItem): item is ActionBarButton => item.kind !== 'control';

/** The letter a button's key defaults to: its label's first. */
function firstLetter(label: string): string {
  return label.trim().charAt(0).toUpperCase();
}

/**
 * Each button's key, by id — its own, or its label's first letter. Throws when a derived key can't
 * be bound (name another) or two buttons claim one key.
 */
function barKeys(groups: readonly ActionBarGroup[]): Map<string, BindableLetter | null> {
  const keys = new Map<string, BindableLetter | null>();
  const claimed = new Map<string, string>();
  for (const item of groups.flatMap((g) => g.items).filter(isButton)) {
    const key = item.hotkey === undefined ? firstLetter(item.label) : item.hotkey;
    if (key !== null) {
      if (!/^[A-Z]$/.test(key) || key === 'G' || key === 'J' || key === 'K') {
        throw new Error(
          `"${item.label}" can't take "${key}" as its key: pass \`hotkey\` (a letter other than G, J and K), or \`null\` for none.`,
        );
      }
      const other = claimed.get(key);
      if (other !== undefined) {
        throw new Error(`"${item.label}" and "${other}" both claim the key ${key}.`);
      }
      claimed.set(key, item.label);
    }
    keys.set(item.id, key as BindableLetter | null);
  }
  return keys;
}

function ActionBar({ groups, pane, floating = true, ...props }: ActionBarProps) {
  const keys = barKeys(groups);
  const buttons = groups.flatMap((g) => g.items).filter(isButton);
  const unbound = useRef<HTMLElement | null>(null);
  const bindings: PaneBinding[] = buttons.flatMap((b) => {
    const key = keys.get(b.id);
    if (key === null || key === undefined) return [];
    return [
      {
        key,
        run: () => b.onPress(),
        enabled: pane !== undefined && b.disabled !== true && b.loading !== true,
        label: b.label,
      },
    ];
  });
  usePaneKeys(pane ?? unbound, bindings);

  const items = groups.flatMap((g) => g.items);
  const full = groups.length === 1 && groups[0]?.label === undefined && items.length === 1;
  const narrow = useNarrow(full, floating);
  /** A control, in a box the bar measures (its width stands in for it in the boards' copy). */
  const control = (item: ActionBarControl) => (
    <span key={item.id} data-bar-control={item.id} className="inline-flex min-w-0">
      {item.control}
    </span>
  );
  /** The bar as the boards draw it: kickers, hairlines, every button with its key. */
  const boards = (copy: boolean) =>
    groups.map((group, i) => (
      <Fragment key={group.id}>
        {i > 0 && <ToolbarSeparator />}
        <ToolbarGroup className={full ? 'w-full [&>*]:flex-1' : undefined}>
          {group.label !== undefined && <ToolbarLabel>{group.label}</ToolbarLabel>}
          {group.items.map((item) =>
            !isButton(item) ? (
              copy ? (
                // A control is drawn once, in the bar seen; its copy holds its measured width.
                <span
                  key={item.id}
                  className="inline-block shrink-0"
                  style={{ width: narrow.controls[item.id] ?? 0 }}
                />
              ) : (
                control(item)
              )
            ) : (
              <ToolbarKeyButton
                key={item.id}
                label={item.label}
                hotkey={keys.get(item.id) ?? null}
                what={item.what}
                variant={item.danger === true ? 'danger' : 'outline'}
                armed={item.armed}
                loading={item.loading}
                disabled={item.disabled}
                onClick={copy ? undefined : item.onPress}
              />
            ),
          )}
        </ToolbarGroup>
      </Fragment>
    ));
  const seen = narrow.on ? (
    <Toolbar
      ref={narrow.ref}
      floating={floating}
      full
      data-narrow=""
      className="[&>*:not([data-slot=toolbar-overflow])]:flex-none"
      {...props}
    >
      <ToolbarOverflow
        grow
        actions={buttons.map((b) => ({
          id: b.id,
          label: b.label,
          ...(keys.get(b.id) != null && { kbd: keys.get(b.id) as string }),
          what: b.what,
          onClick: b.onPress,
          ...(b.danger === true && { danger: true }),
          ...(b.armed !== undefined && { armed: b.armed }),
          ...(b.loading !== undefined && { loading: b.loading }),
          ...(b.disabled !== undefined && { disabled: b.disabled }),
        }))}
      />
      {items.filter((i): i is ActionBarControl => !isButton(i)).map(control)}
    </Toolbar>
  ) : (
    <Toolbar ref={narrow.ref} floating={floating} full={full} {...props}>
      {boards(false)}
    </Toolbar>
  );
  if (full) return seen;
  return (
    <>
      {/* The boards' bar, unseen and inert, clipped to nothing: measured whenever it changes (a
          late web font, a new label), so the bar seen never has to be redrawn to be measured. */}
      <div
        aria-hidden="true"
        inert
        data-slot="action-bar-measure"
        className="pointer-events-none invisible absolute inset-0 overflow-hidden"
      >
        <Toolbar ref={narrow.copy} className="w-max max-w-none">
          {boards(true)}
        </Toolbar>
      </div>
      {seen}
    </>
  );
}

/**
 * Whether the bar as the boards draw it fits its room: measured on the unseen copy (its width) and
 * the pane (its room, less the bar's own inset), and on each control seen (its width, for the copy).
 */
function useNarrow(full: boolean, floating: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [controls, setControls] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const bar = ref.current;
    const twin = copy.current;
    if (full || bar === null || twin === null) {
      setOn(false);
      return;
    }
    const host = floating ? bar.offsetParent : bar.parentElement;
    const decide = () => {
      // Each control's width as drawn, for its stand-in in the copy (set only when it moved).
      const widths: Record<string, number> = {};
      for (const el of bar.querySelectorAll<HTMLElement>('[data-bar-control]')) {
        widths[el.dataset.barControl as string] = el.getBoundingClientRect().width;
      }
      setControls((was) =>
        Object.keys(widths).length === Object.keys(was).length &&
        Object.entries(widths).every(([k, w]) => Math.abs((was[k] ?? -1) - w) < 0.5)
          ? was
          : widths,
      );
      // (A bar always sits in a box; the guard is for the type.)
      /* v8 ignore next */
      if (!(host instanceof HTMLElement)) return;
      // A floating bar keeps its inset from both sides (its own `left` and `right`).
      const style = getComputedStyle(bar);
      const inset = floating ? parseFloat(style.left) + parseFloat(style.right) : 0;
      const room = host.clientWidth - (Number.isFinite(inset) ? inset : 0);
      setOn(twin.getBoundingClientRect().width > room + 0.5);
    };
    decide();
    const observer = new ResizeObserver(decide);
    if (host instanceof HTMLElement) observer.observe(host);
    observer.observe(twin);
    for (const el of bar.querySelectorAll('[data-bar-control]')) observer.observe(el);
    return () => observer.disconnect();
  });
  return { ref, copy, on, controls };
}

export {
  ActionBar,
  type ActionBarButton,
  type ActionBarControl,
  type ActionBarGroup,
  type ActionBarItem,
  type ActionBarProps,
  barKeys,
};
