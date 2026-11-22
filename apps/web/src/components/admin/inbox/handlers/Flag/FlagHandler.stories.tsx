import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { FlagBoard } from './flagBoard';
import {
  ALERT_ITEM,
  AROUND,
  AROUND_CAPPED,
  AROUND_EMPTY,
  AROUND_ONE_SIDED,
  CAPPED_VOTES_ITEM,
  COMMENT_ITEM,
  DECIDED_ITEM,
  DOWN_ITEM,
  ERASED_COMMENT_ITEM,
  GONE_ITEM,
  HAZARD_AUTO_ITEM,
  OWN_FILING_ELSEWHERE_ITEM,
  OWN_ITEM,
  PERSON_ITEM,
  POST_ITEM,
  REFUSED_ITEM,
  RETRACTED_ALERT_ITEM,
  RIDGE_AUTO_ITEM,
  SAFETY_ITEM,
  SAFETY_MANY,
  SAFETY_WITH_CLOSED,
  UNPINNED_ALERT_ITEM,
  UNREADABLE_ITEM,
  UNVOTED_HAZARD_ITEM,
  WEATHER,
  WEATHER_GAPS,
  WEATHER_NONE,
  WITHDRAWN_REPORT_ITEM,
} from './flagFixtures';

/**
 * The flag handler at the boards' inspector size (788 × 874 of the 1440 × 900 board): 2.1 Safety ·
 * Unsafe report and its *Reports around this one* drawer, 2.6 Content flags · Access alert, and every
 * state no board draws. Render `Board21` beside `inbox-v5.html`, `AroundDrawer` (opened) beside
 * `inbox-v5.html?around=1`, `Board26` beside `inbox-handler-v5.html?h=alert`. The frame and the map
 * are stand-ins (W1's and W3's).
 */
const meta = {
  title: 'Admin/Inbox/Flag handler',
  component: FlagBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { item: SAFETY_ITEM, onWrite: fn(async () => true) },
} satisfies Meta<typeof FlagBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) => {
  const el = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (el === null) throw new Error(`No [data-slot="${name}"] drawn`);
  return el;
};
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];
const bar = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="toolbar"]');
/** The bar's key buttons by label (the author's menu has no key), in order. */
const barButtons = (root: HTMLElement) =>
  [...(bar(root)?.querySelectorAll<HTMLElement>('button[aria-keyshortcuts]') ?? [])].map((b) =>
    (b.textContent ?? '').slice(0, -(b.getAttribute('aria-keyshortcuts') ?? '').length),
  );
const pane = (root: HTMLElement) => slot(root, 'story-inspector');
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const sheet = () => document.querySelector<HTMLElement>('[data-slot="around-sheet"]');

const SAFETY_ARGS = { item: SAFETY_ITEM, weather: WEATHER, around: AROUND };

/**
 * Board 2.1 at 360 px: the Stefan estimate's *How it is calculated* link stays inside its cell (it
 * wraps under the figure), and nothing on the pane scrolls sideways.
 */
export const Board21Narrow: Story = {
  args: SAFETY_ARGS,
  render: (args) => (
    <div style={{ width: 360 }}>
      <FlagBoard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const how = slot(canvasElement, 'stefan-how');
    const cell = must(how.closest<HTMLElement>('[data-slot="weather-stefan"]'));
    // Layout, read until it settles: a measure taken before the fonts land is a fallback's.
    await waitFor(() => {
      expect(how.getBoundingClientRect().right).toBeLessThanOrEqual(
        cell.getBoundingClientRect().right + 0.5,
      );
      expect(how.scrollWidth).toBeLessThanOrEqual(how.clientWidth + 0.5);
    });
    await expectNoSidewaysScroll(pane(canvasElement));
  },
};

