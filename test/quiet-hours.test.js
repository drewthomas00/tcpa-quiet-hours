/**
 * Pins the per-state rule matrix, the jurisdiction-resolution priority
 * (ZIP -> area code -> caller-supplied fallback), the Sunday blackout in the
 * states that ban it, the deferral search across DST transitions, and the
 * structured shape of every verdict.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const quietHours = require('..');
const { QuietHoursEngine, SOURCES, REASONS, STATE_RULES } = quietHours;
const jurisdiction = require('../jurisdiction-data');

/** A Date at HH:MM UTC, so tests can drive the engine to known local times. */
function utcDate(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

/** Render an instant on a zone's wall clock, for readable assertions. */
function localTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

// 2026-06-24 is a Wednesday; 2026-06-21 a Sunday; 2026-06-22 a Monday.
const WED = utcDate.bind(null, 2026, 6, 24);
const SUN_10AM_ET = utcDate(2026, 6, 21, 14, 0);
const NOON_ET = WED(16, 0);


// ── extractAreaCode / parseZip3 ──────────────────────────────────

describe('extractAreaCode', () => {
  it('parses E.164 US numbers', () => {
    assert.equal(quietHours.extractAreaCode('+15551234567'), 555);
    assert.equal(quietHours.extractAreaCode('+12121234567'), 212);
  });

  it('parses 10-digit local format and punctuated input', () => {
    assert.equal(quietHours.extractAreaCode('5551234567'), 555);
    assert.equal(quietHours.extractAreaCode('+1 (212) 123-4567'), 212);
  });

  it('returns null for non-NANP numbers', () => {
    assert.equal(quietHours.extractAreaCode('+442012345678'), null);
    assert.equal(quietHours.extractAreaCode('+8612345678901'), null);
  });

  it('returns null for malformed input', () => {
    assert.equal(quietHours.extractAreaCode(''), null);
    assert.equal(quietHours.extractAreaCode(null), null);
    assert.equal(quietHours.extractAreaCode('abc'), null);
  });

  it('rejects area codes that are not legal NPAs', () => {
    // An NPA is N-X-X — the leading digit is 2-9. Returning 0 here used to be
    // skipped downstream only because 0 happens to be falsy.
    assert.equal(quietHours.extractAreaCode('0001234567'), null);
    assert.equal(quietHours.extractAreaCode('1111234567'), null);
  });
});

describe('parseZip3', () => {
  it('takes the first three digits of a ZIP or ZIP+4', () => {
    assert.equal(quietHours.parseZip3('30305'), 303);
    assert.equal(quietHours.parseZip3('30305-1234'), 303);
  });

  it('preserves leading zeros as a numeric prefix', () => {
    assert.equal(quietHours.parseZip3('01001'), 10);
    assert.equal(quietHours.parseZip3('00901'), 9);
  });

  it('returns null when there are fewer than three digits', () => {
    assert.equal(quietHours.parseZip3('12'), null);
    assert.equal(quietHours.parseZip3(''), null);
    assert.equal(quietHours.parseZip3(null), null);
  });

  it('zero-pads an integer ZIP, which cannot carry its own leading zero', () => {
    // A numeric column stored 01001 (Agawam, MA) as 1001. Reading it as
    // prefix 100 answers New York — the wrong state AND a plausible-looking
    // one, which is the worst kind of wrong.
    assert.equal(quietHours.parseZip3(1001), 10);
    assert.equal(quietHours.parseZip3(30305), 303);
    assert.equal(quietHours.parseZip3(100000), null);
    assert.equal(quietHours.parseZip3(-1), null);
    assert.equal(quietHours.parseZip3(303.05), null);
  });

  it('rejects partial strings rather than guessing a prefix from them', () => {
    assert.equal(quietHours.parseZip3('1001'), null, 'a 4-digit string is a typo, not a ZIP');
    assert.equal(quietHours.parseZip3('303'), null);
    assert.equal(quietHours.parseZip3('K1A 0B1'), null,
      'a Canadian postal code has exactly three digits and must not resolve to a US state');
    assert.equal(quietHours.parseZip3('30305-12'), null);
  });
});


// ── jurisdiction resolution priority ─────────────────────────────

describe('evaluate — jurisdiction resolution priority', () => {
  it('prefers ZIP over area code when both are provided', () => {
    // Phone area code 212 -> NY (Eastern). ZIP 33101 (Miami) -> FL, which has
    // a state override and a Sunday blackout. The ZIP must win.
    const out = quietHours.evaluate({ phone: '+12121234567', zipCode: '33101', now: NOON_ET });
    assert.equal(out.state, 'FL');
    assert.equal(out.source, SOURCES.ZIP);
    assert.equal(out.ruleApplied, 'FL');
  });

  it('uses the area code when no ZIP is supplied', () => {
    const out = quietHours.evaluate({ phone: '+12121234567', now: NOON_ET });
    assert.equal(out.state, 'NY');
    assert.equal(out.source, SOURCES.AREA_CODE);
    assert.equal(out.ruleApplied, 'federal');
  });

  it('reports unresolved when the area code is unassigned and nothing else is given', () => {
    // 555 is not an assigned NANP geographic code, so there is nothing to
    // resolve and no fallback to land on.
    const out = quietHours.evaluate({ phone: '+15551234567', now: NOON_ET });
    assert.equal(out.state, null);
    assert.equal(out.source, SOURCES.UNRESOLVED);
    assert.equal(out.eligible, false);
  });

  it('falls back to the caller-supplied timezone, under the federal rule', () => {
    const out = quietHours.evaluate({ fallbackTimezone: 'America/Los_Angeles', now: NOON_ET });
    assert.equal(out.source, SOURCES.FALLBACK);
    assert.equal(out.timezone, 'America/Los_Angeles');
    assert.equal(out.state, null, 'a state override cannot be assumed from a guess');
    assert.equal(out.ruleApplied, 'federal');
  });

  it('returns unresolved + ineligible when no signal is available', () => {
    const out = quietHours.evaluate({ now: NOON_ET });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.NO_TIMEZONE);
    assert.equal(out.source, SOURCES.UNRESOLVED);
  });

  it('emits the same key set on every path, so verdicts log structurally', () => {
    const keys = (v) => Object.keys(v).sort().join(',');
    const expected = 'eligible,reason,ruleApplied,source,state,timezone';
    assert.equal(keys(quietHours.evaluate({ zipCode: '33101', now: NOON_ET })), expected);
    assert.equal(keys(quietHours.evaluate({ now: NOON_ET })), expected);
    assert.equal(keys(quietHours.evaluate({ fallbackTimezone: 'Not/Real', now: NOON_ET })), expected);
  });
});


