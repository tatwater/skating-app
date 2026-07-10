# License exceptions

This project is licensed under the **GNU Affero General Public License, version 3**
(see [`LICENSE`](./LICENSE)). The copyright holder grants the **additional permission**
below under **section 7 of the GNU GPL version 3** (as incorporated into the AGPL-3.0).

> **Not legal advice.** This text is a conventional template for resolving the
> well-known conflict between (A)GPL and mobile app store terms. It has **not** yet been
> reviewed by a lawyer; that review is tracked as **Q10** in
> [`plans/02-open-questions.md`](./plans/02-open-questions.md) and will happen before any
> public/store launch. If you rely on this exception, review it with your own counsel.

---

## Why this exception exists

The AGPL forbids imposing "further restrictions" on recipients (see AGPL-3.0 §7 and
GPL-3.0 §10). The terms of the **Apple App Store** and **Google Play** impose usage
restrictions (device limits, DRM, and other Usage Rules) that are incompatible with that
requirement. Without an explicit exception, distributing this software through those
stores would violate the license — the same conflict that led to GPL apps such as VLC
and GNU Go being removed from the App Store.

Because the project's sole copyright holder wants both (a) the AGPL's copyleft, which
keeps the *service* open, and (b) the ability to ship the mobile apps through Apple's
App Store and Google Play, the copyright holder grants the following additional
permission.

## App Store Distribution Exception (GPL-3.0 §7 additional permission)

> As an additional permission under section 7 of the GNU General Public License version
> 3 (as incorporated by reference into the GNU Affero General Public License version 3),
> the copyright holder grants you permission to convey the Program, or a work based on
> the Program, through the **Apple App Store**, **Apple TestFlight**, the **Google Play
> Store**, or any comparable application distribution platform ("App Store"), and to
> allow recipients who obtain the Program through such an App Store to use it under that
> App Store's usage terms, **notwithstanding** the provisions of the license that would
> otherwise prohibit conveying the Program subject to such further restrictions (in
> particular AGPL-3.0 §7 and GPL-3.0 §10).
>
> This additional permission applies **only** to the terms imposed by the App Store as a
> condition of distribution and use through that App Store. It does **not** grant any
> other permission and does **not** otherwise limit your rights or obligations under the
> license: the corresponding source code must still be made available in accordance with
> the AGPL-3.0, and all other terms of the license continue to apply.
>
> If you modify a copy of the Program, you may extend this additional permission to your
> version, but you are not obligated to do so. You may remove this additional permission
> from your copy, or from any part of it, in accordance with GPL-3.0 §7.

---

## What this does *not* change

- The source code remains **AGPL-3.0**. The exception only relaxes the "no further
  restrictions" rule *for the act of App Store distribution and end-user use via a
  store*.
- The AGPL **network-use / source-availability** obligations still apply — anyone
  running a modified version as a network service must still offer its source.
- Contributions to this repository are accepted under the AGPL-3.0 **plus** this
  exception (see [`CONTRIBUTING.md`](./CONTRIBUTING.md)).

## Alternatives considered

- **Dual-licensing** the store binary under a separate proprietary license: workable
  (the sole copyright holder can do it) but heavier to maintain, for no added benefit at
  this project's scale.
- **A different license** (e.g. MPL-2.0 or Apache-2.0): avoids the store conflict
  entirely but gives up the AGPL's SaaS-copyleft, which is the point of choosing AGPL for
  a hosted service. Rejected — see [D43](./plans/01-decisions.md).
