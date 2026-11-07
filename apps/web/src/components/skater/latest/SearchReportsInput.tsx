import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faXmark } from '@fortawesome/sharp-light-svg-icons';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../kit/button';
import { Input, InputGroup, InputGroupIcon } from '../../kit/input';
import { SEARCH_MAX_CHARS } from './latestSearch';

/** How long typing rests before the search runs (B03 §1.2). */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * "Search reports" (board 4.9, behind `latest-text-search`): the words go to `?q=` once typing
 * rests for 300 ms, so the URL — and the server — see a search, not every keystroke. The query text
 * never reaches analytics (D240: the URL's query string is stripped, and the pageview dedupe drops a
 * search-param-only navigation).
 */
export function SearchReportsInput({
  value,
  onCommit,
}: {
  /** The search in the URL, if any. */
  value: string | undefined;
  /** The trimmed words, or `undefined` for no search. */
  onCommit: (query: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? '');
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // The URL moved on its own (Clear search, Back): follow it — unless it already says what's typed.
  useEffect(() => {
    setText((typed) => ((value ?? '') === typed.trim() ? typed : (value ?? '')));
  }, [value]);

  useEffect(() => {
    const words = text.trim();
    if (words === (value ?? '')) return;
    const timer = setTimeout(
      () => commit.current(words === '' ? undefined : words),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <InputGroup data-slot="latest-search">
      <InputGroupIcon>
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <Input
        type="search"
        aria-label="Search reports"
        placeholder="Search reports"
        maxLength={SEARCH_MAX_CHARS}
        value={text}
        data-attr="latest-search"
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && text !== '') {
            // The field's own Esc clears it; it never reaches a card behind it.
            event.stopPropagation();
            setText('');
          }
        }}
      />
      {text !== '' && (
        <Button
          variant="bare"
          size="icon-xs"
          aria-label="Clear search"
          data-attr="latest-search-clear"
          onClick={() => {
            setText('');
            commit.current(undefined);
          }}
        >
          <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
        </Button>
      )}
    </InputGroup>
  );
}
