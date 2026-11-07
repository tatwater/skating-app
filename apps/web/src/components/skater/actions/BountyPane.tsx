import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faCircleInfo, faXmark } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useAction, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';

import { Button } from '@/components/kit/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/kit/dialog';
import { RadioGroup, RadioRow } from '@/components/kit/radio';
import { useAnalytics } from '@/lib/analytics';

import { INK_PRIMARY } from '../styles';

/**
 * Post a bounty (boards 3.9–3.11) — "ask for fresh eyes", one confirm over the lake you're on. A
 * lake with bays asks which part; the reward and who's asked are the server's. Two refusals: the
 * skater's own open-bounty limit (known before they press, 3.11) and the server's reasons (a recent
 * report already covers it), shown as the server says them so the asker knows why.
 *
 * Copy asks for a report; it never suggests the ice is or isn't anything (D3).
 */

export interface BountyBay {
  id: string;
  name: string;
}

export interface BountyLimit {
  limit: number;
  used: number;
  restricted: boolean;
}

export interface BountyViewProps {
  lakeName: string;
  bays: readonly BountyBay[];
  /** `''` is the whole lake. */
  choice: string;
  limit: BountyLimit | null;
  /** The server's refusal, verbatim. */
  refusal: string | null;
  pending: boolean;
  container?: HTMLElement | null;
  /** Modal in the app; a side-by-side story confines each quad's dialog to its quad instead. */
  modal?: boolean;
  onChoose: (choice: string) => void;
  onPost: () => void;
  onClose: () => void;
}

/** The limit, as the rule line says it. */
export function limitLine(limit: BountyLimit | null): string {
  const n = limit?.limit ?? 3;
  const base = `You may have up to ${n} open ${n === 1 ? 'bounty' : 'bounties'} at a time`;
  return limit?.restricted ? `${base} (a moderator set this for your account).` : `${base}.`;
}

/** The refusal before pressing (3.11), or `null` while there's room. */
export function limitRefusal(limit: BountyLimit | null): string | null {
  if (limit === null || limit.used < limit.limit) return null;
  return `You already have ${limit.used} open ${limit.used === 1 ? 'bounty' : 'bounties'}, the most you can have at once. Another opens up when one closes.`;
}

export function BountyView({
  lakeName,
  bays,
  choice,
  limit,
  refusal,
  pending,
  container,
  modal = true,
  onChoose,
  onPost,
  onClose,
}: BountyViewProps) {
  const refused = refusal ?? limitRefusal(limit);
  return (
    <Dialog open modal={modal} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-slot="bounty-pane"
        className="w-[min(30rem,calc(100vw-2rem))]"
        {...(container !== undefined ? { container } : {})}
      >
        <DialogHeader className="relative pe-(--space-12)">
          <Button
            variant="bare"
            size="icon-sm"
            aria-label="Close"
            data-attr="dialog-close"
            className="absolute top-(--space-3) right-(--space-3)"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </Button>
          <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
            Ask for fresh eyes
          </span>
          <DialogTitle className="text-h tracking-head">Post a bounty on {lakeName}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="m-0 text-row text-fg1 [text-wrap:pretty]">
            A bounty asks nearby skaters to check {lakeName} and post a fresh report.
          </p>
          {bays.length > 0 && (
            <fieldset className="m-0 flex flex-col gap-(--space-2) border-0 p-0">
              <legend className="mb-(--space-2) text-kick leading-none font-semibold tracking-head text-fg uppercase">
                Which part?
              </legend>
              <RadioGroup
                className="border border-solid border-line2 px-(--space-3)"
                aria-label="Which part?"
                value={choice}
                onValueChange={(value) => onChoose(String(value))}
              >
                <RadioRow
                  value=""
                  label={`Anywhere on ${lakeName}`}
                  data-attr="bounty-whole-lake"
                />
                {bays.map((bay) => (
                  <RadioRow key={bay.id} value={bay.id} label={bay.name} data-attr="bounty-bay" />
                ))}
              </RadioGroup>
              <p className="m-0 text-assist text-fg3 [text-wrap:pretty]">
                Narrowing the ask means only a report from that part of the lake will fulfill it.
              </p>
            </fieldset>
          )}
          <ul className="m-0 flex list-disc flex-col gap-(--space-1) ps-(--space-4) text-assist text-fg2">
            <li>Only if the lake doesn’t already have a recent report.</li>
            <li>{limitLine(limit)}</li>
          </ul>
          {refused !== null && (
            <div
              role="alert"
              data-slot="bounty-refused"
              className="flex gap-(--space-2_5) border border-s-2 border-solid border-line2 border-s-fg1 bg-raise p-(--space-3) text-row text-fg"
            >
              <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" className="mt-0.5 text-fg1" />
              <span className="[text-wrap:pretty]">{refused}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button data-attr="bounty-cancel" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className={INK_PRIMARY}
            data-attr="bounty-post"
            disabled={refused !== null}
            loading={pending}
            onClick={onPost}
          >
            <FontAwesomeIcon icon={faBullseyeArrow} aria-hidden="true" />
            Post bounty
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BountyPane({
  waterBodyId,
  lakeName,
  subAreaId,
  onClose,
  onPosted,
}: {
  waterBodyId: string;
  lakeName: string;
  /** The bay the lake is framed on (`?sub=`): the ask starts narrowed to it. */
  subAreaId?: string;
  onClose: () => void;
  /** The new bounty, for the page to open its card. */
  onPosted: (bountyId: string) => void;
}) {
  const { capture } = useAnalytics();
  const create = useAction(api.bounties.create);
  const bodyId = waterBodyId as Id<'waterBodies'>;
  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId: bodyId });
  const limit = useQuery(api.bounties.myBountyLimit, {});
  const bays = (subAreas ?? []).filter((s) => !s.removed).map((s) => ({ id: s._id, name: s.name }));
  const [choice, setChoice] = useState(subAreaId ?? '');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const post = async () => {
    setPending(true);
    setRefusal(null);
    try {
      const id = await create({
        waterBodyId: bodyId,
        ...(choice ? { subAreaId: choice as Id<'waterBodySubAreas'> } : {}),
      });
      capture('bounty_posted', { scoped_to_sub_area: choice !== '' });
      onPosted(String(id));
    } catch (error) {
      setRefusal(
        error instanceof ConvexError
          ? String(error.data)
          : 'Couldn’t post the bounty. Check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <BountyView
      lakeName={lakeName}
      bays={bays}
      choice={choice}
      limit={limit ?? null}
      refusal={refusal}
      pending={pending}
      onChoose={(next) => {
        setChoice(next);
        // A refusal was about the part asked for; a different part is a different ask.
        setRefusal(null);
      }}
      onPost={() => void post()}
      onClose={onClose}
    />
  );
}