/** Board 2.1 — Sarah's unsafe flag on Rob's black-ice report, as drawn. */
export const Board21: Story = {
  args: SAFETY_ARGS,
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'flag-head');
    await expect(head).toHaveTextContent('Flagged: false safety report');
    await expect(slot(head, 'flag-head-safety')).toHaveTextContent('Safety');
    // Filed 10 Oct 18:02, read at noon on the 14th: three whole days (the board rounds it to 4).
    await expect(slot(head, 'flag-head-sub')).toHaveTextContent('3 days ago');
    // The report's history lives in Reports, not built: drawn, and Coming soon.
    const history = slot(head, 'flag-history');
    await expect(history).toHaveTextContent('Open in Reports');
    await expect(history).toHaveAttribute('data-unavailable-title', 'Coming soon');
    // The report as it states itself: where, when, the vantage; the claims; the measured one red.
    await expect(slot(canvasElement, 'subject-kicker')).toHaveTextContent(
      'Report · Enfield, NH · 10 Oct 15:40–17:05 · on the ice',
    );
    await expect(slot(canvasElement, 'subject-name')).toHaveTextContent('Mascoma Lake');
    const chips = slots(canvasElement, 'claim-chip').map((c) => c.textContent);
    await expect(chips).toEqual([
      '3.5″ measured',
      'black ice',
      'glass',
      'still open, south end',
      'good · experienced only',
    ]);
    await expect(slots(canvasElement, 'claim-chip')[0]).toHaveAttribute('data-flagged');
    // That night, at the body: context, in °F, the Stefan figure labeled as the model's.
    await expect(slot(canvasElement, 'weather-low')).toHaveTextContent('Low · 9 Oct');
    await expect(slot(canvasElement, 'weather-low')).toHaveTextContent('24 °F');
    await expect(slot(canvasElement, 'weather-nights')).toHaveTextContent('2 in a row');
    await expect(slot(canvasElement, 'weather-fdd')).toHaveTextContent('31 °F·days since 1 Oct');
    const stefan = slot(canvasElement, 'weather-stefan');
    await expect(stefan).toHaveTextContent('Stefan thickness estimate');
    await expect(stefan).toHaveTextContent('~1.1 in');
    await expect(slot(stefan, 'stefan-sub')).toHaveTextContent("A model's figure");
    await expect(slot(stefan, 'stefan-how')).toHaveAttribute(
      'data-unavailable-title',
      'Coming soon',
    );
    // Around it: within 3 days, the summary quoting the reports' own claims, three at most.
    await expect(slot(canvasElement, 'around-line')).toHaveTextContent(
      '3 more reports at Mascoma Lake, within 3 days of this one',
    );
    await expect(slot(canvasElement, 'around-summary')).toHaveTextContent(
      /^1 measured less · 1 saw open water · 1 saw skim ice$/,
    );
    await expect(slot(canvasElement, 'around-compare')).toHaveTextContent('Compare');
    // The flag: Sarah's words, her byline under them, when at the rule's end.
    await expect(slot(canvasElement, 'flag-quote')).toHaveTextContent('He was on about 2 inches');
    const byline = slot(canvasElement, 'flag-byline');
    await expect(byline).toHaveTextContent('Sarah Berman');
    await expect(byline).toHaveTextContent('@sarah');
    await expect(slot(byline, 'person-byline-meta')).toHaveTextContent('Trusted · 58 pts');
    await expect(slot(canvasElement, 'flag-when')).toHaveTextContent('10 Oct 18:02');
    await expect(slot(canvasElement, 'thumbs')).toHaveTextContent('0 up · 2 down');
    // Corroborations are a count: who corroborated isn't stored, so no one is named.
    await expect(slot(canvasElement, 'corroborations')).toHaveTextContent(
      /^1 other report agreed$/,
    );
    // The author: suspended until 15 Oct, Matt on his own line; the trust class as a tag.
    const author = slot(canvasElement, 'author-block');
    await expect(slot(author, 'author-standing')).toHaveTextContent('Suspended');
    await expect(slot(author, 'author-standing')).toHaveTextContent('until 15 Oct');
    await expect(slot(author, 'author-standing-by')).toHaveTextContent('Matt Steinberg');
    await expect(author).toHaveTextContent('14 · 2 counted by the contradiction check');
    await expect(author).toHaveTextContent('1 · this one');
    await expect(slot(author, 'author-trust')).toHaveTextContent('Trusted');
    await expect(author).not.toHaveTextContent('41 pts');
    // 2.1's line: the earlier flag a moderator actioned.
    await expect(slot(author, 'author-prior')).toHaveTextContent(
      'An earlier flag on them was actioned on Sat 10 Oct',
    );
    // The bar: Flag Dismiss, Report Hide and Remove, the author's menu.
    await expect(barButtons(canvasElement)).toEqual(['Dismiss', 'Hide', 'Remove']);
    await expect(slot(canvasElement, 'author-menu')).toHaveTextContent('Rob Tremblay');
    // The frame's scroll ends with room for the floating bar (80 px).
    await expect(slot(canvasElement, 'inbox-inspector-scroll').className).toContain(
      'pb-(--space-20)',
    );
  },
};

