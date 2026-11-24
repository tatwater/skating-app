import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faXmark } from '@fortawesome/sharp-light-svg-icons';
import {
  KNOW_BEFORE_YOU_GO,
  type KnowBeforeYouGoQuestion,
  knowBeforeYouGoAnswers,
  ONBOARDING_COPY,
} from '@skating/core';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from '../../kit/kbd';

/** Where a question stands: nothing picked, the right pick, or a miss (the right one still waits). */
export type QuestionState = 'ask' | 'right' | 'miss';

/**
 * Seven cells, one per question (board 10.6): the answered ones lit. Full width, no "3 of 7" —
 * the cells say it (First review). The meter's cell look (`CellLoader`'s), drawn as a measurement.
 */
export function QuestionCells({ answered }: { answered: number }) {
  const total = KNOW_BEFORE_YOU_GO.questions.length;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> draws one bar; the boards draw seven cells
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={answered}
      aria-label={ONBOARDING_COPY.questions.kicker}
      data-slot="question-cells"
      className="flex gap-1"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its question's place
          key={i}
          data-slot="cell"
          data-lit={i < answered ? '' : undefined}
          className="block h-1.5 flex-1 bg-line2 data-lit:bg-fg1"
        />
      ))}
    </div>
  );
}

/**
 * **One question** (boards 10.6–10.8, 11.6–11.8; D296): the prompt, the two first-person answers in
 * the data's order (`rightFirst`), and the feedback line — whose room is kept before a pick, so the
 * card never jumps. On a desk each answer wears its key, 1 and 2.
 *
 * - **Correct**: the pick outlined in the bright ink with a check, the other dimmed; *"Correct."*
 *   and the why.
 * - **Not quite**: the miss amber with a cross; *"Not quite."*, the why, *"Pick the correct answer
 *   to continue."* — the right answer still waits, and the button stays off until it's picked.
 *
 * The answers are `ph-no-capture`: a clicked answer's words are what autocapture would record, and
 * a wrong pick is stored nowhere, PostHog included.
 */
export const QuestionCard = forwardRef<
  HTMLButtonElement,
  {
    question: KnowBeforeYouGoQuestion;
    state: QuestionState;
    /** A pick: 0 is the first drawn answer (key 1), 1 the second (key 2). */
    onPick: (index: 0 | 1) => void;
  }
>(function QuestionCard({ question, state, onPick }, firstRef) {
  const copy = ONBOARDING_COPY.questions;
  const answers = knowBeforeYouGoAnswers(question);
  return (
    <>
      <h1
        data-slot="question-prompt"
        className="m-0 font-semibold text-[1.375rem] text-fg leading-[1.3] tracking-normal @max-[48rem]/entry:text-[1.3125rem]"
      >
        {question.prompt}
      </h1>
      <div data-slot="question-picks" className="ph-no-capture flex flex-col gap-2.5">
        {answers.map((answer, i) => {
          const look =
            state === 'right'
              ? answer.right
                ? 'on'
                : 'dim'
              : state === 'miss' && !answer.right
                ? 'miss'
                : 'open';
          const key = String(i + 1);
          return (
            <button
              key={answer.text}
              ref={i === 0 ? firstRef : undefined}
              type="button"
              data-slot="question-pick"
              data-look={look}
              aria-keyshortcuts={key}
              aria-pressed={look === 'on' || look === 'miss'}
              // A settled question takes no more picks; a miss stays pressed but inert.
              aria-disabled={state === 'right' || look === 'miss' || undefined}
              onClick={() => {
                if (state === 'right' || look === 'miss') return;
                onPick(i as 0 | 1);
              }}
              className={cn(
                'flex min-h-[3.625rem] w-full cursor-pointer items-center gap-3.5 rounded-control border border-line2 border-solid bg-transparent py-3 pr-3.5 pl-4 text-left text-[0.9375rem] text-fg leading-[1.4] outline-none',
                'transition-[border-color,box-shadow,color] duration-(--duration-fast) ease-standard',
                'focus-visible:shadow-focus [@media(hover:hover)]:hover:data-[look=open]:border-fg3',
                '@max-[48rem]/entry:min-h-[4.125rem] @max-[48rem]/entry:text-[0.96875rem]',
                'data-[look=on]:cursor-default data-[look=on]:border-fg data-[look=on]:font-medium data-[look=on]:shadow-[inset_0_0_0_1px_var(--fg)]',
                'data-[look=dim]:cursor-default data-[look=dim]:border-line data-[look=dim]:text-fg3',
                'data-[look=miss]:cursor-default data-[look=miss]:border-warn data-[look=miss]:text-fg2',
              )}
            >
              <span className="min-w-0 flex-1">{answer.text}</span>
              <span
                aria-hidden="true"
                className="flex min-w-[1.125rem] flex-none items-center justify-center"
              >
                {look === 'on' ? (
                  <FontAwesomeIcon icon={faCheck} className="h-[0.8125rem]" />
                ) : look === 'miss' ? (
                  <FontAwesomeIcon icon={faXmark} className="h-[0.8125rem] text-warn" />
                ) : look === 'open' ? (
                  <Kbd variant="dim" className="@max-[48rem]/entry:hidden">
                    {key}
                  </Kbd>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <p
        data-slot="question-feedback"
        data-state={state}
        aria-live="polite"
        className={cn(
          'm-0 flex min-h-[2.75rem] items-start gap-3 text-[0.90625rem] text-fg1 leading-normal',
          state === 'ask' && 'invisible',
        )}
      >
        {state !== 'ask' && (
          <>
            <i
              aria-hidden="true"
              className={cn(
                'mt-[0.4375rem] size-2 flex-none',
                state === 'miss' ? 'bg-warn' : 'bg-acc',
              )}
            />
            <span>
              <b className="font-semibold text-fg">
                {state === 'miss' ? copy.notQuite : copy.correct}
              </b>{' '}
              {question.why}
              {state === 'miss' && ` ${copy.pickCorrect}`}
            </span>
          </>
        )}
      </p>
    </>
  );
});
