import {
  type LngLat,
  NO_KNOWN_HAZARDS,
  silhouetteRings,
  UNREPORTED_HAZARDS_POSSIBLE,
} from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Section } from '../../kit/section-slug';
import { must } from '../../kit/storyKit';
import { MASCOMA_RINGS, NEARBY_RINGS, type Ring } from '../map/mapStoryData';
import { type Mode, SkaterPair } from '../storySupport';
import { IceHistoryView, LinksView, PublicAccessView, TermList } from './AboutTab';
import { ActionPane } from './ActionPane';
import { AlertStripView } from './AlertStrip';
import { HazardListView } from './HazardList';
import { InViewListView } from './InViewList';
import { LakeHeader, type LakeHeaderProps } from './LakeHeader';
import type { LakeRowModel } from './LakeRow';
import { LakeSidebar, LakeTabs } from './LakeSidebar';
import { LakeSidebarSkeleton, LakeUnavailable, StandingNoticeView } from './LakeStates';
import type { HazardRowInput, ReportRowModel } from './lakeModel';
import { useEscapeToClose } from './lakeNav';
import type { LakeTab } from './lakeSearch';
import { AccessRulingCardView, ModeratorToolsView } from './ModeratorCard';
import { BountiesLine, ReportsListView, TabStack } from './ReportsTab';

/**
 * The Explore sidebar (row 1: boards 1.1–1.14, and 2.8's loading pattern), on the skater surface
 * in both modes. The sidebar is the real composition built from the same views the pages use; the
 * map beside it is the map's own stories. Real data: Mascoma Lake 1,143 ac, 31 / 79 ft, 748 ft;
 * Crystal Lake, Smith Pond, George Pond (inactive on dev), Halfmile Pond. People, reports, the
 * hazard and the alert are invented; "today" is Saturday 16 January 2027.
 */
const meta = {
  title: 'Skater/Explore sidebar',
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2027, 0, 16, 16, 52);
const DAY = 86_400_000;

const outline = (rings: readonly Ring[] | undefined) =>
  rings ? silhouetteRings({ type: 'Polygon', coordinates: rings as unknown as LngLat[][] }) : null;

const IN_VIEW: LakeRowModel[] = [
  {
    id: 'mascoma',
    name: 'Mascoma Lake',
    sub: 'Reservoir · 1,143 acres · 79 ft max',
    href: '/water/mascoma',
    favorite: true,
    inactive: false,
    trailing: { kind: 'reports', count: '3 reports', when: 'Today' },
    silhouette: outline(MASCOMA_RINGS),
  },
  {
    id: 'crystal',
    name: 'Crystal Lake',
    sub: 'Lake · 390 acres · 55 ft max',
    href: '/water/crystal',
    favorite: false,
    inactive: false,
    trailing: { kind: 'reports', count: '1 report', when: 'Tuesday' },
    silhouette: outline(NEARBY_RINGS['Crystal Lake']),
  },
  {
    id: 'smith',
    name: 'Smith Pond',
    sub: 'Pond · 67 acres · 35 ft max',
    href: '/water/smith',
    favorite: false,
    inactive: false,
    trailing: { kind: 'note', text: 'No recent reports' },
    silhouette: outline(NEARBY_RINGS['Smith Pond']),
  },
  {
    id: 'halfmile',
    name: 'Halfmile Pond',
    sub: 'Pond · 9 acres · 16 ft max',
    href: '/water/halfmile',
    favorite: false,
    inactive: false,
    trailing: { kind: 'note', text: 'No recent reports' },
    silhouette: null,
  },
  {
    id: 'george',
    name: 'George Pond',
    sub: 'Pond · 47 acres · 11 ft max',
    href: '/water/george',
    favorite: false,
    inactive: true,
    trailing: { kind: 'note', text: 'Inactive' },
    silhouette: outline(NEARBY_RINGS['George Pond']),
  },
];

const link = (href: string) => ({
  href,
  onClick: (e: { preventDefault: () => void }) => e.preventDefault(),
});

