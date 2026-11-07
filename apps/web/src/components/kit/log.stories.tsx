import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Log, type LogLine, RunError } from './log';
import { computedColor, contrastBetween, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { must } from './storyKit';

const meta = {
  title: 'Kit/Log',
  component: Log,
  tags: ['autodocs'],
  decorators: [(Story) => <div className="w-[36rem]">{Story()}</div>],
} satisfies Meta<typeof Log>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A weather sweep's output, line `i` of it: neutral run output. */
function sweepLine(i: number): LogLine {
  const s = 12 + i;
  const time = `08:${String(31 + (Math.floor(s / 60) % 28)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (i % 9 === 4)
    return {
      id: i,
      time,
      word: 'warn',
      tone: 'warn',
      text: `retry  open-meteo 429  → try 2 of 3 in 2 s`,
    };
  return {
    id: i,
    time,
    word: 'appended',
    tone: 'ok',
    text: `batch ${i + 1}  145 cells  wtd=${200 + (i % 7)}  1.${i % 10} s`,
  };
}

const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => sweepLine(from + i));

const FAILED: LogLine[] = [
  { time: '04:12:00', word: 'sweep', tone: 'stage', text: 'unattached before 14 Sep 04:12' },
  { time: '04:12:01', text: 'find    2 photos  kg2f7…x9q 3.1 MB · kg29c…m2a 2.4 MB' },
  { time: '04:12:01', text: 'delete  kg2f7…x9q  storage.delete' },
  { time: '04:12:31', word: 'warn', tone: 'warn', text: 'timeout 30 s  → try 2 of 3 in 2 s' },
  { time: '04:12:33', text: 'delete  kg2f7…x9q  storage.delete' },
  { time: '04:13:03', word: 'warn', tone: 'warn', text: 'timeout 30 s  → try 3 of 3 in 4 s' },
  { time: '04:13:07', text: 'delete  kg2f7…x9q  storage.delete' },
  { time: '04:13:34', word: 'exit 1', tone: 'bad', text: '0 / 2 deleted · run finished as failed' },
];

/** A run that writes as you press: the tests' handle on a live log. */
function LiveLog({
  start = 30,
  onCopy,
}: {
  start?: number;
  onCopy?: (t: string, w: string) => void;
}) {
  const [rows, setRows] = useState(() => lines(start));
  return (
    <div className="flex flex-col gap-(--space-3)">
      <Log lines={rows} state="live" onCopy={onCopy} boxClassName="h-[12rem]" />
      <Button
        size="sm"
        className="self-start"
        onClick={() => setRows((r) => [...r, ...lines(10, r.length)])}
      >
        Write 10 lines
      </Button>
    </div>
  );
}

const parts = (scope: Element) => ({
  log: must(scope.querySelector<HTMLElement>('[data-slot="log"]')),
  viewport: must(scope.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')),
  rows: [...scope.querySelectorAll<HTMLElement>('[data-slot="log-line"]')],
});
const atEnd = (v: HTMLElement) => v.scrollHeight - v.scrollTop - v.clientHeight <= 2;

/**
 * Live: the last line rides the white rule with a cursor; the log opens at its end and stays there
 * as lines land. Follow is on.
 */
export const Live: Story = {
  args: { lines: [], state: 'live' },
  render: () => <LiveLog />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const { viewport, rows } = parts(canvasElement);
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    const follow = canvas.getByRole('switch', { name: 'Follow' });
    await expect(follow).toBeChecked();
    const last = must(rows.at(-1));
    await expect(last).toHaveAttribute('data-live');
    await expect(rows.filter((r) => r.hasAttribute('data-live'))).toHaveLength(1);
    await expect(getComputedStyle(last).boxShadow).toContain(computedColor(last, 'var(--fg)'));
    await expect(last.querySelector('[data-slot="log-cursor"]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Write 10 lines' }));
    await waitFor(() => expect(parts(canvasElement).rows).toHaveLength(40));
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    // The rule moved with the end.
    await expect(must(parts(canvasElement).rows.at(-1))).toHaveAttribute('data-live');
    await expect(last).not.toHaveAttribute('data-live');
  },
};

/**
 * Scrolling up pauses following: Follow switches off and new lines land without moving the view.
 * Switching Follow back on jumps to the end and keeps up again.
 */
export const FollowPauses: Story = {
  args: Live.args,
  render: () => <LiveLog />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const { viewport } = parts(canvasElement);
    const follow = canvas.getByRole('switch', { name: 'Follow' });
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -400 }));
    viewport.scrollTop = 0;
    await waitFor(() => expect(follow).not.toBeChecked());
    await userEvent.click(canvas.getByRole('button', { name: 'Write 10 lines' }));
    await waitFor(() => expect(parts(canvasElement).rows).toHaveLength(40));
    await expect(viewport.scrollTop).toBe(0);
    await userEvent.click(follow);
    await expect(follow).toBeChecked();
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    await userEvent.click(canvas.getByRole('button', { name: 'Write 10 lines' }));
    await waitFor(() => expect(parts(canvasElement).rows).toHaveLength(50));
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
  },
};

/** Finished: no Follow (nothing more is coming), no rule on the last line; it opens at its end. */
export const Finished: Story = {
  args: { lines: lines(40), state: 'finished', boxClassName: 'h-[12rem]' },
  play: async ({ canvasElement }) => {
    const { viewport, rows } = parts(canvasElement);
    await expect(within(canvasElement).queryByRole('switch')).toBeNull();
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    await expect(rows.some((r) => r.hasAttribute('data-live') || r.hasAttribute('data-fail'))).toBe(
      false,
    );
    // The thumb is drawn even at rest: a still render shows the box scrolls.
    const bar = must(
      canvasElement.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]'),
    );
    await expect(getComputedStyle(bar).opacity).toBe('1');
    // Scrolled up, it stays where the reader put it, even as the box resizes.
    viewport.scrollTop = 0;
    await waitFor(() => expect(viewport.scrollTop).toBe(0));
    const lines = must(canvasElement.querySelector<HTMLElement>('[data-slot="log-lines"]'));
    lines.style.paddingBottom = '2rem';
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await expect(viewport.scrollTop).toBe(0);
    lines.style.paddingBottom = '';
  },
};

/**
 * Failed: the line where it failed is red-washed, the bar in red. Warnings keep their amber word;
 * nothing else is washed.
 */
export const Failed: Story = {
  args: { lines: FAILED, state: 'failed', boxClassName: 'h-[12rem]' },
  play: async ({ canvasElement }) => {
    const { rows } = parts(canvasElement);
    const failing = rows.filter((r) => r.hasAttribute('data-fail'));
    await expect(failing).toEqual([rows.at(-1)]);
    const line = must(failing[0]);
    await expect(getComputedStyle(line).backgroundColor).toBe(
      computedColor(line, 'var(--bad-wash)'),
    );
    await expect(getComputedStyle(line).boxShadow).toContain(computedColor(line, 'var(--bad)'));
    const warn = must(rows[3]?.querySelector<HTMLElement>('[data-slot="log-word"]'));
    await expect(getComputedStyle(warn).color).toBe(computedColor(warn, 'var(--warn)'));
  },
};

/**
 * Copy log copies every line as printed; the ▾ menu copies only the warnings and errors, or a
 * diagnosis prompt when the caller writes one. The button says Copied a moment, at one width.
 */
export const Copy: Story = {
  args: {
    lines: FAILED,
    state: 'failed',
    boxClassName: 'h-[10rem]',
    onCopy: fn(),
    diagnosis: (l) => `Why did this run fail?\n${l.length} lines follow.`,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const copy = canvas.getByRole('button', { name: /Copy log/ });
    await document.fonts.ready; // the label's face sets the button's width
    const width = copy.getBoundingClientRect().width;
    await userEvent.click(copy);
    await expect(args.onCopy).toHaveBeenLastCalledWith(
      FAILED.map((l) => [l.time, l.word, l.text].filter(Boolean).join('  ')).join('\n'),
      'log',
    );
    await waitFor(() =>
      expect(canvas.getByText('Copied', { selector: '[aria-live]' })).toBeInTheDocument(),
    );
    await expect(copy.getBoundingClientRect().width).toBe(width);

    await userEvent.click(canvas.getByRole('button', { name: 'More ways to copy' }));
    await userEvent.click(
      await within(document.body).findByRole('menuitem', { name: 'Copy warnings & errors' }),
    );
    await expect(args.onCopy).toHaveBeenLastCalledWith(
      [
        '04:12:31  warn  timeout 30 s  → try 2 of 3 in 2 s',
        '04:13:03  warn  timeout 30 s  → try 3 of 3 in 4 s',
        '04:13:34  exit 1  0 / 2 deleted · run finished as failed',
      ].join('\n'),
      'problems',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'More ways to copy' }));
    await userEvent.click(
      await within(document.body).findByRole('menuitem', { name: 'Copy a diagnosis prompt' }),
    );
    await expect(args.onCopy).toHaveBeenLastCalledWith(
      'Why did this run fail?\n8 lines follow.',
      'prompt',
    );
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  },
};

/** By default a copy goes to the clipboard (a refused clipboard is not an error here). */
export const CopyToClipboard: Story = {
  args: { lines: FAILED, state: 'failed', boxClassName: 'h-[10rem]' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Copy log/ }));
    await waitFor(() =>
      expect(canvas.getByText('Copied', { selector: '[aria-live]' })).toBeInTheDocument(),
    );
  },
};

/** Without a diagnosis writer, the menu offers only the warnings-and-errors copy. */
export const CopyWithoutPrompt: Story = {
  args: { lines: FAILED, state: 'failed', boxClassName: 'h-[10rem]', onCopy: fn() },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More ways to copy' }));
    const menu = await within(document.body).findByRole('menu');
    await expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Copy warnings & errors']);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  },
};

/**
 * Thousands of lines: 20,000 written, the latest 5,000 drawn under a note, and lines out of view
 * skip layout. It still opens at its end, and Copy log still copies all 20,000.
 */
export const Thousands: Story = {
  args: { lines: lines(20_000), state: 'live', onCopy: fn() },
  play: async ({ canvasElement, args }) => {
    const { viewport, rows } = parts(canvasElement);
    await expect(rows).toHaveLength(5_000);
    await expect(canvasElement.querySelector('[data-slot="log-trimmed"]')).toHaveTextContent(
      'Earlier lines are not shown · Copy log has every line',
    );
    await expect(getComputedStyle(must(rows[0])).contentVisibility).toBe('auto');
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
    await expect(must(rows.at(-1))).toHaveTextContent('batch 20000');
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Copy log/ }));
    const [text] = (args.onCopy as ReturnType<typeof fn>).mock.lastCall as [string];
    await expect(text.split('\n')).toHaveLength(20_000);
  },
};

/**
 * Measured, not assumed: a line is the mono step × the loose leading; a line too long for the box
 * wraps onto a second and is measured twice as tall; the text starts `space-3_5` in from the box,
 * while the live line's bar and wash run to the edge. The tools sit `space-2` over the box.
 */
export const Junctions: Story = {
  args: {
    lines: [
      ...lines(6),
      {
        time: '08:32:00',
        word: 'appended',
        tone: 'ok',
        text: 'touched  Mascoma Lake · Post Pond · Lake Morey · Crystal Lake · Lake Fairlee · Shaker Lake · Goose Pond · Lake Sunapee · Pleasant Lake · Little Lake Sunapee · Kezar Lake',
      },
      ...lines(3, 6),
    ],
    state: 'live',
    boxClassName: 'h-[14rem]',
  },
  play: async ({ canvasElement }) => {
    await document.fonts.ready; // the mono face sets where a line wraps
    const near = (a: number, b: number, what: string) =>
      expect(Math.abs(a - b), what).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const { log, rows } = parts(canvasElement);
    const one = resolvePx(log, 'calc(var(--type-mono-sm) * var(--lead-loose))');
    // Until the first rendering update decides what's in view, every line holds its estimate;
    // then the long one is measured, wrapped onto two.
    await waitFor(() =>
      expect(must(rows[6]).getBoundingClientRect().height).toBeGreaterThanOrEqual(one * 2 - 0.5),
    );
    await near(must(rows[0]).getBoundingClientRect().height, one, 'line height');
    const box = must(log.querySelector('[data-slot="scroll-area"]')).getBoundingClientRect();
    const edge = resolvePx(log, 'var(--stroke-hair)');
    const live = must(rows.at(-1));
    await near(live.getBoundingClientRect().left - box.left - edge, 0, 'live bar at edge');
    const time = must(live.firstElementChild).getBoundingClientRect();
    await near(time.left - box.left - edge, resolvePx(log, 'var(--space-3_5)'), 'text inset');
    const tools = must(log.querySelector('[data-slot="log-tools"]')).getBoundingClientRect();
    await near(box.top - tools.bottom, resolvePx(log, 'var(--space-2)'), 'tools gap');
    // Follow and the copies share the tools row: Follow at the left, the copies at the right edge.
    const follow = within(canvasElement).getByRole('switch').getBoundingClientRect();
    const copy = must(log.querySelector('[data-slot="log-copy"]')).getBoundingClientRect();
    await expect(follow.left).toBeLessThan(copy.left);
    await near(copy.right, box.right, 'copy at right edge');
  },
};

/** A streaming run, for watching: a line every 600 ms (stops at 200). Scroll up to pause it. */
function Streaming() {
  const [rows, setRows] = useState(() => lines(12));
  useEffect(() => {
    const t = setInterval(
      () => setRows((r) => (r.length >= 200 ? r : [...r, sweepLine(r.length)])),
      600,
    );
    return () => clearInterval(t);
  }, []);
  return <Log lines={rows} state="live" boxClassName="h-[12rem]" />;
}

export const Stream: Story = {
  args: Live.args,
  render: () => <Streaming />,
  play: async ({ canvasElement }) => {
    const { viewport } = parts(canvasElement);
    await waitFor(() => expect(parts(canvasElement).rows.length).toBeGreaterThan(12), {
      timeout: 2_000,
    });
    await waitFor(() => expect(atEnd(viewport)).toBe(true));
  },
};

/**
 * The run error block: the red rule down the left on the red wash, a red kicker head and a quiet
 * aside, the error in mono with its trace quieter, then a foot with the note left and the copies
 * right.
 */
export const RunErrorBlock: Story = {
  args: Failed.args,
  render: () => (
    <RunError
      title="Failed · Wed 14 Oct 04:12"
      aside="3 / 3 tries spent"
      message="Error: storage.delete timed out after 30 s"
      trace={['at deleteFile (storageHygiene.ts:241) · photo kg2f7…x9q · 3.1 MB']}
      note="Nothing is half-done: a photo's row goes only after its file does."
      actions={<Button size="sm">Copy error</Button>}
    />
  ),
  play: async ({ canvasElement }) => {
    const near = (a: number, b: number) =>
      expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const block = must(canvasElement.querySelector<HTMLElement>('[data-slot="run-error"]'));
    await expect(block).toHaveAccessibleName('Failed · Wed 14 Oct 04:12');
    const style = getComputedStyle(block);
    await expect(style.backgroundColor).toBe(computedColor(block, 'var(--bad-wash)'));
    await expect(style.borderLeftColor).toBe(computedColor(block, 'var(--bad)'));
    await near(parseFloat(style.borderLeftWidth), resolvePx(block, 'var(--stroke-note)'));
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.borderRadius).toBe('0px');
    const head = must(block.querySelector('h3'));
    await expect(getComputedStyle(head).color).toBe(computedColor(head, 'var(--bad)'));
    await expect(getComputedStyle(head).textTransform).toBe('uppercase');
    const msg = must(block.querySelector<HTMLElement>('[data-slot="run-error-message"]'));
    const probe = document.createElement('span');
    probe.style.fontFamily = 'var(--family-mono)';
    block.append(probe);
    const mono = getComputedStyle(probe).fontFamily;
    probe.remove();
    await expect(getComputedStyle(msg).fontFamily).toBe(mono);
    const trace = must(block.querySelector<HTMLElement>('[data-slot="run-error-trace"]'));
    await expect(getComputedStyle(trace).color).toBe(computedColor(trace, 'var(--fg3)'));
    // The head, message and foot sit `space-2_5` apart; the content starts `space-4` in.
    const gap = resolvePx(block, 'var(--space-2_5)');
    const b = block.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    const m = msg.getBoundingClientRect();
    const foot = must(block.querySelector('[data-slot="run-error-foot"]')).getBoundingClientRect();
    const headRow = must(
      block.querySelector('[data-slot="run-error-head"]'),
    ).getBoundingClientRect();
    await near(m.top - headRow.bottom, gap);
    await near(foot.top - m.bottom, gap);
    await near(
      h.left - b.left - parseFloat(style.borderLeftWidth),
      resolvePx(block, 'var(--space-4)'),
    );
    // The error reads AA on the wash.
    await expect(
      contrastBetween(block, ['var(--bg)', 'var(--bad-wash)'], ['var(--fg)']),
    ).toBeGreaterThanOrEqual(4.5);
  },
};

/** A failed run as its page shows it: the error block over the log's last lines. */
export const FailedRun: Story = {
  args: Failed.args,
  render: () => (
    <div className="flex flex-col gap-(--space-5)">
      <RunError
        title="Failed · Wed 14 Oct 04:12"
        aside="3 / 3 tries spent"
        message="Error: storage.delete timed out after 30 s"
        trace={['at deleteFile (storageHygiene.ts:241) · photo kg2f7…x9q · 3.1 MB']}
        note="Nothing is half-done: a photo's row goes only after its file does."
      />
      <Log lines={FAILED} state="failed" boxClassName="h-[11rem]" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="run-error"]')).not.toBeNull();
    await expect(parts(canvasElement).rows.at(-1)).toHaveAttribute('data-fail');
  },
};

export const FourUp: Story = {
  args: Failed.args,
  decorators: [(Story) => Story()],
  render: () => (
    <div className="flex w-[24rem] flex-col gap-(--space-4)">
      <RunError
        title="Failed · 04:12"
        aside="3 / 3 tries"
        message="Error: storage.delete timed out"
      />
      <Log
        lines={[
          { time: '04:12:00', text: 'sweep' },
          ...FAILED.slice(1, 7),
          { ...must(FAILED[7]), fail: true },
        ]}
        state="live"
        boxClassName="h-[8rem]"
      />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const row = must(q.querySelector<HTMLElement>('[data-slot="log-line"]'));
      const one = resolvePx(q, 'calc(var(--type-mono-sm) * var(--lead-loose))');
      await expect(Math.abs(row.getBoundingClientRect().height - one)).toBeLessThanOrEqual(0.5);
      const fail = must(q.querySelector<HTMLElement>('[data-fail]'));
      await expect(getComputedStyle(fail).backgroundColor).toBe(
        computedColor(q, 'var(--bad-wash)'),
      );
    }
  },
};
