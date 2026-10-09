# tcpa-quiet-hours

[![npm](https://img.shields.io/npm/v/tcpa-quiet-hours)](https://www.npmjs.com/package/tcpa-quiet-hours)
[![CI](https://github.com/drewthomas00/tcpa-quiet-hours/actions/workflows/ci.yml/badge.svg)](https://github.com/drewthomas00/tcpa-quiet-hours/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](https://www.npmjs.com/package/tcpa-quiet-hours?activeTab=dependencies)
[![node](https://img.shields.io/node/v/tcpa-quiet-hours)](https://www.npmjs.com/package/tcpa-quiet-hours)
[![license](https://img.shields.io/npm/l/tcpa-quiet-hours)](LICENSE)

Is it legal to send this marketing message right now?

The federal rule (TCPA, [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200)) bars telemarketing before 8 AM or after 9 PM **in the called party's local time**. Twenty-one states are stricter — an earlier close, a later open, different hours on weekends, no Sundays, no state holidays — and this library encodes all of them, each with the statute it comes from and a link to the text.

It works out which jurisdiction applies from whatever identifying signal you have, and tells you which signal it used.

Pure functions. No network, no database, no runtime dependencies. TypeScript types included.

```sh
npm install tcpa-quiet-hours
```

## Why this is harder than it looks

**"Local time" means theirs, not yours.** An 8:30 PM send from a California sender is fine for a California recipient and illegal for one in Maryland. If you gate on your own server clock, you are not compliant — you are compliant *in one timezone*, by accident.

**The permitted window is not universally 8 AM–9 PM.** In the recipient's local time:

| Jurisdiction | Mon–Fri | Saturday | Sunday | Holidays |
|---|---|---|---|---|
| Federal default | 8 AM – 9 PM | 8 AM – 9 PM | 8 AM – 9 PM | — |
| Florida, Maryland, Massachusetts, Oklahoma, Oregon, Washington, Wyoming | 8 AM – 8 PM | 8 AM – 8 PM | 8 AM – 8 PM | — |
| Connecticut, Nevada | 9 AM – 8 PM | 9 AM – 8 PM | 9 AM – 8 PM | — |
| Michigan, Minnesota, New Mexico | 9 AM – 9 PM | 9 AM – 9 PM | 9 AM – 9 PM | — |
| Kentucky | 10 AM – 9 PM | 10 AM – 9 PM | 10 AM – 9 PM | — |
| Texas | 9 AM – 9 PM | 9 AM – 9 PM | **noon** – 9 PM | — |
| Alabama, Louisiana | 8 AM – 8 PM | 8 AM – 8 PM | **banned** | **banned** |
| Mississippi | 8 AM – 8 PM *Central Standard Time* | same | **banned** | — |
| South Dakota | 9 AM – 9 PM | 9 AM – 9 PM | **banned** | — |
| Utah | 8 AM – 9 PM | 8 AM – 9 PM | **banned** | **banned** |
| Rhode Island | 9 AM – 6 PM | 10 AM – 5 PM | **banned** | **banned** |
| Pennsylvania, until 2026-10-17 | 8 AM – 9 PM | 8 AM – 9 PM | 8 AM – 9 PM | **banned** |
| Pennsylvania, from 2026-10-18 | 9 AM – 7 PM | 9 AM – 7 PM | **banned** | **banned** |

"Holidays" means each state's own list — Louisiana's includes Mardi Gras and Good Friday, Utah's Pioneer Day, Rhode Island's Victory Day — and every calendar is in `HOLIDAY_CALENDARS`, with its statute.

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
//   ruleApplied: 'MD',
//   jurisdictions: [
//     { state: 'MD', timezone: 'America/New_York', source: 'zip',
//       ruleApplied: 'MD', eligible: false, reason: 'outside_window' }
//   ]
// }
```

Every verdict names the jurisdiction **and how it was resolved**, and every field
is always present, so you can log the whole object structurally. When an audit
six months from now asks "why was 8:30 PM eligible for this recipient?",
`{state: 'MD', source: 'zip', ruleApplied: 'MD'}` answers it without anyone
reconstructing the logic.

`reason` is one of the constants exported as `REASONS` —
`no_timezone_resolved`, `timezone_unparseable`, `invalid_now`,
`state_sunday_blackout`, `state_day_blackout`, `state_holiday_blackout`,
`outside_window` — or `null` when eligible.

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
    // Add a state. A day not named takes `default`; `null` closes a day.
    NC: { windows: { default: ['08:00', '20:00'], sun: null } },

    // Replace one, with an amendment that takes effect on a date (the
    // recipient's local date).
    KY: [
      { windows: { default: ['10:00', '21:00'] } },
      { effectiveFrom: '2027-07-01', windows: { default: ['10:00', '20:00'], sun: null } },
    ],
  },
});
```

A rule can name a bundled holiday calendar (`'AL'`, `'LA'`, `'PA'`, `'RI'`,
`'UT'`) or bring its own:

```js
holidays: {
  observe: 'weekend',                       // Sat → also Fri, Sun → also Mon
  holidays: [
    { name: 'Pioneer Day', month: 7, day: 24 },
    { name: 'Memorial Day', month: 5, weekday: 1, nth: -1 },   // last Monday
    { name: 'Good Friday', easter: -2 },
  ],
}
```

Supplied rules are validated at construction — a malformed time, a window that
closes before it opens, a misspelled field, two versions with the same date —
and throw a `TypeError` with the stack still pointing at your code, rather than
degrading into a silently wrong verdict at send time. The 1.x shape
(`startMinutes`, `endMinutes`, `excludesSundays`) is still accepted.

If you hold a verified address, stop guessing from phone numbers entirely:

```js
const engine = new QuietHoursEngine({
  resolver: ({ phone, zipCode }) => ({
    state: 'FL', timezone: 'America/New_York', source: 'billing_address',
  }),
});
```

The resolver's `state` is upper-cased before the rule lookup, so `'fl'` still
gets Florida's rule.

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

**Some states presume residency from the area code.** Florida, Oklahoma,
Maryland and Connecticut each presume that a call to one of their area codes
reaches a resident. So when the ZIP says Georgia and the number is a Miami 305,
the message has to be lawful in Georgia *and* under Florida's rule — and the
verdict says so: `jurisdictions` lists both, and `ruleApplied` names the one
that blocked it. A custom resolver gets no presumption added; a verified address
is exactly the evidence that rebuts one.

**Mississippi's window is on "Central Standard Time".** Read literally, that is
a fixed UTC−6 clock, an hour off Mississippi's own during daylight saving. The
window is checked on both clocks, so a summer send waits until 9 AM CDT.

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

**Multi-timezone states are handled by ZIP3 and area-code override.** A
prefix or area code is overridden only when its *majority* population sits in
the non-default zone — so the Florida Panhandle, El Paso, western Kentucky, the
Idaho panhandle and Chattanooga resolve correctly whether the signal is a ZIP or
a phone number (915 is read on Mountain time, 865 on Eastern), while those that
merely straddle a line keep the state default rather than being flipped
wholesale.

**Midnight is normalised.** Some ICU builds report hour `24`; unhandled, a
message at 00:15 evaluates as 24:15 and every window comparison inverts.

**The rule tables are deeply frozen.** They are the product; a stray assignment
from anywhere in your dependency graph should not be able to widen a compliance
window process-wide.

**Texts versus calls.** Every rule carries `coversText`: `'yes'` where the
statute names text messages (Connecticut, Oregon, Pennsylvania from 2026-10-18,
South Dakota, Utah), `'unclear'` where it speaks only of calls or telephone
solicitation. Every rule applies by default — a court may yet read "call" to
include a text. `new QuietHoursEngine({ onlyRulesCoveringText: true })` applies
only the `'yes'` rules and falls back to federal for the rest; turn it on only on
your counsel's advice.

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

- **Area codes that straddle a line** — 812/930 in southern Indiana, 906 in the
  Upper Peninsula, 308 in Nebraska — keep the state default, which is wrong for
  their minority. Supply a ZIP where you have one.

Where a prefix genuinely splits with no majority, the state default is used: no
worse than a coin flip, and at least predictable.

## How these rules were checked

Each rule's `citation` names the provision it is drawn from and `sourceUrl`
links the text. `lastVerified` is the date the rule was last read against that
**primary source** — the legislature's own statute page, an enacted session law,
or the agency rule — and is `null` where only an older enactment or a secondary
source could be found (Kentucky, Wyoming, New Mexico; each rule's `note` says
which). The holiday calendars were read the same way, against each state's
holiday statute.

That reading was done with AI-assisted research against the linked sources, on
the date recorded. **It has not been reviewed by a lawyer.** Where a statute was
ambiguous, the rule errs towards blocking, and the `note` says so.

Deliberately not encoded:

- **Rules for prerecorded or autodialed voice messages only** — Maine, Illinois,
  California. They do not govern the messages this library gates.
- **Call-frequency caps** — Florida, Maryland, Oklahoma and Oregon limit
  solicitations to three per 24 hours. That needs send history, which a pure
  time-of-day check does not have.
- **Holidays proclaimed case by case** by a governor or the President.

## Not legal advice

These rules change, and state telemarketing statutes are amended more often than
you would like. The table is **not a claim of completeness** — states not listed
were not all read against primary text. Rules live in `STATE_RULES` and
`HOLIDAY_CALENDARS` (exported) and jurisdiction lookups in `jurisdiction-data.js`
(`require('tcpa-quiet-hours/jurisdiction-data')`), all plain data — a
correction is a small PR.

This library also covers *only* time-of-day, day-of-week and holiday
restrictions. It says nothing about consent, the Do Not Call registry, opt-out
handling, identity disclosure, call-frequency caps, or the other obligations that
make a send lawful. It is one gate of several.

## Upgrading from 1.x

- **The bundled table changed.** Florida no longer bans Sundays (its statute
  never did); fourteen states were added; Alabama, Louisiana and Utah now block
  their holidays; Maryland's, Alabama's and Utah's citations were corrected.
  Expect fewer Sunday blocks in Florida and more blocks almost everywhere else.
- **`STATE_RULES[state]` is now an array of versions**, and a rule has
  `windows` (seven days, Sunday first) instead of `startMinutes` /
  `endMinutes` / `excludesSundays`. Rules you *supply* may still use the 1.x
  shape.
- **Verdicts carry `jurisdictions`**, and `ruleApplied` names the deciding rule,
  which may be a presumed jurisdiction's rather than the primary one's.
- New reasons: `state_day_blackout`, `state_holiday_blackout`. New source:
  `area_code_presumption`.
- Area codes in a state's minority timezone resolve to it (915 → Mountain,
  865 → Eastern), and a custom resolver's `state` is upper-cased.

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
