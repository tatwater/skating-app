import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';

import { cn } from '@/lib/utils';
import { NAME_WORDS as W } from './nameWords';

/**
 * **In the app** (board 4.2): two pictures of the skater app once the pick shows — the body's
 * title as its drawer heads it, and the search finding it by its other name. A static picture of
 * the app is drawn as a picture (Review 11 rule 8): each tilted in 3D, one down-left and one
 * down-right, a hairline between them. Decoration with words: each picture is an image to a reader,
 * named by its alt text. The tilt is still (nothing moves), so reduced motion changes nothing.
 */

const PIC = cn(
  'flex min-w-0 flex-col overflow-hidden bg-bg inset-ring inset-ring-line2',
  // A picture's perspective is a drawing value, as a stroke is (D233): the board's 640 px.
  '[transform-style:preserve-3d]',
);

export function InTheApp({
  name,
  place,
  alias,
  typed,
}: {
  /** The name the body displays once the pick lands. */
  name: string;
  /** Under the title: “Auburn, ME · Lake or pond”. */
  place: string;
  /** The other name, which search still finds; none draws the title alone. */
  alias: string | null;
  /** What the reader typed into search. */
  typed: string;
}) {
  return (
    <div
      data-slot="names-in-the-app"
      className="grid h-[7rem] grid-cols-[auto_var(--stroke-hair)_auto] items-center justify-between gap-x-(--space-3)"
    >
      <div
        role="img"
        aria-label={W.appTitle(name)}
        className={cn(PIC, 'gap-(--space-2) px-(--space-3_5) pt-(--space-2) pb-(--space-3)')}
        style={{ transform: 'perspective(640px) rotateX(14deg) rotateY(15deg)' }}
      >
        <i aria-hidden="true" className="h-[3px] w-(--space-6) self-center rounded-full bg-line2" />
        <span className="flex flex-col gap-(--space-1_5)" aria-hidden="true">
          <span className="text-row leading-none font-semibold tracking-label whitespace-nowrap text-fg uppercase">
            {name}
          </span>
          <span className="text-kick leading-none whitespace-nowrap text-fg3">{place}</span>
        </span>
      </div>
      <i aria-hidden="true" className="self-stretch bg-line" />
      {alias === null ? (
        <span />
      ) : (
        <div
          role="img"
          aria-label={W.appSearch(typed, name)}
          className={cn(PIC, 'gap-(--space-2_5) px-(--space-3) pt-(--space-2_5) pb-(--space-3)')}
          style={{ transform: 'perspective(640px) rotateX(14deg) rotateY(-15deg)' }}
        >
          <span
            aria-hidden="true"
            className="flex h-(--space-6) items-center gap-(--space-2) border-0 border-b-(length:--stroke-hair) border-solid border-line2 text-assist text-fg"
          >
            <FontAwesomeIcon icon={faMagnifyingGlass} className="size-(--space-2_5) text-fg2" />
            <span>{typed}</span>
            <i className="-ms-(--space-1) h-(--space-3) w-(--stroke-hair) bg-fg" />
          </span>
          <span
            aria-hidden="true"
            className="flex items-baseline gap-(--space-2) text-assist whitespace-nowrap text-fg"
          >
            <span>{name}</span>
            <span className="text-fg3">
              {W.also} <span className="text-fg1">{alias}</span>
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