/** H opens the reason dialog, Esc leaves it, ⌘⏎ sends — keys act only inside the inspector. */
export const KeyboardHide: Story = {
  args: SAFETY_ARGS,
  play: async ({ canvasElement, args }) => {
    // Outside the inspector, a letter does nothing.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('h');
    await expect(dialog()).toBeNull();
    // Inside it, H asks why.
    pane(canvasElement).focus();
    await waitFor(() => expect(document.activeElement).toBe(pane(canvasElement)));
    await userEvent.keyboard('h');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('Hide this report?');
    await expect(must(dialog())).toHaveTextContent('Closes every open flag on it, in every lane');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await expect(args.onWrite).not.toHaveBeenCalled();
    // Again, with a reason, sent by ⌘⏎.
    pane(canvasElement).focus();
    await userEvent.keyboard('h');
    await waitFor(() => expect(dialog()).not.toBeNull());
    const field = must(must(dialog()).querySelector<HTMLTextAreaElement>('textarea'));
    // The server's cap on an audit reason: an over-long one is stopped here.
    await expect(field).toHaveAttribute('maxlength', '2000');
    await userEvent.click(field);
    await userEvent.keyboard('Contradicted by a measurement an hour later');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(args.onWrite).toHaveBeenCalledWith({
        kind: 'takeDown',
        status: 'hidden',
        reason: 'Contradicted by a measurement an hour later',
      }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
  },
};

/** D: Dismiss says it clears only this item's flags, and its reason is optional. */
export const KeyboardDismiss: Story = {
  args: SAFETY_ARGS,
  play: async ({ canvasElement, args }) => {
    pane(canvasElement).focus();
    await userEvent.keyboard('d');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('Clears this flag only');
    await expect(must(dialog())).toHaveTextContent('other lanes stay open');
    // The dialog's opening focus lands a beat after it appears: send once focus is inside it.
    await waitFor(() => expect(must(dialog()).contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(args.onWrite).toHaveBeenCalledWith({ kind: 'dismiss' }));
  },
};

/** Board 2.1's drawer: *Compare* opens it; newest first, this report among them; Esc closes. */
export const AroundDrawer: Story = {
  args: SAFETY_ARGS,
  play: async ({ canvasElement }) => {
    await expect(sheet()).toBeNull();
    await userEvent.click(slot(canvasElement, 'around-compare'));
    await waitFor(() => expect(sheet()).not.toBeNull());
    const s = must(sheet());
    await expect(within(s).getByText('Reports around this one')).toBeVisible();
    await expect(slot(s, 'around-span')).toHaveTextContent('Mascoma Lake · 7–13 Oct');
    await expect(slot(s, 'around-days')).toHaveTextContent('±3 days');
    const stats = slot(s, 'around-stats');
    await expect(stats).toHaveTextContent('4 incl. this one');
    await expect(stats).toHaveTextContent('1.8–3.5 in');
    // Newest first, this report among them, marked by its badge in the distance slot.
    const authors = slots(s, 'around-author').map((a) => a.textContent);
    await expect(authors).toEqual([
      'Dana Whitlock',
      'Sarah Berman',
      'Rob Tremblay',
      'Luc Pelletier',
    ]);
    const mine = must(s.querySelector<HTMLElement>('[data-slot="around-row"][data-this]'));
    await expect(slot(mine, 'around-this')).toHaveTextContent('This report');
    await expect(mine.querySelector('[data-slot="around-open"]')).toBeNull();
    // A quiet run of days after the newest report.
    await expect(s.querySelector('[data-slot="around-day"][data-none]')).toHaveTextContent(
      'no reports',
    );
    // Every other row's link is there (Coming soon), shown on hover or focus.
    await expect(slots(s, 'around-open')).toHaveLength(3);
    await expect(slot(s, 'around-open-all')).toHaveTextContent('Open all 4 in Reports');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheet()).toBeNull());
  },
};

/** The ±1/3/7 control reads another window. */
export const AroundWindow: Story = {
  args: { ...SAFETY_ARGS, drawer: { 7: AROUND_CAPPED } },
  play: async ({ canvasElement }) => {
    await userEvent.click(slot(canvasElement, 'around-compare'));
    await waitFor(() => expect(sheet()).not.toBeNull());
    await userEvent.click(slot(must(sheet()), 'around-days'));
    const seven = await waitFor(() => must(document.querySelector<HTMLElement>('[data-days="7"]')));
    await userEvent.click(seven);
    await waitFor(() => expect(slot(must(sheet()), 'around-days')).toHaveTextContent('±7 days'));
    // A window the read cut short says so, both sides.
    await waitFor(() => expect(slots(must(sheet()), 'around-capped')).toHaveLength(2));
    // …and every count of it is a floor.
    await expect(slot(must(sheet()), 'around-open-all')).toHaveTextContent(
      'Open all 4+ in Reports',
    );
    await expect(slot(must(sheet()), 'around-stats')).toHaveTextContent('4+ incl. this one');
    // Every tile over the cut-short read is a floor, and the range says whose it is.
    await expect(slot(must(sheet()), 'around-stats')).toHaveTextContent('On the ice2+');
    await expect(slot(must(sheet()), 'around-stats')).toHaveTextContent('Of the reports read');
  },
};

