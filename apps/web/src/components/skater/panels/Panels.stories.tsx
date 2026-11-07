import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from '../../kit/button';
import { computedColor, sameColor } from '../../kit/measure';
import { must } from '../../kit/storyKit';
import { SkaterPair } from '../storySupport';
import { INK_PRIMARY } from '../styles';
import { BountyPanelView } from './BountyPanelView';
import { CommentThreadView } from './CommentThread';
import { FlagDialogView } from './FlagDialog';
import { HazardPanelView } from './HazardPanelView';
import { InsetCard, PanelColumn } from './InsetCard';
import {
  BOARD_NOW,
  BOUNTY_MINE,
  BOUNTY_NORTH,
  HAZARD_LEAD,
  HAZARD_THIN,
  REPORT_PAT,
} from './panelFixtures';
import { RatingsRowView } from './RatingsRow';
import { ReportPanelView } from './ReportPanelView';
import { StoryRouter } from './storyRouter';
import { WeatherSinceView } from './WeatherSince';

/**
 * The panels row (boards 2.1–2.7), dark and light: each panel's view in its inset card, from the
 * boards' fixtures. The live containers wire these views to Convex; here they're props only.
 */
const meta = {
  title: 'Skater/Panels/Panels',
  component: InsetCard,
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof InsetCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const quads = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-skater-pair] > section'),
];
const cardOf = (root: ParentNode) => root.querySelector<HTMLElement>('[data-slot="inset-card"]');

function Frame({
  backTo,
  label,
  foot,
  children,
}: {
  backTo: string;
  label: string;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <StoryRouter>
      <PanelColumn>
        <InsetCard backTo={backTo} onClose={() => {}} returnKey="story" label={label} foot={foot}>
          {children}
        </InsetCard>
      </PanelColumn>
    </StoryRouter>
  );
}

const thumbs = (helpful: number) => (
  <>
    <RatingsRowView helpful={helpful} mine={null} canRate onRate={() => {}} />
    <span className="ml-auto">
      <FlagDialogView target="report" onSubmit={async () => {}} />
    </span>
  </>
);

/** 2.1 / 2.2: the lead at the Narrows — fresh, confirmed twice, the verdicts under it. */
export const Hazard: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="92rem">
      {() => (
        <Frame backTo="Mascoma Lake" label="Hazard" foot={thumbs(9)}>
          <HazardPanelView
            data={HAZARD_LEAD}
            onVerdict={() => {}}
            weather={
              <WeatherSinceView
                label="Recent weather here"
                since="Since Thursday"
                line="3 to 22°F · no new snow · NW wind 3 to 9 mph"
              />
            }
          />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of quads(canvasElement)) {
      const card = await waitFor(() => must(cardOf(quad)));
      await expect(getComputedStyle(card).borderRadius).toBe('0px');
      await expect(within(card).getByRole('heading', { name: 'Open water / lead' })).toBeVisible();
      const verdicts = within(card).getByRole('group', { name: 'Seen this recently?' });
      await expect(within(verdicts).getAllByRole('button')).toHaveLength(4);
      // What you press is rounded (2 px); the badge isn't.
      const verdict = must(verdicts.querySelector<HTMLElement>('button'));
      await expect(getComputedStyle(verdict).borderRadius).toBe(
        getComputedStyle(within(card).getByRole('button', { name: /Helpful/ })).borderRadius,
      );
      const badge = within(card).getByText('Recently reported');
      await expect(getComputedStyle(badge).borderRadius).toBe('0px');
    }
  },
};

/** 2.3: thin ice off Black Point, "Fully healed" pressed — the second confirmation, in ice, not red. */
export const FullyHealedConfirm: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="96rem">
      {() => (
        <Frame backTo="Mascoma Lake" label="Hazard" foot={thumbs(3)}>
          <HazardPanelView
            data={HAZARD_THIN}
            onVerdict={() => {}}
            weather={
              <WeatherSinceView
                label="Recent weather here"
                since="Since Jan 4"
                line="Above freezing with rain Jan 7 and 8, then below 10°F most nights · 3.1″ of snow Jan 13"
                caveat="Possibly snow-hidden."
              />
            }
          />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of quads(canvasElement)) {
      const card = await waitFor(() => must(cardOf(quad)));
      await userEvent.click(within(card).getByRole('button', { name: /^Fully healed/ }));
      const confirm = await waitFor(() =>
        must(card.querySelector<HTMLElement>('[data-slot="healed-confirm"]')),
      );
      // Clearing a hazard is good news: the confirm is drawn in ice, never red (Review 4).
      const style = getComputedStyle(confirm);
      await expect(style.borderTopColor).toEqual(sameColor(computedColor(confirm, 'var(--acc)')));
      await expect(style.borderTopColor).not.toEqual(
        sameColor(computedColor(confirm, 'var(--bad)')),
      );
      const yes = within(confirm).getByRole('button', { name: 'Yes, I don’t see it anymore' });
      await expect(getComputedStyle(yes).backgroundColor).toEqual(
        sameColor(computedColor(confirm, 'var(--acc)')),
      );
      // The words are heard before the button.
      await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true));
    }
  },
};

