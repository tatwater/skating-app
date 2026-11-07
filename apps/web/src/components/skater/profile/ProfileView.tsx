import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock } from '@fortawesome/sharp-light-svg-icons';
import {
  badgeLabel,
  DELETED_DISPLAY_NAME,
  LEAVING_PROFILE_NOTICE,
  type PostCardData,
} from '@skating/core';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { Button } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import { Skeleton } from '../../kit/skeleton';
import { INK_PRIMARY } from '../styles';
import { ProfileReportRow } from './ProfileReportRow';

export interface ProfileHeadModel {
  name: string;
  username: string;
  imageUrl?: string;
  /** The class's name, and — for a moderator only — the raw score beside it (D50). */
  trust: { label: string; points?: number } | null;
  /** Handle · town · (your own) who can see it. */
  sub: string[];
  bio?: string;
}

export type ProfileModel =
  | { kind: 'loading' }
  /** Doesn't exist, or a block stands between you (6.9). */
  | { kind: 'unavailable' }
  /** Your own, while the account is being deleted (6.7). */
  | { kind: 'leaving'; deletesOn: string }
  /** Someone else's private profile: the header and nothing else (6.6). */
  | { kind: 'private'; head: ProfileHeadModel }
  | {
      kind: 'full';
      head: ProfileHeadModel;
      reportCount: number;
      commentCount: number;
      /** How many lakes they reported on — when the server sends it. */
      lakeCount?: number;
      badges: string[];
      posts: PostCardData[];
    };

/**
 * A skater's page (row 6), props only: the header, then the reports in the wide column and what
 * sits beside them — the moderator's tools on someone else's page (6.8), the counts and badges,
 * and, on your own, your bounties. No points anywhere (Review 2). The header and the reports are
 * people's words and faces: `ph-no-capture` (D240).
 */