/** *Around it* with nothing in the window. */
export const AroundEmpty: Story = {
  args: { ...SAFETY_ARGS, around: AROUND_EMPTY },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'around-line')).toHaveTextContent(
      'No other reports at Mascoma Lake within 3 days of this one',
    );
    await expect(canvasElement.querySelector('[data-slot="around-summary"]')).toBeNull();
  },
};

/** *Around it* one-sided, one report hidden (staff see it, marked). */
export const AroundOneSided: Story = {
  args: { ...SAFETY_ARGS, around: AROUND_ONE_SIDED },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'around-summary')).toHaveTextContent(
      /^1 measured less · 1 saw open water$/,
    );
    await userEvent.click(slot(canvasElement, 'around-compare'));
    await waitFor(() => expect(sheet()).not.toBeNull());
    await expect(slot(must(sheet()), 'around-down')).toHaveTextContent('Hidden');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(sheet()).toBeNull());
  },
};

/** *That night* with inputs missing: what is missing is said, never guessed. */
export const WeatherMissing: Story = {
  args: { ...SAFETY_ARGS, weather: WEATHER_GAPS },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'weather-low')).toHaveTextContent('Not recorded');
    await expect(slot(canvasElement, 'weather-nights')).toHaveTextContent('1 in a row, then a gap');
    await expect(slot(canvasElement, 'weather-stefan')).toHaveTextContent(
      'Not enough cold yet for an estimate',
    );
  },
};

/** No weather kept for the body at all. */
export const WeatherNotRecorded: Story = {
  args: { ...SAFETY_ARGS, weather: null },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'claim-weather-missing')).toHaveTextContent(
      'Not recorded yet',
    );
    await expect(canvasElement.querySelector('[data-slot="weather-stefan"]')).toBeNull();
  },
};

/** Two people flagged it: the count ends the rule, each byline carries its time. */
export const ManyFlaggers: Story = {
  args: { ...SAFETY_ARGS, item: SAFETY_MANY },
  play: async ({ canvasElement }) => {
    const block = slot(canvasElement, 'flag-block');
    await expect(slot(block, 'section-count')).toHaveTextContent('2');
    await expect(slots(block, 'flag-member')).toHaveLength(2);
    await expect(slots(block, 'flag-quote')).toHaveLength(1);
    const metas = slots(block, 'person-byline-meta').map((m) => m.textContent);
    await expect(metas).toEqual([
      'Trusted · 58 pts · 10 Oct 18:02',
      'Trusted · 22 pts · 11 Oct 07:30',
    ]);
    await expect(slot(canvasElement, 'author-block')).toHaveTextContent('2 · this one');
  },
};

