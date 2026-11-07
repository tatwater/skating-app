import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 200;
const MAX_ROWS = 6;

/** A lake the search found — a body, or a bay standing for its body. */
export interface PickedLake {
  waterBodyId: string;
  name: string;
}

/**
 * *Or find a lake by name* (5.2), under the cards: the bounded name search (`waterBodies.searchByName`,
 * lakes and their bays). A bay picks its lake — a report is about a water body; where on it is the
 * where questions'. `/` focuses it while the sheet is open.
 */
export function LakeNameSearch({ onPick }: { onPick: (picked: PickedLake) => void }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hits = useQuery(
    api.waterBodies.searchByName,
    term.length >= 2 ? { query: term, limit: MAX_ROWS } : 'skip',
  );
  const rows = (hits ?? []).slice(0, MAX_ROWS);
  const pick = (i: number) => {
    const hit = rows[i];
    if (hit === undefined) return;
    onPick({
      waterBodyId: hit.waterBodyId,
      name: hit.kind === 'subArea' ? (hit.parentName ?? hit.name) : hit.name,
    });
  };

  return (
    <div data-slot="lake-name-search" className="flex flex-col">
      <InputGroup>
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input
          ref={inputRef}
          type="search"
          aria-controls={listId}
          aria-label="Find a lake by name"
          data-attr="which-lake-search"
          placeholder="Or find a lake by name"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(active);
            }
          }}
        />
        <InputGroupKbd>/</InputGroupKbd>
      </InputGroup>
      {rows.length > 0 ? (
        <ul id={listId} aria-label="Lakes" className="m-0 flex list-none flex-col p-0">
          {rows.map((hit, i) => (
            <li
              key={hit._id}
              className="border-0 border-b border-solid border-line last:border-b-0"
            >
              <button
                type="button"
                data-attr="which-lake-result"
                data-active={i === active ? '' : undefined}
                onClick={() => pick(i)}
                className={cn(
                  'flex w-full cursor-pointer items-baseline gap-(--space-2) rounded-control border-0 bg-transparent px-(--space-2) py-(--space-2_5) text-left text-row text-fg1 outline-none',
                  'hover:bg-lift-08 focus-visible:shadow-focus',
                  i === active && 'bg-lift-08 text-fg',
                )}
              >
                <span className="font-medium">{hit.name}</span>
                <span className="text-assist text-fg3">
                  {[hit.kind === 'subArea' ? hit.parentName : undefined, hit.states.join(', ')]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : term.length >= 2 && hits !== undefined ? (
        <p className="m-0 py-(--space-2_5) text-assist text-fg3">
          No lake by that name. Try another spelling, or drop a photo from the water.
        </p>
      ) : null}
    </div>
  );
}
