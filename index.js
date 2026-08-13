/**
 * tcpa-quiet-hours — is it legal to send this marketing message right now?
 *
 * The federal rule (TCPA, 47 CFR 64.1200) bars telemarketing before 8 AM or
 * after 9 PM in the *called party's* local time. Several states tighten that
 * window; this library encodes seven of them, six of which also ban Sunday
 * contact outright, and resolves which jurisdiction applies from whatever
 * identifying signal you have.
 *
 * Two things are easy to get wrong and are the reason this exists:
 *
 *   1. "Local time" means the recipient's local time, not yours. An 8:30 PM
 *      send from a California sender is legal in California and illegal for a
 *      recipient in Maryland.
 *   2. The permitted window is not universally 8 AM–9 PM. Alabama, Florida,
 *      Louisiana and Mississippi close at 8 PM and ban Sundays; South Dakota
 *      opens at 9 AM and bans Sundays; Utah bans Sundays but keeps the 9 PM
 *      close.
 *
 * Pure evaluation — no I/O, no network, no database, zero runtime dependencies.
 *
 * NOT LEGAL ADVICE, and the built-in table is not a claim of completeness.
 * State telemarketing statutes are amended often. Verify against current law
 * before you rely on this, and inject your own rules when you find a
 * difference — see `new QuietHoursEngine({rules})`.
 */
'use strict';

const { wallClockPartsInZone, UNKNOWN_DAY } = require('./timezone');
const { deepFreeze } = require('./freeze');
const jurisdiction = require('./jurisdiction-data');

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;

/**
 * The largest wall-clock shift a single DST transition can produce, used to
 * bound the drift correction in `nextEligibleAt`. Real transitions are 30 or
 * 60 minutes; anything beyond this band means the calendar day itself moved
 * and the search should re-derive it rather than nudge.
 */
const MAX_DST_DRIFT_MINUTES = 120;

/**
 * Why a message was or was not eligible. Every verdict carries exactly one,
 * or `null` when eligible.
 */
const REASONS = deepFreeze({
  /** No usable timezone for the recipient. Fail closed. */
  NO_TIMEZONE: 'no_timezone_resolved',
  /** The resolved zone is not an IANA identifier the runtime accepts. */
  TIMEZONE_UNPARSEABLE: 'timezone_unparseable',
  /** `now` was not a Date or epoch-millisecond number. */
  INVALID_NOW: 'invalid_now',
  /** The recipient's state bans Sunday contact and it is Sunday there. */
  SUNDAY_BLACKOUT: 'state_sunday_blackout',
  /** Outside the permitted time-of-day window. */
  OUTSIDE_WINDOW: 'outside_window',
});

/** How the recipient's jurisdiction was determined, reported on every verdict. */
const SOURCES = deepFreeze({
  ZIP: 'zip',
  AREA_CODE: 'area_code',
  FALLBACK: 'fallback',
  UNRESOLVED: 'unresolved',
});

/**
 * Federal TCPA default: 8 AM – 9 PM called-party local, Sundays permitted.
 * Applies whenever no state override is known.
 */
const FEDERAL_RULE = deepFreeze({
  state: null,
  startMinutes: 8 * 60,
  endMinutes: 21 * 60,
  excludesSundays: false,
  label: 'federal',
  citation: '47 CFR 64.1200(c)(1)',
  lastVerified: null,
});

/**
 * State overrides, each stricter than federal in at least one dimension.
 *
 * `citation` records the statute a rule is drawn from so a correction is
 * reviewable by someone who is not the author, and `lastVerified` records
 * when a human last checked it against primary law.
 *
 * `lastVerified` is `null` on every rule below. These were compiled from
 * secondary sources — state statutes as summarised by industry compliance
 * trackers — and have NOT been read against the primary text. Treat the
 * citations as the place to start verifying, not as verification.
 */