/** Board 2.6 — Kate's flag on Jamie's pinned Fairlee alert. */
export const Board26: Story = {
  args: { item: ALERT_ITEM },
  play: async ({ canvasElement }) => {
    // At the boards' width the alert's life runs across, as drawn (not the kit's stacked form) —
    // once the strip's measure settles (a late face re-measures), never sampled once.
    await waitFor(() =>
      expect(
        must(
          [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="life-strip"]')].find(
            (el) => el.closest('[data-slot="life-strip-measure"]') === null,
          ),
        ),
      ).not.toHaveAttribute('data-narrow'),
    );
    const head = slot(canvasElement, 'flag-head');
    await expect(head).toHaveTextContent('Flag on an access alert');
    await expect(slot(head, 'flag-head-sub')).toHaveTextContent('Other · 6 hours ago');
    const history = slot(head, 'flag-history');
    await expect(history).toHaveTextContent('Open in Body');
    await expect(history).toHaveAttribute('href', '/admin/body/wb_morey');
    await expect(slot(canvasElement, 'subject-name')).toHaveTextContent('“Fairlee launch closed”');
    const card = slot(canvasElement, 'alert-card');
    await expect(card).toHaveTextContent('Fairlee town launch');
    await expect(card).toHaveTextContent('Official');
    await expect(card).toHaveTextContent('Pinned · since 3 Oct');
    await expect(slot(canvasElement, 'flag-quote')).toHaveTextContent('Paving’s done');
    // Under the card, *The flag*: Kate's words, her byline carrying its time.
    await expect(slot(canvasElement, 'flag-byline')).toHaveTextContent('Kate Donovan');
    await expect(slot(canvasElement, 'person-byline-meta')).toHaveTextContent(
      'Trusted · 22 pts · 14 Oct 06:00',
    );
    await expect(canvasElement.querySelector('[data-slot="section-chip"]')).not.toHaveTextContent(
      /^Flag$/,
    );
    // Its life: posted, pinned, confirmed, flagged today, and the day it would lapse.
    const stations = slots(canvasElement, 'life-station');
    await expect(stations.map((s) => s.dataset.mark)).toEqual([
      'dot',
      'square',
      'ring',
      'now',
      'end',
    ]);
    await expect(stations[3]).toHaveTextContent('14 Oct · today');
    await expect(slots(canvasElement, 'life-line').map((l) => l.dataset.line)).toEqual([
      'thin',
      'heavy',
      'heavy',
      'dashed',
    ]);
    // What each drawn lever does.
    const does = slot(canvasElement, 'alert-does');
    await expect(does).toHaveTextContent('Back to active · lapses on its own');
    await expect(does).toHaveTextContent('The flag only · Kate told');
    // The bar: Alert Unpin and Retract, then Flag Dismiss — no author menu (the board's).
    await expect(barButtons(canvasElement)).toEqual(['Unpin', 'Retract', 'Dismiss']);
    await expect(canvasElement.querySelector('[data-slot="author-menu"]')).toBeNull();
  },
};

/** U unpins after asking why. */
/**
 * Board 2.6 at 360 px: the alert's life stacks top to bottom (the kit's narrow form), and nothing on
 * the pane scrolls sideways — no scroller of its own around the strip.
 */
export const Board26Narrow: Story = {
  args: { item: ALERT_ITEM },
  render: (args) => (
    <div style={{ width: 360 }}>
      <FlagBoard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const seen = () =>
      [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="life-strip"]')].find(
        (el) => el.closest('[data-slot="life-strip-measure"]') === null,
      );
    await waitFor(() => expect(must(seen())).toHaveAttribute('data-narrow'));
    await expect(canvasElement.querySelector('[data-slot="alert-life-scroll"]')).toBeNull();
    await waitFor(() =>
      expect(must(seen()).getBoundingClientRect().right).toBeLessThanOrEqual(
        pane(canvasElement).getBoundingClientRect().right + 0.5,
      ),
    );
    await expectNoSidewaysScroll(pane(canvasElement));
  },
};

export const KeyboardUnpin: Story = {
  args: { item: ALERT_ITEM },
  play: async ({ canvasElement, args }) => {
    pane(canvasElement).focus();
    await userEvent.keyboard('u');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('Unpin this alert?');
    await userEvent.click(must(must(dialog()).querySelector('textarea')));
    await userEvent.keyboard('The lot reopened');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(args.onWrite).toHaveBeenCalledWith({
        kind: 'alert',
        verb: 'unpin',
        reason: 'The lot reopened',
      }),
    );
  },
};

/** A content flag on a Post: its reports as 2.1's blocks; two reasons, each over its flag. */
export const PostFlag: Story = {
  args: { item: POST_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'flag-head')).toHaveTextContent('Flag on a Post');
    await expect(slot(canvasElement, 'flag-head-sub')).toHaveTextContent('Spam · Harassment ·');
    await expect(slots(canvasElement, 'post-report')).toHaveLength(2);
    await expect(slots(canvasElement, 'flag-reason').map((r) => r.textContent)).toEqual([
      'Spam',
      'Harassment',
    ]);
    await expect(barButtons(canvasElement)).toEqual(['Dismiss', 'Hide', 'Remove']);
  },
};

/** A comment, its thread's head above it; the author may not post comments. */
export const CommentFlag: Story = {
  args: { item: COMMENT_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'comment-on')).toHaveTextContent('Rob Tremblay’s report');
    await expect(slot(canvasElement, 'comment-body')).toHaveTextContent(
      'Learn to read a thermometer.',
    );
    await expect(slot(canvasElement, 'author-block')).toHaveTextContent('reports · hazards');
    await expect(slot(canvasElement, 'author-block')).not.toHaveTextContent('comments');
  },
};

