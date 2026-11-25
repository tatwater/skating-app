import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-regular-svg-icons';
import { MAX_REFERENCE_LINK_LABEL, MAX_URL_CHARS, referenceLinkError } from '@skating/core';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, buttonVariants } from '@/components/kit/button';
import { Input } from '@/components/kit/input';
import { Section } from '@/components/kit/section-slug';
import { SortableRows } from '@/components/kit/sortable-rows';
import { cn } from '@/lib/utils';
import { LINK_EDITED_AWAY, LINKS_GONE, LINKS_KEPT_MOVING } from '../../consoleWords';
import { listChanged, sayNotSaved, useBodyHold } from '../../frame/currentBody';
import { useListMemory, useListWriter } from '../listWriter';
import {
  carryIds,
  type DerivedRow,
  derivedRows,
  googleMapsRow,
  type KeyedLink,
  type LinksBody,
  linkChanges,
  type StaffLink,
  sameLinks,
} from './linksModel';

/**
 * Board 5.4.9, Body › Links, the default view: the links built from the lake (derived at render
 * time, stored nowhere) — the lake sheet's, then one for staff alone, the lake on Google Maps, which
 * skaters never read and the section's count leaves out — the links staff added — rows that reorder by a grip, each with Edit — and
 * where skaters read them all, in this order, under *Elsewhere* in the lake sheet.
 *
 * Everything arrives as props; the wiring (`LinksTab`) reads the body and writes the list.
 */

export type LinksTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  body: LinksBody;
  now: number;
  /** The viewer holds `body.identity` (the staff links are theirs to edit). */
  canEdit: boolean;
  /**
   * Writes the whole staff list (add, edit, remove and reorder all land here), naming the list it
   * was built on (`expected`, the server's compare-and-set): a list that moved underneath is thrown
   * as `list_changed` with the current one. Resolves `false` for a write refused (already said in
   * its toast, naming the body).
   */
  onSave?: (links: StaffLink[], expected: StaffLink[]) => Promise<unknown>;
  /** The queue's name above the page (`links:<body>`), so a pressed save outlives the page. */
  queueKey?: string;
  /** The skater's lake sheet for this body, opened in a new tab; `null` draws no link. */
  lakeSheetHref: string | null;
};

type Editing = {
  /**
   * The link this editor is bound to, by identity: a row's key, or — for a link being added — the
   * key the page minted for it when Add was pressed, which its row carries once saved. Never
   * matched by its words: two links may say the same.
   */
  key: string;
  /** Opened by Add: drawn at the list's foot for its whole life, never remounted into a row. */
  added: boolean;
  /** An added link not saved yet: its Done adds it; once saved, Done edits it. */
  unsaved: boolean;
  label: string;
  url: string;
  error: string | null;
  /** This opening of the editor: a save it sent closes it, and nothing it didn't send does. */
  opening: number;
};

/**
 * Focus is nowhere the moderator put it — nowhere, the page, or a container holding `region` (the
 * console's panel, where its floor, `useKeepFocus`, catches focus a closed editor dropped, and may
 * do so before this tab's effect runs): the only focus a completion may take back.
 */
const focusIsLost = (region: HTMLElement | null): boolean => {
  const active = document.activeElement;
  return (
    active === null || active === document.body || (region !== null && active.contains(region))
  );
};

/** Said when an added link's row can't be told from the list any more (another write moved it). */
const LOST_ADD =
  'The list changed while this link was saving, so this editor can’t tell which row it is. Cancel, then edit the link from its row.';

/**
 * A change to the staff list, by link id: what the write queue applies to its newest list. `null`:
 * the change no longer applies (what it changes was removed meanwhile).
 */
type Change = (base: readonly KeyedLink[]) => readonly KeyedLink[] | null;

/**
 * **A link's id outlives the page, as its queue does** (`ListWritersProvider`): a change queued
 * behind a save still on its way names links by id, and may be taken up after the page has gone and
 * come back. So ids are minted once across every mount (never `link-1` again for another link), and
 * the rows' ids and the lists the page sent live beside the queue (`useListMemory`), which a page
 * coming back adopts — never a fresh numbering under which a queued "remove link-3" would take
 * another link, or its own edit go unrecognized.
 */
