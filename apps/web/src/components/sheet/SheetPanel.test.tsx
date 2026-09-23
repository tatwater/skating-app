import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuestionBlock, SheetPanel } from './SheetPanel';

describe('SheetPanel', () => {
  it('reads its name alone until filled, then its summary when collapsed, and says when it is needed', () => {
    const { rerender } = render(
      <SheetPanel label="Snow" summary="" collapsed onToggle={() => {}}>
        <p>body</p>
      </SheetPanel>,
    );
    expect(screen.getByRole('button', { name: 'Snow' })).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <SheetPanel label="Snow" summary="None" collapsed onToggle={() => {}}>
        <p>body</p>
      </SheetPanel>,
    );
    expect(screen.getByRole('button', { name: /^Snow/ })).toHaveTextContent('None');
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    rerender(
      <SheetPanel label="Snow" summary="None" collapsed={false} onToggle={() => {}} gap>
        <p>body</p>
      </SheetPanel>,
    );
    expect(screen.getByRole('button', { name: 'Snow · needed' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('a question block names the question and closes on Done', () => {
    let done = 0;
    render(
      <QuestionBlock title="Where did you get on?" onDone={() => done++}>
        <p>the launches</p>
      </QuestionBlock>,
    );
    expect(screen.getByText('Where did you get on?')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Done' }).click();
    expect(done).toBe(1);
  });
});