// ── federal rule (8 AM – 9 PM, Sundays allowed) ──────────────────

describe('evaluate — federal default rule', () => {
  it('passes at 8:00 AM local (start inclusive)', () => {
    assert.equal(quietHours.evaluate({ phone: '+12121234567', now: WED(12, 0) }).eligible, true);
  });

  it('skips at 7:59 AM local', () => {
    const out = quietHours.evaluate({ phone: '+12121234567', now: WED(11, 59) });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.OUTSIDE_WINDOW);
  });

  it('passes at 8:59 PM local (still inside)', () => {
    assert.equal(quietHours.evaluate({ phone: '+12121234567', now: WED(0, 59) }).eligible, true);
  });

  it('skips at 9:00 PM local (end exclusive)', () => {
    assert.equal(quietHours.evaluate({ phone: '+12121234567', now: WED(1, 0) }).eligible, false);
  });

  it('allows Sunday under the federal rule', () => {
    assert.equal(quietHours.evaluate({ phone: '+12121234567', now: SUN_10AM_ET }).eligible, true);
  });
});


// ── state-specific overrides ─────────────────────────────────────

describe('evaluate — state overrides', () => {
  it('MD: 8 AM – 8 PM, Sundays allowed', () => {
    const before = quietHours.evaluate({ zipCode: '21201', now: WED(23, 59) }); // 19:59 EDT
    assert.equal(before.eligible, true);
    assert.equal(before.ruleApplied, 'MD');

    const after = quietHours.evaluate({ zipCode: '21201', now: utcDate(2026, 6, 25, 0, 0) }); // 20:00 EDT
    assert.equal(after.eligible, false, 'federal would still allow 20:00; MD does not');
    assert.equal(after.ruleApplied, 'MD');
  });

  it('FL: blocks Sundays entirely', () => {
    const out = quietHours.evaluate({ zipCode: '33101', now: SUN_10AM_ET });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.SUNDAY_BLACKOUT);
    assert.equal(out.ruleApplied, 'FL');
  });

  it('AL: blocks Sundays and closes at 8 PM', () => {
    const sunday = quietHours.evaluate({ zipCode: '35201', now: SUN_10AM_ET });
    assert.equal(sunday.reason, REASONS.SUNDAY_BLACKOUT);
    assert.equal(sunday.ruleApplied, 'AL');

    // Wed 20:30 CDT = Thu 01:30 UTC — inside federal, past Alabama's close.
    const evening = quietHours.evaluate({ zipCode: '35201', now: utcDate(2026, 6, 25, 1, 30) });
    assert.equal(evening.eligible, false);
    assert.equal(evening.reason, REASONS.OUTSIDE_WINDOW);
  });

  it('SD: opens at 9 AM, an hour later than federal', () => {
    const early = quietHours.evaluate({ zipCode: '57104', now: WED(13, 0) }); // 08:00 CDT
    assert.equal(early.eligible, false);
    assert.equal(early.ruleApplied, 'SD');

    const onTime = quietHours.evaluate({ zipCode: '57104', now: WED(14, 0) }); // 09:00 CDT
    assert.equal(onTime.eligible, true);
  });

  it('UT: federal hours, but no Sundays', () => {
    const wednesday = quietHours.evaluate({ zipCode: '84101', now: WED(20, 0) }); // 14:00 MDT
    assert.equal(wednesday.eligible, true);
    assert.equal(wednesday.ruleApplied, 'UT');

    const sunday = quietHours.evaluate({ zipCode: '84101', now: utcDate(2026, 6, 21, 20, 0) });
    assert.equal(sunday.eligible, false);
    assert.equal(sunday.reason, REASONS.SUNDAY_BLACKOUT);
  });

  it('applies the blackout on the RECIPIENT\'s Sunday, not the sender\'s', () => {
    // Sat 2026-06-20 23:30 Pacific is already Sun 02:30 Eastern.
    const instant = utcDate(2026, 6, 21, 6, 30);
    assert.equal(localTime(instant, 'America/Los_Angeles').startsWith('Sat'), true);

    const florida = quietHours.evaluate({ zipCode: '33101', now: instant });
    assert.equal(florida.reason, REASONS.SUNDAY_BLACKOUT,
      'it is Sunday in Miami even though it is Saturday on the west coast');
  });
});