const STATE_RULES = deepFreeze({
  MD: {
    state: 'MD', startMinutes: 8 * 60, endMinutes: 20 * 60, excludesSundays: false,
    label: 'MD', citation: 'Md. Code Ann., Com. Law § 14-2201 et seq.', lastVerified: null,
  },
  AL: {
    state: 'AL', startMinutes: 8 * 60, endMinutes: 20 * 60, excludesSundays: true,
    label: 'AL', citation: 'Ala. Code § 8-19A-1 et seq.', lastVerified: null,
  },
  MS: {
    state: 'MS', startMinutes: 8 * 60, endMinutes: 20 * 60, excludesSundays: true,
    label: 'MS', citation: 'Miss. Code Ann. § 77-3-701 et seq.', lastVerified: null,
  },
  LA: {
    state: 'LA', startMinutes: 8 * 60, endMinutes: 20 * 60, excludesSundays: true,
    label: 'LA', citation: 'La. Rev. Stat. Ann. § 45:811 et seq.', lastVerified: null,
  },
  FL: {
    state: 'FL', startMinutes: 8 * 60, endMinutes: 20 * 60, excludesSundays: true,
    label: 'FL', citation: 'Fla. Stat. § 501.616 et seq.', lastVerified: null,
  },
  SD: {
    state: 'SD', startMinutes: 9 * 60, endMinutes: 21 * 60, excludesSundays: true,
    label: 'SD', citation: 'S.D. Codified Laws § 37-30A-1 et seq.', lastVerified: null,
  },
  UT: {
    state: 'UT', startMinutes: 8 * 60, endMinutes: 21 * 60, excludesSundays: true,
    label: 'UT', citation: 'Utah Code Ann. § 13-26-1 et seq.', lastVerified: null,
  },
});

/**
 * Coerce `now` to a valid instant.
 *
 * `Date` and epoch milliseconds are both accepted so the two public methods
 * agree; anything else — including an Invalid Date — is rejected rather than
 * silently producing a verdict from a NaN clock.
 *
 * @param {Date|number} now
 * @returns {Date|null}
 */
function toInstant(now) {
  if (now instanceof Date) return Number.isFinite(now.getTime()) ? now : null;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  return null;
}

/**
 * Validate a single rule and return a frozen copy.
 *
 * A caller-supplied rule that is subtly malformed — a string where a number
 * belongs, a window that closes before it opens — would otherwise degrade into
 * a permanently-ineligible recipient or, worse, a silently widened window.
 * Fail at construction, where the stack trace still points at the caller.
 *
 * @param {string} code - the state key this rule is registered under
 * @param {object} rule
 * @returns {Readonly<object>}
 * @throws {TypeError} on any malformed field
 */
function normalizeRule(code, rule) {
  const where = `QuietHoursEngine: rule '${code}'`;
  if (!rule || typeof rule !== 'object') {
    throw new TypeError(`${where} must be an object`);
  }

  const { startMinutes, endMinutes, excludesSundays = false } = rule;
  for (const [field, value] of [['startMinutes', startMinutes], ['endMinutes', endMinutes]]) {
    if (!Number.isInteger(value) || value < 0 || value > MINUTES_PER_DAY) {
      throw new TypeError(`${where}: ${field} must be an integer in 0..${MINUTES_PER_DAY} (got ${value})`);
    }
  }
  if (startMinutes >= endMinutes) {
    throw new TypeError(`${where}: startMinutes (${startMinutes}) must be before endMinutes (${endMinutes})`);
  }
  if (typeof excludesSundays !== 'boolean') {
    throw new TypeError(`${where}: excludesSundays must be a boolean (got ${typeof excludesSundays})`);
  }

  return deepFreeze({
    state: code,
    startMinutes,
    endMinutes,
    excludesSundays,
    label: typeof rule.label === 'string' && rule.label ? rule.label : code,
    citation: typeof rule.citation === 'string' ? rule.citation : null,
    lastVerified: typeof rule.lastVerified === 'string' ? rule.lastVerified : null,
  });
}

/** Options `resolveJurisdiction` understands. */
const JURISDICTION_OPTIONS = Object.freeze(['phone', 'zipCode', 'fallbackTimezone']);
/** Options `evaluate` understands. */
const EVALUATE_OPTIONS = Object.freeze([...JURISDICTION_OPTIONS, 'now']);
/** Options `nextEligibleAt` understands. */
const NEXT_ELIGIBLE_OPTIONS = Object.freeze([...EVALUATE_OPTIONS, 'maxDays']);

/** A `{…}` literal, not an array, a Date, or any other class instance. */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Name a bad argument in a way that points at the mistake. */
function describe(value) {
  if (Array.isArray(value)) return 'an array';
  const name = value && value.constructor && value.constructor.name;
  return name ? `a ${name}` : typeof value;
}