/** 2.4 / 2.5: Pat's report, today — the readings, the weather since, the photos, the comments. */
export const Report: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="122rem">
      {() => (
        <Frame backTo="Mascoma Lake" label="Report" foot={thumbs(6)}>
          <ReportPanelView
            data={REPORT_PAT}
            weather={
              <WeatherSinceView
                label="Weather since this report"
                since="Since 11:40 AM"
                line="18°F · NW 9 mph · no new snow"
              />
            }
            comments={
              <CommentThreadView
                now={BOARD_NOW}
                viewer={{ displayName: 'Kate Donovan' }}
                onCreate={async () => {}}
                onEdit={async () => {}}
                onRemove={async () => {}}
                nodes={[
                  {
                    id: 'c1',
                    hidden: false,
                    comment: {
                      body: 'Did the lead at the bridge look any smaller from the launch?',
                      authorId: 'u2',
                      author: { username: 'sberman', displayName: 'Sarah Berman' },
                      isOwn: false,
                      createdAt: BOARD_NOW - 60 * 60_000,
                    },
                    replies: [
                      {
                        id: 'c2',
                        hidden: false,
                        comment: {
                          body: 'Same as Thursday from what I could see — still steaming. Gave it a wide berth.',
                          authorId: 'u1',
                          author: { username: 'placasse', displayName: 'Pat Lacasse' },
                          isOwn: false,
                          createdAt: BOARD_NOW - 50 * 60_000,
                        },
                        replies: [],
                      },
                    ],
                  },
                  {
                    id: 'c3',
                    hidden: false,
                    comment: {
                      body: 'Thanks. Going to look at it from Shakoma this afternoon.',
                      authorId: 'u3',
                      author: { username: 'mochs', displayName: 'Matt Ochs' },
                      isOwn: false,
                      createdAt: BOARD_NOW - 25 * 60_000,
                    },
                    replies: [],
                  },
                ]}
              />
            }
          />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of quads(canvasElement)) {
      const card = await waitFor(() => must(cardOf(quad)));
      await expect(within(card).getByRole('heading', { name: 'Mascoma South' })).toBeVisible();
      await expect(
        within(card).getByText('3', { selector: '[data-slot="section-slug"] *' }),
      ).toBeVisible();
      // A list's last row has no rule under it.
      const readings = card.querySelectorAll('li.border-dotted');
      await expect(getComputedStyle(must(readings[readings.length - 1])).borderBottomWidth).toBe(
        '0px',
      );
      // People are circles.
      const face = must(card.querySelector<HTMLElement>('[data-slot="avatar"]'));
      await expect(getComputedStyle(face).borderRadius).not.toBe('0px');
    }
  },
};

/** 2.6: the open ask on Mascoma North — "3 want a report", the one place it's said. */
export const Bounty: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="40rem">
      {() => (
        <Frame
          backTo="Mascoma North"
          label="Bounty"
          foot={
            <>
              <Button variant="primary" size="sm" className={INK_PRIMARY}>
                Add a report
              </Button>
              <Button size="sm">I want this too</Button>
            </>
          }
        >
          <BountyPanelView
            data={BOUNTY_NORTH}
            rateCandidate={() => (
              <RatingsRowView
                helpful={11}
                mine={null}
                canRate
                compact
                withUnhelpful={false}
                onRate={() => {}}
              />
            )}
          />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of quads(canvasElement)) {
      const card = await waitFor(() => must(cardOf(quad)));
      await expect(within(card).getByText('3 want a report')).toBeVisible();
      await expect(within(card).queryByText(/points|pts/i)).toBeNull();
      await expect(
        within(card).getByRole('button', { name: /Back to Mascoma North/ }),
      ).toBeVisible();
      // The last candidate carries no rule.
      const rows = card.querySelectorAll<HTMLElement>('[data-slot="bounty-candidate"]');
      await expect(getComputedStyle(must(rows[rows.length - 1])).borderBottomWidth).toBe('0px');
    }
  },
};

/** 2.7: Kate's own — the fulfilling thumbs, and Cancel in red. */
export const BountyYours: Story = {
  args: {} as never,
  render: () => (
    <SkaterPair height="34rem">
      {() => (
        <Frame
          backTo="Mascoma Lake"
          label="Bounty"
          foot={
            <Button size="sm" className="text-bad inset-ring-bad">
              Cancel bounty
            </Button>
          }
        >
          <BountyPanelView
            data={BOUNTY_MINE}
            rateCandidate={() => (
              <RatingsRowView helpful={6} mine={null} canRate compact onRate={() => {}} />
            )}
          />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    for (const quad of quads(canvasElement)) {
      const card = await waitFor(() => must(cardOf(quad)));
      await expect(within(card).getByText('You want a report')).toBeVisible();
      await expect(
        within(card).getByText('A helpful thumb from you fulfills the bounty.'),
      ).toBeVisible();
      const cancel = within(card).getByRole('button', { name: 'Cancel bounty' });
      await expect(getComputedStyle(cancel).color).toEqual(
        sameColor(computedColor(cancel, 'var(--bad)')),
      );
    }
  },
};