// ── DST ──────────────────────────────────────────────────────────

describe('DST', () => {
  it('Arizona does not shift, while a Mountain-DST state does', () => {
    // 03:30 UTC. Phoenix is UTC-7 all year: 20:30 local in both seasons.
    const summer = utcDate(2026, 6, 25, 3, 30);
    const winter = utcDate(2026, 12, 25, 3, 30);

    assert.equal(quietHours.evaluate({ phone: '+16025551234', now: summer }).eligible, true);
    assert.equal(quietHours.evaluate({ phone: '+16025551234', now: winter }).eligible, true);

    // Denver is UTC-6 in summer, so the same instant is 21:30 there — blocked.
    assert.equal(quietHours.evaluate({ phone: '+13035551234', now: summer }).eligible, false);
    assert.equal(quietHours.evaluate({ phone: '+13035551234', now: winter }).eligible, true);
  });

  it('nextEligibleAt lands on 8:00 AM across a spring-forward', () => {
    // 2026-03-08 02:00 EST becomes 03:00 EDT. Adding elapsed hours from
    // 01:00 EST overshoots to 09:00 unless the drift is taken back out.
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now: utcDate(2026, 3, 8, 6, 0) });
    assert.equal(at.toISOString(), '2026-03-08T12:00:00.000Z');
    assert.match(localTime(at, 'America/New_York'), /08:00/);
  });

  it('nextEligibleAt lands on 8:00 AM across a fall-back', () => {
    // 2026-11-01 02:00 EDT becomes 01:00 EST — an hour is repeated.
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now: utcDate(2026, 11, 1, 5, 0) });
    assert.equal(at.toISOString(), '2026-11-01T13:00:00.000Z');
    assert.match(localTime(at, 'America/New_York'), /08:00/);
  });
});


// ── nextEligibleAt ───────────────────────────────────────────────

