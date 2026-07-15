import { api } from '@skating/convex/api'
import { humanizeEnum, searchQueryArg } from '@skating/core'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { SearchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from './ui/combobox'

/** A search result row from `waterBodies.searchByName` (the light fly-to fields). */
export type LakeHit = {
  _id: string
  name: string
  type: string
  centroid: { lat: number; lng: number }
  states: string[]
}

/** "Lake · NY" — or "Lake · NY, VT" for a border-spanning body; just the type if unknown. */
function hitMeta(hit: LakeHit): string {
  const type = humanizeEnum(hit.type)
  return hit.states.length ? `${type} · ${hit.states.join(', ')}` : type
}

/**
 * Presentational lake-search box on the shadcn/Base-UI `Combobox`. Convex-free so it's testable.
 * Client filtering is disabled (`filter={null}`) so the server's typo-tolerant matches survive.
 * `open` is optional (uncontrolled in the app; forced in tests to render the result list).
 */
export function LakeSearchBox({
  items,
  inputValue,
  onInputValueChange,
  onSelect,
  emptyVisible,
  open,
}: {
  items: LakeHit[]
  inputValue: string
  onInputValueChange: (value: string) => void
  onSelect: (hit: LakeHit) => void
  emptyVisible: boolean
  open?: boolean
}) {
  return (
    <Combobox
      items={items}
      filter={null}
      open={open}
      inputValue={inputValue}
      onInputValueChange={onInputValueChange}
      itemToStringLabel={(hit: LakeHit | null) => hit?.name ?? ''}
      isItemEqualToValue={(a: LakeHit | null, b: LakeHit | null) => a?._id === b?._id}
      onValueChange={(hit: LakeHit | null) => {
        if (hit) onSelect(hit)
      }}
    >
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <ComboboxInput
          className="pl-8"
          placeholder="Search lakes by name…"
          aria-label="Search lakes by name"
        />
      </div>
      <ComboboxContent>
        <ComboboxList>
          {(hit: LakeHit) => (
            <ComboboxItem key={hit._id} value={hit}>
              <span className="flex-1 truncate">{hit.name || 'Unnamed water'}</span>
              <span className="text-xs text-muted-foreground">{hitMeta(hit)}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        {emptyVisible ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">No lakes found.</div>
        ) : null}
      </ComboboxContent>
    </Combobox>
  )
}

/**
 * Map search box (Phase 2.5). Full-text lake lookup over the regional corpus via
 * `waterBodies.searchByName` (server-side, typo-tolerant); the query is debounced and skipped
 * under 2 chars. Selecting a result navigates to `/water/$id` — the detail drawer opens and flies
 * the map to the lake (reusing the existing fly-to), so search needs no map wiring of its own.
 */
export function LakeSearch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150)
    return () => clearTimeout(id)
  }, [text])

  const arg = searchQueryArg(debounced)
  const results = useQuery(api.waterBodies.searchByName, arg)

  return (
    <LakeSearchBox
      items={results ?? []}
      inputValue={text}
      onInputValueChange={setText}
      emptyVisible={arg !== 'skip' && results !== undefined && results.length === 0}
      onSelect={(hit) => {
        setText('')
        navigate({ to: '/water/$id', params: { id: hit._id } })
      }}
    />
  )
}
