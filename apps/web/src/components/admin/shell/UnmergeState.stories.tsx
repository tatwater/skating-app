import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConvexError } from 'convex/values';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { must } from '@/components/kit/storyKit';
import { createToastManager, Toaster } from '@/components/kit/toast';
import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';
import { said } from '../said';
import {
  type RunningUnmerge,
  UnmergeLeftView,
  type UnmergeReceipt,
  UnmergingNoteView,
} from './UnmergeLeft';

/**
 * An unmerge's state as the console says it — the Undone toast's line, History's unmerge row, and the
 * place a merge is refused mid-unmerge — from running to done, and stalled: what stopped it, and
 * *Resume* (a refusal is a toast). The server here is a fixture.
 */
const meta = {
  title: 'Admin/Shell/Unmerge state',
  globals: { surface: 'admin' },
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A failed page's error text, as the scheduler records it on a deployment. */
const FAILED = 'Uncaught Error: Too many reads in a single function execution';
const at = (done: boolean, count: number, stalled: string | null = null): UnmergeReceipt => ({
  unmergeActionId: 'u1' as never,
  done,
  stalled: stalled === null ? null : { code: 'pageFailed' as const, error: stalled },
  left: { count, byKind: count > 0 ? { reports: count } : {}, rows: [] },
});

/** Its pages landing, then the last: "Moving rows back…", then what stayed. */
function RunningToDone() {
  const [receipt, setReceipt] = useState(at(false, 0));
  useEffect(() => {
    const t = setTimeout(() => setReceipt(at(true, 3)), 300);
    return () => clearTimeout(t);
  }, []);
  return <UnmergeLeftView receipt={receipt} fallback="Both rows stay in the audit log" />;
}

export const RunningThenDone: Story = {
  name: 'Running → done',
  render: () => <RunningToDone />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByText(MW.unmerging)).toBeVisible();
    await expect(await page.findByText(MW.leftSince(3))).toBeVisible();
    await expect(page.queryByRole('button', { name: MW.resume })).toBeNull();
  },
};

/** A page failed: it stopped, why, and *Resume* — pressed, it runs again to its end. */
function StalledToResumed() {
  const [receipt, setReceipt] = useState(at(false, 1, FAILED));
  return (
    <UnmergeLeftView
      receipt={receipt}
      resume={{
        pending: false,
        onResume: () => {
          setReceipt(at(false, 1));
          setTimeout(() => setReceipt(at(true, 1)), 300);
        },
      }}
    />
  );
}

export const StalledThenResumed: Story = {
  name: 'Running → stalled → resumed → done',
  render: () => <StalledToResumed />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByText(MW.unmergeStalled)).toBeVisible();
    await expect(page.getByText(`${MW.stallWhy.pageFailed} ${FAILED}`)).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: MW.resume }));
    await expect(page.getByText(`${MW.unmerging} · ${MW.leftSince(1)}`)).toBeVisible();
    await expect(await page.findByText(MW.leftSince(1))).toBeVisible();
    await expect(page.queryByRole('button', { name: MW.resume })).toBeNull();
  },
};

/** *Resume* refused (another press already carried it on): a toast in the server's words. */
function Refused() {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div className="flex flex-col gap-(--space-3)">
      <UnmergeLeftView
        receipt={at(false, 0, FAILED)}
        resume={{
          pending: false,
          onResume: () =>
            void said(
              async () => {
                throw new ConvexError('This unmerge is still running.');
              },
              (why) => ({ title: MW.notResumed, description: why }),
              { manager },
            ),
        }}
      />
      <div ref={setBox} className="relative h-[9rem] w-full max-w-(--size-sheet-sm)">
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </div>
  );
}

export const ResumeRefused: Story = {
  name: 'Resume refused',
  render: () => <Refused />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: MW.resume }));
    const toast = await waitFor(() =>
      must(canvasElement.querySelector<HTMLElement>('[data-slot="toast"]')),
    );
    await expect(toast).toHaveTextContent('Not resumed');
    await expect(toast).toHaveTextContent('This unmerge is still running.');
    await expect(toast).toHaveAttribute('data-type', 'bad');
  },
};

const RUNNING: NonNullable<RunningUnmerge> = {
  ...(at(false, 0, FAILED) as NonNullable<UnmergeReceipt>),
  mergeActionId: 'ma1' as never,
};

/** A merge refused mid-unmerge, that unmerge stalled: the sentence, then *Resume*. */
export const RefusedWhileStalled: Story = {
  name: 'Merge refused · its unmerge stalled',
  render: () => (
    <div className="w-(--size-inspector)">
      <UnmergingNoteView
        sentence="This body is still being unmerged. Merge it once that finishes."
        running={RUNNING}
        resume={{ pending: false, onResume: () => {} }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(note).toHaveTextContent('This body is still being unmerged.');
    await expect(note).toHaveTextContent(MW.unmergeStalled);
    await waitFor(() =>
      expect(within(note).getByRole('button', { name: MW.resume })).toBeVisible(),
    );
  },
};

/** Each way an unmerge can stop, by the server's code: the headline, then the code in plain words. */
export const StallCodes: Story = {
  name: 'Stall codes',
  render: () => (
    <div className="flex w-(--size-inspector) flex-col gap-(--space-3)">
      {(Object.keys(MW.stallWhy) as (keyof typeof MW.stallWhy)[]).map((code) => (
        <UnmergeLeftView
          key={code}
          receipt={{ ...(at(false, 0) as NonNullable<UnmergeReceipt>), stalled: { code } }}
          resume={{ pending: false, onResume: () => {} }}
        />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    for (const words of Object.values(MW.stallWhy)) {
      await expect(page.getByText(words)).toBeVisible();
    }
    await expect(page.getAllByText(MW.unmergeStalled)).toHaveLength(
      Object.keys(MW.stallWhy).length,
    );
  },
};