describe('nextEligibleAt', () => {
  it('returns the current instant when already eligible', () => {
    const now = NOON_ET;
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now });
    assert.equal(at.getTime(), now.getTime());
    assert.notEqual(at, now, 'must be a copy — the caller still owns their Date');
  });

  it('waits for this morning\'s open when called before it', () => {
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now: WED(6, 0) }); // 02:00 EDT
    assert.match(localTime(at, 'America/New_York'), /Wed, Jun 24, 08:00/);
  });

  it('rolls to tomorrow\'s open when called after the close', () => {
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now: utcDate(2026, 6, 25, 2, 0) }); // Wed 22:00 EDT
    assert.match(localTime(at, 'America/New_York'), /Thu, Jun 25, 08:00/);
  });

  it('honours a state\'s later opening time', () => {
    const at = quietHours.nextEligibleAt({ zipCode: '57104', now: WED(13, 0) }); // 08:00 CDT
    assert.match(localTime(at, 'America/Chicago'), /Wed, Jun 24, 09:00/, 'SD opens at 9 AM');
  });

  it('skips an entire blacked-out Sunday', () => {
    // Alabama, Saturday 21:00 CDT — past the close, and Sunday is banned.
    const at = quietHours.nextEligibleAt({ zipCode: '35201', now: utcDate(2026, 6, 21, 2, 0) });
    assert.match(localTime(at, 'America/Chicago'), /Mon, Jun 22, 08:00/);
  });

  it('returns null when no jurisdiction resolves', () => {
    assert.equal(quietHours.nextEligibleAt({ now: NOON_ET }), null);
    assert.equal(quietHours.nextEligibleAt({ phone: '+15551234567', now: NOON_ET }), null);
  });

  it('returns null when the resolved zone is not a real IANA id', () => {
    assert.equal(quietHours.nextEligibleAt({ fallbackTimezone: 'Not/A_Real_Zone', now: NOON_ET }), null);
  });

  it('returns null when nothing qualifies inside the horizon', () => {
    // 02:00 EDT with a horizon of a few seconds: the next open is hours away.
    const at = quietHours.nextEligibleAt({ zipCode: '10001', now: WED(6, 0), maxDays: 0.0001 });
    assert.equal(at, null);
  });

  it('throws on a non-positive or non-finite maxDays', () => {
    // Returning null would be indistinguishable from "never contactable",
    // which is an expensive thing to debug from a queue that stopped draining.
    for (const maxDays of [0, -1, NaN, Infinity, '8']) {
      assert.throws(
        () => quietHours.nextEligibleAt({ zipCode: '10001', now: NOON_ET, maxDays }),
        /maxDays/,
      );
    }
  });

  it('returns null for an unusable now', () => {
    assert.equal(quietHours.nextEligibleAt({ zipCode: '10001', now: new Date('nope') }), null);
  });

  it('never returns an instant that evaluate() would reject', () => {
    // Sweep every half hour of a week across the four rule shapes.
    const zips = ['10001', '21201', '35201', '57104'];
    for (const zipCode of zips) {
      for (let step = 0; step < 7 * 48; step += 1) {
        const now = new Date(Date.UTC(2026, 2, 5) + step * 30 * 60 * 1000); // spans 2026-03-08
        const at = quietHours.nextEligibleAt({ zipCode, now });
        assert.ok(at, `${zipCode} step ${step}: expected a deferral target`);
        assert.ok(at.getTime() >= now.getTime(), `${zipCode} step ${step}: went backwards`);
        assert.equal(quietHours.evaluate({ zipCode, now: at }).eligible, true,
          `${zipCode} step ${step}: returned ${at.toISOString()}, which is not eligible`);
      }
    }
  });
});


// ── malformed input ──────────────────────────────────────────────

