import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow } from '@fortawesome/sharp-light-svg-icons';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { PersonName } from '../../PersonName';
import { CardHead, CardRule, CardSection } from './InsetCard';
import { panelTriggerProps } from './panelNavigation';

/**
 * The open bounty (boards 2.6/2.7), props only: whose ask it is and how many share it, where it
 * applies, and the reports that might answer it. **No points anywhere** (Review 2).
 *
 * **"3 want a report" is said here and nowhere else.** Each person's ask is its own bounty row, so a
 * lake says "3 open bounties"; this card is the one place the asks are gathered into people, beside
 * their faces (Review 4).
 */
export interface BountyWanter {
  displayName: string;
  profileImageUrl?: string;
}

export interface BountyCandidate {
  reportId: string;
  authorName: string;
  /** "Thu 3:15 PM". */
  when: string;
  /** "Good" — the author's claim. */
  qualityLabel: string | null;
  isOwn: boolean;
}

export interface BountyPanelData {
  /** The bay or the lake the ask is for: "Mascoma North". */
  title: string;
  /** "Open · expires in 2d · only a report from this bay fulfills it". */
  status: string;
  open: boolean;
  /** The viewer is this bounty's requester. */
  mine: boolean;
  /** Everyone who wants a report here, the first to ask last (they're newest first). */
  wanters: readonly BountyWanter[];
  /** "Any part of Mascoma Lake", for your own ask. */
  scope: string;
  candidates: readonly BountyCandidate[];
}

/** "3 want a report", "You want a report", "You and 2 others want a report", "Rob wants a report". */
export function wantLine(wanters: readonly BountyWanter[], mine: boolean): string {
  const n = wanters.length;
  if (mine) {
    if (n <= 1) return 'You want a report';
    return `You and ${n - 1} ${n - 1 === 1 ? 'other' : 'others'} want a report`;
  }
  if (n === 1) return `${wanters[0]?.displayName} wants a report`;
  return `${n} want a report`;
}

export function BountyPanelView({
  data,
  rateCandidate,
}: {
  data: BountyPanelData;
  /** The thumbs on a candidate row; the container wires them (the requester's fulfills the ask). */
  rateCandidate?: (candidate: BountyCandidate) => ReactNode;
}) {
  const first = data.wanters[data.wanters.length - 1];
  const sub = data.mine
    ? data.scope
    : data.wanters.length > 1 && first !== undefined
      ? `${first.displayName} asked first`
      : data.scope;
  return (
    <>
      <CardHead kind="Bounty" title={data.title} where={<span>{data.status}</span>} />
      <div
        data-slot="bounty-ask"
        className="flex items-center gap-(--space-3_5) border border-solid border-line p-(--space-3_5)"
      >
        <span className="flex shrink-0" aria-hidden="true">
          {data.wanters.slice(0, 4).map((w, i) => (
            <Avatar
              // Wanters are distinct people; a name can repeat, so the place breaks the tie.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={`${w.displayName}-${i}`}
              name={w.displayName}
              size="sm"
              {...(w.profileImageUrl !== undefined ? { src: w.profileImageUrl } : {})}
              className={cn('shadow-[0_0_0_3px_var(--bg)]', i > 0 && '-ms-[0.3125rem]')}
              style={{ zIndex: 4 - i }}
            />
          ))}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-(--space-0_5) text-row leading-body">
          <PersonName className="font-medium text-fg">
            {wantLine(data.wanters, data.mine)}
          </PersonName>
          <PersonName className="text-assist text-fg2">{sub}</PersonName>
        </span>
        <span
          data-slot="bounty-count"
          className="inline-flex h-6 shrink-0 items-center gap-(--space-1_5) border border-solid border-fg1 px-[0.5625rem] text-[0.78125rem] font-medium text-fg"
        >
          <FontAwesomeIcon icon={faBullseyeArrow} aria-hidden="true" className="h-3" />
          <span aria-hidden="true">{data.wanters.length}</span>
          <span className="sr-only">
            {data.wanters.length} open {data.wanters.length === 1 ? 'bounty' : 'bounties'}
          </span>
        </span>
      </div>
      {data.mine && <CardRule />}
      <CardSection label="Candidate reports">
        {data.mine && data.open && data.candidates.some((c) => !c.isOwn) && (
          <p className="m-0 mb-(--space-1_5) text-assist text-fg2">
            A helpful thumb from you fulfills the bounty.
          </p>
        )}
        {data.candidates.length === 0 ? (
          <p className="m-0 text-assist text-fg2">
            No reports yet. Skaters who were here recently have been asked.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {data.candidates.map((c) => (
              <li
                key={c.reportId}
                data-slot="bounty-candidate"
                className="flex items-center gap-(--space-3) border-0 border-b border-dotted border-line2 py-(--space-3) last:border-b-0"
              >
                <Avatar name={c.authorName} />
                <span className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
                  <Link
                    to="/report/$id"
                    params={{ id: c.reportId }}
                    data-attr="bounty-candidate"
                    {...panelTriggerProps('report', c.reportId)}
                    className="truncate text-row font-medium text-fg underline decoration-line2 underline-offset-[3px] hover:decoration-fg2"
                  >
                    <PersonName>{c.authorName}</PersonName> · {c.when}
                  </Link>
                  {c.qualityLabel !== null && (
                    <span className="flex items-center gap-(--space-2)">
                      <Badge>{c.qualityLabel}</Badge>
                    </span>
                  )}
                </span>
                {rateCandidate?.(c)}
              </li>
            ))}
          </ul>
        )}
      </CardSection>
    </>
  );
}