/** The app's flag on a hazard — no person, its rule and its count. */
export const AppFlagOnHazard: Story = {
  args: { item: HAZARD_AUTO_ITEM },
  play: async ({ canvasElement }) => {
    const app = slot(canvasElement, 'flag-app');
    await expect(app).toHaveTextContent('Filed by the app');
    await expect(slot(canvasElement, 'flag-head')).toHaveTextContent('Flagged: never there');
    // The hazard vote's note is the rule's own count, as filed: drawn.
    await expect(slot(app, 'flag-app-note')).toHaveTextContent(
      '2 skaters reported that nothing was ever at this pin.',
    );
    await expect(app).toHaveTextContent('Filed by the app');
    await expect(slot(app, 'flag-occurrences')).toHaveTextContent(
      '4th occurrence · last dismissed 6 d ago',
    );
    await expect(canvasElement.querySelector('[data-slot="flag-byline"]')).toBeNull();
    // One story: the rule names the verdict as the votes do, and the votes behind it are drawn.
    await expect(app).toHaveTextContent(
      'The app files this when 2 people vote “Nothing here — never was”',
    );
    const rows = slots(canvasElement, 'hazard-verdict');
    await expect(rows.map((r) => r.textContent)).toEqual([
      '1Still here',
      '0Healing — still unsafe',
      '0Fully healed',
      '2Nothing here — never was',
    ]);
    // A verdict nobody cast is drawn quietly, never left out.
    await expect(rows[1]).toHaveAttribute('data-none');
  },
};

/** The contradiction check on a person: the person leads, Open in People, no content levers. */
export const PersonFlag: Story = {
  args: { item: PERSON_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'flag-head')).toHaveTextContent('Flag on a person');
    await expect(slot(canvasElement, 'flag-history')).toHaveAttribute(
      'href',
      '/admin/people/p_rob',
    );
    await expect(slot(canvasElement, 'author-block')).toHaveTextContent('The person');
    await expect(slot(canvasElement, 'flag-app')).toHaveTextContent(
      'The contradiction check filed this: 3 of their reports, with no corroboration of their own, disagreed with a more-corroborated report at the same body by more than the weather since explains',
    );
    // Production's note on this flag is fixed server prose, not the rule's count: never drawn.
    await expect(canvasElement.querySelector('[data-slot="flag-app-note"]')).toBeNull();
    await expect(slot(canvasElement, 'flag-app')).not.toHaveTextContent('Auto:');
    // Their reports, counted among their newest 100: a floor, never an exact figure it isn't.
    await expect(slot(canvasElement, 'author-block')).toHaveTextContent(
      '100+ · 3 counted by the contradiction check',
    );
    await expect(slot(canvasElement, 'author-prior')).toHaveTextContent(
      '50+ earlier flags on them were actioned',
    );
    // The reports the rule counted, each opening in the app in a new tab.
    const counted = slot(canvasElement, 'contradicted-reports');
    await expect(slot(counted, 'section-count')).toHaveTextContent('3');
    const rows = slots(counted, 'contradicted-report');
    await expect(rows.map((r) => r.textContent?.split('Open')[0])).toEqual([
      '10 Oct · on the ice',
      '7 Oct · on the ice',
      '3 Oct · from shore',
    ]);
    const link = must(rows[0]?.querySelector('a'));
    await expect(link).toHaveAttribute('href', '/report/r_black_ice');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(barButtons(canvasElement)).toEqual(['Dismiss']);
  },
};

/** Down before this flag was read: Restore, on one press, no reason. */
export const AlreadyDown: Story = {
  args: { item: DOWN_ITEM },
  play: async ({ canvasElement, args }) => {
    await expect(slot(canvasElement, 'subject-down')).toHaveTextContent(
      'Hidden before this flag was read',
    );
    await expect(barButtons(canvasElement)).toEqual(['Dismiss', 'Restore']);
    pane(canvasElement).focus();
    await userEvent.keyboard('r');
    await waitFor(() => expect(args.onWrite).toHaveBeenCalledWith({ kind: 'restore' }));
    await expect(dialog()).toBeNull();
  },
};

/** Gone: its author deleted it; the flag waits, Dismiss only. */
export const ContentGone: Story = {
  args: { item: GONE_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'subject-gone')).toHaveTextContent('This content is gone');
    await expect(barButtons(canvasElement)).toEqual(['Dismiss']);
  },
};

/** A viewer whose `can` refuses every verb: no bar, and no key acts. */
export const EveryVerbRefused: Story = {
  args: SAFETY_ARGS && { ...SAFETY_ARGS, item: REFUSED_ITEM },
  play: async ({ canvasElement }) => {
    await expect(bar(canvasElement)).toBeNull();
    pane(canvasElement).focus();
    await userEvent.keyboard('h');
    await expect(dialog()).toBeNull();
  },
};

