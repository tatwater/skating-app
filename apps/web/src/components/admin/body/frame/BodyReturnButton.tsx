import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeftLong } from '@fortawesome/sharp-regular-svg-icons';
import { Button } from '@/components/kit/button';
import { ConsoleTopStart } from '../../shell/ConsoleShell';

/**
 * The Body console's way back, in the top bar's start: a long left arrow and *Corpus*, whatever the
 * destination is (the Corpus list, the Inbox item, the old water page — the route decides). The
 * arrow only says "back": it is hidden from assistive tech, so the button's name is its label.
 */
export function BodyReturnButton({ onReturn }: { onReturn: () => void }) {
  return (
    <ConsoleTopStart>
      <Button variant="outline" size="sm" onClick={onReturn} aria-keyshortcuts="Shift+Enter">
        <FontAwesomeIcon
          icon={faArrowLeftLong}
          data-slot="return-arrow"
          className="h-[1em]"
          aria-hidden="true"
        />
        Corpus
      </Button>
    </ConsoleTopStart>
  );
}
