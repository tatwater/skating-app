import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faLocationDot } from '@fortawesome/sharp-light-svg-icons';

import { Avatar } from '../../kit/avatar';
import { Button } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import type { OpenBountyCard, PastBountyCard } from './profileModel';

/**
 * Your bounties (6.1), on your own profile only: the open ones first, with the reports that have
 * come in and the way to review them, then the past ones, each saying how it ended. A bounty is a
 * target glyph and the people who want a report — never points (Review 2).
 */
export function YourBounties({
  open,
  past,
  canceling,
  onReview,
  onCancel,
}: {
  open: OpenBountyCard[];
  past: PastBountyCard[];
  /** The bounty mid-cancel. */
  canceling: string | null;
  onReview: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  if (open.length === 0 && past.length === 0) return null;
  return (
    <Section
      title="Your bounties"
      end={<span className="text-fg1 text-row">{`${open.length} open`}</span>}
    >
      <div className="flex flex-col gap-(--space-3_5)">
        {open.map((b) => (
          <article
            key={b.id}
            className="flex flex-col gap-(--space-2_5) border border-line2 border-solid p-(--space-3_5)"
          >
            <div className="flex items-start gap-(--space-2_5)">
              <FontAwesomeIcon
                icon={faBullseyeArrow}
                aria-hidden="true"
                className="mt-[0.0625rem] h-[1.125rem] text-fg"
              />
              <div className="min-w-0">
                <div className="font-semibold text-fg">{b.place}</div>
                <div className="text-assist text-fg2">{b.posted}</div>
              </div>
            </div>
            <div className="text-assist text-fg2">{b.meta}</div>
            {b.candidates.length > 0 && (
              <ul className="ph-no-capture m-0 flex list-none flex-col gap-(--space-2) border-0 border-line border-t border-solid p-0 pt-(--space-2_5)">
                {b.candidates.map((c) => (
                  <li key={c.id} className="flex items-center gap-(--space-2) text-assist text-fg2">
                    <Avatar name={c.name} size="sm" aria-hidden="true" />
                    <span>
                      <span className="text-fg">{c.name}</span>
                      {c.line && ` · ${c.line}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-(--space-2)">
              <Button size="sm" className="flex-1" onClick={() => onReview(b.id)}>
                <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" />
                Review on the map
              </Button>
              <Button
                size="sm"
                loading={canceling === b.id}
                onClick={() => onCancel(b.id)}
                aria-label={`Cancel the bounty on ${b.place}`}
              >
                Cancel
              </Button>
            </div>
          </article>
        ))}
        {past.length > 0 && (
          <>
            <span className="mt-(--space-2) font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
              Past
            </span>
            <ul className="m-0 flex list-none flex-col p-0">
              {past.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-col gap-(--space-1_5) border-0 border-line2 border-b border-dotted py-(--space-3) last:border-b-0"
                >
                  <div className="flex items-baseline gap-(--space-2)">
                    <b className="font-medium text-fg">{b.place}</b>
                    <span className="ml-auto whitespace-nowrap font-(family-name:--family-mono) text-fg2 text-mono-sm">
                      {b.status}
                    </span>
                  </div>
                  {b.answeredBy ? (
                    <div className="ph-no-capture flex items-center gap-(--space-2) text-assist text-fg2">
                      <Avatar name={b.answeredBy} size="sm" aria-hidden="true" />
                      <span>
                        Answered by <span className="text-fg">{b.answeredBy}</span>
                      </span>
                    </div>
                  ) : (
                    <div className="text-assist text-fg2">{b.note}</div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}
