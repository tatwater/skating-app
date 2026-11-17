import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/kit/button';
import { cn } from '@/lib/utils';

/**
 * **Kit candidate — clamped text**: a person's words (an appeal, a long reason) bounded by the
 * lines they take on screen, with the rest a press away.
 *
 * - **Bounded by rendered lines, never by the string.** The collapsed text is clamped to `lines`
 *   lines (CSS line clamp, its ellipsis the browser's); how many characters fit depends on the
 *   width, so no count of characters or newlines can say where it is cut.
 * - **"Is there more" is measured** (`clampOverflows`), on the rendered element — and asked again
 *   whenever its box changes size (a narrow layout, a resize, the face loading) and whenever the
 *   text changes. The expand control is drawn exactly while the text is (or, shown whole, would be)
 *   cut: a real button with its state (`aria-expanded`, `aria-controls`). It keeps focus as it
 *   expands and collapses; if it goes while focused (the text now fits), focus goes to the text.
 * - **Line breaks are the text's own**, kept in both states (`whitespace-pre-line`); a long unbroken
 *   run wraps rather than scroll the column sideways.
 * - **No bound on what is put in the page**: that is the writer's cap, a separate thing (an appeal's
 *   body is capped at its write).
 */

const clampStyle = (lines: number): CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden',
});

/**
 * Whether `el`, clamped to `lines`, is cut: its content runs past its clamped box. One question in
 * both states — shown whole, it is asked under the clamp, put on and taken off again before
 * anything paints (so a whole text can say it would be cut, and keep its *Show less*), never
 * predicted from a line height, which can be `normal` or differ from a line's box.
 */
export function clampOverflows(el: HTMLElement, lines: number): boolean {
  const shown = el.style.cssText;
  Object.assign(el.style, clampStyle(lines));
  const cut = el.scrollHeight > el.clientHeight + 1;
  if (el.style.cssText !== shown) el.style.cssText = shown;
  return cut;
}

/** The one seam the measure goes through, so a test without layout can say what it would find. */
export const clampMeasure = { overflows: clampOverflows };

// Its own box's ref and focusability are what focus falls back to when the button goes: not a
// caller's to replace.
type ClampedTextProps = Omit<ComponentProps<'span'>, 'children' | 'ref' | 'tabIndex'> & {
  /** The words, as written. */
  children: ReactNode;
  /** Lines shown while collapsed. */
  lines: number;
  /** The button's words: to show it all, and to clamp it again. */
  showAll: string;
  showLess: string;
};

function ClampedText({
  children,
  lines,
  showAll,
  showLess,
  className,
  ...props
}: ClampedTextProps) {
  const id = useId();
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const measure = useCallback(() => {
    const el = text.current;
    if (el === null) return;
    const next = clampMeasure.overflows(el, lines);
    // The button goes while focused: focus goes to the text, never back to the page.
    if (!next && button.current !== null && document.activeElement === button.current) {
      box.current?.focus({ preventScroll: true });
    }
    setCut(next);
  }, [lines]);

  // Asked on every change of the text or its state, after layout and before paint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the words or the clamp change.
  useLayoutEffect(measure, [measure, children, whole]);

  // And whenever its box changes size, or a face loads and reflows it.
  useLayoutEffect(() => {
    const el = text.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    // Absent under jsdom; a layout effect never runs without a document.
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener?.('loadingdone', measure);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener?.('loadingdone', measure);
    };
  }, [measure]);

  return (
    <span
      data-slot="clamped-text"
      {...props}
      ref={box}
      tabIndex={-1}
      className={cn('block outline-none', className)}
    >
      <span
        ref={text}
        id={id}
        data-slot="clamped-text-body"
        data-clamped={whole ? undefined : ''}
        className="block whitespace-pre-line [overflow-wrap:anywhere]"
        style={whole ? undefined : clampStyle(lines)}
      >
        {children}
      </span>
      {cut && (
        <Button
          ref={button}
          variant="bare"
          size="xs"
          aria-expanded={whole}
          aria-controls={id}
          onClick={() => setWhole((w) => !w)}
        >
          {whole ? showLess : showAll}
        </Button>
      )}
    </span>
  );
}

export { ClampedText, type ClampedTextProps };