/**
 * Reject any option key this method does not read.
 *
 * Every input here is optional, so an unrecognised key would otherwise be
 * dropped in silence — and the one that matters most is the one you are least
 * likely to notice losing. `fallbackTimezone` is consulted only when neither
 * ZIP nor area code resolves a jurisdiction, so a misspelling of it passes
 * every test that supplies a resolvable phone number and then, for the slice
 * of recipients where nothing else resolves, produces `no_timezone_resolved`
 * on every send. That fails closed, so nothing unlawful goes out — but it
 * presents as "quiet hours" rather than as the configuration bug it is, and
 * `nextEligibleAt` degrades from deferring a message to dropping it.
 *
 * A typo should cost you a stack trace at the call site, not a silent outage
 * for an unknown fraction of your recipients.
 *
 * @param {*} args
 * @param {ReadonlyArray<string>} allowed
 * @param {string} where - method name, for the message
 * @throws {TypeError} on a non-object, or any key outside `allowed`
 */
function assertKnownOptions(args, allowed, where) {
  if (args === null || args === undefined) return;
  // A plain object specifically. An array or a class instance has no own keys
  // to object to, so it would slip through the loop below and produce a
  // fail-closed verdict — and `evaluate(someDate)` is exactly the mistake
  // somebody makes when they assume the argument is `now`. Silently answering
  // it is the failure this guard exists to prevent.
  if (!isPlainObject(args)) {
    throw new TypeError(
      `QuietHoursEngine.${where}: options must be a plain object `
      + `(got ${describe(args)}). Did you mean { now: … }?`,
    );
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new TypeError(
        `QuietHoursEngine.${where}: unknown option '${key}' `
        + `(expected one of: ${allowed.join(', ')}). `
        + 'Silently ignoring it would hide a missing fallback timezone until it '
        + 'blocked live sends.',
      );
    }
  }
}

/**
 * Evaluates TCPA quiet-hours eligibility against a rule set.
 *
 * The default export is a ready-built instance using the bundled rules, which
 * is what most callers want. Construct your own when you need to correct or
 * extend the table — the README is explicit that these statutes change, and
 * waiting on a release of this package is not an acceptable compliance
 * posture:
 *
 *   const engine = new QuietHoursEngine({
 *     rules: { OK: { startMinutes: 8 * 60, endMinutes: 20 * 60 } },
 *   });
 */
class QuietHoursEngine {
  /**
   * @param {object} [options]
   * @param {Object<string, {startMinutes: number, endMinutes: number,
   *   excludesSundays?: boolean, label?: string, citation?: string,
   *   lastVerified?: string}>} [options.rules] - state overrides merged over
   *   the bundled table. A key already present replaces that state's rule.
   * @param {(args: {phone?: string, zipCode?: string, fallbackTimezone?: string})
   *   => {state: ?string, timezone: ?string, source: string}} [options.resolver]
   *   - replaces ZIP/area-code resolution wholesale, for callers who hold a
   *   verified billing address and should not be guessing from a phone number.
   * @throws {TypeError} if any supplied rule is malformed
   */
  constructor({ rules, resolver } = {}) {
    if (rules !== undefined && (rules === null || typeof rules !== 'object')) {
      throw new TypeError('QuietHoursEngine: rules must be an object keyed by state code');
    }
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError('QuietHoursEngine: resolver must be a function');
    }

    const merged = { ...STATE_RULES };
    for (const [code, rule] of Object.entries(rules || {})) {
      merged[code.toUpperCase()] = normalizeRule(code.toUpperCase(), rule);
    }