describe('evaluate — malformed input', () => {
  it('fails closed on a timezone Intl does not recognise', () => {
    const out = quietHours.evaluate({ fallbackTimezone: 'Not/A_Real_Zone', now: NOON_ET });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.TIMEZONE_UNPARSEABLE);
  });

  it('distinguishes an unusable clock from an unusable timezone', () => {
    const out = quietHours.evaluate({ zipCode: '10001', now: new Date('not a date') });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.INVALID_NOW, 'blaming the timezone would send someone hunting in the wrong place');
    assert.equal(quietHours.evaluate({ zipCode: '10001', now: 'today' }).reason, REASONS.INVALID_NOW);
  });

  it('accepts epoch milliseconds as well as a Date', () => {
    const asDate = quietHours.evaluate({ zipCode: '10001', now: NOON_ET });
    const asNumber = quietHours.evaluate({ zipCode: '10001', now: NOON_ET.getTime() });
    assert.deepEqual(asNumber, asDate);
  });

  it('falls through to the area code when the ZIP is too short', () => {
    const out = quietHours.evaluate({ zipCode: '12', phone: '+12121234567', now: NOON_ET });
    assert.equal(out.source, SOURCES.AREA_CODE);
    assert.equal(out.state, 'NY');
  });

  it('handles ZIP+4', () => {
    assert.equal(quietHours.evaluate({ zipCode: '33101-4567', now: NOON_ET }).state, 'FL');
  });
});


// ── unknown options ──────────────────────────────────────────────

describe('unknown option keys are rejected, not ignored', () => {
  // Every option is optional, so a misspelling would otherwise be dropped in
  // silence. The one that hurts is fallbackTimezone: it is consulted ONLY when
  // neither ZIP nor area code resolves, so a typo passes every test that
  // supplies a resolvable phone and then blocks live sends for the recipients
  // where nothing else resolves — reported as quiet hours, not as a config bug.
  it('throws on a misspelled option, naming it and the valid ones', () => {
    assert.throws(
      () => quietHours.evaluate({ fallbackTimeZone: 'America/Denver', now: NOON_ET }),
      (err) => err instanceof TypeError
        && /unknown option 'fallbackTimeZone'/.test(err.message)
        && /fallbackTimezone/.test(err.message),
    );
  });

  it('guards all three entry points', () => {
    assert.throws(() => quietHours.evaluate({ nope: 1 }), /unknown option 'nope'/);
    assert.throws(() => quietHours.nextEligibleAt({ nope: 1 }), /unknown option 'nope'/);
    assert.throws(() => quietHours.resolveJurisdiction({ nope: 1 }), /unknown option 'nope'/);
  });

  it('scopes each method to the options it actually reads', () => {
    // maxDays is real, but only nextEligibleAt honours it. Accepting it on
    // evaluate would imply a horizon that method does not have.
    assert.doesNotThrow(() => quietHours.nextEligibleAt({ zipCode: '10001', now: NOON_ET, maxDays: 2 }));
    assert.throws(() => quietHours.evaluate({ zipCode: '10001', now: NOON_ET, maxDays: 2 }), /maxDays/);
    assert.throws(() => quietHours.resolveJurisdiction({ zipCode: '10001', now: NOON_ET }), /now/);
  });

  it('still accepts no arguments at all', () => {
    for (const args of [undefined, null, {}]) {
      assert.equal(quietHours.evaluate(args).eligible, false);
      assert.equal(quietHours.nextEligibleAt(args), null);
      assert.equal(quietHours.resolveJurisdiction(args).source, SOURCES.UNRESOLVED);
    }
  });

  it('rejects a non-object where options belong', () => {
    assert.throws(() => quietHours.evaluate('America/Denver'), /must be a plain object/);
    assert.throws(() => quietHours.evaluate(42), /must be a plain object/);
  });

  it('rejects a Date or an array, which have no keys to object to', () => {
    // `evaluate(someDate)` is what somebody writes when they assume the
    // argument is `now`. An array and a Date carry no own enumerable keys, so
    // the unknown-key loop finds nothing to complain about and the call
    // returns a fail-closed verdict — the silent wrong answer this guard
    // exists to prevent.
    assert.throws(() => quietHours.evaluate(new Date()), /plain object \(got a Date\)/);
    assert.throws(() => quietHours.evaluate([]), /plain object \(got an array\)/);
    assert.throws(() => quietHours.nextEligibleAt(new Date()), /plain object/);
  });
});

