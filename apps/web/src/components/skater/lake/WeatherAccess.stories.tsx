import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Section } from '../../kit/section-slug';
import { must } from '../../kit/storyKit';
import { type Mode, SkaterPair } from '../storySupport';
import {
  AccessAlertBox,
  AccessPhotoStrip,
  AccessProblemPopover,
  DerivedPutInCard,
  ParkingRow,
  PutInCard,
} from './access/AccessViews';
import { ACCESS_NOW, MASCOMA_ACCESS } from './access/accessFixtures';
import {
  derivedPutIns,
  lotDirections,
  lotLine,
  otherParking,
  putInCards,
} from './access/accessModel';
import { LakeSidebar, LakeTabs } from './LakeSidebar';
import type { LakeTab } from './lakeSearch';
import { TabStack } from './ReportsTab';
import { deriveForecast } from './weather/useWeatherData';
import {
  AcrossTheLakeView,
  ForecastView,
  PastWeatherView,
  WeatherAtSelect,
} from './weather/WeatherViews';
import {
  forecastPayload,
  NOW_MS,
  pastHeadline,
  SPREAD,
  timelineDays,
} from './weather/weatherFixtures';
import { type WeatherPlace, WHOLE_LAKE } from './weather/weatherModel';

/**
 * The lake's Weather (boards 1.6, 1.7) and Getting there (1.8) tabs, on the skater surface in both
 * modes. Real composition from the same views the tabs connect; the weather runs through core
 * (`buildPastWeatherPanel`, `weatherTimelineModel`, `buildForecastPlan`), so every sentence is
 * core's. "Today" is Saturday 16 January 2027; the weather, people and alerts are invented.
 */