/** The viewer's own alert (D269): no bar. */
export const OwnContent: Story = {
  args: { item: OWN_ITEM },
  play: async ({ canvasElement }) => {
    await expect(bar(canvasElement)).toBeNull();
    await expect(slot(canvasElement, 'alert-card')).toBeVisible();
  },
};

/**
 * The viewer filed an open flag on this report in another lane: a takedown would close it, so the
 * server's `can` refuses Hide and Remove with the own-filing sentence — the bar draws Dismiss only.
 */
export const OwnFilingElsewhere: Story = {
  args: { ...SAFETY_ARGS, item: OWN_FILING_ELSEWHERE_ITEM },
  play: async ({ canvasElement }) => {
    await expect(barButtons(canvasElement)).toEqual(['Dismiss']);
    await expect(within(canvasElement).queryByRole('button', { name: /^Hide/ })).toBeNull();
    await expect(within(canvasElement).queryByRole('button', { name: /^Remove/ })).toBeNull();
    // Nor does its key act.
    pane(canvasElement).focus();
    await userEvent.keyboard('h');
    await expect(dialog()).toBeNull();
  },
};

/** Decided by a colleague while open: the frame locks, the bar goes. */
export const DecidedWhileOpen: Story = {
  args: { ...SAFETY_ARGS, item: DECIDED_ITEM },
  play: async ({ canvasElement }) => {
    await expect(bar(canvasElement)).toBeNull();
    await expect(slot(canvasElement, 'inbox-inspector-lock')).toHaveTextContent('Matt Steinberg');
  },
};

/** Board 2.1 in light mode. */
export const Board21Light: Story = {
  args: SAFETY_ARGS,
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'flag-head')).toHaveTextContent(
      'Flagged: false safety report',
    );
  },
};

/** Board 2.6 in light mode. */
export const Board26Light: Story = {
  args: { item: ALERT_ITEM },
  globals: { surface: 'admin', mode: 'light' },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(slots(canvasElement, 'life-station')).toHaveLength(5));
  },
};

/** Rob deleted the report himself: never read as up; Hide keeps a decision on his record. */
export const AuthorDeletedReport: Story = {
  args: { ...SAFETY_ARGS, item: WITHDRAWN_REPORT_ITEM },
  play: async ({ canvasElement }) => {
    const note = slot(canvasElement, 'subject-withdrawn');
    await expect(note).toHaveTextContent('Withdrawn on 12 Oct');
    // It says which withdrawal: the author's delete.
    await expect(note).toHaveAttribute('data-withdrawal', 'deleted');
    await expect(note).toHaveTextContent('Its author deleted it.');
    await expect(note).not.toHaveTextContent('erased');
    await expect(note).toHaveTextContent('Skaters no longer see it');
    await expect(canvasElement.querySelector('[data-slot="subject-down"]')).toBeNull();
    await expect(barButtons(canvasElement)).toEqual(['Dismiss', 'Hide', 'Remove']);
    pane(canvasElement).focus();
    await userEvent.keyboard('h');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('keeps the decision on their record');
    await expect(must(dialog())).not.toHaveTextContent('brings it back');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
  },
};

/** An erased comment: its words are gone, and it says so. */
export const ErasedComment: Story = {
  args: { item: ERASED_COMMENT_ITEM },
  play: async ({ canvasElement }) => {
    const note = slot(canvasElement, 'subject-withdrawn');
    await expect(note).toHaveTextContent('Withdrawn on 13 Oct');
    // It says which withdrawal: the 30-day erasure.
    await expect(note).toHaveAttribute('data-withdrawal', 'erased');
    await expect(note).toHaveTextContent('It was erased');
    await expect(canvasElement.querySelector('[data-slot="comment-body"]')).toBeNull();
  },
};

/** An alert its author retracted: Unpin and Retract refused, so only Dismiss. */
export const RetractedAlert: Story = {
  args: { item: RETRACTED_ALERT_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'subject-retracted')).toHaveTextContent('Retracted on 14 Oct');
    await expect(barButtons(canvasElement)).toEqual(['Dismiss']);
    await waitFor(() =>
      expect(slots(canvasElement, 'life-station').at(-1)).toHaveTextContent('Retracted'),
    );
  },
};