describe('the fallback timezone actually reaches the verdict', () => {
  // Guards the rename directly: these are the only paths where the fallback is
  // consulted at all, so a dropped option shows up here and nowhere else.
  it('is used when neither ZIP nor area code resolves', () => {
    const out = quietHours.evaluate({ fallbackTimezone: 'America/Los_Angeles', now: WED(6, 30) });
    assert.equal(out.timezone, 'America/Los_Angeles');
    assert.equal(out.source, SOURCES.FALLBACK);
    // 23:30 Tuesday Pacific — outside the window, and provably not UTC or ET.
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.OUTSIDE_WINDOW);
  });

  it('is used when the area code is unassigned', () => {
    const out = quietHours.evaluate({
      phone: '+15551234567', fallbackTimezone: 'America/Los_Angeles', now: NOON_ET,
    });
    assert.equal(out.source, SOURCES.FALLBACK);
    assert.equal(out.timezone, 'America/Los_Angeles');
  });

  it('lets nextEligibleAt DEFER rather than drop', () => {
    // Without the fallback this returns null, which callers correctly treat as
    // unsendable — turning a deferral back into a silent drop.
    const at = quietHours.nextEligibleAt({ fallbackTimezone: 'America/Los_Angeles', now: WED(6, 30) });
    assert.notEqual(at, null, 'a resolvable fallback must produce a deferral target');
    assert.match(localTime(at, 'America/Los_Angeles'), /08:00/);
  });
});


// ── territories and military prefixes ────────────────────────────

describe('territories and military ZIP prefixes', () => {
  it('resolves the US territories, which are fully subject to the TCPA', () => {
    assert.equal(quietHours.evaluate({ zipCode: '00901', now: NOON_ET }).timezone, 'America/Puerto_Rico');
    assert.equal(quietHours.evaluate({ zipCode: '00802', now: NOON_ET }).state, 'VI');
    assert.equal(quietHours.evaluate({ zipCode: '96910', now: NOON_ET }).timezone, 'Pacific/Guam');
  });

  it('falls through to the phone for a military ZIP, which has no usable zone', () => {
    // An APO/FPO prefix is a failed ZIP resolution, not a resolution that
    // happens to be blank — discarding a good phone number over it silently
    // made a reachable recipient unsendable.
    const out = quietHours.evaluate({ zipCode: '09001', phone: '+12121234567', now: NOON_ET });
    assert.equal(out.source, SOURCES.AREA_CODE);
    assert.equal(out.state, 'NY');
  });

  it('still fails closed for a military ZIP with nothing else to go on', () => {
    const out = quietHours.evaluate({ zipCode: '09001', now: NOON_ET });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.NO_TIMEZONE);
  });

  it('treats 340 (APO/FPO Americas) as military, not as Florida', () => {
    // 340xx sits inside Florida's 320-349 block but is Armed Forces Americas.
    // Mapping it to FL would apply Florida's Sunday blackout to a recipient
    // whose actual location is unknown — and worse, claim source: zip for it.
    assert.equal(jurisdiction.getZipState(340), 'AA');
    const out = quietHours.evaluate({ zipCode: '34012', phone: '+12121234567', now: NOON_ET });
    assert.equal(out.source, SOURCES.AREA_CODE);
    assert.equal(out.state, 'NY');
  });

  it('resolves 885 — El Paso\'s second prefix — to Texas, Mountain time', () => {
    // 885 sits between New Mexico's 870-884 and Nevada's 889-898 and is easy
    // to lose. It is El Paso, TX: Texas rules on Mountain-zone wall clocks.
    assert.equal(jurisdiction.getZipState(885), 'TX');
    const out = quietHours.evaluate({ zipCode: '88510', now: NOON_ET });
    assert.equal(out.state, 'TX');
    assert.equal(out.timezone, 'America/Denver');
    assert.equal(out.source, SOURCES.ZIP);
  });
});


// ── jurisdiction tables ──────────────────────────────────────────

