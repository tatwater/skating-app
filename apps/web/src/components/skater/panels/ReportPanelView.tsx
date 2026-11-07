import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-light-svg-icons';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { PersonName } from '../../PersonName';
import { Chips, ClaimBadges, type ReportClaims } from '../cards/ReportChips';
import { CardHead, CardRule, CardSection } from './InsetCard';

/**
 * The open report (boards 2.4/2.5), props only: who, when and where; their claims; their words; what
 * they saw, section by section; the weather since; the other lakes of the same post; the photos;
 * then the comments. Every value is already in words (imperial, D25) — the container formats them
 * with core's `reportDisplay` helpers so this stays a fixture-renderable view.
 */
export interface ReportPanelData {
  reportId: string;
  /** "Mascoma South" — the finest name the report carries; the bay when there is one. */
  title: string;
  /** "Today · off the ice 11:40 AM · skated 2 h", plus the season and *edited* when they apply. */
  when: string;
  author: {
    displayName: string;
    username: string;
    profileImageUrl?: string;
    deleted?: true;
  } | null;
  /** In the viewer's block set: the name dims and says so; the report is never hidden (D3). */
  authorBlocked: boolean;
  claims: ReportClaims;
  /** The post's words (A10 / D186): the author's, over the data. */
  postTitle?: string;
  postBody?: string;
  iceTypes: readonly string[];
  surfaceTags: readonly string[];
  /** "5″ off the beach · drilled", one line per reading. */
  thickness: readonly string[];
  snow: string | null;
  conditions: ReadonlyArray<{ label: string; value: string }>;
  notes?: string;
  /** The other lakes of the same post, in the author's order. */
  siblings: ReadonlyArray<{ reportId: string; bodyName: string }>;
  photos: ReadonlyArray<{
    photoId: string;
    url: string | null;
    thumbUrl: string | null;
    caption?: string;
  }>;
  /** The drawn path stops short of the put-in the author didn't share (D58): said, not hidden. */
  trackClipped: boolean;
  /** The author's own: how many people were waiting for this (D170). */
  bountiesAnswered: number;
}

