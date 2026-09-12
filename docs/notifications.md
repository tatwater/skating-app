# How notifications work

*The design rationale behind the inbox, the settle window, and the two transports. The decisions this
explains are D164–D171 in [`plans/01-decisions.md`](../plans/01-decisions.md); the build record is
[`plans/phase-N8-notification-pipeline.md`](../plans/phase-N8-notification-pipeline.md).*

## The inbox is the product; push and email are ways of pointing at it

Every notification Gli sends is first a row in your inbox — the bell on the web, the bell on the You
tab on your phone. A push is a pointer to that row. An email is a pointer to that row. If you turn
both off, the row is still there; if a push is lost in the network, the row is still there.

That ordering is deliberate, and it took a phase to arrive at. For a long time the app wrote
notifications and nothing read them: six kinds of notification — someone found your report helpful, a
bounty opened on a lake you'd reported, a lake you'd favorited got new ice — were being generated with
"push delivery deferred, lands an in-app row" written next to each, and the in-app row was landfill,
because no screen showed it. The fix was not to build push. It was to build the reader, and then make
push and email two more readers.

## What you get told about

Ten kinds, each with its own switch, all on by default except the two that need a home location:

- **On your own contributions** — a comment on your report or a reply to your comment; someone
  finding your report or hazard helpful, or a later report agreeing with yours; your hazard pin being
  confirmed, disputed, or marked healed by other skaters; a moderator ruling on something you
  flagged.
- **On what you asked for** — a report arriving on a bounty you posted; a bounty opening on a lake
  you recently reported.
- **On the ice near you** — a new report on a lake you've favorited; a daily digest of every report
  within your drive-time radius; a "great ice" report within a wider radius.
- **On what you recorded** — a skate the app captured that you never turned into a report.

What you are *not* told about by notification: a new hazard on a lake you are not standing on. That
one is a presence signal, and it fires on the ice, on your phone, with no server involved — see
[on-ice alerts](./on-ice-alerts.md). Putting safety content on the least reliable transport we have,
for a skater who by definition isn't there, was the thing not to do.

## Notifications settle before they send

A misclick is a normal thing to do. Thumb the wrong report, notice, tap again to undo. Before this
phase, the first tap sent the author a notification instantly and the second tap could not recall it:
someone was told their report had been found helpful by a person who no longer thought so.

So every notification a person's action triggers sits in a queue for sixty seconds, and at the end of
the minute the app asks **"is this still true?"** before delivering. Is the thumb still there, and
still a thumbs-up? Is the comment still visible? Is the hazard still in the state that triggered
this? Is the bounty still open? If not, the notification is dropped — not retried, because the thing
that would make it true again is a new action, and that new action queues its own notification.

The same minute does something else useful: five thumbs inside it become one "5 people found this
helpful", and a thumb retracted inside it drops out of the count rather than cancelling the whole
thing. Helpful → unhelpful → helpful, all inside one window, is exactly one notification.

Why sixty seconds rather than "a few"? The queue drains once a minute, so anything shorter would be
indistinguishable. And why re-check at send rather than cancel at undo? Because cancelling means every
undo path in the app — retract a thumb, delete a comment, hide a report, flip a verdict — would need to
know the queue exists and find the right row, and the one nobody thought of would ship a phantom.
Re-checking is one place, and it covers content that vanished for reasons that were never an "undo".

## What "still true" also covers

Two things are re-read at the moment of sending that most systems only check at the moment of
queueing. Whether you still *want* this kind of notification — you may have switched it off during
the minute. And whether you have since blocked the person — a block on Gli is a mute (their reports
stay on the map, because a report is a safety observation), and a mute has to reach your phone.

The inbox applies the block again when it renders, so an old row from someone you blocked last week
is filtered too. And a notification whose target has since been removed by a moderator is **shown,
described, and not tappable** — "someone found a report that's no longer available helpful" — because
a row that silently vanished would read as a bug, and a tap that lands on "not found" would read as
one too.

## The inbox empties every July

Every notification is about a moment: someone thumbed your report, three lakes near you had new ice.
None of that survives a summer, and an inbox in July holding February's ice reports would be landfill
with a badge on it. So the inbox is purged at the season boundary (July 1, the same clock the rest of
the app turns on), read or not — an unread notification about last season's ice is worth less than a
read one, not more. The inbox is not an archive. The record of what happened to your contributions is
the data export, which reads the live tables.

## The daily digest is 8pm, local

The "all reports within my radius" digest lands at 8pm in your phone's timezone. The hour is not a
setting (8pm is the whole feature) and it is not sunset. Sunset in Vermont is around 16:20 in early
January and 20:30 in late June; a digest that tracked it would arrive mid-workday at exactly the point
in the season when skating happens, and late at night when it doesn't. The zone is your device's, not
one derived from your home, because "when will this person look at their phone" is a question about
where they are.

## Two switches for the two transports

Beyond the ten per-kind switches there are two more: **push to my phone** and **email me the ones
worth an email**. They are not a grid. The per-kind switches decide what reaches you; these decide how
far it reaches.

Email is deliberately for a fixed short list: the daily digest, an unreported skate, a bounty asked or
answered, a moderator's ruling. Never a thumb, a comment, a favorited lake's new report or a "great
ice" alert — those are frequent and hours-old by the time anyone opens mail, and an email about each
would be spam you had configured yourself. Every email has a one-click unsubscribe, and the link can
do exactly one thing: turn the email switch off.

Push has one more switch, on the phone itself: **this phone**. That is the only place the app ever
asks for notification permission — never on first launch, where a permission prompt is exactly the
friction that gets it denied. Turning "this phone" off is remembered on the phone; turning "push to my
phone" off silences every phone you're signed in on.

## Offline

Nothing arrives while you're offline; a push is a push. What the phone keeps is the last page of the
inbox and the unread count, so on the ice with no signal the list still reads back, and opening it
there marks the rows read locally — the marks are sent when you're back in range. A tap on a cached
row opens the lake like normal, and the lake screen does what it can from its own cache. The offline
case that matters for safety, the hazard alert while you skate, was already built to work without a
server, and none of this touches it.
