import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import { type Ref, useEffect, useRef, useState } from 'react';

import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';

import { SEARCH_LABEL } from '../words/corpusWords';

/** How long typing rests before the search is asked (the library's beat). */
export const TASK_SEARCH_DEBOUNCE_MS = 250;

/**
 * **A task lane's search** (4.2, 4.3's field): the body by name, either name, or an id. It waits a
 * beat before it asks, so the URL and the read follow what was typed, not every key; Esc clears it.
 *
 * **Typing belongs to the place it was typed in** (the library's rule): pending typing is dropped
 * whenever the place moves — another lane, a tab, the back button — and the field shows what the
 * URL says. One rule, checked twice: the place moving resets the field, and a wait that ends after
 * the place moved sends nothing.
 *
 * A twin of the library's private `SearchField` (`bodies/ListTools.tsx`): a kit candidate, so the
 * two become one.
 */
export function TaskSearch({
  q,
  place,
  onSearch,
  placeholder,
  inputRef,
}: {
  q: string;
  /** Where the search is typed: typing belongs to it, and is dropped when it moves. */
  place: string;
  onSearch: (q: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  const [text, setText] = useState(q);
  const sent = useRef(q);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ onSearch, place });
  latest.current = { onSearch, place };
  const typedIn = useRef(place);
  useEffect(() => {
    if (q !== sent.current || place !== typedIn.current) {
      window.clearTimeout(timer.current);
      sent.current = q;
      typedIn.current = place;
      setText(q);
    }
  }, [q, place]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <InputGroup data-slot="corpus-search" className="h-(--space-8) text-body">
      <InputGroupIcon>
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <Input
        ref={inputRef}
        type="search"
        aria-label={SEARCH_LABEL}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          window.clearTimeout(timer.current);
          const at = latest.current.place;
          timer.current = window.setTimeout(() => {
            if (latest.current.place !== at) return;
            sent.current = next.trim();
            latest.current.onSearch(next.trim());
          }, TASK_SEARCH_DEBOUNCE_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && text !== '') {
            event.preventDefault();
            setText('');
            window.clearTimeout(timer.current);
            if (sent.current === '') return;
            sent.current = '';
            onSearch('');
          }
        }}
      />
      <InputGroupKbd always>/</InputGroupKbd>
    </InputGroup>
  );
}