export function ProfileView({
  model,
  actions,
  modTools,
  bounties,
  now,
  onNavigate,
}: {
  model: ProfileModel;
  /** Edit profile, or Block and Flag; Cancel deletion while leaving. */
  actions?: ReactNode;
  modTools?: ReactNode;
  /** Your bounties (your own profile only). */
  bounties?: ReactNode;
  now: number;
  onNavigate: (href: string) => void;
}) {
  if (model.kind === 'loading') return <ProfileSkeleton />;
  if (model.kind === 'unavailable') return <Unavailable onNavigate={onNavigate} />;

  if (model.kind === 'leaving') {
    return (
      <Page>
        <Header
          head={{ name: DELETED_DISPLAY_NAME, username: '', trust: null, sub: [] }}
          ghost
          actions={actions}
        />
        <div className="flex max-w-[45rem] flex-col gap-(--space-3_5)">
          <p className="m-0 text-pretty text-body text-fg1 leading-body">
            {LEAVING_PROFILE_NOTICE}
          </p>
          <p className="m-0 text-assist text-fg2 leading-body">
            Your account will be deleted on {model.deletesOn}. Until then you can browse, but not
            post.
          </p>
        </div>
      </Page>
    );
  }

  if (model.kind === 'private') {
    return (
      <Page>
        <Header head={model.head} actions={actions} />
        <div className="flex flex-col items-center gap-(--space-2_5) pt-(--space-14) text-center">
          <FontAwesomeIcon icon={faLock} aria-hidden="true" className="h-[1.25rem] text-fg2" />
          <span className="text-fg text-h">This profile is private.</span>
          <span className="max-w-[26.25rem] text-assist text-fg2">
            Their reports and hazards still show on the map and in Latest.
          </span>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Header head={model.head} actions={actions} />
      <div className="flex items-start gap-[3rem] max-lg:flex-col">
        <section className="flex w-[38.75rem] max-w-full flex-none flex-col gap-heading">
          <Section title="Recent reports">
            {model.posts.length === 0 ? (
              <p className="m-0 text-fg2 text-row">No reports yet.</p>
            ) : (
              <div className="flex flex-col gap-(--space-6)">
                {model.posts.map((post) => (
                  <ProfileReportRow
                    key={post.postId}
                    post={post}
                    now={now}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            )}
          </Section>
        </section>
        <aside className="flex min-w-0 flex-1 flex-col gap-(--space-8)">
          {modTools}
          <div className="flex flex-col gap-(--space-3_5)">
            <Stats
              reports={model.reportCount}
              comments={model.commentCount}
              lakes={model.lakeCount}
            />
            {model.badges.length > 0 && (
              <ul
                aria-label="Badges"
                className="m-0 flex list-none flex-wrap gap-(--space-1_5) p-0"
              >
                {model.badges.map((b) => (
                  <li key={b}>
                    <Badge variant="outline" tone="lit">
                      {badgeLabel(b)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {bounties}
        </aside>
      </div>
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="profile"
      className="mx-auto flex w-full max-w-[65rem] flex-col gap-(--space-8) px-(--space-4) pt-(--space-8) pb-(--space-14)"
    >
      {children}
    </div>
  );
}

function Header({
  head,
  ghost = false,
  actions,
}: {
  head: ProfileHeadModel;
  ghost?: boolean;
  actions?: ReactNode;
}) {
  return (
    <header className="ph-no-capture flex items-start gap-(--space-6) border-0 border-line border-b border-solid pb-(--space-7)">
      {ghost ? (
        <span
          aria-hidden="true"
          className="size-[5.25rem] flex-none rounded-full border border-line2 border-dashed"
        />
      ) : (
        <Avatar
          name={head.name}
          src={head.imageUrl}
          aria-hidden="true"
          className="size-[5.25rem] bg-raise text-[1.5rem] text-fg1 shadow-[0_0_0_1px_var(--line2),0_0_0_4px_var(--bg),0_0_0_5px_var(--fg2)]"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-2_5)">
        <h1
          className={cn(
            'm-0 flex flex-wrap items-center gap-(--space-3_5) font-semibold text-[1.875rem] leading-[1.05]',
            ghost ? 'text-fg2 italic tracking-normal' : 'text-fg uppercase tracking-disp',
          )}
        >
          {head.name}
          {head.trust && (
            <span
              className="flex"
              title={head.trust.points !== undefined ? 'Trust score' : undefined}
            >
              <Badge variant={head.trust.points !== undefined ? 'solid' : 'outline'}>
                {head.trust.label}
              </Badge>
              {head.trust.points !== undefined && (
                <Badge variant="outline" className="border-l-0">
                  {head.trust.points.toLocaleString('en-US')}
                </Badge>
              )}
            </span>
          )}
        </h1>
        {head.sub.length > 0 && (
          <p className="m-0 flex flex-wrap text-fg2 text-row">
            {head.sub.map((part, i) => (
              <span key={part}>
                {i > 0 && (
                  <span aria-hidden="true" className="mx-(--space-2) text-fg3">
                    ·
                  </span>
                )}
                {part}
              </span>
            ))}
          </p>
        )}
        {head.bio && (
          <p className="m-0 mt-[0.125rem] max-w-[38.75rem] whitespace-pre-wrap text-pretty text-body text-fg1 leading-body">
            {head.bio}
          </p>
        )}
      </div>
      {actions != null && <div className="flex flex-none gap-(--space-2)">{actions}</div>}
    </header>
  );
}

function Stats({
  reports,
  comments,
  lakes,
}: {
  reports: number;
  comments: number;
  lakes: number | undefined;
}) {
  const cells: [string, number][] = [
    ['Reports', reports],
    ['Comments', comments],
    ...(lakes !== undefined ? ([['Lakes', lakes]] as [string, number][]) : []),
  ];
  return (
    <dl className="m-0 flex border border-line border-solid">
      {cells.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-1 flex-col gap-(--space-2) px-(--space-4) py-(--space-3_5) [&+&]:border-0 [&+&]:border-line [&+&]:border-l [&+&]:border-solid"
        >
          <dt className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
            {label}
          </dt>
          <dd className="m-0 font-(family-name:--family-mono) font-medium text-fg text-stat leading-none">
            {value.toLocaleString('en-US')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Unavailable({ onNavigate }: { onNavigate: (href: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col px-(--space-4) pt-(--space-20)">
      <div className="flex flex-col gap-(--space-3_5) border border-line border-solid px-(--space-7) pt-(--space-6) pb-(--space-7)">
        <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
          Profile
        </span>
        <h1 className="m-0 font-semibold text-fg text-h">Profile not available</h1>
        <p className="m-0 text-body text-fg1 leading-body">
          This profile doesn’t exist or isn’t visible to you.
        </p>
        <div className="flex gap-(--space-2)">
          <Button variant="primary" className={INK_PRIMARY} onClick={() => onNavigate('/latest')}>
            Back to Latest
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <Page>
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading profile"
        className="flex items-start gap-(--space-6) border-0 border-line border-b border-solid pb-(--space-7)"
      >
        <Skeleton className="size-[5.25rem] rounded-full" />
        <div className="flex flex-1 flex-col gap-(--space-3)">
          <Skeleton className="h-[1.875rem] w-[18rem]" />
          <Skeleton className="h-[1rem] w-[14rem]" />
        </div>
      </div>
    </Page>
  );
}