describe('jurisdiction.getStateTimezone', () => {
  it('returns the state default when no ZIP3 is given', () => {
    assert.equal(jurisdiction.getStateTimezone('FL'), 'America/New_York');
    assert.equal(jurisdiction.getStateTimezone('TX'), 'America/Chicago');
  });

  it('overrides to the minority zone for a documented border ZIP3', () => {
    assert.equal(jurisdiction.getStateTimezone('FL', 324), 'America/Chicago');     // Panhandle
    assert.equal(jurisdiction.getStateTimezone('KY', 420), 'America/Chicago');     // Western KY
    assert.equal(jurisdiction.getStateTimezone('IN', 476), 'America/Chicago');     // Evansville
    assert.equal(jurisdiction.getStateTimezone('TN', 377), 'America/New_York');    // Knoxville
    assert.equal(jurisdiction.getStateTimezone('TX', 799), 'America/Denver');      // El Paso
    assert.equal(jurisdiction.getStateTimezone('OR', 979), 'America/Denver');      // Malheur
    assert.equal(jurisdiction.getStateTimezone('ID', 838), 'America/Los_Angeles'); // ID panhandle
    assert.equal(jurisdiction.getStateTimezone('ID', 835), 'America/Los_Angeles'); // Lewiston
  });

  it('ignores a ZIP3 override that does not belong to the state', () => {
    // Without the state gate the prefix wins outright, and a New York
    // recipient carrying a stray Florida ZIP answers America/Chicago.
    assert.equal(jurisdiction.getStateTimezone('NY', 324), 'America/New_York');
    assert.equal(jurisdiction.getStateTimezone('ZZ', 799), null);
    assert.equal(jurisdiction.getStateTimezone(null, 799), null);
    assert.equal(jurisdiction.getStateTimezone(undefined, 420), null);
  });

  it('keeps the state default for a non-border ZIP3 in a multi-zone state', () => {
    assert.equal(jurisdiction.getStateTimezone('FL', 331), 'America/New_York');  // Miami
    assert.equal(jurisdiction.getStateTimezone('TN', 372), 'America/Chicago');   // Nashville
    assert.equal(jurisdiction.getStateTimezone('TN', 375), 'America/Chicago');   // Memphis
    assert.equal(jurisdiction.getStateTimezone('TX', 750), 'America/Chicago');   // Dallas
  });

  it('does not override a ZIP3 whose majority already matches the state default', () => {
    // Michigan's UP: Marquette and Escanaba are Eastern, like the default.
    assert.equal(jurisdiction.getStateTimezone('MI', 498), 'America/Detroit');
    assert.equal(jurisdiction.getStateTimezone('MI', 499), 'America/Detroit');
    // Western Kansas: only four counties are Mountain, and Colby (67701) and
    // Dodge City (67801) are not among them.
    assert.equal(jurisdiction.getStateTimezone('KS', 677), 'America/Chicago');
    assert.equal(jurisdiction.getStateTimezone('KS', 678), 'America/Chicago');
  });

  it('resolves every zone in the tables through Intl', () => {
    const zones = new Set(Object.values(jurisdiction.STATE_TIMEZONE));
    for (const [, , , zone] of jurisdiction.ZIP3_TIMEZONE_OVERRIDES) zones.add(zone);
    for (const zone of zones) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }), `${zone} is not a valid IANA zone`);
    }
  });
});

describe('jurisdiction.getZipState', () => {
  it('maps Vermont\'s prefixes to Vermont', () => {
    // 050-059 is Vermont, except 055 — the Andover, MA service center.
    assert.equal(jurisdiction.getZipState(50), 'VT');
    assert.equal(jurisdiction.getZipState(55), 'MA');
    assert.equal(jurisdiction.getZipState(56), 'VT', '05602 is Montpelier, VT');
    assert.equal(jurisdiction.getZipState(57), 'VT', '05701 is Rutland, VT');
    assert.equal(jurisdiction.getZipState(58), 'VT', '05819 is St. Johnsbury, VT');
  });

  it('maps 201 to Virginia, not DC', () => {
    assert.equal(jurisdiction.getZipState(200), 'DC');
    assert.equal(jurisdiction.getZipState(201), 'VA', '20101 is Dulles, VA');
    assert.equal(jurisdiction.getZipState(202), 'DC');
  });

  it('rejects out-of-range and non-integer prefixes', () => {
    for (const bad of [-1, 1000, NaN, 30.5, '305', null]) {
      assert.equal(jurisdiction.getZipState(bad), null, `${bad} should not resolve`);
    }
  });

  it('has no overlapping or inverted ranges', () => {
    const seen = new Map();
    for (const [start, end, state] of jurisdiction.ZIP3_RANGES) {
      assert.ok(start <= end, `range for ${state} is inverted: ${start}..${end}`);
      for (let p = start; p <= end; p += 1) {
        assert.equal(seen.has(p), false, `prefix ${p} claimed by both ${seen.get(p)} and ${state}`);
        seen.set(p, state);
      }
    }
  });
});


// ── immutability ─────────────────────────────────────────────────

