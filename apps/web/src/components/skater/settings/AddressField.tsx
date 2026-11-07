import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLocationDot, faMagnifyingGlass } from '@fortawesome/sharp-light-svg-icons';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';

import { cn } from '@/lib/utils';

import {
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupIcon,
} from '../../kit/input';
import { Kbd } from '../../kit/kbd';
import { PLATE } from '../styles';
import type { AddressLookup, AddressSuggestion } from './geocoder';

/** "14 School Street, Hanover, NH 03755, USA" → the street, then the rest. */
export function splitAddress(label: string): { street: string; rest: string | null } {
  const at = label.indexOf(',');
  if (at === -1) return { street: label, rest: null };
  const rest = label
    .slice(at + 1)
    .trim()
    .replace(/(^|,\s*)(USA|United States)$/i, '')
    .trim();
  return { street: label.slice(0, at).trim(), rest: rest || null };
}

/**
 * The credits a geocoder attribution may link, each to its canonical page. Only these names become
 * links, and only to these URLs — a URL inside the attribution string itself is never followed, so
 * whatever the provider sends stays plain text apart from the two names its terms ask us to credit.
 */
const CREDIT_LINKS: ReadonlyArray<readonly [name: string, href: string]> = [
  ['Geoapify', 'https://www.geoapify.com/'],
  ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'],
];
const CREDIT_PATTERN = new RegExp(CREDIT_LINKS.map(([name]) => name).join('|'), 'g');

/**
 * "Powered by Geoapify | © OpenStreetMap contributors" → the same text with each known credit a
 * new-tab link to its canonical page; anything else is left as text.
 */
export function linkifyAttribution(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(CREDIT_PATTERN)) {
    const href = CREDIT_LINKS.find(([name]) => name === match[0])?.[1];
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <a
        key={match.index}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-fg3 underline underline-offset-2 hover:text-fg1"
      >
        {match[0]}
      </a>,
    );
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * A typed address with the provider's suggestions under it (7.18): the primary way to set a home
 * or a traveling base. A combobox — ↑↓ move through the suggestions, Enter takes the lit one, Esc
 * closes the list — and the provider's attribution sits under the suggestions wherever they show.
 * What's typed is someone's address: `ph-no-capture`, never in the URL, never in an event.
 */
export function AddressField({
  label,
  hint,
  value,
  onValueChange,
  lookup,
  onPick,
  autoFocus = false,
}: {
  label: string;
  hint: string;
  value: string;
  onValueChange: (value: string) => void;
  lookup: AddressLookup;
  onPick: (suggestion: AddressSuggestion) => void;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [lit, setLit] = useState(0);
  const [closed, setClosed] = useState(false);
  const suggestions = lookup.state === 'ok' || lookup.state === 'loading' ? lookup.suggestions : [];
  const open = !closed && suggestions.length > 0;
  const attribution =
    lookup.state === 'ok'
      ? lookup.attribution
      : 'attribution' in lookup
        ? lookup.attribution
        : null;

  // A new list starts lit at its top (adjusted during render, not in an effect).
  const listKey = suggestions.map((s) => s.label).join('\n');
  const [seen, setSeen] = useState(listKey);
  if (seen !== listKey) {
    setSeen(listKey);
    setLit(0);
  }

  const pick = (s: AddressSuggestion) => {
    setClosed(true);
    onPick(s);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      // One Esc closes the list; the page underneath never sees it.
      event.preventDefault();
      event.stopPropagation();
      setClosed(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        // Reopened from the keyboard: the list starts at its top again.
        if (suggestions.length > 0) {
          setClosed(false);
          setLit(0);
        }
        return;
      }
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setLit((at) => (at + step + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      const chosen = suggestions[lit];
      if (chosen) pick(chosen);
    }
  };

  const typed = value.trim().toLowerCase();
  return (
    <Field className="ph-no-capture relative gap-0">
      <FieldLabel className="mb-(--space-1_5)">{label}</FieldLabel>
      <InputGroup>
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${lit}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="Start typing an address"
          value={value}
          data-attr="settings-address"
          onChange={(e) => {
            setClosed(false);
            onValueChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      </InputGroup>
      {open && (
        <div
          data-slot="address-suggestions"
          className={cn(PLATE, 'relative z-4 mt-(--space-1) py-(--space-1_5)')}
        >
          <div id={listId} role="listbox" aria-label="Suggested addresses">
            {suggestions.map((s, i) => {
              const { street, rest } = splitAddress(s.label);
              const bold = typed.length > 0 && street.toLowerCase().startsWith(typed);
              return (
                // The keyboard drives the list from the input (aria-activedescendant); a press picks.
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys are the input's, by design
                <div
                  key={`${s.label}-${s.lat}-${s.lng}`}
                  tabIndex={-1}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === lit}
                  data-lit={i === lit ? '' : undefined}
                  className="flex h-[2.875rem] cursor-pointer items-center gap-(--space-3) px-(--space-3_5) data-lit:bg-raise"
                  onPointerMove={() => setLit(i)}
                  // Keep the input focused through the press.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(s)}
                >
                  <FontAwesomeIcon
                    icon={faLocationDot}
                    aria-hidden="true"
                    className="h-[0.8125rem] text-fg2"
                  />
                  <span className="text-body text-fg">
                    {bold ? (
                      <>
                        <b className="font-semibold">{street.slice(0, typed.length)}</b>
                        {street.slice(typed.length)}
                      </>
                    ) : (
                      street
                    )}
                  </span>
                  {rest && <span className="ml-(--space-2) text-assist text-fg2">{rest}</span>}
                </div>
              );
            })}
          </div>
          <div className="mt-(--space-1) flex flex-wrap items-center gap-(--space-4) border-0 border-line border-t border-solid px-(--space-3_5) pt-(--space-2) pb-(--space-1) text-assist text-fg3">
            <span className="flex items-center gap-(--space-1_5)">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Move
            </span>
            <span className="flex items-center gap-(--space-1_5)">
              <Kbd>↵</Kbd>
              Choose
            </span>
            <span className="flex items-center gap-(--space-1_5)">
              <Kbd>Esc</Kbd>
              Close
            </span>
            {attribution && (
              <span data-slot="geocoder-attribution" className="ml-auto text-fg3">
                {linkifyAttribution(attribution)}
              </span>
            )}
          </div>
        </div>
      )}
      <FieldDescription className="mt-(--space-2)">
        {lookup.state === 'error'
          ? 'Suggestions didn’t load. Keep typing, or use your current location.'
          : hint}
      </FieldDescription>
    </Field>
  );
}
