import {
  groupTermsBlocks,
  ONBOARDING_COPY,
  splitBold,
  TERMS,
  type TermsDocument,
  termsSectionHeading,
} from '@skating/core';
import { forwardRef } from 'react';

/** `**bold**` as `<strong>`, the same spans the emailed copy bolds. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {splitBold(text).map((span, i) =>
        span.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a span is its place in the sentence
          <strong key={i} className="font-semibold text-fg">
            {span.text}
          </strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a span is its place in the sentence
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The terms as a screen reads them: core's data (`legal/terms.ts`), every section numbered, its
 * paragraphs and lists, then the end marker — the line whose arrival on screen is what "read to the
 * end" means. The marker is forwarded so a reader can watch it.
 */
export const TermsText = forwardRef<HTMLDivElement, { terms?: TermsDocument }>(function TermsText(
  { terms = TERMS },
  endRef,
) {
  return (
    <div data-slot="terms-text" className="flex flex-col gap-3">
      {terms.sections.map((section, i) => (
        <section key={section.heading} className="flex flex-col gap-3">
          <h2 className="m-0 mt-2 font-semibold text-[0.78125rem] text-fg uppercase leading-[1.3] tracking-[0.1em] [section:first-child>&]:mt-0">
            {termsSectionHeading(i, section)}
          </h2>
          {groupTermsBlocks(section.blocks).map((run, j) =>
            run.kind === 'p' ? (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: a paragraph is its place in the section
                key={j}
                className="m-0 text-[0.84375rem] text-fg1 leading-[1.55] @max-[48rem]/entry:text-[0.90625rem]"
              >
                <Inline text={run.text} />
              </p>
            ) : (
              <ul
                // biome-ignore lint/suspicious/noArrayIndexKey: a list is its place in the section
                key={j}
                className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[0.84375rem] text-fg1 leading-[1.55] marker:text-fg3 @max-[48rem]/entry:text-[0.90625rem]"
              >
                {run.items.map((item) => (
                  <li key={item}>
                    <Inline text={item} />
                  </li>
                ))}
              </ul>
            ),
          )}
        </section>
      ))}
      <div
        ref={endRef}
        data-slot="terms-end"
        className="mt-2 flex items-center gap-2.5 whitespace-nowrap font-(family-name:--family-mono) font-medium text-fg3 text-kick leading-none before:h-px before:flex-1 before:bg-line2 after:h-px after:flex-1 after:bg-line2"
      >
        {ONBOARDING_COPY.terms.endMarker}
      </div>
    </div>
  );
});
