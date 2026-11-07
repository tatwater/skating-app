import { Avatar } from '../../kit/avatar';
import { Button } from '../../kit/button';
import { Block, BlockText, PaneHead } from './SettingsParts';

export interface BlockedPerson {
  userId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
}

/**
 * Blocked people (7.10): the people you blocked, each with Unblock. A block never hides a report
 * (D3) — it's said at the top, because it's the thing a person blocking someone needs to know.
 */
export function BlockedSection({
  people,
  pending,
  onUnblock,
}: {
  /** `undefined` while loading. */
  people: BlockedPerson[] | undefined;
  /** The rows mid-unblock. */
  pending: ReadonlySet<string>;
  onUnblock: (person: BlockedPerson) => void;
}) {
  return (
    <>
      <PaneHead title="Blocked people">
        You don’t see each other’s profiles or comments. Their ice reports stay on the map — a block
        never removes safety information.
      </PaneHead>
      <Block>
        {people !== undefined && people.length > 0 && (
          <ul
            aria-label="Blocked people"
            className="ph-no-capture m-0 flex list-none flex-col border-0 border-line border-t border-solid p-0 [&>li:last-child]:border-b-0"
          >
            {people.map((p) => (
              <li
                key={p.userId}
                className="flex items-center gap-(--space-3) border-0 border-line border-b border-solid py-(--space-3)"
              >
                <Avatar name={p.displayName} src={p.profileImageUrl} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-fg text-row">{p.displayName}</div>
                  <div className="truncate font-(family-name:--family-mono) text-fg2 text-mono-sm">
                    @{p.username}
                  </div>
                </div>
                <Button
                  size="sm"
                  className="ml-auto"
                  loading={pending.has(p.userId)}
                  onClick={() => onUnblock(p)}
                  aria-label={`Unblock ${p.displayName}`}
                >
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
        {people !== undefined && people.length === 0 && (
          <BlockText>You haven’t blocked anyone.</BlockText>
        )}
        <BlockText muted>To block someone, open their profile and choose Block.</BlockText>
      </Block>
    </>
  );
}
