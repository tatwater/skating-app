import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { CronCard } from './CronCard';
import { CronRunLog, cronLogLine } from './CronRunLog';
import { at, PUMP_JOB, ZONE } from './cronFixtures';

/**
 * The card's own clock (the verdict re-read every second from the read's inputs, with no new read)
 * and the run log's lines, its older pages and its empty state.
 */

beforeAll(stubJsdomAnimations);
afterEach(() => {
  vi.useRealTimers();
});

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

describe('the card’s clock', () => {
  it('turns late, then stalled, as the viewer’s clock passes, with no new read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(14, 10));
    const job = { ...PUMP_JOB, inputs: { lastTickAt: at(14, 9), lastOutcome: 'ok' as const } };
    render(<CronCard job={job} onOpenRuns={() => {}} timeZone={ZONE} />);
    expect(slot('cron-card')?.dataset.state).toBe('ok');
    expect(slot('cron-when')).toHaveProperty('textContent', '14:09 · On time');
    act(() => {
      vi.advanceTimersByTime(6 * 60_000);
    });
    expect(slot('cron-card')?.dataset.state).toBe('late');
    expect(slot('cron-when')?.textContent).toBe('Late');
    act(() => {
      vi.advanceTimersByTime(25 * 60_000);
    });
    expect(slot('cron-card')?.dataset.state).toBe('stalled');
  });

  it('opens its runs', () => {
    const onOpenRuns = vi.fn();
    render(<CronCard job={PUMP_JOB} onOpenRuns={onOpenRuns} now={at(14, 12, 30)} />);
    fireEvent.click(slot('cron-runs') as HTMLElement);
    expect(onOpenRuns).toHaveBeenCalledOnce();
  });

  it('says a press started the run under way', () => {
    const job = { ...PUMP_JOB, inputs: { ...PUMP_JOB.inputs, runningTrigger: 'manual' as const } };
    render(<CronCard job={job} onOpenRuns={() => {}} now={at(14, 12, 30)} timeZone={ZONE} />);
    expect(slot('cron-sub')?.textContent).toBe('Every 3 minutes · Run now');
  });
});

describe('the run log', () => {
  const line = (seq: number, kind: string, text: string, dropped: number | null = null) => ({
    seq,
    loggedAt: at(14, 0, seq),
    kind,
    text,
    dropped,
  });

  it('tones lines by kind and writes a capped log honestly', () => {
    expect(cronLogLine(line(1, 'fail', 'boom'), ZONE)).toEqual({
      id: 1,
      time: '14:00:01',
      word: 'fail',
      tone: 'bad',
      text: 'boom',
    });
    expect(cronLogLine(line(2, 'line', 'plain'), ZONE)).toEqual({
      id: 2,
      time: '14:00:02',
      text: 'plain',
    });
    expect(cronLogLine(line(3, 'cap', 'x', 1_200), ZONE).text).toBe(
      '1,200 lines past the log’s limit weren’t kept',
    );
  });

  it('says when a run kept no lines, and when it is loading', () => {
    const { rerender } = render(
      <CronRunLog lines={undefined} more={false} failed={false} label="Log" />,
    );
    expect(slot('cron-run-log')?.dataset.loading).toBe('');
    rerender(<CronRunLog lines={[]} more={false} failed={false} label="Log" />);
    expect(slot('cron-run-log-empty')?.textContent).toBe('This run didn’t keep any lines.');
  });

  it('asks for older lines when scrolled to the top', () => {
    const onLoadOlder = vi.fn();
    render(
      <CronRunLog
        lines={[line(1, 'line', 'a'), line(2, 'line', 'b')]}
        more
        onLoadOlder={onLoadOlder}
        failed
        label="Log"
      />,
    );
    expect(slot('cron-run-log-more')?.textContent).toBe('Scroll up for older lines');
    const viewport = slot('scroll-area-viewport') as HTMLElement;
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(onLoadOlder).toHaveBeenCalled();
  });
});
