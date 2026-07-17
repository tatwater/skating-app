import { api } from '@skating/convex/api'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { SearchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar } from './ProfileView'
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from './ui/combobox'

/** A public-profile search hit (from `profiles.searchProfiles`). */
export interface ProfileHit {
  userId: string
  username: string
  displayName: string
  profileImageUrl?: string
  homeTownLabel?: string
}

/**
 * Presentational profile-search box (reuses the `LakeSearch` Combobox pattern). Convex-free so it's
 * testable; client filtering is off so the server's name matches survive. Searches **public**
 * profiles only (D13) — the server excludes private + blocked.
 */
export function ProfileSearchBox({
  items,
  inputValue,
  onInputValueChange,
  onSelect,
  emptyVisible,
  open,
}: {
  items: ProfileHit[]
  inputValue: string
  onInputValueChange: (value: string) => void
  onSelect: (hit: ProfileHit) => void
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
      itemToStringLabel={(hit: ProfileHit | null) => hit?.displayName ?? ''}
      isItemEqualToValue={(a: ProfileHit | null, b: ProfileHit | null) => a?.userId === b?.userId}
      onValueChange={(hit: ProfileHit | null) => {
        if (hit) onSelect(hit)
      }}
    >
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <ComboboxInput
          className="pl-8"
          placeholder="Search skaters by name…"
          aria-label="Search skaters by name"
        />
      </div>
      <ComboboxContent>
        <ComboboxList>
          {(hit: ProfileHit) => (
            <ComboboxItem key={hit.userId} value={hit}>
              <Avatar displayName={hit.displayName} imageUrl={hit.profileImageUrl} size={20} />
              <span className="flex-1 truncate">{hit.displayName}</span>
              <span className="text-muted-foreground text-xs">
                {hit.homeTownLabel ?? `@${hit.username}`}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        {emptyVisible ? (
          <div className="px-2 py-4 text-center text-muted-foreground text-sm">
            No skaters found.
          </div>
        ) : null}
      </ComboboxContent>
    </Combobox>
  )
}

/** Public-profile search (D13); selecting a result navigates to that profile. */
export function ProfileSearch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), 150)
    return () => clearTimeout(id)
  }, [text])

  const results = useQuery(
    api.profiles.searchProfiles,
    debounced.length > 0 ? { query: debounced } : 'skip',
  )

  return (
    <ProfileSearchBox
      items={results ?? []}
      inputValue={text}
      onInputValueChange={setText}
      emptyVisible={debounced.length > 0 && results !== undefined && results.length === 0}
      onSelect={(hit) => {
        setText('')
        navigate({ to: '/u/$username', params: { username: hit.username } })
      }}
    />
  )
}
