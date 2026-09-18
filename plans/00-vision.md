# Vision

**A map of the ice, kept by the people who were just on it.**

A map-first app for Nordic (wild) ice skating — lakes, ponds, bays, and (eventually) rivers — where
skaters share what the ice was like when they were standing on it, and where everything else you'd
want to know about a body of water before you drive to it is already waiting in the same place.

This is the guiding document: what we're trying to do and why it matters. The mechanics live
elsewhere — the [decisions log](./01-decisions.md) for every choice and its reasoning, the
[roadmap](./07-roadmap.md) for what's being built, and [`docs/`](../docs/) for how the important systems
work.

## The problem

Nordic skating is a niche but passionate sport, concentrated where winters are long — New England,
New York, Québec, Alaska, the Upper Midwest. Its defining fact is that ice conditions are extremely
time- and place-sensitive: ice that was perfect this morning can be ruined by an afternoon of sun,
a night of snow, or a warm rain — and ice that was too thin on Tuesday can be the skate of the year
on Friday.

The community coordinates almost entirely over **email and Facebook groups**. Email is a poor fit for
information that expires in days and only matters to each person within an acceptable driving radius:

- The one report you needed is buried between a gear-for-sale thread and a fifty-reply argument.
- It's easy to miss, hard to search, and impossible to sort by *physical location*.
- Threads about water bodies three states away flood everyone's inbox.
- There's no structure: no map, no distance, no sense of how old a report is or what the weather
  has done to it since — not without a side quest through three other sites.

The people in those groups are careful, experienced, and generous with what they know. The tools
are what's holding the knowledge back.

## The product

**The center of the app is a human report:** a named skater, a specific water body, a specific
time, and what they found — the ice, the thickness they measured, the hazards they saw, a photo, a
note. Everything else exists to make those reports easier to write, easier to find, and easier to
interpret and extrapolate from.

Around each report, the app already knows the lake. How deep it is and which parts are deepest. Which
shore the wind hammers. Where the boat launch is, where you can park, how far the walk in is, and
whether anyone's posted a sign saying you can't. What it looks like from orbit this week, and the week
it froze over. What the weather has done since the last skater was there. Today that research means a
dozen browser tabs across a dozen services; here it's one drawer, one tap, and the report sits on
top of all of it.

Two surfaces, one product: a **mobile app** built for the field — cold hands, low battery, no signal
— and a **web app** for planning at a big screen and writing the longer story of a good day.

## Product principles

1. **Safety-first, never authoritative.** The app helps skaters make *their own* decisions. It
   never says ice is "safe" or "good to go," never predicts, never grades. Every report is one
   named peer's observation at one time and place, and the decision to step onto the ice is always
   the individual's.
   - We *contextualize* aging reports — "three days of sun and rain since this one" — to support
     judgment, not replace it. When something on the map fades, it's our **confidence** fading, never
     a claim that a hazard has gone.
   - A report that says **"don't"** is as valuable as one that says "go."
   - A dangerously false "the ice is great!" is a safety issue, not just spam. Anyone can flag bad
     reporting, and a human moderator can take it down fast.
2. **Fast and low-friction in the cold.** Reporting and confirming a hazard must be near-instant:
   minimum taps, minimum battery, and it works with no signal — write it on the ice, it syncs from
   the car.