let mintedLinks = 0;
const mintLink = () => `link-${++mintedLinks}`;

export function LinksTabView({
  body,
  now,
  canEdit,
  onSave,
  queueKey = 'links',
  lakeSheetHref,
  className,
  ...props
}: LinksTabViewProps) {
  const derived = derivedRows(body, now);
  const maps = googleMapsRow(body);
  // Each link's id: the page's own sends name it exactly; any other list carries it only to a link
  // with exactly its words (`carryIds`).
  // The rows' ids and the lists this page sent live beside the queue (`useListMemory`): a change
  // still queued names them after the page has gone, and a page coming back adopts them.
  const ids = useListMemory<KeyedLink[]>(queueKey, 'ids', () => []);
  const links = body.referenceLinks;
  // **The rows' identities come from the page's own writes where it can tell**: a list the server
  // shows that is exactly one this page sent and hasn't seen shown yet takes that list's keys, row
  // for row — so a link this page added carries the key it was minted with, even beside a duplicate
  // of its words, and even when its echo renders after the next save has gone out. Once shown, a
  // sent list is spent, with every one sent before it: a later list that only reads the same (an
  // undo, another moderator's edits) carries ids by their words (`carryIds`), like any other list.
  const unseen = useListMemory<(readonly KeyedLink[])[]>(queueKey, 'unseen', () => []);
  const staff = useMemo(() => {
    const list = links ?? [];
    let at = unseen.current.length - 1;
    while (at >= 0 && !sameLinks(unseen.current[at] ?? [], list)) at--;
    const sent = unseen.current[at];
    if (sent !== undefined) unseen.current = unseen.current.slice(at + 1);
    // A list that still reads as the rows drawn keeps them whole — a page come back before its own
    // edit's echo, or the same list delivered again: nothing it hasn't seen has happened to them (the
    // queue reads such a list so too, `observe`), so a change pressed on a row meanwhile still finds
    // its link, never a fresh id the edit in flight left it under.
    if (sent === undefined && sameLinks(ids.current, list)) return ids.current;
    // Otherwise ids carry by exact words (`carryIds`), from what the page drew and from the newest
    // list it sent — so its own edit keeps its id when its echo arrives beside another moderator's
    // change, and nothing is ever inferred from a place.
    const newest = unseen.current.at(-1) ?? [];
    const prev = [...newest, ...ids.current.filter((l) => !newest.some((n) => n.key === l.key))];
    const next = sent !== undefined ? sent.map((l) => ({ ...l })) : carryIds(prev, list, mintLink);
    ids.current = next;
    return next;
    // `ids` and `unseen` are the list's own (`useListMemory`): new objects whenever `queueKey` changes.
  }, [links, ids, unseen]);
  const section = useRef<HTMLDivElement | null>(null);
  // **Focus is never taken from the keyboard by a save**: after an edit or an add lands, the link's
  // own Edit takes focus back (its id survives the edit; an add's was minted at Add) once its row
  // shows; after a remove, or before the row shows, the section's next stop.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    const root = section.current;
    // **Only focus the closed editor dropped is taken back** — fallen to the page with it, or caught
    // by the console's floor — never focus the moderator has since put somewhere else. Decided here,
    // after the editor has gone, the one place that sees where focus ended up.
    if (!focusIsLost(root)) return;
    const target =
      root?.querySelector<HTMLElement>(
        `[data-link-key="${CSS.escape(key)}"] [data-slot="link-edit"]`,
      ) ?? root?.querySelector<HTMLElement>('[data-slot="link-edit"], [data-slot="link-add"]');
    target?.focus();
  });
  const editable = canEdit && onSave !== undefined;
  const [editing, setEditing] = useState<Editing | null>(null);
  // **A save's completion acts only on the editor opening that sent it** — never on whatever editor
  // stands in that place now. Each opening has its own id: after Cancel and Edit on the same link
  // (or another), a late save closes nothing, takes no focus and discards nothing typed since.
  const openings = useRef(0);
  const open = (e: Omit<Editing, 'opening' | 'added' | 'unsaved'> & { added?: boolean }) =>
    setEditing({
      ...e,
      added: e.added === true,
      unsaved: e.added === true,
      opening: ++openings.current,
    });
  const openNow = useRef<Editing | null>(null);
  openNow.current = editing;
  // **A finished save closes its editor only if the draft is still what it sent.** Typed on since,
  // the editor stays open holding the newer text — an unsaved edit over the saved value, nothing
  // lost and nothing claimed saved that wasn't.
  const landed = (opening: number, key: string, sent: StaffLink | null) => {
    const now = openNow.current;
    // **A completion acts only if its editor is still the open one**: none open (canceled), or
    // another opening, and it closes nothing and takes no focus.
    if (now === null || now.opening !== opening) return;
    if (sent !== null) {
      const draft = { label: now.label.trim(), url: now.url.trim() };
      if (draft.label !== sent.label || draft.url !== sent.url) {
        // Saved, and typed on since: the same editor, still mounted, now edits what it saved.
        setEditing((e) => (e !== null && e.opening === opening ? { ...e, unsaved: false } : e));
        return;
      }
    }
    // Asks for the link's Edit to take focus; the effect hands it over only if focus left with the
    // editor, never from a control the moderator has moved to while the save was out.
    refocus.current = key;
    setEditing(null);
  };
  // The openings with a save on its way: an opening's own Done and Remove don't send twice (a ref,
  // so two presses in one frame see it); a reopened editor isn't held by the old one's save.
  const sending = useRef(new Set<number>());
  const [busyOpenings, setBusyOpenings] = useState<ReadonlySet<number>>(new Set());
  const editorBusy = editing !== null && busyOpenings.has(editing.opening);
  // **A row's editor whose link is no longer in the list** (changed or removed by another write) is
  // drawn at the foot, holding what was typed and saying why — never bound to no row, which would
  // hide it and, while it stays open, every Edit and Add with it. Not while its own save is out
  // (that save closes it, or is refused and it shows then); its Done and Remove send nothing, the
  // link they would change being gone.
  const orphaned =
    editing !== null &&
    !editing.added &&
    !busyOpenings.has(editing.opening) &&
    !staff.some((l) => l.key === editing.key);
  // It takes focus only if focus fell with its row — never from where the moderator moved since.
  useEffect(() => {
    if (!orphaned || !focusIsLost(section.current)) return;
    section.current?.querySelector<HTMLElement>('[data-slot="link-editor"] input')?.focus();
  }, [orphaned]);
  const editorSave = async (opening: number, change: Change) => {
    sending.current.add(opening);
    setBusyOpenings(new Set(sending.current));
    try {
      return await save(change);
    } finally {
      sending.current.delete(opening);
      setBusyOpenings(new Set(sending.current));
    }
  };
  // **A saved add is found by its key in the list the queue builds on** — which holds an add the
  // server acknowledged before the render that shows it — never only in the rows drawn. If that list
  // no longer holds it (another write moved the list before its echo could be told), nothing is
  // sent and the editor says so (`null`), never guessing by its words.
  const editorChange = async (
    { key, opening, added, unsaved }: Editing,
    change: Change,
  ): Promise<boolean | null> => {
    if (!added || unsaved) return editorSave(opening, change);
    const seen = { lost: false };
    const ok = await editorSave(opening, (base) => {
      if (base.some((l) => l.key === key)) return change(base);
      seen.lost = true;
      return base;
    });
    if (!seen.lost) return ok;
    setEditing((e) => (e !== null && e.opening === opening ? { ...e, error: LOST_ADD } : e));
    return null;
  };
  // Writes in flight: the grips hold a dropped order until the server's echo moves the rows.
  const [inFlight, setInFlight] = useState(0);

  // **Every save goes through one queue** (`listWriter`): reorder, add, edit and remove each hand
  // it a change by link id, applied to the newest list the server acknowledged — so a remove
  // pressed while a reorder saves can't put the old order back, and two saves never overlap.
  // A refusal is a toast naming the body (D268).
  const hold = useBodyHold();
  const words = (l: readonly KeyedLink[]) => l.map(({ label, url }) => ({ label, url }));
  const push = useListWriter<KeyedLink>(
    queueKey,
    staff,
    async (next, base) => {
      if (!onSave) return false;
      // The list this attempt sends, keys and all: the server's echo of it takes these keys.
      unseen.current = [...unseen.current, next];
      try {
        // `false`: refused, and said in its toast — never taken as acknowledged.
        if ((await onSave(words(next), words(base))) !== false) return true;
        unseen.current = unseen.current.filter((s) => s !== next);
        return false;
      } catch (err) {
        // Refused or moved: the server never held this list, so nothing it shows takes its keys.
        unseen.current = unseen.current.filter((s) => s !== next);
        const current = listChanged(err) as StaffLink[] | null;
        if (current !== null) {
          // Moved underneath: the queue re-applies the change on the list as it now stands, keyed as
          // the rows key it — never a second minting of the same list, under which an edit opened
          // from a row would find nothing to change. Already drawn: the rows' own keys. Not drawn
          // yet: carried by words from the base, and held for the render that shows it.
          if (sameLinks(ids.current, current)) return { current: ids.current };
          const rebuilt = carryIds(base, current, mintLink);
          unseen.current = [...unseen.current, rebuilt];
          return { current: rebuilt };
        }
        // `onSave` passes on nothing else (`sendFor` says every refusal itself): never taken as saved.
        return false;
      }
    },
    // The keys are the page's own: a link the queue added is the same link once its echo shows.
    sameLinks,
    // A change that no longer applies (its link was removed meanwhile), or a list that kept moving
    // under it, is said, never dropped quietly: a toast naming the body.
    (why) => sayNotSaved(hold, why === 'gone' ? LINKS_GONE : LINKS_KEPT_MOVING),
  );
  const save = async (change: Change) => {
    setInFlight((n) => n + 1);
    try {
      return await push(change);
    } finally {
      setInFlight((n) => n - 1);
    }
  };

  const commitEdit = async () => {
    if (editing === null || sending.current.has(editing.opening)) return;
    if (orphaned) {
      setEditing({ ...editing, error: LINK_EDITED_AWAY });
      return;
    }
    const draft = { label: editing.label, url: editing.url };
    const error = referenceLinkError(draft);
    if (error !== null) {
      setEditing({ ...editing, error });
      return;
    }
    const clean = { label: draft.label.trim(), url: draft.url.trim() };
    const { key, opening, unsaved } = editing;
    const ok = await editorChange(
      editing,
      unsaved ? linkChanges.add({ ...clean, key }) : linkChanges.edit(key, clean),
    );
    if (ok) landed(opening, key, clean);
  };

  const removeEdited = async () => {
    if (editing === null || editing.unsaved) {
      setEditing(null);
      return;
    }
    if (sending.current.has(editing.opening)) return;
    if (orphaned) {
      setEditing({ ...editing, error: LINK_EDITED_AWAY });
      return;
    }
    const { key, opening } = editing;
    const ok = await editorChange(editing, linkChanges.remove(key));
    // A removed link has no row left to edit: its editor goes whatever was typed.
    if (ok) landed(opening, key, null);
  };

  const offeredCount = derived.filter((d) => d.offered).length;
  const sheetCount = offeredCount + staff.length;
  // An added link's editor stays at the foot until it closes: its saved row isn't drawn twice
  // meanwhile (and with no other row, no empty list is drawn above it).
  const rowItems = editing?.added ? staff.filter((l) => l.key !== editing.key) : staff;

  return (
    <div
      data-slot="links-tab"
      className={cn('flex flex-col gap-(--space-5_5)', className)}
      {...props}
    >
      <Section title="Built from the lake" count={offeredCount}>
        <ul className="m-0 flex list-none flex-col p-0">
          {derived.map((row) => (
            <DerivedLinkRow key={row.id} row={row} />
          ))}
          {maps !== null && <DerivedLinkRow row={{ ...maps, offered: true }} staffOnly />}
        </ul>
      </Section>

      <Section
        ref={section}
        title="Added by staff"
        count={staff.length}
        end={
          editable && editing === null ? (
            <Button
              size="xs"
              data-slot="link-add"
              onClick={() =>
                open({
                  key: mintLink(),
                  added: true,
                  label: '',
                  url: '',
                  error: null,
                })
              }
            >
              Add a link
            </Button>
          ) : undefined
        }
      >
        {rowItems.length > 0 && (
          <SortableRows<KeyedLink>
            aria-label="Links added by staff"
            items={rowItems}
            idOf={(l) => l.key}
            labelOf={(l) => l.label}
            // Editing takes the grips away (the lift is put down); a save keeps them, inert.
            disabled={!editable || editing !== null}
            pending={inFlight > 0}
            onReorder={(keys) => void save(linkChanges.order(keys))}
            renderRow={(link, { grip }) =>
              editing !== null && !editing.added && editing.key === link.key ? (
                <LinkEditor
                  editing={editing}
                  busy={editorBusy}
                  onChange={setEditing}
                  onDone={() => void commitEdit()}
                  onCancel={() => setEditing(null)}
                  onRemove={() => void removeEdited()}
                />
              ) : (
                <StaffLinkRow
                  link={link}
                  grip={grip}
                  onEdit={
                    editable && editing === null
                      ? () =>
                          open({
                            key: link.key,
                            label: link.label,
                            url: link.url,
                            error: null,
                          })
                      : undefined
                  }
                />
              )
            }
          />
        )}
        {editing !== null && (editing.added || orphaned) && (
          <LinkEditor
            // One instance for the add's whole life — saved or not — so focus, caret, selection
            // and an IME's composition are never touched by a save. (An orphaned row's editor
            // mounts here once its row has gone, and takes focus only if focus fell with it.)
            key={editing.opening}
            autoFocus={editing.added}
            editing={
              orphaned && editing.error === null ? { ...editing, error: LINK_EDITED_AWAY } : editing
            }
            busy={editorBusy}
            onChange={setEditing}
            onDone={() => void commitEdit()}
            onCancel={() => setEditing(null)}
            onRemove={() => void removeEdited()}
          />
        )}
      </Section>

      <Section
        title="In the lake sheet"
        end={
          lakeSheetHref === null ? undefined : (
            <a
              href={lakeSheetHref}
              target="_blank"
              rel="noreferrer"
              data-slot="button"
              className={buttonVariants({ variant: 'link', size: 'xs' })}
            >
              Lake sheet
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.9em]" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )
        }
      >
        <p data-slot="links-sheet-note" className="m-0 text-assist leading-(--lead-list) text-fg3">
          {/* With no link, the sheet draws no Elsewhere at all (`LinksView` returns nothing). */}
          {sheetCount === 0
            ? 'With no links, the lake sheet has no Elsewhere section.'
            : `Skaters read ${sheetCount === 1 ? 'this link' : `all ${sheetCount}`}, in this order, under Elsewhere.`}
        </p>
      </Section>
    </div>
  );
}

