# tcpa-quiet-hours

[![npm](https://img.shields.io/npm/v/tcpa-quiet-hours)](https://www.npmjs.com/package/tcpa-quiet-hours)
[![CI](https://github.com/drewthomas00/tcpa-quiet-hours/actions/workflows/ci.yml/badge.svg)](https://github.com/drewthomas00/tcpa-quiet-hours/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](https://www.npmjs.com/package/tcpa-quiet-hours?activeTab=dependencies)
[![node](https://img.shields.io/node/v/tcpa-quiet-hours)](https://www.npmjs.com/package/tcpa-quiet-hours)
[![license](https://img.shields.io/npm/l/tcpa-quiet-hours)](LICENSE)

Is it legal to send this marketing message right now?

The federal rule (TCPA, [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200)) bars telemarketing before 8 AM or after 9 PM **in the called party's local time**. Several states tighten that window; this library encodes seven of them, six of which also ban Sunday contact outright.

It works out which jurisdiction applies from whatever identifying signal you have, and tells you which signal it used.

Pure functions. No network, no database, no runtime dependencies. TypeScript types included.

```sh
npm install tcpa-quiet-hours
```

## Why this is harder than it looks

**"Local time" means theirs, not yours.** An 8:30 PM send from a California sender is fine for a California recipient and illegal for one in Maryland. If you gate on your own server clock, you are not compliant — you are compliant *in one timezone*, by accident.

**The permitted window is not universally 8 AM–9 PM.**

| Jurisdiction | Window | Sundays |
|---|---|---|
| Federal default | 8:00 AM – 9:00 PM | permitted |
| Maryland | 8:00 AM – 8:00 PM | permitted |
| Alabama, Florida, Louisiana, Mississippi | 8:00 AM – 8:00 PM | **banned** |
| Utah | 8:00 AM – 9:00 PM | **banned** |
| South Dakota | 9:00 AM – 9:00 PM | **banned** |

**Area codes travel.** Someone who moved from Chicago to Phoenix keeps their 312 number, and Arizona does not observe DST. A ZIP beats an area code every time, which is why the verdict tells you which one it used.

## Usage

```js
const quietHours = require('tcpa-quiet-hours');

const verdict = quietHours.evaluate({
  phone: '+15551234567',
  zipCode: '21201',                     // optional, but the strongest signal
  fallbackTimezone: 'America/New_York', // used only if nothing else resolves
});

// {
//   eligible: false,
//   reason: 'outside_window',
//   state: 'MD',
//   timezone: 'America/New_York',
//   source: 'zip',
//   ruleApplied: 'MD'
// }
```

Every verdict names the jurisdiction **and how it was resolved**, and every field
is always present, so you can log the whole object structurally. When an audit
six months from now asks "why was 8:30 PM eligible for this recipient?",
`{state: 'MD', source: 'zip', ruleApplied: 'MD'}` answers it without anyone
reconstructing the logic.

`reason` is one of the constants exported as `REASONS` —
`no_timezone_resolved`, `timezone_unparseable`, `invalid_now`,
`state_sunday_blackout`, `outside_window` — or `null` when eligible.

### Deferring instead of dropping

Knowing "not now" only lets you drop a message. To defer one — which is what
somebody who scheduled a 9:30 PM blast actually wants — you need a time to defer
to:

```js
const when = quietHours.nextEligibleAt({ zipCode: '21201' });
// → Date, the next 8:00 AM on the recipient's clock
// → null if nothing qualifies within maxDays (default 8). Treat null as
//   unsendable, NOT as "retry forever".
```

The search jumps by wall-clock minutes and then **re-reads the recipient's clock
and corrects**, because a DST transition in between moves the clock underneath
the arithmetic. Without that correction, a deferral computed across a
spring-forward fires an hour late.

A `maxDays` that is zero, negative or non-finite **throws**. Returning `null`
there would be indistinguishable from "this recipient is never contactable",
which is an expensive thing to debug from a queue that quietly stopped draining.

### Correcting the rules yourself

State telemarketing statutes are amended more often than you would like, and
waiting on a release of this package is not a compliance posture. Build your own
engine:

```js
const { QuietHoursEngine } = require('tcpa-quiet-hours');

const engine = new QuietHoursEngine({
  rules: {
    OK: { startMinutes: 8 * 60, endMinutes: 20 * 60 },   // add a state
    FL: { startMinutes: 8 * 60, endMinutes: 21 * 60,     // or replace one
          excludesSundays: false },
  },
});

engine.evaluate({ zipCode: '73101' });
```

Supplied rules are validated at construction — a string where a number belongs,
or a window that closes before it opens, throws a `TypeError` with the stack
still pointing at your code, rather than degrading into a silently wrong verdict
at send time.

If you hold a verified billing address, stop guessing from phone numbers
entirely:

```js
const engine = new QuietHoursEngine({
  resolver: ({ phone, zipCode }) => ({
    state: 'FL', timezone: 'America/New_York', source: 'billing_address',
  }),
});
```

## Behaviour worth knowing

**It fails closed, everywhere.** No resolvable timezone, an unreadable clock, a
zone `Intl` rejects, a weekday that could not be mapped — every one of them is
`eligible: false`. An unknown recipient location is not permission, and a
Sunday it could not identify is not a Sunday it may ignore.

**An unrecognised option throws.** Every input is optional, so a misspelling
would otherwise be dropped in silence — and `fallbackTimezone` is the one you
are least likely to notice losing, because it is consulted *only* when neither
ZIP nor area code resolves. A typo passes every test that supplies a resolvable
phone number, and then, for the slice of recipients where nothing else
resolves, returns `no_timezone_resolved` on every send. That fails closed, so
nothing unlawful goes out — but it presents as "quiet hours" rather than as the
configuration bug it is, and `nextEligibleAt` quietly degrades from deferring a
message to dropping it. A typo should cost you a stack trace, not a silent
outage:

```js
quietHours.evaluate({ fallbackTimeZone: 'America/Denver' });
// TypeError: QuietHoursEngine.evaluate: unknown option 'fallbackTimeZone'
//   (expected one of: phone, zipCode, fallbackTimezone, now)
```

Each method accepts only what it reads, so `maxDays` on `evaluate` — which has
no search horizon — throws rather than implying one.

**Resolution order is ZIP → area code → your fallback.** A ZIP that names a
place with no usable timezone (military APO/FPO) is a *failed* resolution and
falls through to the phone, rather than discarding a perfectly good number.
So is a partial ZIP: only a full 5- or 9-digit ZIP is trusted, because `'1001'`
read as a prefix answers New York for what was probably 01001, Massachusetts.
(An *integer* 1001 is zero-padded and resolves — a numeric column cannot keep
its leading zero.) With only a fallback timezone, `state` is `null` and the
federal rule applies — a state override cannot be assumed from a guess.

**US territories are covered.** Puerto Rico, the Virgin Islands, Guam, the
Northern Marianas and American Samoa are fully subject to the TCPA and resolve
to real zones.

**Multi-timezone states are handled by ZIP3 override.** A prefix is overridden
only when its *majority* population sits in the non-default zone — so the
Florida Panhandle, El Paso, western Kentucky, the Idaho panhandle and
Chattanooga resolve correctly, while prefixes that merely straddle a line keep
the state default rather than being flipped wholesale.

**Midnight is normalised.** Some ICU builds report hour `24`; unhandled, a
message at 00:15 evaluates as 24:15 and every window comparison inverts.

**The rule tables are deeply frozen.** They are the product; a stray assignment
from anywhere in your dependency graph should not be able to widen a compliance
window process-wide.

**The 9 PM boundary is exclusive.** The statute bars contact "after 9 PM", so
9:00:00 PM sharp is arguably lawful. This blocks it. The cost of being wrong is
asymmetric.

## Known gaps

A ZIP3 prefix cannot express every timezone boundary, and this library would
rather say so than pretend:

- **Arizona's `865` prefix** carries both the Navajo Nation (which observes DST)
  and the Hopi Reservation (which does not), inside a state that otherwise does
  neither. It keeps `America/Phoenix`.
- **Michigan's Upper Peninsula (`498`/`499`)** splits Eastern and Central within
  a single prefix. It keeps the state default.
- **Alaska's Aleutian chain** west of 169°30′W is `America/Adak`, an hour behind
  the rest of the state.

Where a prefix genuinely splits with no majority, the state default is used: no
worse than a coin flip, and at least predictable.

## Not legal advice

These rules change, and state telemarketing statutes are amended more often than
you would like. The seven states encoded here are **not a claim of
completeness** — they are the overrides this library knows about.

Every rule carries a `citation` naming the statute it is drawn from, and a
`lastVerified` field. **`lastVerified` is `null` on every bundled rule**: they
were compiled from secondary sources — state statutes as summarised by industry
compliance trackers — and have not been read against the primary text. Treat the
citations as where to start verifying, not as verification.

Rules live in `STATE_RULES` (exported) and jurisdiction lookups in
`jurisdiction-data.js` (`require('tcpa-quiet-hours/jurisdiction-data')`), both
plain data — a correction is a one-line PR.

This library also covers *only* time-of-day and day-of-week restrictions. It
says nothing about consent, the Do Not Call registry, opt-out handling, identity
disclosure, or the other obligations that make a send lawful. It is one gate of
several.

## Testing

```sh
npm test
```

Node's built-in test runner, no framework. CI runs the suite on Node 18–24 and
again under a non-UTC `TZ`, because a timezone library that only passes on a
UTC machine has not been tested.

## Related packages

Small, dependency-light pieces pulled out of production systems I've built:

- **[twilio-signature-verify](https://github.com/drewthomas00/twilio-signature-verify)** — verify `X-Twilio-Signature`, including behind a reverse proxy
- **[pg-cron-lease](https://github.com/drewthomas00/pg-cron-lease)** — make an in-process cron job a singleton across replicas, using Postgres
- **[us-zip-centroids](https://github.com/drewthomas00/us-zip-centroids)** — offline US ZIP → lat/lng, no geocoder

## License

MIT © [Drew Thomas](https://drewthomasbuilds.com)