/** A hidden comment to a viewer who can't read hidden content: the words held back, said so. */
export const WordsHeldBack: Story = {
  args: { item: UNREADABLE_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'words-hidden')).toHaveTextContent(
      'shown only to staff who can read hidden content',
    );
    await expect(slot(canvasElement, 'subject-down')).toBeVisible();
    await expect(barButtons(canvasElement)).toEqual(['Dismiss', 'Restore']);
  },
};

/** A body with no weather rows: the nights and the degree-days are not recorded, never zero. */
export const WeatherNone: Story = {
  args: { ...SAFETY_ARGS, weather: WEATHER_NONE },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'weather-nights')).toHaveTextContent('Not recorded');
    await expect(slot(canvasElement, 'weather-fdd')).toHaveTextContent('Not recorded');
    await expect(slot(canvasElement, 'weather-fdd')).not.toHaveTextContent('0');
    await expect(slot(canvasElement, 'weather-stefan')).toHaveTextContent(
      'No weather recorded for this body',
    );
  },
};

/** A closed member is not this item's question: not drawn, not counted, not dismissed again. */
export const ClosedMemberLeftOut: Story = {
  args: { ...SAFETY_ARGS, item: SAFETY_WITH_CLOSED },
  play: async ({ canvasElement }) => {
    const block = slot(canvasElement, 'flag-block');
    await expect(slot(block, 'section-count')).toHaveTextContent('2');
    await expect(slots(block, 'flag-member')).toHaveLength(2);
    await expect(block).not.toHaveTextContent('Closed long ago');
    await expect(slot(canvasElement, 'author-block')).toHaveTextContent('2 · this one');
    pane(canvasElement).focus();
    await userEvent.keyboard('d');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('Clears these 2 flags only');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
  },
};

/** A failed weather or *Around it* read says it failed and offers *Try again* — never "not recorded". */
export const ContextReadsFailed: Story = {
  args: { ...SAFETY_ARGS, weather: 'failed', around: 'failed', onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    const weather = slot(canvasElement, 'claim-weather');
    await expect(weather).toHaveTextContent('The weather for that night couldn’t be read');
    await expect(weather).not.toHaveTextContent('Not recorded');
    const around = slot(canvasElement, 'around-it');
    await expect(around).toHaveTextContent('The reports around it couldn’t be read');
    await userEvent.click(within(weather).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(args.onRetry).toHaveBeenCalled());
  },
};

/** An alert that isn't pinned: Pin (P) is offered and Unpin isn't; P asks why, ⌘⏎ sends. */
export const UnpinnedAlertPin: Story = {
  args: { item: UNPINNED_ALERT_ITEM },
  play: async ({ canvasElement, args }) => {
    await expect(barButtons(canvasElement)).toEqual(['Pin', 'Retract', 'Dismiss']);
    await expect(slot(canvasElement, 'alert-does')).toHaveTextContent('the flags dismissed');
    pane(canvasElement).focus();
    await userEvent.keyboard('p');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await expect(must(dialog())).toHaveTextContent('Pin this alert as official?');
    await expect(must(dialog())).toHaveTextContent('in every lane, is dismissed');
    await userEvent.click(must(must(dialog()).querySelector('textarea')));
    await userEvent.keyboard('Still closed, I checked');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(args.onWrite).toHaveBeenCalledWith({
        kind: 'alert',
        verb: 'pin',
        reason: 'Still closed, I checked',
      }),
    );
  },
};

/** A ridge crossing: every verdict relabeled by core for a passage marker, the rule's words too. */
export const RidgeCrossingVotes: Story = {
  args: { item: RIDGE_AUTO_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'flag-app')).toHaveTextContent('vote “No crossing here”');
    await expect(slots(canvasElement, 'hazard-verdict').map((r) => r.textContent)).toEqual([
      '1Still crossable',
      '2Crossing looks dicey now',
      '3Ridge closed / healed',
      '4No crossing here',
    ]);
  },
};

/** No votes yet: said in words, never as a resolved hazard. */
export const HazardNoVotes: Story = {
  args: { item: UNVOTED_HAZARD_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'hazard-votes-none')).toHaveTextContent(
      'No one has voted on it yet',
    );
    await expect(slots(canvasElement, 'hazard-verdict')).toHaveLength(0);
  },
};

/** More votes than the read counts: every figure a floor, zeros included. */
export const HazardVotesCapped: Story = {
  args: { item: CAPPED_VOTES_ITEM },
  play: async ({ canvasElement }) => {
    await expect(slots(canvasElement, 'hazard-verdict-count').map((c) => c.textContent)).toEqual([
      '120+',
      '0+',
      '30+',
      '50+',
    ]);
  },
};
