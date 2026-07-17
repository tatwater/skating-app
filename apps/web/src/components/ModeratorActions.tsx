import { api } from '@skating/convex/api'
import { useMutation, useQuery } from 'convex/react'
import { ShieldIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

/** Whether the current user is at least a moderator (D37) — gates the inline actions below. */
export function useIsModerator(): boolean {
  const profile = useQuery(api.profiles.current, {})
  return profile?.role === 'moderator' || profile?.role === 'admin'
}

/**
 * Role-gated inline moderator takedown (D32/D37) — hide or remove a **visible** report/comment, each
 * requiring a reason (written to the `moderationActions` audit log). This is the minimal founder
 * takedown path; the full queue + restore-of-hidden-content lives in the Phase 7 `/admin` surface.
 * Renders nothing for non-moderators, so callers can drop it in unconditionally.
 */
export function ModeratorActions({
  targetType,
  targetId,
}: {
  targetType: 'report' | 'comment'
  targetId: string
}) {
  const isModerator = useIsModerator()
  const setStatus = useMutation(api.moderation.setModerationStatus)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!isModerator) return null

  const act = async (status: 'hidden' | 'removed') => {
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    setError(null)
    try {
      await setStatus({ targetType, targetId, status, reason: reason.trim() })
    } catch {
      setError('Could not apply the action. Please try again.')
    }
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <ShieldIcon className="size-4" />
        Moderate
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Moderate this {targetType}</DialogTitle>
          <DialogDescription>
            Hiding or removing writes an audit record. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mod-reason">Reason</Label>
          <Textarea
            id="mod-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being taken down?"
          />
        </div>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="secondary" onClick={() => act('hidden')} disabled={!reason.trim()}>
            Hide
          </Button>
          <Button variant="destructive" onClick={() => act('removed')} disabled={!reason.trim()}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