/** A link opened in a new tab: the square new-tab button at a row's end. */
function OpenLink({
  href,
  label,
  disabled = false,
}: {
  href: string;
  label: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <Button size="icon-xs" disabled aria-label={`${label} (not offered)`}>
        <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.8em]" />
      </Button>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-slot="button"
      aria-label={`${label} (opens in a new tab)`}
      className={buttonVariants({ size: 'icon-xs' })}
    >
      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.8em]" />
    </a>
  );
}

const ROW =
  'grid items-start gap-x-(--space-3_5) border-b border-dotted border-line py-(--space-2_5) first:pt-0 last:border-b-0 last:pb-0';

/** A staff row sits inside the sortable list's `li`: first and last are the `li`'s. */
const STAFF_ROW =
  'grid items-start gap-x-(--space-3_5) border-0 border-b border-dotted border-line py-(--space-2_5) in-[li:first-child]:pt-0 in-[li:last-child]:border-b-0 in-[li:last-child]:pb-0';

function DerivedLinkRow({
  row,
  staffOnly = false,
}: {
  row: Omit<DerivedRow, 'id'> & { id: string };
  /** Built for staff alone (never in the lake sheet): full strength, outside the count. */
  staffOnly?: boolean;
}) {
  return (
    <li
      data-slot="link-row"
      data-link-id={row.id}
      data-staff-only={staffOnly ? '' : undefined}
      data-offered={row.offered && !staffOnly ? '' : undefined}
      className={cn(
        ROW,
        'grid-cols-[minmax(0,1fr)_auto]',
        !row.offered && 'opacity-(--opacity-muted)',
      )}
    >
      <span className="flex min-w-0 flex-col gap-(--space-1)">
        <span className="text-body leading-(--lead-snug) text-fg">{row.label}</span>
        <span className="text-assist leading-(--lead-list) text-fg3">{row.sub}</span>
      </span>
      <OpenLink href={row.url} label={row.label} disabled={!row.offered} />
    </li>
  );
}