const meta = {
  title: 'Skater/Lake Weather and Getting there',
  globals: { surface: 'skater', mode: 'light' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const darkQuad = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('section[data-mode="dark"]'));

function Frame({ tab, children }: { tab: LakeTab; children: ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[var(--size-sidebar)_minmax(0,1fr)]">
      <LakeSidebar
        label="Mascoma Lake"
        body={
          <LakeTabs tab={tab} onTabChange={() => {}}>
            {children}
          </LakeTabs>
        }
      />
      <div aria-hidden="true" className="bg-raise" />
    </div>
  );
}

// ── Weather ───────────────────────────────────────────────────────────────────────────────────

const PLACES: WeatherPlace[] = [
  WHOLE_LAKE,
  { id: 'north', name: 'Mascoma North' },
  { id: 'south', name: 'Mascoma South' },
];
const pick = fn();
const forecast = deriveForecast(forecastPayload(), NOW_MS);

function WeatherBody({
  container,
  places,
}: {
  container: HTMLElement | null;
  places: WeatherPlace[];
}) {
  return (
    <TabStack>
      {places.length >= 2 && (
        <WeatherAtSelect
          places={places}
          selected={WHOLE_LAKE}
          onSelect={pick}
          container={container}
        />
      )}
      <PastWeatherView
        loading={false}
        refreshing={false}
        headline={pastHeadline()}
        timeline={timelineDays()}
        largeBody={false}
        coarse={false}
        container={container}
      />
      {places.length >= 3 && (
        <AcrossTheLakeView
          spread={SPREAD}
          bayHref={(id) => ({
            href: `/water/mascoma?sub=${id}`,
            onClick: (e) => e.preventDefault(),
          })}
        />
      )}
      <ForecastView
        loading={false}
        refreshing={false}
        line={forecast.line}
        plan={forecast.plan}
        container={container}
      />
    </TabStack>
  );
}

/** 1.6 / 1.7 — Mascoma, whole lake: two bays, so "Weather at" and "Across the lake" show. */
export const Weather: Story = {
  render: () => (
    <SkaterPair height="100rem">
      {(_, c) => (
        <Frame tab="weather">
          <WeatherBody container={c} places={PLACES} />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    pick.mockClear();
    const quad = darkQuad(canvasElement);
    const q = within(quad);
    await expect(q.getByRole('tab', { name: 'Weather' })).toHaveAttribute('aria-selected', 'true');
    // Observation above forecast: the order is an authority claim.
    const titles = q.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    await expect(titles).toEqual(['What it’s been through', 'Across the lake', 'What’s coming']);
    // The keyboard path: "Weather at", then the window's tooltip, then into the chart's slider.
    const select = q.getByRole('combobox', { name: 'Which part of the lake the weather is for' });
    select.focus();
    await userEvent.keyboard('{Enter}');
    const south = await within(document.body).findByRole('option', { name: 'Mascoma South' });
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(south).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{Enter}');
    await expect(pick).toHaveBeenCalledWith('south');
    // The list closes and hands focus back to the select before the next stop.
    await waitFor(() => expect(within(document.body).queryByRole('listbox')).toBeNull());
    await waitFor(() => expect(select).toHaveFocus());
    await userEvent.tab();
    await expect(q.getByRole('button', { name: 'Last 10 days' })).toHaveFocus();
    // The tip mounts at its starting style (transparent), then fades in: wait for it to arrive.
    const tip = await within(document.body).findByText(
      'The 10 full days before today. Today is still in progress and is not counted.',
    );
    await waitFor(() => expect(tip).toBeVisible());
    const slider = q.getByRole('slider', { name: 'Scroll the weather chart through time' });
    slider.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(slider).toHaveAttribute('aria-valuetext', '1.0 days back');
    await userEvent.keyboard('{End}');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Showing the most recent days');
    // A day card is a pressable: 2 px, pressed when chosen; Enter chooses it.
    const days = within(q.getByRole('group', { name: 'Daily forecast' })).getAllByRole('button');
    const sun = must(days[1]);
    sun.focus();
    await userEvent.keyboard('{Enter}');
    await expect(sun).toHaveAttribute('aria-pressed', 'true');
    await expect(getComputedStyle(sun).borderTopLeftRadius).toBe('2px');
    // Units with the values, US units; no verdict about the ice.
    await expect(quad.textContent).toMatch(/°F/);
    await expect(quad.textContent).not.toMatch(/\bsafe\b|skateable|good to go/i);
  },
};

/** Crystal Lake: one sample point, so no "Weather at" — the tab starts at what it's been through. */
export const WeatherOnePoint: Story = {
  render: () => (
    <SkaterPair height="82rem">
      {(_, c) => (
        <Frame tab="weather">
          <WeatherBody container={c} places={[WHOLE_LAKE]} />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.queryByText('Weather at')).toBeNull();
    await expect(q.queryByRole('heading', { name: 'Across the lake' })).toBeNull();
  },
};

/** The tab while its reads are out: the two frames C's mount point drew, kept. */
export const WeatherLoading: Story = {
  render: () => (
    <SkaterPair height="30rem">
      {() => (
        <Frame tab="weather">
          <TabStack>
            <PastWeatherView
              loading
              refreshing={false}
              headline={[]}
              timeline={[]}
              largeBody={false}
              coarse={false}
            />
            <ForecastView loading refreshing={false} line={null} plan={null} />
          </TabStack>
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const quad = darkQuad(canvasElement);
    await expect(quad.querySelectorAll('section[aria-busy="true"]')).toHaveLength(2);
  },
};

// ── Getting there ─────────────────────────────────────────────────────────────────────────────

const post = fn(() => Promise.resolve(null));
const vote = fn();
const opened = fn();

function AccessBody({ container, mode }: { container: HTMLElement | null; mode: Mode }) {
  const cards = putInCards(MASCOMA_ACCESS, 'web', ACCESS_NOW);
  const lots = otherParking(MASCOMA_ACCESS);
  return (
    <TabStack>
      <Section title="Put-ins" level={2} count={cards.length}>
        {cards.map((card, i) => (
          <PutInCard
            key={card.id}
            card={card}
            nowMs={ACCESS_NOW}
            container={container}
            problem={
              <AccessProblemPopover
                putInName={card.name}
                onPost={post}
                // The board draws the first card's popover open (on the dark quad only).
                defaultOpen={i === 0 && mode === 'dark'}
                container={container}
              />
            }
            alerts={card.alerts.map((alert) => (
              <AccessAlertBox
                key={alert.id}
                alert={alert}
                busy={false}
                error={null}
                onVote={vote}
                onRetract={null}
              />
            ))}
            photos={
              card.recommended ? (
                <AccessPhotoStrip
                  name={card.name}
                  photos={[
                    { id: 'a', thumbUrl: null },
                    { id: 'b', thumbUrl: null },
                  ]}
                  uploading={false}
                  error={null}
                  onAdd={() => {}}
                  onRemove={null}
                />
              ) : null
            }
            onDirections={opened}
          />
        ))}
      </Section>
      <Section title="Parking" level={2} count={lots.length}>
        <ul className="m-0 list-none p-0">
          {lots.map((lot) => (
            <ParkingRow
              key={lot.id}
              name={lot.name ?? 'Parking lot'}
              line={lotLine(lot)}
              directions={lotDirections(lot, 'web')}
              onDirections={opened}
              container={container}
            />
          ))}
        </ul>
      </Section>
    </TabStack>
  );
}

/** 1.8 — Getting there, with "Report an access problem" open beside the first card. */
export const GettingThere: Story = {
  render: () => (
    <SkaterPair height="118rem">
      {(mode, c) => (
        <Frame tab="access">
          <AccessBody container={c} mode={mode} />
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    post.mockClear();
    const quad = darkQuad(canvasElement);
    const q = within(quad);
    // The board's open popover: a square panel, Post sends the default reason.
    const dialog = await within(quad).findByRole('dialog');
    await expect(getComputedStyle(dialog).borderTopLeftRadius).toBe('0px');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post' }));
    await expect(post).toHaveBeenCalledWith('not_plowed', undefined);
    await waitFor(() => expect(within(quad).queryByRole('dialog')).toBeNull());
    await expect(q.getByRole('tab', { name: 'Getting there' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The keyboard path: the corner button opens it, focus moves in, Esc closes it and returns.
    const corner = q.getByRole('button', {
      name: 'Report an access problem at Shakoma Beach',
    });
    corner.focus();
    await userEvent.keyboard('{Enter}');
    const reopened = await within(quad).findByRole('dialog');
    await waitFor(() => expect(reopened.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(within(quad).queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(corner).toHaveFocus());

    // The hike-in stays its own line; cards are square, pressables 2 px.
    const ramp = q.getByRole('article', { name: 'Mascoma Lakeside Park Boat Ramp' });
    await expect(within(ramp).getByText('Hike-in')).toBeVisible();
    await expect(getComputedStyle(ramp).borderTopLeftRadius).toBe('0px');
    const directions = within(ramp).getByRole('link', { name: /Directions to parking/ });
    await expect(directions).toHaveAttribute('target', '_blank');
    await expect(getComputedStyle(directions).borderTopLeftRadius).toBe('2px');
    // The alert's two answers.
    const beach = q.getByRole('article', { name: 'Shakoma Beach' });
    await userEvent.click(within(beach).getByRole('button', { name: 'Still blocked' }));
    await expect(vote).toHaveBeenCalledWith('still_blocked');
    // The last parking row has no rule under it.
    const rows = quad.querySelectorAll<HTMLElement>('[data-slot="parking-row"]');
    await expect(getComputedStyle(must(rows[rows.length - 1])).borderBottomWidth).toBe('0px');
  },
};

/** A lake with no stored launch: the spots reports put in at, and the act pane as the way to report. */
export const GettingThereFromReports: Story = {
  render: () => (
    <SkaterPair height="24rem">
      {(_, c) => (
        <Frame tab="access">
          <TabStack>
            {derivedPutIns(
              [
                {
                  coord: { lat: 43.61, lng: -72.12 },
                  source: 'derived',
                  reportCount: 3,
                  lastUsedAt: ACCESS_NOW - 3 * 86_400_000,
                },
              ],
              'web',
              ACCESS_NOW,
            ).map((d) => (
              <DerivedPutInCard key={d.key} model={d} onDirections={opened} container={c} />
            ))}
          </TabStack>
        </Frame>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const q = within(darkQuad(canvasElement));
    await expect(q.getByRole('article', { name: 'Where skaters put in' })).toBeVisible();
    await expect(q.getByText(/3 reports · last used/)).toBeVisible();
  },
};
