import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-regular-svg-icons';
import { type ReferenceLinkBody, referenceLinkError } from '@skating/core';
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
import { useBodyBound } from '../../frame/currentBody';
import { useListWriter } from '../listWriter';
import {
  carryIds,
  type DerivedRow,
  derivedRows,
  type KeyedLink,
  linkChanges,
  type StaffLink,
  sameLinks,
} from './linksModel';

/**
 * Board 5.4.9, Body › Links, the default view: the links built from the lake (derived at render
 * time, stored nowhere), the links staff added — rows that reorder by a grip, each with Edit — and
 * where skaters read them all, in this order, under *Elsewhere* in the lake sheet.
 *
 * Everything arrives as props; the wiring (`LinksTab`) reads the body and writes the list.
 */

export type LinksTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  body: ReferenceLinkBody;
  now: number;
  /** The viewer holds `body.identity` (the staff links are theirs to edit). */
  canEdit: boolean;
  /** Writes the whole staff list (add, edit, remove and reorder all land here). */
  onSave?: (links: StaffLink[]) => Promise<void>;
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

/** Said when an added link's row can't be told from the list any more (another write moved it). */
const LOST_ADD =
  'The list changed while this link was saving, so this editor can’t tell which row it is. Cancel, then edit the link from its row.';

export function LinksTabView({
  body,
  now,
  canEdit,
  onSave,
  lakeSheetHref,
  className,
  ...props
}: LinksTabViewProps) {
  const derived = derivedRows(body, now);
  // Each link keeps its id across an edit (its words change, its id doesn't): `carryIds`.
  const minted = useRef(0);
  const ids = useRef<KeyedLink[]>([]);
  const links = body.referenceLinks;
  // **The rows' identities come from the page's own writes where it can tell**: a list the server
  // shows that is exactly the one this page last sent takes that list's keys, row for row — so a
  // link this page added carries the key it was minted with, even beside a duplicate of its words.
  // Any other list carries ids by their words (`carryIds`).
  const lastSent = useRef<readonly KeyedLink[] | null>(null);
  const staff = useMemo(() => {
    const sent = lastSent.current;
    const next =
      sent !== null && sameLinks(sent, links ?? [])
        ? sent.map((l) => ({ ...l }))
        : carryIds(ids.current, links ?? [], () => `link-${++minted.current}`);
    ids.current = next;
    return next;
  }, [links]);
  const section = useRef<HTMLDivElement | null>(null);
  // **Focus is never taken from the keyboard by a save**: after an edit lands, the link's own Edit
  // takes focus back (its id survives the edit); after a remove or an add, the section's next stop.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    const root = section.current;
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
    if (now !== null && now.opening !== opening) return;
    if (now !== null && sent !== null) {
      const draft = { label: now.label.trim(), url: now.url.trim() };
      if (draft.label !== sent.label || draft.url !== sent.url) {
        // Saved, and typed on since: the same editor, still mounted, now edits what it saved.
        setEditing((e) => (e !== null && e.opening === opening ? { ...e, unsaved: false } : e));
        return;
      }
    }
    refocus.current = key;
    setEditing(null);
  };
  // The openings with a save on its way: an opening's own Done and Remove don't send twice (a ref,
  // so two presses in one frame see it); a reopened editor isn't held by the old one's save.
  const sending = useRef(new Set<number>());
  const [busyOpenings, setBusyOpenings] = useState<ReadonlySet<number>>(new Set());
  const editorBusy = editing !== null && busyOpenings.has(editing.opening);
  const editorSave = async (
    opening: number,
    change: (base: readonly KeyedLink[]) => readonly KeyedLink[],
  ) => {
    sending.current.add(opening);
    setBusyOpenings(new Set(sending.current));
    try {
      return await save(change);
    } finally {
      sending.current.delete(opening);
      setBusyOpenings(new Set(sending.current));
    }
  };
  // Writes in flight: the grips hold a dropped order until the server's echo moves the rows.
  const [inFlight, setInFlight] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  // **Every save goes through one queue** (`listWriter`): reorder, add, edit and remove each hand
  // it a change by link id, applied to the newest list the server acknowledged — so a remove
  // pressed while a reorder saves can't put the old order back, and two saves never overlap.
  const here = useBodyBound();
  const push = useListWriter<KeyedLink>(
    staff,
    async (next) => {
      if (!onSave) return false;
      setSaveError(null);
      // The list this attempt sends, keys and all: the server's echo of it takes these keys.
      lastSent.current = next;
      try {
        await onSave(next.map(({ label, url }) => ({ label, url })));
        return true;
      } catch (err) {
        // Refused: the server holds no list of ours to carry keys from.
        lastSent.current = null;
        setSaveError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    // The keys are the page's own: a link the queue added is the same link once its echo shows.
    sameLinks,
    // The console's binding: a queue whose console has gone takes up nothing more.
    here,
  );
  const save = async (change: (base: readonly KeyedLink[]) => readonly KeyedLink[]) => {
    setInFlight((n) => n + 1);
    try {
      return await push(change);
    } finally {
      setInFlight((n) => n - 1);
    }
  };

  const commitEdit = async () => {
    if (editing === null || sending.current.has(editing.opening)) return;
    // A saved add whose row the page can no longer tell (another write moved the list): say so,
    // never guess by its words.
    if (editing.added && !editing.unsaved && !staff.some((l) => l.key === editing.key)) {
      setEditing({ ...editing, error: LOST_ADD });
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
    const ok = await editorSave(
      opening,
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
    const { key, opening } = editing;
    const ok = await editorSave(opening, linkChanges.remove(key));
    // A removed link has no row left to edit: its editor goes whatever was typed.
    if (ok) landed(opening, key, null);
  };

  const offeredCount = derived.filter((d) => d.offered).length;
  const sheetCount = offeredCount + staff.length;

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
                  key: `link-${++minted.current}`,
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
        {staff.length > 0 && (
          <SortableRows<KeyedLink>
            aria-label="Links added by staff"
            // An added link's editor stays at the foot until it closes: its saved row isn't drawn
            // twice meanwhile.
            items={editing?.added ? staff.filter((l) => l.key !== editing.key) : staff}
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
        {editing?.added && (
          <LinkEditor
            // One instance for the add's whole life — saved or not — so focus, caret, selection
            // and an IME's composition are never touched by a save.
            key={editing.opening}
            editing={editing}
            busy={editorBusy}
            onChange={setEditing}
            onDone={() => void commitEdit()}
            onCancel={() => setEditing(null)}
            onRemove={() => void removeEdited()}
          />
        )}
        {saveError !== null && (
          <p role="alert" className="m-0 text-assist text-bad">
            {saveError}
          </p>
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
      rel="noreferrer"
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

function DerivedLinkRow({ row }: { row: DerivedRow }) {
  return (
    <li
      data-slot="link-row"
      data-offered={row.offered ? '' : undefined}
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
  onChange,
  onDone,
  onCancel,
  onRemove,
}: {
  editing: Editing;
  busy: boolean;
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
        autoFocus
        value={editing.label}
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
        data-link-field="url"
        value={editing.url}
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