const MASCOMA_HEADER: LakeHeaderProps = {
  kicker: 'Reservoir · NH',
  name: 'Mascoma Lake',
  facts: [
    { kicker: 'Area', value: '1,143', unit: 'ac' },
    { kicker: 'Depth avg / max', value: '31 / 79', unit: 'ft' },
    { kicker: 'Elevation', value: '748', unit: 'ft' },
  ],
  favorite: { on: false, pending: false, onToggle: fn() },
  newReport: link('/water/mascoma?post=new&postBody=mascoma'),
  reportHazard: link('/water/mascoma?act=hazard'),
  postBounty: link('/water/mascoma?act=bounty'),
  directions: {
    href: 'https://www.google.com/maps/dir/?api=1&destination=43.63,-72.15',
    label: 'Directions to parking',
    onOpen: fn(),
  },
};

const NARROWS: HazardRowInput = {
  _id: 'narrows',
  type: 'open_water',
  freshness: 'fresh',
  provisional: false,
  subAreaName: 'The Narrows, by Shaker Bridge',
  firstReportedAt: NOW - 2 * DAY,
  confirmCount: 2,
};

const report = (over: Partial<ReportRowModel> & Pick<ReportRowModel, 'id'>): ReportRowModel => ({
  when: 'Today · 11:40 AM',
  where: '',
  badges: [],
  notes: null,
  iceTypes: [],
  photoCount: 0,
  ...over,
});

const REPORTS = [
  {
    author: { name: 'Pat Lacasse' },
    row: report({
      id: 'pat',
      where: 'Mascoma South · On the ice',
      badges: [
        { label: 'Experienced only', kind: 'suitability', tone: 'default' },
        { label: 'Good', kind: 'quality', tone: 'default' },
      ],
      notes:
        'Black ice from the launch to the islands, a skim of new snow past them. Drilled 5″ off the beach and 4″ near the islands.',
      iceTypes: ['Black ice', 'Snow covered'],
      photoCount: 3,
    }),
  },
  {
    author: { name: 'Sarah Berman' },
    row: report({
      id: 'sarah',
      when: 'Thu · 3:15 PM',
      where: 'Mascoma North · From shore',
      badges: [{ label: "Don't go", kind: 'suitability', tone: 'bad' }],
      notes: 'Open lead running from the bridge into the north basin. Didn’t go out.',
    }),
  },
  {
    author: { name: 'Kate Donovan' },
    row: report({
      id: 'kate',
      when: 'Wed · 9:05 AM',
      where: 'Mascoma South · On the ice',
      badges: [
        { label: 'Not for beginners', kind: 'suitability', tone: 'default' },
        { label: 'Fair', kind: 'quality', tone: 'default' },
      ],
      notes: 'Bumpy refrozen slush near the beach, better out past the point.',
      iceTypes: ['Snow ice'],
    }),
  },
] as const;

/** The lake page's sidebar, from its views, beside a stand-in for the map. */
function LakeFrame({
  header,
  alert = null,
  tab = 'reports',
  overlay = null,
  label = 'Mascoma Lake',
  children,
}: {
  header: ReactNode;
  alert?: ReactNode;
  tab?: LakeTab;
  overlay?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full grid-cols-[27.5rem_minmax(0,1fr)]">
      <LakeSidebar
        label={label}
        header={
          <>
            {header}
            {alert}
          </>
        }
        body={
          <LakeTabs
            tab={tab}
            onTabChange={() => {}}
            overlay={overlay}
            contourCredit="5 ft contours, surveyed by NH GRANIT."
          >
            {children}
          </LakeTabs>
        }
      />
      <div aria-hidden="true" className="bg-raise" />
    </div>
  );
}

function ReportsBody({
  container,
  empty = false,
}: {
  container: HTMLElement | null;
  empty?: boolean;
}) {
  return (
    <TabStack>
      <HazardListView
        hazards={empty ? [] : [NARROWS]}
        features={[]}
        now={NOW}
        hrefFor={(id) => `/hazard/${id}`}
        onOpen={(_, e) => e.preventDefault()}
        container={container}
      />
      <ReportsListView
        model={{
          status: 'ready',
          rows: empty ? [] : [...REPORTS],
          canLoadMore: false,
          loadingMore: false,
        }}
        onOpen={(_, e) => e.preventDefault()}
        onLoadMore={() => {}}
        emptyLine="No reports yet this season — be the first."
      />
      {!empty && <BountiesLine count={3} href="/bounty/b1" onOpen={(e) => e.preventDefault()} />}
    </TabStack>
  );
}

const darkQuad = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('section[data-mode="dark"]'));

// ── Stories ───────────────────────────────────────────────────────────────────────────────────