export function ReportPanelView({
  data,
  weather,
  comments,
}: {
  data: ReportPanelData;
  /** The weather-since strip; the container builds it so the view stays Convex-free. */
  weather?: ReactNode;
  comments?: ReactNode;
}) {
  return (
    <>
      <CardHead kind="Report" title={data.title} where={<span>{data.when}</span>} />
      {data.author !== null && (
        <div
          data-slot="report-byline"
          data-blocked={data.authorBlocked ? '' : undefined}
          className="flex items-center gap-(--space-2_5) text-assist text-fg2"
        >
          <Avatar
            name={data.author.displayName}
            size="sm"
            {...(data.author.profileImageUrl !== undefined
              ? { src: data.author.profileImageUrl }
              : {})}
          />
          <span>
            by <Author author={data.author} blocked={data.authorBlocked} />
          </span>
          {data.authorBlocked && <Badge variant="outline">Blocked</Badge>}
        </div>
      )}
      <ClaimBadges claims={data.claims} />
      {(data.postTitle !== undefined || data.postBody !== undefined) && (
        <div className="flex flex-col gap-(--space-2)">
          {data.postTitle !== undefined && (
            <p className="m-0 text-[1.0625rem] font-semibold text-fg">{data.postTitle}</p>
          )}
          {data.postBody !== undefined && (
            <p className="m-0 text-body leading-body whitespace-pre-wrap text-fg1 [text-wrap:pretty]">
              {data.postBody}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-(--space-4_5)">
        {data.iceTypes.length > 0 && (
          <CardSection label="Ice types">
            <Chips values={data.iceTypes} />
          </CardSection>
        )}
        {data.surfaceTags.length > 0 && (
          <CardSection label="Surface">
            <Chips values={data.surfaceTags} />
          </CardSection>
        )}
        {data.thickness.length > 0 && (
          <CardSection label="Thickness">
            <ul className="m-0 flex list-none flex-col p-0">
              {data.thickness.map((line, i) => (
                <li
                  // Readings are an ordered, stable list; two can read the same.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                  key={i}
                  className="border-0 border-b border-dotted border-line py-(--space-1_5) text-assist text-fg1 last:border-b-0"
                >
                  {line}
                </li>
              ))}
            </ul>
          </CardSection>
        )}
        {data.snow !== null && (
          <CardSection label="Snow">
            <p className="m-0 text-assist text-fg1">{data.snow}</p>
          </CardSection>
        )}
        {data.conditions.length > 0 && (
          <CardSection label="Conditions">
            <dl className="m-0 grid grid-cols-2 gap-x-(--space-4) gap-y-(--space-2_5)">
              {data.conditions.map((row) => (
                <div key={row.label} className="flex flex-col gap-[0.1875rem]">
                  <dt className="text-[0.75rem] text-fg3">{row.label}</dt>
                  <dd className="m-0 text-row text-fg1">{row.value}</dd>
                </div>
              ))}
            </dl>
          </CardSection>
        )}
        {weather}
        {data.notes !== undefined && data.notes !== '' && (
          <CardSection label="Notes">
            <p className="m-0 text-row whitespace-pre-wrap text-fg1">{data.notes}</p>
          </CardSection>
        )}
        {data.siblings.length > 0 && (
          <CardSection label="Also in this post">
            <ul className="m-0 flex list-none flex-col gap-(--space-1) p-0">
              {data.siblings.map((sibling) => (
                <li key={sibling.reportId}>
                  <Link
                    to="/report/$id"
                    params={{ id: sibling.reportId }}
                    data-attr="report-sibling"
                    className="text-row text-fg1 underline decoration-line2 underline-offset-[3px] hover:decoration-fg2"
                  >
                    {sibling.bodyName}
                  </Link>
                </li>
              ))}
            </ul>
          </CardSection>
        )}
        {data.photos.some((p) => p.thumbUrl !== null) && (
          <CardSection label="Photos">
            <ol className="m-0 flex list-none flex-wrap gap-(--space-1_5) p-0">
              {data.photos.map((photo, i) =>
                photo.thumbUrl === null ? null : (
                  <li key={photo.photoId}>
                    <a
                      href={photo.url ?? photo.thumbUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-attr="report-photo"
                      className="group/photo relative block outline-none focus-visible:shadow-focus"
                    >
                      <img
                        src={photo.thumbUrl}
                        alt={photo.caption ?? `Photo ${i + 1}`}
                        className="block h-14 w-[4.5rem] border border-solid border-line bg-raise object-cover"
                      />
                      <span className="sr-only">(opens in a new tab)</span>
                      <FontAwesomeIcon
                        icon={faArrowUpRightFromSquare}
                        aria-hidden="true"
                        className="absolute top-1 right-1 h-2.5 text-fg opacity-0 group-hover/photo:opacity-100"
                      />
                    </a>
                  </li>
                ),
              )}
            </ol>
          </CardSection>
        )}
        {data.trackClipped && (
          <p className="m-0 text-[0.78125rem] text-fg3">
            The start and end of this track are hidden: the skater didn’t share their put-in.
          </p>
        )}
        {data.bountiesAnswered > 0 && (
          <p className="m-0 text-assist text-fg2">
            Thanks for this report. At least{' '}
            {data.bountiesAnswered === 1
              ? 'one skater was'
              : `${data.bountiesAnswered} skaters were`}{' '}
            looking forward to it.
          </p>
        )}
      </div>
      {comments !== undefined && (
        <>
          <CardRule />
          {comments}
        </>
      )}
    </>
  );
}

function Author({
  author,
  blocked,
}: {
  author: NonNullable<ReportPanelData['author']>;
  blocked: boolean;
}) {
  const name = (
    <PersonName className={cn('font-medium', blocked ? 'text-fg3' : 'text-fg1')}>
      {author.displayName}
    </PersonName>
  );
  if (author.deleted || author.username === '') return name;
  return (
    <Link
      to="/u/$username"
      params={{ username: author.username }}
      data-attr="report-author"
      className="no-underline hover:underline"
    >
      {name}
    </Link>
  );
}
