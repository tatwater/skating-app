import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faLocationDot } from '@fortawesome/sharp-light-svg-icons';

import { Avatar } from '../../kit/avatar';
import { Button } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import { PersonName } from '../../PersonName';
import { panelTriggerProps } from '../panels/panelNavigation';
import { answeredLabel, expiresLabel, type WantedPlace } from './latestModel';

/**
 * *Wanted near you* (boards 4.16, 4.17): the places skaters are asking a fresh look at, under
 * Recommended. Each place gathers every open bounty on it ("3 open bounties" — each person's ask is
 * its own), names who asked first, and opens that bounty over its lake on the map. **The whole
 * section is absent when there are none** (4.17): no heading, no empty line.
 */
export function WantedColumn({
  places,
  now,
  onOpenBounty,
}: {
  places: readonly WantedPlace[] | undefined;
  now: number;
  onOpenBounty: (bountyId: string) => void;
}) {
  if (places === undefined || places.length === 0) return null;
  return (
    <Section title="Wanted near you" data-slot="latest-wanted">
      <p className="m-0 text-assist text-fg2 [text-wrap:pretty]">
        Skaters asking for a fresh look. A report there answers it.
      </p>
      {places.map((place) => (
        <WantedCard key={place.key} place={place} now={now} onOpenBounty={onOpenBounty} />
      ))}
    </Section>
  );
}

function WantedCard({
  place,
  now,
  onOpenBounty,
}: {
  place: WantedPlace;
  now: number;
  onOpenBounty: (bountyId: string) => void;
}) {
  return (
    <div
      data-slot="wanted-card"
      className="ph-no-capture flex flex-col gap-(--space-3) border border-solid border-line2 p-(--space-3_5)"
    >
      <div className="flex items-start gap-(--space-3)">
        <FontAwesomeIcon icon={faBullseyeArrow} aria-hidden="true" className="mt-1 h-4 text-fg1" />
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold text-fg">{place.place}</span>
          {place.lake !== null && <span className="text-assist text-fg2">{place.lake}</span>}
        </div>
        <span className="ml-auto text-assist whitespace-nowrap text-fg2">
          <b className="font-semibold text-fg">{place.count}</b> open{' '}
          {place.count === 1 ? 'bounty' : 'bounties'}
        </span>
      </div>
      {place.firstAsker !== null && (
        <span className="flex items-center gap-(--space-2) text-assist text-fg2">
          <Avatar
            size="sm"
            name={place.firstAsker.displayName}
            {...(place.firstAsker.profileImageUrl !== undefined
              ? { src: place.firstAsker.profileImageUrl }
              : {})}
          />
          <span className="min-w-0">
            Asked first by{' '}
            <PersonName className="text-fg">{place.firstAsker.displayName}</PersonName>
          </span>
        </span>
      )}
      <span className="text-assist text-fg2">
        {expiresLabel(place.expiresAt, now)} · {answeredLabel(place.answered)}
      </span>
      <Button
        size="sm"
        className="self-start"
        data-attr="latest-wanted-open"
        {...panelTriggerProps('bounty', place.bountyId)}
        aria-label={`Open the bounty at ${place.place} on the map`}
        onClick={() => onOpenBounty(place.bountyId)}
      >
        <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" className="h-3" />
        Open on the map
      </Button>
    </div>
  );
}
