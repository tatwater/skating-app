import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import { useMutation } from 'convex/react'
import { FlagIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from './ui/badge'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'

/** Flag targets + reasons mirror the backend enums (`FLAG_TARGET_TYPES` / `FLAG_REASONS`). */
export type FlagTargetType = 'report' | 'comment' | 'photo' | 'user'

/** `unsafe_false_report` leads — a dangerously false "ice is great" claim is a safety issue (D3). */
const REASONS: { value: string; label: string }[] = [
  { value: 'unsafe_false_report', label: 'Dangerously false ice report (safety)' },
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'inappropriate', label: 'Inappropriate' },
  { value: 'other', label: 'Other' },
]

/**
 * "De-emphasized + Blocked chip" author line (D3): a blocked author's *report* stays visible (safety),
 * but their name is muted and carries a chip so the viewer sees the block is working.
 */
export function BlockedChip() {
  return (
    <Badge variant="outline" className="text-foreground-muted">
      Blocked
    </Badge>
  )
}

/**
 * Flag a report / comment / photo / user for abuse (D32). A reason picker (incl. the first-class
 * `unsafe_false_report`, D3) + an optional note, submitted to `contentFlags.flag` (deduped
 * server-side to one open flag per target). Shows a confirmed state after submit.
 */
export function FlagDialog({
  targetType,
  targetId,
  label = 'Flag',
}: {
  targetType: FlagTargetType
  targetId: string
  label?: string
}) {
  const flag = useMutation(api.contentFlags.flag)
  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!reason) return
    setError(null)
    try {
      await flag({
        targetType,
        targetId,
        reason: reason as 'unsafe_false_report',
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setSubmitted(true)
    } catch {
      setError('Could not submit the flag. Please try again.')
    }
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <FlagIcon className="size-4" />
        {label}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag this {targetType}</DialogTitle>
          <DialogDescription>
            Reports of dangerously false ice conditions are treated as a safety issue.
          </DialogDescription>
        </DialogHeader>
        {submitted ? (
          <p className="text-foreground text-sm">Thanks — a moderator will review this.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flag-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v ?? '')}>
                <SelectTrigger id="flag-reason">
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flag-note">Note (optional)</Label>
              <Textarea
                id="flag-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add any context that helps a moderator."
              />
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          {submitted ? (
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button onClick={submit} disabled={!reason}>
                Submit flag
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Block a user (D32) — hides their profile + comments from you (both ways) but never their reports
 * (D3). A confirm dialog explains that, since a block is bidirectional and hides the person. On
 * success the caller's profile query re-runs and the blocked profile becomes not-found (unblock lives
 * in Settings → Blocked users).
 */
export function BlockButton({
  targetUserId,
  displayName,
}: {
  targetUserId: string
  displayName: string
}) {
  const block = useMutation(api.blocks.block)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Controlled dialog: only close on success. Wrapping the confirm in `DialogClose` closed the
  // dialog synchronously — before the mutation resolved — so a failure's `setError` painted a
  // hidden/unmounted dialog and the user saw the block silently "succeed". Now a throw keeps the
  // dialog open with the error, and blocking a harasser can't fail invisibly.
  const confirm = async () => {
    setError(null)
    setPending(true)
    try {
      await block({ targetUserId: targetUserId as Id<'profiles'> })
      setOpen(false)
    } catch {
      setError('Could not block. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Block</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block {displayName}?</DialogTitle>
          <DialogDescription>
            You won’t see each other’s profiles or comments. Their ice reports stay on the map — a
            block never removes safety information. You can undo this in Settings.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            Block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