/** 1.1 — nothing chosen: the lakes in view. The last row has no rule under it. */
export const NothingChosen: Story = {
  render: () => (
    <SkaterPair height="56rem">
      {() => (
        <div className="grid h-full grid-cols-[27.5rem_minmax(0,1fr)]">
          <InViewListView
            model={{ rows: IN_VIEW, hiddenCount: 0 }}
            onOpen={(_, e) => e.preventDefault()}
          />
          <div aria-hidden="true" className="bg-raise" />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const q = within(quad);
    await expect(q.getByRole('heading', { level: 1 })).toHaveTextContent('5 lakes');
    const rows = q.getAllByRole('link');
    await expect(rows).toHaveLength(5);
    await expect(getComputedStyle(rows.at(-1) as HTMLElement).borderBottomWidth).toBe('0px');
    await expect(getComputedStyle(rows[0] as HTMLElement).borderBottomStyle).toBe('dotted');
    // A clickable row keeps the control radius (Review 4).
    await expect(getComputedStyle(rows[0] as HTMLElement).borderTopLeftRadius).toBe('2px');
    // The favorite's star is gold, and the sidebar is the boards' 440 px.
    await expect(q.getByLabelText('A favorite')).toBeVisible();
    await expect(q.getByRole('complementary').getBoundingClientRect().width).toBe(440);
    // The keyboard walks the rows in order.
    (rows[0] as HTMLElement).focus();
    await userEvent.tab();
    await expect(rows[1]).toHaveFocus();
  },
};

/** 1.2 — Mascoma chosen, Reports open: known hazards, the reports, the bounties. */
export const LakeReports: Story = {
  render: () => (
    <SkaterPair height="56rem">
      {(_, c) => (
        <LakeFrame header={<LakeHeader {...MASCOMA_HEADER} />}>
          <ReportsBody container={c} />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const q = within(quad);
    // One primary, the two actions under it, Directions an icon; the keyboard meets them in order.
    const star = q.getByRole('button', { name: 'Add this lake to favorites' });
    star.focus();
    for (const name of [
      'Add a report',
      'Report a hazard',
      'Post a bounty',
      'Directions to parking',
    ]) {
      await userEvent.tab();
      await expect(document.activeElement).toBe(q.getByRole('link', { name }));
    }
    await userEvent.tab();
    await expect(q.getByRole('tab', { name: 'Reports' })).toHaveFocus();
    // A populated list carries the (i), and no standing caveat under it (D237).
    await expect(q.getByRole('button', { name: 'About known hazards' })).toBeVisible();
    await expect(quad.textContent).not.toContain(NO_KNOWN_HAZARDS);
    // Bounties are counted, never pointed.
    await expect(q.getByText('3 open bounties')).toBeVisible();
    await expect(quad.textContent).not.toMatch(/\bpts\b|points/i);
    // Cards and badges are square; pressables are 2 px.
    const badge = must(quad.querySelector<HTMLElement>('[data-slot="badge"]'));
    await expect(getComputedStyle(badge).borderTopLeftRadius).toBe('0px');
    await expect(
      getComputedStyle(q.getByRole('link', { name: 'Add a report' })).borderTopLeftRadius,
    ).toBe('2px');
    // The last report has no rule under it.
    const rows = quad.querySelectorAll<HTMLElement>('[data-slot="report-row"]');
    await expect(getComputedStyle(rows[rows.length - 1] as HTMLElement).borderBottomWidth).toBe(
      '0px',
    );
    // The attribution rests at the foot.
    await expect(
      q.getByText('Basemap and water © OpenStreetMap contributors.'),
    ).toBeInTheDocument();
  },
};

/** 1.2.1 — the (i) beside Known hazards, its tooltip open: one tooltip style, square. */
export const HazardsTooltip: Story = {
  render: () => (
    <SkaterPair height="40rem">
      {(_, c) => (
        <LakeFrame header={<LakeHeader {...MASCOMA_HEADER} />}>
          <ReportsBody container={c} />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const info = within(quad).getByRole('button', { name: 'About known hazards' });
    info.focus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}{Tab}');
    await expect(info).toHaveFocus();
    const tip = await waitFor(() =>
      must(quad.querySelector<HTMLElement>('[data-slot="tooltip-content"]')),
    );
    await expect(tip).toHaveTextContent(UNREPORTED_HAZARDS_POSSIBLE);
    await expect(getComputedStyle(tip).borderTopLeftRadius).toBe('0px');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(quad.querySelector('[data-slot="tooltip-content"]')).toBeNull());
  },
};

/** An empty list says the whole sentence, and has no (i). */
export const NoKnownHazards: Story = {
  render: () => (
    <SkaterPair height="34rem">
      {(_, c) => (
        <LakeFrame header={<LakeHeader {...MASCOMA_HEADER} name="Smith Pond" kicker="Pond · NH" />}>
          <ReportsBody container={c} empty />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText(NO_KNOWN_HAZARDS)).toBeVisible();
    await expect(q.queryByRole('button', { name: 'About known hazards' })).toBeNull();
  },
};

/** 1.10 — the bay: its own name, star and figures; the lake it's part of, with the lake's star. */
export const Bay: Story = {
  render: () => (
    <SkaterPair height="44rem">
      {(_, c) => (
        <LakeFrame
          label="Mascoma North"
          header={
            <LakeHeader
              {...MASCOMA_HEADER}
              kicker="Bay · NH"
              name="Mascoma North"
              partOf={{ name: 'Mascoma Lake', link: link('/water/mascoma'), favorite: true }}
              facts={[
                { kicker: 'Area', value: '296', unit: 'ac' },
                { kicker: 'Depth max', value: '36', unit: 'ft' },
                { kicker: 'Elevation', value: '748', unit: 'ft' },
              ]}
            />
          }
        >
          <ReportsBody container={c} />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByRole('button', { name: 'Add this bay to favorites' })).toBeVisible();
    await expect(q.getByRole('link', { name: 'Mascoma Lake' })).toHaveAttribute(
      'href',
      '/water/mascoma',
    );
    await expect(q.getByLabelText('Mascoma Lake is a favorite')).toBeVisible();
  },
};

/** 1.12 — an NWS warning, above the tabs. */
export const WeatherAlert: Story = {
  render: () => (
    <SkaterPair height="48rem">
      {(_, c) => (
        <LakeFrame
          header={
            <LakeHeader
              {...MASCOMA_HEADER}
              favorite={{ on: true, pending: false, onToggle: fn() }}
            />
          }
          alert={
            <AlertStripView
              alerts={[
                {
                  id: 'a1',
                  event: 'Winter Storm Warning',
                  severity: 'Severe',
                  headline:
                    'Winter Storm Warning issued January 16 at 3:42AM EST until January 17 at 7:00AM EST by NWS Gray ME',
                  zones: [],
                  states: [],
                },
              ]}
            />
          }
        >
          <ReportsBody container={c} />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const alerts = within(quad).getByRole('region', { name: 'National Weather Service alerts' });
    await expect(alerts).toHaveTextContent('Winter Storm Warning');
    // Above the tabs: the alert comes before the tab row in the document.
    const tabs = within(quad).getByRole('tablist');
    await expect(
      alerts.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A favorite's star is gold.
    const star = within(quad).getByRole('button', { name: 'Remove this lake from favorites' });
    await expect(star).toHaveAttribute('aria-pressed', 'true');
  },
};

/** 1.13 — an inactive pond: gray, the notice under the facts, no bounty. */
export const Inactive: Story = {
  render: () => (
    <SkaterPair height="44rem">
      {(_, c) => (
        <LakeFrame
          label="George Pond"
          header={
            <LakeHeader
              {...MASCOMA_HEADER}
              kicker="Pond · NH"
              name="George Pond"
              inactive
              facts={[
                { kicker: 'Area', value: '47', unit: 'ac' },
                { kicker: 'Depth max', value: '11', unit: 'ft' },
              ]}
              standing={
                <StandingNoticeView
                  standing={{ standing: 'dormant', since: 1, reason: 'inactive' }}
                />
              }
              postBounty={null}
              directions={null}
            />
          }
        >
          <ReportsBody container={c} empty />
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByText('Inactive')).toBeVisible();
    await expect(q.queryByRole('link', { name: 'Post a bounty' })).toBeNull();
    await expect(q.getByRole('banner')).toHaveAttribute('data-inactive', '');
  },
};

/** 1.9 / 1.14 — About, as a moderator sees it: the ruling, the shape, history, links, the tools. */
export const AboutModerator: Story = {
  render: () => (
    <SkaterPair height="72rem">
      {() => (
        <LakeFrame header={<LakeHeader {...MASCOMA_HEADER} />} tab="about">
          <TabStack>
            <PublicAccessView
              access={{ verdict: 'open', decidedAt: NOW - 35 * DAY, decidedByUserId: 'm' }}
              pendingCount={0}
              alreadyReported={false}
              onReport={null}
              moderator={
                <AccessRulingCardView
                  verdict="open"
                  pendingCount={0}
                  busy={false}
                  error={null}
                  onRule={fn()}
                />
              }
            />
            <Section title="Shape" level={2}>
              <TermList
                rows={[
                  { term: 'Shoreline', value: '11.4 mi' },
                  { term: 'Length', value: '4.1 mi, northwest to southeast' },
                  { term: 'Width', value: '0.8 mi at its widest' },
                ]}
              />
            </Section>
            <IceHistoryView
              lines={[
                'Skaters have reported a pressure ridge near Mascoma North in 3 of the last 5 winters.',
              ]}
            />
            <LinksView
              links={[
                {
                  id: 'stored:0',
                  label: 'Mascoma Lake Association',
                  url: 'https://www.mascomalake.org/',
                  note: 'The lake association — water levels, the dam, events on the ice',
                },
                {
                  id: 'community',
                  label: 'Upper Valley Nordic skating',
                  url: 'https://groups.google.com/g/uvnordic',
                  note: 'A regional skaters’ group',
                },
              ]}
            />
            <ModeratorToolsView
              editorHref="/admin/water/mascoma"
              pendingReview={false}
              busy={false}
              onApprove={fn()}
              onReject={fn()}
            />
          </TabStack>
        </LakeFrame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    const q = within(quad);
    await expect(q.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
    // App links leave in a new tab; the moderator cards are dashed hairlines, square.
    for (const a of q.getAllByRole('link', { name: /Association|Nordic|Edit this lake/ })) {
      await expect(a).toHaveAttribute('target', '_blank');
    }
    const card = q.getByRole('region', { name: 'Moderator tools' });
    await expect(getComputedStyle(card).borderTopStyle).toBe('dashed');
    await expect(getComputedStyle(card).borderTopLeftRadius).toBe('0px');
    await expect(q.getByText(/Ice history/i)).toBeVisible();
  },
};

const back = fn();

function ActionStory({ mode }: { mode: Mode }) {
  useEscapeToClose(mode === 'dark', back);
  return (
    <LakeFrame
      header={<LakeHeader {...MASCOMA_HEADER} />}
      overlay={
        <ActionPane act="hazard" backTo="Mascoma Lake" onBack={back} autoFocus={mode === 'dark'} />
      }
    >
      <ReportsBody container={null} />
    </LakeFrame>
  );
}

/** An action over the sidebar (row 3): focus moves into it, Esc leaves it — one Esc per screen. */
export const Action: Story = {
  render: () => <SkaterPair height="40rem">{(mode) => <ActionStory mode={mode} />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    back.mockClear();
    const quad = darkQuad(canvasElement);
    const pane = within(quad).getByRole('region', { name: 'Report a hazard' });
    await waitFor(() =>
      expect(within(pane).getByRole('button', { name: 'Back to Mascoma Lake' })).toHaveFocus(),
    );
    // The tab under it is dimmed and out of reach.
    await expect(must(quad.querySelector('[data-slot="lake-tab-panel"]'))).toHaveAttribute('inert');
    await userEvent.keyboard('{Escape}');
    await expect(back).toHaveBeenCalledTimes(1);
  },
};

/** 2.8 — the sidebar loading: the header's runs and the body's blocks, each the size it holds. */
export const Loading: Story = {
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <div className="grid h-full grid-cols-[27.5rem_minmax(0,1fr)]">
          <LakeSidebarSkeleton />
          <div aria-hidden="true" className="bg-raise" />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const region = within(darkQuad(canvasElement)).getByRole('complementary', {
      name: 'Loading the lake',
    });
    await expect(region).toHaveAttribute('aria-busy', 'true');
  },
};

/** A broken link: said plainly, with the way back. */
export const NotFound: Story = {
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <div className="grid h-full grid-cols-[27.5rem_minmax(0,1fr)]">
          <LakeUnavailable kind="not-found" explore={link('/')} />
          <div aria-hidden="true" className="bg-raise" />
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByRole('heading', { name: 'Lake not found' })).toBeVisible();
    await userEvent.tab();
    await expect(q.getByRole('link', { name: 'Back to Explore' })).toHaveFocus();
  },
};