    /** @type {Readonly<Object<string, object>>} */
    this.rules = deepFreeze(merged);
    this._resolver = resolver || null;
    Object.freeze(this);
  }

  /**
   * Decide whether contacting this recipient is permitted at `now`.
   *
   * The verdict names the jurisdiction *and* how it was resolved, so an audit
   * six months later can answer "why was 8:30 PM eligible for this recipient?"
   * from the log line alone: `{state: 'MD', source: 'zip', ruleApplied: 'MD'}`.
   *
   * Every field is always present, so the shape is stable enough to log
   * structurally and to index on.
   *
   * @param {object} args
   * @param {string} [args.phone] - E.164 or 10/11-digit NANP, e.g. '+15551234567'
   * @param {string|number} [args.zipCode] - 5-digit US ZIP or ZIP+4; the first
   *   3 digits are used. An integer is zero-padded; a partial string is ignored.
   * @param {string} [args.fallbackTimezone] - IANA zone used when nothing else resolves
   * @param {Date|number} [args.now] - defaults to the current instant
   * @returns {{eligible: boolean, reason: ?string, state: ?string,
   *   timezone: ?string, source: string, ruleApplied: ?string}}
   * @throws {TypeError} on an unrecognised option key
   */
  evaluate(args) {
    assertKnownOptions(args, EVALUATE_OPTIONS, 'evaluate');
    const { phone, zipCode, fallbackTimezone, now = new Date() } = args || {};
    const { state, timezone, source } = this.resolveJurisdiction({ phone, zipCode, fallbackTimezone });
    const verdict = (eligible, reason, ruleApplied = null) =>
      ({ eligible, reason, state, timezone, source, ruleApplied });

    // Fail closed. An unknown recipient location is not permission.
    if (!timezone) return verdict(false, REASONS.NO_TIMEZONE);

    const instant = toInstant(now);
    if (!instant) return verdict(false, REASONS.INVALID_NOW);

    const rule = this._ruleFor(state);

    let local;
    try {
      local = wallClockPartsInZone(instant, timezone);
    } catch (_err) {
      // Intl throws RangeError on anything that is not an IANA zone id —
      // including the Windows ids ("Eastern Standard Time") that
      // Microsoft-stack products export.
      return verdict(false, REASONS.TIMEZONE_UNPARSEABLE, rule.label);
    }

    // A day we could not read is NOT "some day other than Sunday". Treating it
    // that way would turn the six Sunday blackouts into a no-op — the exact
    // violation this library exists to prevent — so it fails closed with the
    // rest of the unreadable-clock cases.
    if (local.dayOfWeek === UNKNOWN_DAY
      || !Number.isFinite(local.hour) || !Number.isFinite(local.minute)) {
      return verdict(false, REASONS.TIMEZONE_UNPARSEABLE, rule.label);
    }

    if (rule.excludesSundays && local.dayOfWeek === 0) {
      return verdict(false, REASONS.SUNDAY_BLACKOUT, rule.label);
    }

    // End-exclusive: 9:00 PM sharp is blocked. The statute bars contact
    // "after 9 PM", so the boundary minute is arguably lawful — we take the
    // conservative side, because the cost of being wrong is asymmetric.
    const inside = local.minutesOfDay >= rule.startMinutes
      && local.minutesOfDay < rule.endMinutes;

    return verdict(inside, inside ? null : REASONS.OUTSIDE_WINDOW, rule.label);
  }

  /**
   * The next instant at which this recipient becomes contactable.
   *
   * A sender that only knows "not now" can only drop the message. To *defer*
   * it — which is what someone who scheduled a 9:30 PM blast actually wants —
   * you need a time to defer to. Returns `now` when already eligible.
   *
   * @param {object} args - same jurisdiction inputs as evaluate()
   * @param {Date|number} [args.now]
   * @param {number} [args.maxDays=8] - search horizon; never loops forever
   * @returns {Date|null} null when nothing resolves or nothing inside the
   *   horizon qualifies. Treat null as unsendable, not as "defer indefinitely".
   * @throws {TypeError} if maxDays is not a positive finite number, or on an
   *   unrecognised option key
   */
  nextEligibleAt(args) {
    assertKnownOptions(args, NEXT_ELIGIBLE_OPTIONS, 'nextEligibleAt');
    const { phone, zipCode, fallbackTimezone, now = new Date(), maxDays = 8 } = args || {};
    if (!Number.isFinite(maxDays) || maxDays <= 0) {
      // Silently returning null here would be indistinguishable from "this
      // recipient is never contactable", which is a very expensive thing to
      // debug from a queue that quietly stopped draining.
      throw new TypeError(`nextEligibleAt: maxDays must be a positive number (got ${maxDays})`);
    }

    const start = toInstant(now);
    if (!start) return null;

    // Resolve once. `evaluate` would re-resolve on every probe, and this loop
    // probes up to `maxDays` times.
    const { state, timezone } = this.resolveJurisdiction({ phone, zipCode, fallbackTimezone });
    if (!timezone) return null;
    const rule = this._ruleFor(state);

    const partsAt = (date) => {
      try {
        const parts = wallClockPartsInZone(date, timezone);
        return parts.dayOfWeek === UNKNOWN_DAY || !Number.isFinite(parts.minutesOfDay)
          ? null
          : parts;
      } catch (_err) {
        return null;
      }
    };

    const horizon = start.getTime() + maxDays * MS_PER_DAY;
    // Copy, so the returned Date is never the caller's own object in the
    // already-eligible case — handing back a live reference invites a caller
    // to mutate the argument they passed in.
    let cursor = new Date(start.getTime());

    while (cursor.getTime() <= horizon) {
      const parts = partsAt(cursor);
      if (!parts) return null;

      const blackedOut = rule.excludesSundays && parts.dayOfWeek === 0;
      const minutes = parts.minutesOfDay;
      if (!blackedOut && minutes >= rule.startMinutes && minutes < rule.endMinutes) {
        return cursor;
      }

      // Aim at the next window open: today's if we are still early, otherwise
      // tomorrow's (past the close, or the whole day is blacked out).
      const jump = (!blackedOut && minutes < rule.startMinutes)
        ? rule.startMinutes - minutes
        : (MINUTES_PER_DAY - minutes) + rule.startMinutes;

      let next = new Date(cursor.getTime() + jump * MS_PER_MINUTE);

      // That jump added ELAPSED time, and a DST transition in between moves
      // the wall clock underneath it — a spring-forward lands the cursor on
      // 9:00 AM local when it was aiming at 8:00. Re-read the clock and take
      // the difference back out. Only a same-day-sized correction is
      // accepted; anything larger means the day moved and the loop should
      // re-derive it from scratch.
      const landed = partsAt(next);
      if (landed) {
        const drift = landed.minutesOfDay - rule.startMinutes;
        if (drift !== 0 && Math.abs(drift) <= MAX_DST_DRIFT_MINUTES) {
          next = new Date(next.getTime() - drift * MS_PER_MINUTE);
        }
      }

      // The cursor must advance strictly, or a drift correction that lands on
      // or behind the current position would spin the loop forever.
      cursor = next.getTime() > cursor.getTime()
        ? next
        : new Date(cursor.getTime() + MS_PER_MINUTE);
    }

    return null;
  }

  /**
   * Resolve {state, timezone, source} from the strongest signal available.
   *
   * ZIP beats area code because area codes travel: someone who moved from
   * Chicago to Phoenix keeps their 312 number, and Arizona does not observe
   * DST. Treat an area-code resolution as a weak signal.
   *
   * @param {{phone?: string, zipCode?: string, fallbackTimezone?: string}} args
   * @returns {{state: ?string, timezone: ?string, source: string}}
   * @throws {TypeError} on an unrecognised option key
   */
  resolveJurisdiction(args) {
    assertKnownOptions(args, JURISDICTION_OPTIONS, 'resolveJurisdiction');
    const { phone, zipCode, fallbackTimezone } = args || {};
    if (this._resolver) {
      const resolved = this._resolver({ phone, zipCode, fallbackTimezone });
      // Fail loud, not with a destructuring error three frames away: a
      // resolver that returns nothing is a wiring bug, not a jurisdiction.
      if (!resolved || typeof resolved !== 'object') {
        throw new TypeError('QuietHoursEngine: resolver must return {state, timezone, source}');
      }
      return resolved;
    }

    // 1. ZIP — geographic, and the only signal that cannot follow a person.
    const zip3 = parseZip3(zipCode);
    if (zip3 !== null) {
      const state = jurisdiction.getZipState(zip3);
      // zip3 is passed through so a border ZIP in a multi-timezone state (the
      // Florida Panhandle, El Paso) resolves to its actual zone rather than
      // the state's most-populous one.
      const timezone = state ? jurisdiction.getStateTimezone(state, zip3) : null;
      // A prefix can name a place with no usable zone — military APO/FPO is
      // the common case. That is a failed ZIP resolution, not a resolution
      // that happens to be blank, so keep looking rather than discarding a
      // perfectly good phone number.
      if (timezone) return { state, timezone, source: SOURCES.ZIP };
    }

    // 2. Area code — weaker, for the reason above, but better than nothing.
    const areaCode = extractAreaCode(phone);
    if (areaCode !== null) {
      const state = jurisdiction.getAreaCodeState(areaCode);
      const timezone = state ? jurisdiction.getStateTimezone(state) : null;
      if (timezone) return { state, timezone, source: SOURCES.AREA_CODE };
    }

    // 3. Caller-supplied fallback. State is unknown, so only the federal rule
    //    can apply — a state override cannot be assumed from a guess.
    if (fallbackTimezone) {
      return { state: null, timezone: fallbackTimezone, source: SOURCES.FALLBACK };
    }

    return { state: null, timezone: null, source: SOURCES.UNRESOLVED };
  }

  /**
   * The rule governing `state`, falling back to federal.
   * @private
   */
  _ruleFor(state) {
    if (!state) return FEDERAL_RULE;
    return Object.prototype.hasOwnProperty.call(this.rules, state)
      ? this.rules[state]
      : FEDERAL_RULE;
  }
}