3. **Respect the community and its safety culture.** Don't lecture experts. The reference material
   already exists — the **Nordic Skater** sites (<https://nordicskaters.squarespace.com/> and
   <http://lakeice.squarespace.com/>) whose vocabulary this app adopts — so we link out to the expert
   guidance and get people straight to reading and writing reports. Recruit and bridge; not replace.
4. **Privacy by default where it matters.** Your home is private — it's a filter, never shown. Reports
   are public, because a report is a gift to the next skater and the app is a commons, not a private
   log. Your profile is as public as you want it. Your data is yours to export and yours to take
   with you.

## What you can do

### Say how the ice was

- **Report** — live or just-finished: ice type, thickness readings, conditions, hazards, photos, the
  put-in you used, and when you skated.
- **Mark a hazard** where it actually is — a point, a line, a shaded area inside the water body — and
  the next skaters confirm if it's still there or say it's gone. Some hazards return to the same
  place every winter; the app remembers, so a pressure ridge that forms off the same point every
  year can present a warning on the map before anyone hits it.
- **Talk** — threaded comments on a report. Ask what the north end was like. Say thanks.
- **Ask** — post a bounty on a water body nobody's reported on lately; skaters who've been there
  recently or live nearby get the nudge.
- **Be trusted** — reputation earned from corroboration and helpfulness. Encourages participation and
  accuracy, but is not a badge of honor, never a leaderboard, never a number you're chasing.

### Do all your research in one place

Tap any water body and it's already there, with its source credited:

- **Depth** and **contours** — how deep, where the shallows are, the org that surveyed it, and whether
  a number is measured or estimated. Deep water freezes late; the app tells you which parts are deep.
- **Wind** — which direction winter wind actually comes from on *this* lake, and which shore takes
  it, from years of climatology rather than a guess from the lake's shape.
- **Access** — the launches, the lots, the walk in with its distance and climb, and the posted rules
  where there are any. A body you can't legally reach says so.
- **From orbit** — a season of satellite passes of this water body, clipped to its shape, cloudy
  passes left out, to scrub through and watch the ice form and change.
- **Weather** — what it has done since the last report, hour by hour, and a seven-day planner for
  when to go. Turn it around and search by weather: *three nights below 20°F and no snow, within an
  hour of home* — and find ice nobody's written about yet.
- **Places within places** — the bay is its own destination, with its own launches, its own depth,
  its own reports, whether it's on the ocean, a Great Lake, or just a lake with different parts.

### On the ice

- **Record your skate** in the app. Stop, and it offers to file the report with the real path
  attached — a path is evidence, and evidence on unmapped water can put a new pond on the map.
- **On-ice mode**, opt-in: as you skate toward a reported hazard, your phone tells you before you
  reach it.
- **Push your track** to Strava, Garmin, and the rest, so recording here costs you nothing you
  already had.
- **Or bring your own.** Already record with a watch or another app? Import the GPX and file the
  report from it — keep recording the way you prefer, and the skate still lands on the map.

### Hear about what matters

Notifications are about *your* water, on *your* terms: the lake you love got its first report of the
season; the bounty you posted got answered; someone confirmed the hazard you marked; the weather
turned on the pond you skated last weekend; the ice arrived. One evening digest if that's how you
like it, silence if it's not.

## Two lenses

The app has two front pages, and they're two views of the same reports. **Explore** is spatial: the
map, centered on home — or on wherever you're headed — water in focus, everything else for
reference. **Latest** is chronological: what's fresh, sorted by skate time, tuned to how far you're
willing to drive. Reporting and bounties
hang off both.

## Who it's for, and where

**First: about twenty friends.** The founder's own skating circle, on real ice, to kick off the 2026-27
season, until we prove the app is something worth sharing.

**Then: New England and New York**, where the community and its email groups already are, and where
the app already knows roughly 25,000 water bodies. The 2026-27 season is that region. **Southern Québec**
is the obvious next step — the same skaters cross the border for a day — and comes as soon as there's a
real signal. **Alaska**, and potentially the Upper Midwest, are prepped for 2027-28.

Reports are seeded and kept fresh by the people who skate: native reporting, the in-app recorder, and
— aspirationally — a bridge to the existing email and Facebook groups that runs both ways, so the
knowledge already flowing reaches everyone, and a report written here can still reach the skaters
who haven't switched.

## Look and feel

The look this app is heading toward is **FUI** — "fantasy UI," the interfaces of sci-fi and spy films:
reserved, precise, technical; a map that reads like an instrument. Techy without being cold to use, and
never at the expense of legibility. What's built today points in that direction; the design work ahead
of it is much bigger than what's behind it, and the bar is high.

Two first-class themes, because they're safety features: a **bright, high-contrast outdoor mode**
you can read in glare on sunny ice, and a **dark mode** for planning on the sofa. WCAG AA contrast,
dynamic type, and screen-reader labels are the floor, not polish.

## What this app is not

Some of the sharpest decisions were about what to leave out. Recording them here so the pitch stays
honest:

- **Not a prediction.** No AI ice forecast, no "safe" badge, no ice classification from a photo.
  Machines summarize and curate what humans and instruments observed; they never grade the ice or make
  safety decisions for you.
- **Not a social network.** No follows, no friends, no feed of people. A report is a report
  regardless of who wrote it; private coordination belongs off-platform.
- **Not a Strava scraper.** Tracks are recorded here or imported by you, owned by you, and *pushed*
  out. Nothing is pulled from a fitness platform behind your back; a path reaches the map only because
  you attached it to a report.
- **Not anonymous by design.** Every report has a name on it. That's the trust model; the app
  protects your home, not your authorship.
- **Not a safety guide.** The guides exist and are excellent; we link to them.
- **Not a place to organize a group skate.** Maybe one day. Not yet.
- **Not a business.** A passion project, open source, on free tiers for as long as that holds. Skaters
  who want to can chip in toward running costs (how is still open — Q14).

Everything above is in service of one thing: the next skater knowing what the last one knew.