describe('rule tables are immutable', () => {
  it('cannot be mutated through a nested rule object', () => {
    // A shallow freeze leaves these writable, and a single stray assignment
    // would widen a compliance window process-wide with nothing in the diff.
    assert.throws(() => { STATE_RULES.MD.endMinutes = 1; }, TypeError);
    assert.throws(() => { STATE_RULES.MD = null; }, TypeError);
    assert.equal(STATE_RULES.MD.endMinutes, 20 * 60);
  });

  it('cannot be mutated through the jurisdiction range tables', () => {
    assert.throws(() => { jurisdiction.ZIP3_RANGES[0][2] = 'XX'; }, TypeError);
    assert.throws(() => { jurisdiction.STATE_TIMEZONE.NY = 'UTC'; }, TypeError);
  });

  it('carries a citation and an explicit lastVerified on every rule', () => {
    for (const [code, rule] of Object.entries(STATE_RULES)) {
      assert.equal(typeof rule.citation, 'string', `${code} needs a citation`);
      assert.ok(rule.citation.length > 0, `${code} needs a citation`);
      assert.ok('lastVerified' in rule, `${code} must state whether it has been verified`);
    }
  });
});


// ── custom engines ───────────────────────────────────────────────

describe('QuietHoursEngine — custom rules', () => {
  it('accepts an added state override', () => {
    const engine = new QuietHoursEngine({
      rules: { OK: { startMinutes: 8 * 60, endMinutes: 20 * 60 } },
    });

    // Wed 20:30 CDT — inside the federal window, outside the injected one.
    const now = utcDate(2026, 6, 25, 1, 30);
    assert.equal(quietHours.evaluate({ zipCode: '73101', now }).eligible, true);

    const out = engine.evaluate({ zipCode: '73101', now });
    assert.equal(out.eligible, false);
    assert.equal(out.ruleApplied, 'OK');
  });

  it('replaces a bundled rule', () => {
    const engine = new QuietHoursEngine({
      rules: { FL: { startMinutes: 8 * 60, endMinutes: 21 * 60, excludesSundays: false } },
    });
    assert.equal(engine.evaluate({ zipCode: '33101', now: SUN_10AM_ET }).eligible, true);
    assert.equal(quietHours.evaluate({ zipCode: '33101', now: SUN_10AM_ET }).eligible, false,
      'the default engine must be unaffected');
  });

  it('leaves the bundled table untouched', () => {
    // eslint-disable-next-line no-new
    new QuietHoursEngine({ rules: { FL: { startMinutes: 0, endMinutes: 1 } } });
    assert.equal(STATE_RULES.FL.startMinutes, 8 * 60);
  });

  it('rejects a malformed rule at construction, not at evaluation', () => {
    const bad = [
      [{ OK: { startMinutes: '8', endMinutes: 1200 } }, /startMinutes/],
      [{ OK: { startMinutes: 480, endMinutes: 2000 } }, /endMinutes/],
      [{ OK: { startMinutes: 1200, endMinutes: 480 } }, /must be before/],
      [{ OK: { startMinutes: 480, endMinutes: 1200, excludesSundays: 'yes' } }, /excludesSundays/],
      [{ OK: null }, /must be an object/],
    ];
    for (const [rules, message] of bad) {
      assert.throws(() => new QuietHoursEngine({ rules }), message);
    }
    assert.throws(() => new QuietHoursEngine({ rules: 'nope' }), /rules must be an object/);
    assert.throws(() => new QuietHoursEngine({ resolver: 'nope' }), /resolver must be a function/);
  });
});

describe('QuietHoursEngine — custom resolver', () => {
  it('replaces ZIP and area-code guessing wholesale', () => {
    // What a caller with a verified billing address on file should be doing.
    const engine = new QuietHoursEngine({
      resolver: () => ({ state: 'FL', timezone: 'America/New_York', source: 'billing_address' }),
    });
    const out = engine.evaluate({ phone: '+12125551234', now: SUN_10AM_ET });
    assert.equal(out.source, 'billing_address');
    assert.equal(out.reason, REASONS.SUNDAY_BLACKOUT, 'the injected state still drives the rule');
  });

  it('fails loud when a resolver returns nothing', () => {
    // A resolver that forgets its return statement is a wiring bug; the error
    // should name it, not surface as a destructuring TypeError frames away.
    const engine = new QuietHoursEngine({ resolver: () => undefined });
    assert.throws(() => engine.evaluate({ now: NOON_ET }), /resolver must return/);
  });
});