/**
 * Parse the 3-digit prefix out of a US ZIP code.
 *
 * Only a full ZIP is trusted — a 5- or 9-digit string, or an integer up to
 * 99999. Anything shorter is a guess, and a guessed prefix is worse than none:
 * `'1001'` read as prefix 100 answers New York for what was probably 01001,
 * Massachusetts, and a Canadian postal code ('K1A 0B1') contains exactly three
 * digits that would otherwise "resolve" to a US state. Failing here lets
 * resolution fall through to the phone number instead.
 *
 *   '30305'      → 303
 *   '30305-1234' → 303
 *   '01001'      → 10
 *   1001         → 10    (numbers are zero-padded — a leading zero cannot
 *                         survive a numeric column, so 1001 must mean 01001)
 *   '1001'       → null  (a 4-digit string is a typo, not a ZIP)
 *   'K1A 0B1'    → null
 *
 * @param {string|number} zipCode
 * @returns {number|null}
 */
function parseZip3(zipCode) {
  if (typeof zipCode === 'number') {
    if (!Number.isInteger(zipCode) || zipCode < 0 || zipCode > 99999) return null;
    return Number.parseInt(String(zipCode).padStart(5, '0').slice(0, 3), 10);
  }
  if (typeof zipCode !== 'string') return null;
  const digits = zipCode.replace(/[^0-9]/g, '');
  if (digits.length !== 5 && digits.length !== 9) return null;
  return Number.parseInt(digits.slice(0, 3), 10);
}

