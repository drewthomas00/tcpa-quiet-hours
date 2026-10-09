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
    const expected = 'eligible,jurisdictions,reason,ruleApplied,source,state,timezone';
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

  it('FL: closes at 8 PM, and Sundays are permitted', () => {
    // Fla. Stat. § 501.616(6)(a) says nothing about Sundays; 1.x wrongly
    // blocked them.
    const sunday = quietHours.evaluate({ zipCode: '33101', now: SUN_10AM_ET });
    assert.equal(sunday.eligible, true);
    assert.equal(sunday.ruleApplied, 'FL');

    const evening = quietHours.evaluate({ zipCode: '33101', now: utcDate(2026, 6, 25, 0, 30) }); // 20:30 EDT
    assert.equal(evening.eligible, false);
    assert.equal(evening.reason, REASONS.OUTSIDE_WINDOW);
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

    const rhodeIsland = quietHours.evaluate({ zipCode: '02903', now: instant });
    assert.equal(rhodeIsland.reason, REASONS.SUNDAY_BLACKOUT,
      'it is Sunday in Providence even though it is Saturday on the west coast');
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

  it('mentions the fallback timezone only for a key that looks like one', () => {
    assert.throws(() => quietHours.evaluate({ fallback_tz: 'America/Denver' }), /meant as fallbackTimezone/);
    assert.throws(
      () => quietHours.evaluate({ maxDays: 3 }),
      (err) => /unknown option 'maxDays'/.test(err.message) && !/meant as fallbackTimezone/.test(err.message),
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

  it('resolves the Pacific ZIPs whose prefix belongs to somewhere else', () => {
    // American Samoa's 96799 sits in Hawaii's 967 (an hour ahead of it), and
    // the Marianas and the Freely Associated States share Guam's 969.
    const cases = {
      96799: ['AS', 'Pacific/Pago_Pago'],
      96950: ['MP', 'Pacific/Saipan'],
      96940: ['PW', 'Pacific/Palau'],
      96942: ['FM', 'Pacific/Chuuk'],
      96960: ['MH', 'Pacific/Majuro'],
      96813: ['HI', 'Pacific/Honolulu'],
      96910: ['GU', 'Pacific/Guam'],
    };
    for (const [zip, [state, timezone]] of Object.entries(cases)) {
      assert.deepEqual(quietHours.resolveJurisdiction({ zipCode: zip }), { state, timezone, source: SOURCES.ZIP }, zip);
    }
    // 07:30 in Pago Pago is 08:30 in Honolulu: read on Hawaii's clock, it passed.
    const out = quietHours.evaluate({ zipCode: '96799', now: new Date('2026-10-08T18:30:00Z') });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.OUTSIDE_WINDOW);
    // 21:30 in Majuro is 19:30 in Guam: read on Guam's clock, it passed.
    assert.equal(quietHours.evaluate({ zipCode: '96960', now: new Date('2026-10-08T09:30:00Z') }).eligible, false);
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
    for (const zone of Object.values(jurisdiction.AREA_CODE_TIMEZONE_OVERRIDES)) zones.add(zone);
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
    assert.throws(() => { STATE_RULES.MD[0].windows[3].end = 1; }, TypeError);
    assert.throws(() => { STATE_RULES.MD[0].windows[3] = null; }, TypeError);
    assert.throws(() => { STATE_RULES.MD.push({}); }, TypeError);
    assert.throws(() => { STATE_RULES.MD = null; }, TypeError);
    assert.throws(() => { quietHours.HOLIDAY_CALENDARS.AL.holidays.pop(); }, TypeError);
    assert.equal(STATE_RULES.MD[0].windows[3].end, 20 * 60);
  });

  it('cannot be mutated through the jurisdiction range tables', () => {
    assert.throws(() => { jurisdiction.ZIP3_RANGES[0][2] = 'XX'; }, TypeError);
    assert.throws(() => { jurisdiction.STATE_TIMEZONE.NY = 'UTC'; }, TypeError);
  });

  it('carries a citation and an explicit lastVerified on every rule', () => {
    for (const [code, versions] of Object.entries(STATE_RULES)) {
      for (const rule of versions) {
        assert.equal(typeof rule.citation, 'string', `${code} needs a citation`);
        assert.ok(rule.citation.length > 0, `${code} needs a citation`);
        assert.ok('lastVerified' in rule, `${code} must state whether it has been verified`);
        assert.ok(['yes', 'unclear', 'no'].includes(rule.coversText), `${code} must say whether it covers texts`);
      }
    }
  });

  it('only encodes rules stricter than federal somewhere', () => {
    // A rule identical to federal is noise, and noise in a compliance table
    // reads as coverage that is not there.
    for (const [code, versions] of Object.entries(STATE_RULES)) {
      for (const rule of versions) {
        const stricter = rule.holidays || rule.fixedClock || rule.windows.some(
          (w) => w === null || w.start > 8 * 60 || w.end < 21 * 60,
        );
        assert.ok(stricter, `${code} (${rule.effectiveFrom || 'original'}) is no stricter than federal`);
      }
    }
  });
});


// ── custom engines ───────────────────────────────────────────────

describe('QuietHoursEngine — custom rules', () => {
  it('accepts an added state override', () => {
    const engine = new QuietHoursEngine({
      rules: { NC: { windows: { default: ['08:00', '20:00'] } } },
    });

    // Wed 20:30 EDT — inside the federal window, outside the injected one.
    const now = utcDate(2026, 6, 25, 0, 30);
    assert.equal(quietHours.evaluate({ zipCode: '27601', now }).eligible, true);

    const out = engine.evaluate({ zipCode: '27601', now });
    assert.equal(out.eligible, false);
    assert.equal(out.ruleApplied, 'NC');
  });

  it('replaces a bundled rule', () => {
    const engine = new QuietHoursEngine({
      // The 1.x rule shape is still accepted.
      rules: { UT: { startMinutes: 8 * 60, endMinutes: 21 * 60, excludesSundays: false } },
    });
    const sundayNoonMountain = utcDate(2026, 6, 21, 18, 0);
    assert.equal(engine.evaluate({ zipCode: '84101', now: sundayNoonMountain }).eligible, true);
    assert.equal(quietHours.evaluate({ zipCode: '84101', now: sundayNoonMountain }).eligible, false,
      'the default engine must be unaffected');
  });

  it('leaves the bundled table untouched', () => {
    // eslint-disable-next-line no-new
    new QuietHoursEngine({ rules: { FL: { startMinutes: 0, endMinutes: 1 } } });
    assert.equal(STATE_RULES.FL[0].windows[1].start, 8 * 60);
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

describe('jurisdiction.getAreaCodeTimezone', () => {
  it('reads an area code in its state\'s minority zone on its own clock', () => {
    assert.equal(jurisdiction.getAreaCodeTimezone(915), 'America/Denver');    // El Paso
    assert.equal(jurisdiction.getAreaCodeTimezone(865), 'America/New_York');  // Knoxville
    assert.equal(jurisdiction.getAreaCodeTimezone(423), 'America/New_York');  // Chattanooga
    assert.equal(jurisdiction.getAreaCodeTimezone(270), 'America/Chicago');   // Bowling Green
    assert.equal(jurisdiction.getAreaCodeTimezone(219), 'America/Chicago');   // Gary
    assert.equal(jurisdiction.getAreaCodeTimezone(850), 'America/Chicago');   // Pensacola
  });

  it('keeps the state default everywhere else', () => {
    assert.equal(jurisdiction.getAreaCodeTimezone(214), 'America/Chicago');   // Dallas
    assert.equal(jurisdiction.getAreaCodeTimezone(615), 'America/Chicago');   // Nashville
    assert.equal(jurisdiction.getAreaCodeTimezone(305), 'America/New_York');  // Miami
    assert.equal(jurisdiction.getAreaCodeTimezone(800), null);                // toll-free
  });

  it('only overrides codes that belong to the state it names', () => {
    for (const code of Object.keys(jurisdiction.AREA_CODE_TIMEZONE_OVERRIDES)) {
      assert.ok(jurisdiction.getAreaCodeState(Number(code)), `${code} has an override but no state`);
    }
  });
});

describe('area-code resolution in a multi-timezone state', () => {
  it('blocks a 7:30 AM Mountain send to an El Paso number', () => {
    // 13:30Z is 7:30 AM MDT. Read on Texas's default Central clock it is
    // 8:30 AM, and the send would pass.
    const out = quietHours.evaluate({ phone: '+19155551234', now: utcDate(2026, 7, 15, 13, 30) });
    assert.equal(out.timezone, 'America/Denver');
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.OUTSIDE_WINDOW);
  });

  it('blocks a 9:30 PM Eastern send to a Knoxville number', () => {
    // 01:30Z is 9:30 PM EDT, 8:30 PM on Tennessee's default Central clock.
    const out = quietHours.evaluate({ phone: '+18655551234', now: utcDate(2026, 7, 16, 1, 30) });
    assert.equal(out.timezone, 'America/New_York');
    assert.equal(out.eligible, false);
  });
});

describe('QuietHoursEngine — custom resolver', () => {
  it('matches a lower-case state from a resolver to its rule', () => {
    // 'md' must still close at 8 PM. Unnormalised it misses the 'MD' key and
    // falls through to the federal 9 PM, widening the window silently.
    const engine = new QuietHoursEngine({
      resolver: () => ({ state: 'md', timezone: 'America/New_York', source: 'billing_address' }),
    });
    const out = engine.evaluate({ now: utcDate(2026, 6, 25, 0, 30) }); // 8:30 PM EDT
    assert.equal(out.state, 'MD');
    assert.equal(out.ruleApplied, 'MD');
    assert.equal(out.eligible, false);
  });

  it('replaces ZIP and area-code guessing wholesale', () => {
    // What a caller with a verified billing address on file should be doing.
    const engine = new QuietHoursEngine({
      resolver: () => ({ state: 'UT', timezone: 'America/Denver', source: 'billing_address' }),
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

  it('fails loud when a resolver omits source, so every verdict field is present', () => {
    const engine = new QuietHoursEngine({ resolver: () => ({ state: 'MD', timezone: 'America/New_York' }) });
    assert.throws(() => engine.evaluate({ now: NOON_ET }), /resolver must return/);
  });

  it('reads ruleFor\'s state case-insensitively, as the resolver does', () => {
    const engine = new QuietHoursEngine();
    assert.equal(engine.ruleFor('md', '2026-10-08'), engine.ruleFor('MD', '2026-10-08'));
    assert.equal(engine.ruleFor('md', '2026-10-08').label, 'MD');
  });
});


// ── 2.0: per-day windows, holidays, effective dates, presumptions ─

const holidays = require('../holidays');

describe('per-weekday windows', () => {
  it('TX: opens at noon on Sundays, 9 AM otherwise', () => {
    const sunday10 = quietHours.evaluate({ zipCode: '75201', now: utcDate(2026, 6, 21, 15, 0) }); // 10:00 CDT
    assert.equal(sunday10.eligible, false);
    assert.equal(sunday10.reason, REASONS.OUTSIDE_WINDOW);
    assert.equal(quietHours.evaluate({ zipCode: '75201', now: utcDate(2026, 6, 21, 17, 0) }).eligible, true); // noon
    assert.equal(quietHours.evaluate({ zipCode: '75201', now: WED(14, 0) }).eligible, true); // Wed 09:00 CDT
    assert.equal(quietHours.evaluate({ zipCode: '75201', now: WED(13, 59) }).eligible, false); // 08:59
  });

  it('RI: 9–6 on weekdays, 10–5 on Saturdays, never on Sundays', () => {
    assert.equal(quietHours.evaluate({ zipCode: '02903', now: WED(21, 59) }).eligible, true);  // 17:59 EDT
    assert.equal(quietHours.evaluate({ zipCode: '02903', now: WED(22, 0) }).eligible, false);  // 18:00
    const saturday = (h, m) => utcDate(2026, 6, 27, h, m);
    assert.equal(quietHours.evaluate({ zipCode: '02903', now: saturday(13, 59) }).eligible, false); // 09:59
    assert.equal(quietHours.evaluate({ zipCode: '02903', now: saturday(14, 0) }).eligible, true);   // 10:00
    assert.equal(quietHours.evaluate({ zipCode: '02903', now: saturday(21, 0) }).eligible, false);  // 17:00
  });

  it('reports a closed weekday other than Sunday as a day blackout', () => {
    const engine = new QuietHoursEngine({ rules: { NC: { windows: { default: ['08:00', '21:00'], wed: null } } } });
    assert.equal(engine.evaluate({ zipCode: '27601', now: NOON_ET }).reason, REASONS.DAY_BLACKOUT);
  });
});

describe('rules that take effect on a date', () => {
  // Pennsylvania's Act 47 of 2026: from 2026-10-18, 9 AM – 7 PM, no Sundays.
  it('applies the old PA window before the effective date and the new one from it', () => {
    const satEvening = quietHours.evaluate({ zipCode: '19103', now: utcDate(2026, 10, 17, 23, 30) }); // Sat 19:30 EDT
    assert.equal(satEvening.eligible, true, 'the 9 PM close still applies on 10-17');

    const sunNoon = quietHours.evaluate({ zipCode: '19103', now: utcDate(2026, 10, 18, 16, 0) });
    assert.equal(sunNoon.reason, REASONS.SUNDAY_BLACKOUT, '10-18 is a Sunday, and the new rule bars it');

    const monEvening = quietHours.evaluate({ zipCode: '19103', now: utcDate(2026, 10, 19, 23, 30) }); // Mon 19:30
    assert.equal(monEvening.eligible, false);
    assert.equal(monEvening.reason, REASONS.OUTSIDE_WINDOW);
  });

  it('switches on the RECIPIENT\'s local date', () => {
    // 03:30Z on 10-18 is still 23:30 on 10-17 in Philadelphia: the old rule.
    const engine = new QuietHoursEngine({
      rules: {
        NC: [
          { windows: { default: ['00:00', '24:00'] } },
          { effectiveFrom: '2026-10-18', windows: { default: ['09:00', '10:00'] } },
        ],
      },
    });
    assert.equal(engine.evaluate({ zipCode: '27601', now: utcDate(2026, 10, 18, 3, 30) }).eligible, true);
    assert.equal(engine.evaluate({ zipCode: '27601', now: utcDate(2026, 10, 18, 4, 30) }).eligible, false);
  });

  it('defers across the change to the new rule\'s window', () => {
    // Sat 10-17 21:30 EDT: closed under the old rule; Sunday is closed under
    // the new one; Monday 10-19 opens at 9 AM.
    const next = quietHours.nextEligibleAt({ zipCode: '19103', now: utcDate(2026, 10, 18, 1, 30) });
    assert.equal(next.toISOString(), '2026-10-19T13:00:00.000Z');
  });
});

describe('holidays', () => {
  it('computes Western Easter', () => {
    const iso = (y) => new Date(holidays.easterSunday(y)).toISOString().slice(0, 10);
    assert.equal(iso(2024), '2024-03-31');
    assert.equal(iso(2025), '2025-04-20');
    assert.equal(iso(2026), '2026-04-05');
    assert.equal(iso(2027), '2027-03-28');
    assert.equal(iso(2038), '2038-04-25');
  });

  it('resolves nth and last weekdays', () => {
    const cal = holidays.normalizeCalendar('t', {
      holidays: [
        { name: 'last Mon May', month: 5, weekday: 1, nth: -1 },
        { name: '4th Thu Nov', month: 11, weekday: 4, nth: 4 },
        { name: 'Tue after 1st Mon Nov', month: 11, weekday: 1, nth: 1, offset: 1 },
      ],
    });
    const dates = holidays.datesIn(cal, 2026);
    assert.equal(dates.get('2026-05-25'), 'last Mon May');
    assert.equal(dates.get('2026-11-26'), '4th Thu Nov');
    assert.equal(dates.get('2026-11-03'), 'Tue after 1st Mon Nov');
  });

  it('blocks a weekend holiday AND its observed weekday', () => {
    const cal = holidays.normalizeCalendar('t', { observe: 'weekend', holidays: [{ name: 'NY', month: 1, day: 1 }] });
    // 2028-01-01 is a Saturday: observed Friday 2027-12-31.
    assert.equal(holidays.holidayOn(cal, 2027, '2027-12-31'), 'NY');
    assert.equal(holidays.holidayOn(cal, 2028, '2028-01-01'), 'NY');
    const sundayOnly = holidays.normalizeCalendar('t', { observe: 'sunday', holidays: [{ name: 'NY', month: 1, day: 1 }] });
    assert.equal(holidays.holidayOn(sundayOnly, 2027, '2027-12-31'), null);
  });

  it('carries a December holiday observed in January into the new year', () => {
    // 2028-12-31 is a Sunday, observed Monday 2029-01-01.
    const cal = holidays.normalizeCalendar('t', { observe: 'sunday', holidays: [{ name: 'NYE', month: 12, day: 31 }] });
    assert.equal(holidays.holidayOn(cal, 2028, '2028-12-31'), 'NYE');
    assert.equal(holidays.holidayOn(cal, 2029, '2029-01-01'), 'NYE');
  });

  it('AL: no contact on Christmas Day', () => {
    // 2026-12-25 is a Friday.
    const out = quietHours.evaluate({ zipCode: '35203', now: utcDate(2026, 12, 25, 17, 0) });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(quietHours.evaluate({ zipCode: '35203', now: utcDate(2026, 12, 24, 17, 0) }).eligible, true);
  });

  it('defers past a holiday that follows a Sunday-banned day', () => {
    // AL, Sat 2026-12-26 21:00 CST → Sunday banned → Mon 12-28 08:00.
    const engine = new QuietHoursEngine({
      rules: { AL: { windows: { default: ['08:00', '20:00'], sun: null },
        holidays: { holidays: [{ name: 'Test Monday', month: 12, day: 28 }] } } },
    });
    const next = engine.nextEligibleAt({ zipCode: '35203', now: utcDate(2026, 12, 27, 3, 0) });
    assert.equal(next.toISOString(), '2026-12-29T14:00:00.000Z', 'Tue 08:00 CST');
  });

  it('rejects a malformed calendar at construction', () => {
    const rule = (h) => ({ NC: { windows: { default: ['08:00', '21:00'] }, holidays: h } });
    assert.throws(() => new QuietHoursEngine({ rules: rule('Nowhere') }), /no holiday calendar named/);
    assert.throws(() => new QuietHoursEngine({ rules: rule({ holidays: [{ name: 'x', month: 13, day: 1 }] }) }), /month 1-12/);
    assert.throws(() => new QuietHoursEngine({ rules: rule({ holidays: [{ name: 'x', month: 1, weekday: 1, nth: 5 }] }) }), /nth/);
    assert.throws(() => new QuietHoursEngine({ rules: rule({ observe: 'monday', holidays: [] }) }), /observe/);
  });
});

describe('a statute that names a fixed clock (MS: "Central Standard Time")', () => {
  it('checks the window on standard time as well as the recipient\'s daylight time', () => {
    // 8:30 AM CDT is 7:30 AM CST — before the open on the statute's clock.
    const morning = quietHours.evaluate({ zipCode: '39201', now: utcDate(2026, 6, 24, 13, 30) });
    assert.equal(morning.eligible, false);
    // 9:00 AM CDT is 8:00 AM CST.
    assert.equal(quietHours.evaluate({ zipCode: '39201', now: utcDate(2026, 6, 24, 14, 0) }).eligible, true);
    // In winter the clocks agree: 8:00 AM CST.
    assert.equal(quietHours.evaluate({ zipCode: '39201', now: utcDate(2026, 1, 7, 14, 0) }).eligible, true);
  });

  it('defers to the later of the two openings', () => {
    const next = quietHours.nextEligibleAt({ zipCode: '39201', now: utcDate(2026, 6, 24, 11, 0) }); // 6 AM CDT
    assert.equal(next.toISOString(), '2026-06-24T14:00:00.000Z', '9 AM CDT = 8 AM CST');
  });
});

describe('area-code presumption (FL, OK, MD, CT)', () => {
  const EVENING_ET = utcDate(2026, 6, 25, 0, 30); // Wed 20:30 EDT

  it('holds a Georgia ZIP with a Florida number to Florida\'s 8 PM close too', () => {
    const out = quietHours.evaluate({ zipCode: '30305', phone: '+13055551234', now: EVENING_ET });
    assert.equal(out.eligible, false);
    assert.equal(out.state, 'GA', 'the primary jurisdiction is still the ZIP');
    assert.equal(out.ruleApplied, 'FL', 'the deciding rule is the presumed one');
    assert.deepEqual(out.jurisdictions.map((j) => [j.state, j.source, j.eligible]), [
      ['GA', SOURCES.ZIP, true],
      ['FL', SOURCES.AREA_CODE_PRESUMPTION, false],
    ]);
  });

  it('adds nothing for a state without a presumption', () => {
    // 512 is Austin; Texas has no area-code presumption.
    const out = quietHours.evaluate({ zipCode: '30305', phone: '+15125551234', now: EVENING_ET });
    assert.equal(out.eligible, true);
    assert.equal(out.jurisdictions.length, 1);
  });

  it('adds nothing when the ZIP and the number agree', () => {
    assert.equal(quietHours.resolveJurisdictions({ zipCode: '33101', phone: '+13055551234' }).length, 1);
  });

  it('is not applied over a custom resolver', () => {
    const engine = new QuietHoursEngine({
      resolver: () => ({ state: 'GA', timezone: 'America/New_York', source: 'billing_address' }),
    });
    assert.equal(engine.evaluate({ phone: '+13055551234', now: EVENING_ET }).eligible, true);
  });

  it('defers until both jurisdictions are open', () => {
    // Connecticut opens at 9; a Georgia ZIP alone would open at 8.
    const next = quietHours.nextEligibleAt({ zipCode: '30305', phone: '+12035551234', now: utcDate(2026, 6, 24, 11, 0) });
    assert.equal(next.toISOString(), '2026-06-24T13:00:00.000Z', '9 AM EDT');
  });
});

describe('onlyRulesCoveringText', () => {
  it('falls back to federal for rules not clearly covering texts, and keeps the rest', () => {
    const engine = new QuietHoursEngine({ onlyRulesCoveringText: true });
    const evening = utcDate(2026, 6, 25, 1, 30); // Wed 20:30 CDT
    assert.equal(engine.evaluate({ zipCode: '75201', now: WED(13, 30) }).ruleApplied, 'federal', 'TX is unclear');
    assert.equal(engine.evaluate({ zipCode: '57104', now: WED(13, 30) }).ruleApplied, 'SD', 'SD names texts');
    assert.equal(quietHours.evaluate({ zipCode: '35203', now: evening }).eligible, false, 'default engine applies AL');
  });

  it('must be a boolean', () => {
    assert.throws(() => new QuietHoursEngine({ onlyRulesCoveringText: 'yes' }), /boolean/);
  });
});

describe('rule validation (2.0 shape)', () => {
  const bad = [
    [{ NC: { windows: { default: ['8:00', '20:00'] } } }, /HH:MM/],
    [{ NC: { windows: { default: ['08:00', '25:00'] } } }, /HH:MM/],
    [{ NC: { windows: { weekday: ['08:00', '20:00'] } } }, /unknown windows key 'weekday'/],
    [{ NC: { windows: { mon: ['08:00', '20:00'] } } }, /no default/],
    [{ NC: { windows: { default: ['08:00', '20:00'] }, startMinutes: 480 } }, /not both/],
    [{ NC: { windows: { default: ['08:00', '20:00'] }, excludeSundays: true } }, /unknown field 'excludeSundays'/],
    [{ NC: { windows: { default: ['08:00', '20:00'] }, effectiveFrom: '10/18/2026' } }, /YYYY-MM-DD/],
    [{ NC: { windows: { default: ['08:00', '20:00'] }, fixedClock: 'Central Standard Time' } }, /fixedClock/],
    [{ NC: { windows: { default: ['08:00', '20:00'] }, coversText: true } }, /coversText/],
    [{ NC: [{ windows: { default: ['08:00', '20:00'] } }, { windows: { default: ['09:00', '20:00'] } }] }, /same effectiveFrom/],
    [{ NC: [] }, /no versions/],
  ];
  for (const [rules, message] of bad) {
    it(`rejects ${JSON.stringify(rules).slice(0, 70)}`, () => {
      assert.throws(() => new QuietHoursEngine({ rules }), message);
    });
  }

  it('rejects an unknown constructor option', () => {
    assert.throws(() => new QuietHoursEngine({ rule: {} }), /unknown option 'rule'/);
  });
});

describe('deferral lands on whole minutes', () => {
  it('returns 8:00:00, not 8:00 plus the seconds of now', () => {
    const next = quietHours.nextEligibleAt({ zipCode: '30305', now: new Date(Date.UTC(2026, 5, 24, 10, 15, 37, 250)) });
    assert.equal(next.toISOString(), '2026-06-24T12:00:00.000Z');
  });
});

describe('the bundled holiday calendars', () => {
  const at = (zipCode, y, m, d, utcHour) => quietHours.evaluate({ zipCode, now: utcDate(y, m, d, utcHour, 0) });

  it('LA: Mardi Gras and Good Friday, by Easter', () => {
    // Easter 2027 is March 28: Mardi Gras Feb 9, Good Friday Mar 26.
    assert.equal(at('70112', 2027, 2, 9, 18).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('70112', 2027, 3, 26, 18).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('70112', 2027, 2, 10, 18).eligible, true);
  });

  it('LA: the election-day holiday falls in even years only', () => {
    assert.equal(at('70112', 2026, 11, 3, 18).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('70112', 2027, 11, 2, 18).eligible, true);
  });

  it('UT: Pioneer Day on a Saturday blocks the Saturday and the Friday before', () => {
    // 2027-07-24 is a Saturday.
    assert.equal(at('84101', 2027, 7, 24, 18).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('84101', 2027, 7, 23, 18).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('84101', 2027, 7, 22, 18).eligible, true);
  });

  it('PA: Flag Day and Election Day are legal holidays; Juneteenth is not', () => {
    assert.equal(at('19103', 2027, 6, 14, 17).reason, REASONS.HOLIDAY_BLACKOUT); // Mon
    assert.equal(at('19103', 2026, 11, 3, 17).reason, REASONS.HOLIDAY_BLACKOUT); // Tue
    assert.equal(at('19103', 2026, 11, 4, 17).eligible, true);
    assert.equal(at('19103', 2028, 6, 19, 17).eligible, true); // Mon, Juneteenth
  });

  it('RI: a Saturday Christmas blocks the Friday before and the Monday after', () => {
    // 2027-12-25 is a Saturday.
    assert.equal(at('02903', 2027, 12, 24, 17).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('02903', 2027, 12, 27, 17).reason, REASONS.HOLIDAY_BLACKOUT);
    assert.equal(at('02903', 2027, 12, 28, 17).eligible, true);
  });

  it('RI: Victory Day, the second Monday of August', () => {
    assert.equal(at('02903', 2027, 8, 9, 17).reason, REASONS.HOLIDAY_BLACKOUT);
  });

  it('every calendar names its source', () => {
    for (const [name, calendar] of Object.entries(quietHours.HOLIDAY_CALENDARS)) {
      assert.ok(calendar.citation, `${name} needs a citation`);
      assert.ok(calendar.holidays.length > 0, `${name} is empty`);
    }
  });
});

describe('ESM consumers', () => {
  it('can import every documented name', async () => {
    // cjs-module-lexer detects only plain-identifier exports; anything else
    // compiles against index.d.ts and then fails at runtime.
    const mod = await import('../index.js');
    for (const name of ['evaluate', 'nextEligibleAt', 'resolveJurisdiction', 'resolveJurisdictions',
      'defaultEngine', 'QuietHoursEngine', 'FEDERAL_RULE', 'STATE_RULES', 'HOLIDAY_CALENDARS',
      'SOURCES', 'REASONS', 'extractAreaCode', 'parseZip3']) {
      assert.ok(name in mod, `${name} is not a named ESM export`);
    }
  });
});