function StaffLinkRow({
  link,
  grip,
  onEdit,
}: {
  link: KeyedLink;
  grip: ReactNode;
  onEdit: (() => void) | undefined;
}) {
  return (
    <div
      data-slot="link-row"
      data-link-key={link.key}
      className={cn(
        STAFF_ROW,
        grip === null
          ? 'grid-cols-[minmax(0,1fr)_auto]'
          : 'grid-cols-[auto_minmax(0,1fr)_auto] gap-x-(--space-2_5)',
      )}
    >
      {grip !== null && <span className="flex h-[1.3em] items-center">{grip}</span>}
      <span className="flex min-w-0 flex-col gap-(--space-1)">
        <span className="text-body leading-(--lead-snug) text-fg">{link.label}</span>
        <span className="truncate font-(family-name:--family-mono) text-mono-sm leading-(--lead-list) text-fg3">
          {link.url}
        </span>
      </span>
      <span className="flex items-center gap-(--space-2)">
        {onEdit !== undefined && (
          <Button size="xs" data-slot="link-edit" onClick={onEdit}>
            Edit
          </Button>
        )}
        <OpenLink href={link.url} label={link.label} />
      </span>
    </div>
  );
}

/** A row opened for editing: its label and address, Remove inside it, Done to save. */
function LinkEditor({
  editing,
  busy,
  autoFocus = true,
  onChange,
  onDone,
  onCancel,
  onRemove,
}: {
  editing: Editing;
  busy: boolean;
  /** The label takes focus as it mounts: an editor the moderator opened. */
  autoFocus?: boolean;
  onChange: (next: Editing) => void;
  onDone: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const labelId = useId();
  const urlId = useId();
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onDone();
    }
  };
  return (
    <div
      data-slot="link-editor"
      data-editing-key={editing.key}
      className="flex flex-col gap-(--space-2) border-0 border-b border-dotted border-line py-(--space-2_5) last:border-b-0 in-[li:last-child]:border-b-0"
    >
      <label htmlFor={labelId} className="sr-only">
        Label
      </label>
      <Input
        id={labelId}
        autoFocus={autoFocus}
        value={editing.label}
        maxLength={MAX_REFERENCE_LINK_LABEL}
        placeholder="What the link is, as skaters read it"
        onChange={(e) => onChange({ ...editing, label: e.target.value, error: null })}
        onKeyDown={keys}
        aria-invalid={editing.error !== null || undefined}
      />
      <label htmlFor={urlId} className="sr-only">
        Address
      </label>
      <Input
        id={urlId}
        value={editing.url}
        maxLength={MAX_URL_CHARS}
        placeholder="https://"
        className="font-(family-name:--family-mono) text-mono-sm"
        onChange={(e) => onChange({ ...editing, url: e.target.value, error: null })}
        onKeyDown={keys}
        aria-invalid={editing.error !== null || undefined}
      />
      {editing.error !== null && (
        <p role="alert" className="m-0 text-assist text-bad">
          {editing.error}
        </p>
      )}
      <span className="flex items-center gap-(--space-2)">
        <Button size="xs" loading={busy} onClick={onDone}>
          Done
        </Button>
        <Button size="xs" variant="bare" onClick={onCancel}>
          Cancel
        </Button>
        {!editing.unsaved && (
          <Button size="xs" variant="danger" className="ms-auto" onClick={onRemove}>
            Remove
          </Button>
        )}
      </span>
    </div>
  );
}