/**
 * Extract the 3-digit NANP area code from a phone number.
 *
 *   '+15551234567' → 555
 *   '5551234567'   → 555
 *   '+44...'       → null  (non-NANP country code)
 *   '0001234567'   → null  (an NPA cannot begin with 0 or 1)
 *
 * @param {string} phone
 * @returns {number|null}
 */
function extractAreaCode(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/[^0-9]/g, '');

  let national;
  if (digits.length === 11 && digits.charAt(0) === '1') {
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else {
    return null;
  }

  // An NPA is N-X-X: the leading digit is 2-9. Rejecting the rest here means
  // no caller downstream has to rely on 0 being falsy to skip a bad parse.
  const npa = national.slice(0, 3);
  if (!/^[2-9][0-9]{2}$/.test(npa)) return null;
  return Number.parseInt(npa, 10);
}

/** Ready-built engine using the bundled rules — what most callers want. */
const defaultEngine = new QuietHoursEngine();

// A namespace, not the instance itself. Exporting the instance and bolting the
// class onto it as a property reads as a singleton by accident; this says
// plainly that the module offers a default engine AND the class to build your
// own, and it leaves the instance free to be frozen.
module.exports = {
  evaluate: (args) => defaultEngine.evaluate(args),
  nextEligibleAt: (args) => defaultEngine.nextEligibleAt(args),
  resolveJurisdiction: (args) => defaultEngine.resolveJurisdiction(args),

  defaultEngine,
  QuietHoursEngine,

  FEDERAL_RULE,
  STATE_RULES,
  SOURCES,
  REASONS,

  extractAreaCode,
  parseZip3,
};
