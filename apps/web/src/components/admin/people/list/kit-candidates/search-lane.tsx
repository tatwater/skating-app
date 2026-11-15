import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import { type ComponentProps, type Ref, useEffect, useRef, useState } from 'react';

import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';
import { cn } from '@/lib/utils';

/**
 * **A kit candidate** (People, B01): the search lane — a search field drawn as the first lane of a
 * lanes sidebar (`.lane.search`), over the kit `Lanes`. A search in a lane uses only the input's own
 * rule, never a second one under the lane (Round 2, rule 9); it sits at the lanes' inset, a lane's
 * height plus the gap the group kicker under it keeps.
 *
 * - **Its `/` cap shows at rest** — the key that puts focus here. The page binds the key; the field
 *   only shows it.
 * - **It waits a beat before it asks** (`debounceMs`), so the URL and the read follow the words, not
 *   each key. Escape clears it at once.
 * - **Typing belongs to the place it was typed in.** `place` names everything about the page the
 *   search belongs to (the lane, the open record): whenever it changes — another lane, a record
 *   opened, the back button — pending typing is dropped and the field shows `value` again, whether
 *   or not the search itself changed (two places can both have an empty one). A wait that ends
 *   after the place moved sends nothing, and an unmounted field sends nothing at all.
 */

const DEBOUNCE_MS = 250;

type SearchLaneProps = Omit<ComponentProps<'div'>, 'onChange'> & {
  /** The search as the page holds it (the URL's). */
  value: string;
  /** The typed search, once typing rests (trimmed); `''` when cleared. */
  onSearch: (value: string) => void;
  /** The field's accessible name ("Search any account"). */
  label: string;
  /** What it says at rest; default the label. */
  placeholder?: string;
  /** Where the search is typed; typing pending when it changes is dropped. Default: one place. */
  place?: string;
  /** How long typing rests before it is sent. */
  debounceMs?: number;
  /** The key that focuses it, shown in its cap; `null` for none. */
  focusKey?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
};

function SearchLane({
  value,
  onSearch,
  label,
  placeholder = label,
  place = '',
  debounceMs = DEBOUNCE_MS,
  focusKey = '/',
  inputRef,
  disabled = false,
  className,
  ...props
}: SearchLaneProps) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ onSearch, place });
  latest.current = { onSearch, place };
  const typedIn = useRef(place);
  useEffect(() => {
    if (value !== sent.current || place !== typedIn.current) {
      window.clearTimeout(timer.current);
      sent.current = value;
      typedIn.current = place;
      setText(value);
    }
  }, [value, place]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div
      data-slot="search-lane"
      className={cn('flex shrink-0 px-(--space-4_5) pb-(--space-2_5)', className)}
      {...props}
    >
      <InputGroup className="text-row">
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input
          ref={inputRef}
          type="search"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          className="text-row"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            window.clearTimeout(timer.current);
            const at = latest.current.place;
            timer.current = window.setTimeout(() => {
              if (latest.current.place !== at) return;
              sent.current = next.trim();
              latest.current.onSearch(next.trim());
            }, debounceMs);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || text === '') return;
            event.preventDefault();
            setText('');
            window.clearTimeout(timer.current);
            // Typing that never landed leaves nothing to clear.
            if (sent.current === '') return;
            sent.current = '';
            onSearch('');
          }}
        />
        {focusKey !== null && <InputGroupKbd always>{focusKey}</InputGroupKbd>}
      </InputGroup>
    </div>
  );
}

export { SearchLane, type SearchLaneProps };
