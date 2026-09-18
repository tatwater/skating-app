# The outbound bridge — posting a skater's report to their email group

> **Backlog — founder ask, 2026-09-17.** The outbound half of the community bridge; the inbound half
> (their posts → our reports) is the gated one, Q8 / L5. This one is the skater's own words, sent
> with their consent, under their name, to a list they belong to — so it waits on design, not on a
> lawyer. Context: `04-integrations.md` § Forum / Facebook bridging, `02-open-questions.md` § Q8.

## What it needs

Mechanical, not clever:

- **An opt-in per group.** The skater picks which of the region's lists their reports go to; nothing
  posts by default, and a report can be held back one at a time.
- **A mail rendered from the report** — `packages/email`, the same templates as everything else, with
  the water body link and *"posted from Gli"* as the footer rather than a banner.
- **A sender the group accepts.** Google Groups and most lists reject mail from non-members: either a
  Gli address subscribed to each group (one subscription per list, moderated like any member) or the
  skater's own address via a reply-to arrangement, so replies on the list reach the skater, not us.
- **The group's own posting rules honored** — subject conventions, no attachments where the list
  strips them, photo links rather than inline images, and whatever each list's moderators ask for.

## Open

Which lists exist per region and their posting rules (the L5a corpus knows the Google Group; the
Facebook groups have no email path at all, so "bridge" there means a link, not a post); whether a
report edited after posting sends a correction; and how replies on the list — which are comments, in
our model — come back, which is the inbound half's problem again.
