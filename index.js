/**
 * tcpa-quiet-hours — is it legal to send this marketing message right now?
 *
 * The federal rule (TCPA, 47 CFR 64.1200) bars telemarketing before 8 AM or
 * after 9 PM in the *called party's* local time. Many states tighten that:
 * an earlier close (8 PM is common, 7 PM in Pennsylvania), a later open (9 or
 * 10 AM), a different window on Saturdays or Sundays, no Sundays at all, no
 * state holidays. This library encodes those rules, works out which
 * jurisdiction applies from whatever identifying signal you have, and reads
 * the clock where the recipient is.
 *
 * Pure evaluation — no I/O, no network, no database, zero runtime dependencies.
 *
 * NOT LEGAL ADVICE, and the bundled table is not a claim of completeness.
 * State telemarketing statutes are amended often. Every rule carries the
 * statute it is drawn from and a link to it; verify against current law before
 * you rely on this, and inject your own rules when you find a difference — see
 * `new QuietHoursEngine({rules})`.
 */
'use strict';

const { wallClockPartsInZone, UNKNOWN_DAY } = require('./timezone');
const { deepFreeze } = require('./freeze');
const { normalizeCalendar, holidayOn } = require('./holidays');
const jurisdiction = require('./jurisdiction-data');
const bundled = require('./rules');

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
  /** A zone involved is not an IANA identifier the runtime accepts. */
  TIMEZONE_UNPARSEABLE: 'timezone_unparseable',
  /** `now` was not a Date or epoch-millisecond number. */
  INVALID_NOW: 'invalid_now',
  /** The state bans contact on Sundays and it is Sunday there. */
  SUNDAY_BLACKOUT: 'state_sunday_blackout',
  /** The state bans contact on this weekday (other than Sunday). */
  DAY_BLACKOUT: 'state_day_blackout',
  /** The state bans contact on its holidays and today is one. */
  HOLIDAY_BLACKOUT: 'state_holiday_blackout',
  /** Outside the permitted time-of-day window. */
  OUTSIDE_WINDOW: 'outside_window',
});

/** How a jurisdiction was determined, reported on every verdict. */
const SOURCES = deepFreeze({
  ZIP: 'zip',
  AREA_CODE: 'area_code',
  /**
   * A second jurisdiction, from a state whose statute presumes that a number
   * with one of its area codes reaches a resident — whatever the ZIP says.
   */
  AREA_CODE_PRESUMPTION: 'area_code_presumption',
  FALLBACK: 'fallback',
  UNRESOLVED: 'unresolved',
});

/** What a rule says about text messages, as opposed to voice calls. */
const TEXT_COVERAGE = Object.freeze(['yes', 'unclear', 'no']);

const DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

const RULE_FIELDS = Object.freeze([
  'windows', 'startMinutes', 'endMinutes', 'excludesSundays', 'holidays',
  'effectiveFrom', 'fixedClock', 'areaCodePresumption', 'coversText',
  'label', 'citation', 'sourceUrl', 'lastVerified', 'note',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a time of day as minutes from midnight: an integer, or 'HH:MM'.
 * '24:00' is the end of the day.
 */
function toMinutes(where, value) {
  let minutes = value;
  if (typeof value === 'string') {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    minutes = match && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new TypeError(`${where} must be 'HH:MM' or an integer in 0..${MINUTES_PER_DAY} (got ${value})`);
  }
  return minutes;
}

/** One day's window: `[start, end]` → `{start, end}` in minutes, or null for closed. */
function normalizeWindow(where, value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${where} must be [start, end] or null (got ${JSON.stringify(value)})`);
  }
  const start = toMinutes(`${where} start`, value[0]);
  const end = toMinutes(`${where} end`, value[1]);
  if (start >= end) {
    throw new TypeError(`${where}: start (${value[0]}) must be before end (${value[1]})`);
  }
  return Object.freeze({ start, end });
}

/**
 * The seven daily windows, Sunday first, from either rule shape:
 *
 *   { windows: { default: ['09:00', '21:00'], sun: ['12:00', '21:00'], sat: null } }
 *   { startMinutes: 480, endMinutes: 1200, excludesSundays: true }     (1.x shape)
 *
 * A day not named takes `default`; a day set to null is closed.
 */
function normalizeWindows(where, rule) {
  const legacy = rule.startMinutes !== undefined || rule.endMinutes !== undefined
    || rule.excludesSundays !== undefined;
  if (rule.windows !== undefined && legacy) {
    throw new TypeError(`${where}: give either windows or startMinutes/endMinutes/excludesSundays, not both`);
  }
  if (rule.windows === undefined) {
    const { excludesSundays = false } = rule;
    if (typeof excludesSundays !== 'boolean') {
      throw new TypeError(`${where}: excludesSundays must be a boolean (got ${typeof excludesSundays})`);
    }
    const day = normalizeWindow(where, [
      toMinutes(`${where}: startMinutes`, rule.startMinutes),
      toMinutes(`${where}: endMinutes`, rule.endMinutes),
    ]);
    return Object.freeze(DAY_KEYS.map((key) => (key === 'sun' && excludesSundays ? null : day)));
  }
  const windows = rule.windows;
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) {
    throw new TypeError(`${where}: windows must be an object keyed by default/sun/mon/…/sat`);
  }
  for (const key of Object.keys(windows)) {
    if (key !== 'default' && !DAY_KEYS.includes(key)) {
      throw new TypeError(`${where}: unknown windows key '${key}' (expected default, ${DAY_KEYS.join(', ')})`);
    }
  }
  return Object.freeze(DAY_KEYS.map((key) => {
    if (Object.prototype.hasOwnProperty.call(windows, key)) return normalizeWindow(`${where}: windows.${key}`, windows[key]);
    if (!Object.prototype.hasOwnProperty.call(windows, 'default')) {
      throw new TypeError(`${where}: windows.${key} is missing and there is no default`);
    }
    return normalizeWindow(`${where}: windows.default`, windows.default);
  }));
}

/**
 * Validate one rule and return a frozen copy.
 *
 * A caller-supplied rule that is subtly malformed — a string where a number
 * belongs, a window that closes before it opens, a misspelled field — would
 * otherwise degrade into a permanently-ineligible recipient or, worse, a
 * silently widened window. Fail at construction, where the stack trace still
 * points at the caller.
 *
 * @param {string} code - the state key this rule is registered under
 * @param {object} rule
 * @param {Object<string, object>} calendars - named holiday calendars
 * @returns {Readonly<object>}
 * @throws {TypeError} on any malformed field
 */
function normalizeRule(code, rule, calendars) {
  const where = `QuietHoursEngine: rule '${code}'`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError(`${where} must be an object`);
  }
  for (const key of Object.keys(rule)) {
    if (!RULE_FIELDS.includes(key)) {
      throw new TypeError(`${where}: unknown field '${key}' (expected one of: ${RULE_FIELDS.join(', ')})`);
    }
  }

  const windows = normalizeWindows(where, rule);

  let holidays = null;
  if (typeof rule.holidays === 'string') {
    if (!Object.prototype.hasOwnProperty.call(calendars, rule.holidays)) {
      throw new TypeError(`${where}: no holiday calendar named '${rule.holidays}'`);
    }
    holidays = calendars[rule.holidays];
  } else if (rule.holidays !== undefined && rule.holidays !== null) {
    holidays = normalizeCalendar(`${where}: holidays`, rule.holidays);
  }

  const effectiveFrom = rule.effectiveFrom === undefined ? null : rule.effectiveFrom;
  if (effectiveFrom !== null && (typeof effectiveFrom !== 'string' || !ISO_DATE.test(effectiveFrom))) {
    throw new TypeError(`${where}: effectiveFrom must be 'YYYY-MM-DD' (got ${effectiveFrom})`);
  }

  const fixedClock = rule.fixedClock === undefined ? null : rule.fixedClock;
  if (fixedClock !== null) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: fixedClock });
    } catch (_err) {
      throw new TypeError(`${where}: fixedClock must be an IANA zone (got ${fixedClock})`);
    }
  }

  const { areaCodePresumption = false, coversText = 'unclear' } = rule;
  if (typeof areaCodePresumption !== 'boolean') {
    throw new TypeError(`${where}: areaCodePresumption must be a boolean`);
  }
  if (!TEXT_COVERAGE.includes(coversText)) {
    throw new TypeError(`${where}: coversText must be one of ${TEXT_COVERAGE.join(', ')} (got ${coversText})`);
  }

  const text = (value) => (typeof value === 'string' && value ? value : null);
  return deepFreeze({
    state: code,
    label: text(rule.label) || code,
    windows,
    holidays,
    effectiveFrom,
    fixedClock,
    areaCodePresumption,
    coversText,
    citation: text(rule.citation),
    sourceUrl: text(rule.sourceUrl),
    lastVerified: text(rule.lastVerified),
    note: text(rule.note),
  });
}

/**
 * A state's rule history: one rule, or an array of versions each taking
 * effect on its `effectiveFrom` date (the recipient's local date). Returned
 * oldest first.
 */
function normalizeVersions(code, input, calendars) {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) throw new TypeError(`QuietHoursEngine: rule '${code}' has no versions`);
  const versions = list
    .map((rule) => normalizeRule(code, rule, calendars))
    .sort((a, b) => (a.effectiveFrom || '').localeCompare(b.effectiveFrom || ''));
  const dates = versions.map((v) => v.effectiveFrom || '');
  if (new Set(dates).size !== dates.length) {
    throw new TypeError(`QuietHoursEngine: rule '${code}' has two versions with the same effectiveFrom`);
  }
  return Object.freeze(versions);
}

const CALENDARS = deepFreeze(Object.fromEntries(
  Object.entries(bundled.HOLIDAY_CALENDARS)
    .map(([name, calendar]) => [name, normalizeCalendar(`holiday calendar '${name}'`, calendar)]),
));

/** Federal TCPA default: 8 AM – 9 PM called-party local, every day. */
const FEDERAL_RULE = normalizeRule('federal', {
  windows: { default: ['08:00', '21:00'] },
  label: 'federal',
  coversText: 'yes',
  citation: '47 CFR 64.1200(c)(1)',
  sourceUrl: 'https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200',
}, CALENDARS);

/** The bundled state rules, each a list of versions (oldest first). */
const STATE_RULES = deepFreeze(Object.fromEntries(
  Object.entries(bundled.STATE_RULES)
    .map(([code, input]) => [code, normalizeVersions(code, input, CALENDARS)]),
));

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

/** Wall-clock parts, or null for a zone Intl rejects or a day it cannot name. */
function readClock(instant, timeZone) {
  let parts;
  try {
    parts = wallClockPartsInZone(instant, timeZone);
  } catch (_err) {
    // Intl throws RangeError on anything that is not an IANA zone id —
    // including the Windows ids ("Eastern Standard Time") that Microsoft-stack
    // products export.
    return null;
  }
  // A day we could not read is NOT "some day other than Sunday". Treating it
  // that way would turn every Sunday and holiday blackout into a no-op.
  if (parts.dayOfWeek === UNKNOWN_DAY || !Number.isFinite(parts.minutesOfDay)
    || !ISO_DATE.test(parts.isoDate)) {
    return null;
  }
  return parts;
}

/**
 * Is `rule` satisfied on this wall clock? Returns the reason it is not, or null.
 *
 * End-exclusive: 9:00 PM sharp is blocked. The statutes bar contact "after
 * 9 PM", so the boundary minute is arguably lawful — we take the conservative
 * side, because the cost of being wrong is asymmetric.
 */
function blockedBy(rule, parts) {
  const window = rule.windows[parts.dayOfWeek];
  if (!window) return parts.dayOfWeek === 0 ? REASONS.SUNDAY_BLACKOUT : REASONS.DAY_BLACKOUT;
  if (rule.holidays && holidayOn(rule.holidays, parts.year, parts.isoDate)) return REASONS.HOLIDAY_BLACKOUT;
  if (parts.minutesOfDay < window.start || parts.minutesOfDay >= window.end) return REASONS.OUTSIDE_WINDOW;
  return null;
}

/** Options `resolveJurisdiction` understands. */
const JURISDICTION_OPTIONS = Object.freeze(['phone', 'zipCode', 'fallbackTimezone']);
/** Options `evaluate` understands. */
const EVALUATE_OPTIONS = Object.freeze([...JURISDICTION_OPTIONS, 'now']);
/** Options `nextEligibleAt` understands. */
const NEXT_ELIGIBLE_OPTIONS = Object.freeze([...EVALUATE_OPTIONS, 'maxDays']);
/** Options the constructor understands. */
const ENGINE_OPTIONS = Object.freeze(['rules', 'resolver', 'onlyRulesCoveringText']);

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
        + `(expected one of: ${allowed.join(', ')}).`
        + (allowed.includes('fallbackTimezone')
          ? ' Silently ignoring it would hide a missing fallback timezone until it blocked live sends.'
          : ''),
      );
    }
  }
}

/**
 * Evaluates TCPA quiet-hours eligibility against a rule set.
 *
 * The module-level functions use a ready-built instance with the bundled
 * rules, which is what most callers want. Construct your own when you need to
 * correct or extend the table — these statutes change, and waiting on a
 * release of this package is not an acceptable compliance posture:
 *
 *   const engine = new QuietHoursEngine({
 *     rules: { OK: { windows: { default: ['08:00', '20:00'] } } },
 *   });
 */
class QuietHoursEngine {
  /**
   * @param {object} [options]
   * @param {Object<string, object|object[]>} [options.rules] - state rules
   *   merged over the bundled table, keyed by state code. A key already present
   *   replaces that state's rule history entirely. A value may be one rule or
   *   an array of versions with `effectiveFrom` dates.
   * @param {(args: {phone?: string, zipCode?: string, fallbackTimezone?: string})
   *   => {state: ?string, timezone: ?string, source: string}} [options.resolver]
   *   - replaces ZIP/area-code resolution wholesale, for callers who hold a
   *   verified address and should not be guessing from a phone number.
   * @param {boolean} [options.onlyRulesCoveringText=false] - apply only state
   *   rules whose statute clearly covers text messages (`coversText: 'yes'`);
   *   the rest fall back to the federal rule. Off by default, because a court
   *   may yet read "call" to include a text. Turn it on only on your counsel's
   *   advice, and only for a channel that sends nothing but texts.
   * @throws {TypeError} if any supplied rule or option is malformed
   */
  constructor(options = {}) {
    assertKnownOptions(options, ENGINE_OPTIONS, 'constructor');
    const { rules, resolver, onlyRulesCoveringText = false } = options || {};
    if (rules !== undefined && (rules === null || typeof rules !== 'object' || Array.isArray(rules))) {
      throw new TypeError('QuietHoursEngine: rules must be an object keyed by state code');
    }
    if (resolver !== undefined && typeof resolver !== 'function') {
      throw new TypeError('QuietHoursEngine: resolver must be a function');
    }
    if (typeof onlyRulesCoveringText !== 'boolean') {
      throw new TypeError('QuietHoursEngine: onlyRulesCoveringText must be a boolean');
    }

    const merged = { ...STATE_RULES };
    for (const [code, input] of Object.entries(rules || {})) {
      const key = code.toUpperCase();
      merged[key] = normalizeVersions(key, input, CALENDARS);
    }

    /** @type {Readonly<Object<string, ReadonlyArray<object>>>} */
    this.rules = deepFreeze(merged);
    this._resolver = resolver || null;
    this._onlyRulesCoveringText = onlyRulesCoveringText;
    Object.freeze(this);
  }

  /**
   * Decide whether contacting this recipient is permitted at `now`.
   *
   * The verdict names the jurisdiction *and* how it was resolved, so an audit
   * six months later can answer "why was 8:30 PM eligible for this recipient?"
   * from the log line alone: `{state: 'MD', source: 'zip', ruleApplied: 'MD'}`.
   *
   * When a second jurisdiction applies — a ZIP in one state and a phone
   * number from a state whose statute presumes residency by area code — the
   * message must be lawful under both. `jurisdictions` lists every one that
   * was checked; `ruleApplied` names the rule that decided the verdict.
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
   *   timezone: ?string, source: string, ruleApplied: ?string,
   *   jurisdictions: Array<{state: ?string, timezone: string, source: string,
   *   ruleApplied: string, eligible: boolean, reason: ?string}>}}
   * @throws {TypeError} on an unrecognised option key
   */
  evaluate(args) {
    assertKnownOptions(args, EVALUATE_OPTIONS, 'evaluate');
    const { phone, zipCode, fallbackTimezone, now = new Date() } = args || {};
    const found = this._jurisdictions({ phone, zipCode, fallbackTimezone });
    const [{ state, timezone, source }] = found;
    const verdict = (eligible, reason, ruleApplied, jurisdictions) =>
      ({ eligible, reason, state, timezone, source, ruleApplied, jurisdictions });

    // Fail closed. An unknown recipient location is not permission.
    if (!timezone) return verdict(false, REASONS.NO_TIMEZONE, null, []);

    const instant = toInstant(now);
    if (!instant) return verdict(false, REASONS.INVALID_NOW, null, []);

    const checked = found.map((j) => ({ j, result: this._check(j, instant) }));
    const jurisdictions = checked.map(({ j, result }) => ({
      state: j.state,
      timezone: j.timezone,
      source: j.source,
      ruleApplied: result.rule.label,
      eligible: result.reason === null,
      reason: result.reason,
    }));
    const deciding = checked.find(({ result }) => result.reason !== null) || checked[0];
    return verdict(
      deciding.result.reason === null,
      deciding.result.reason,
      deciding.result.rule.label,
      jurisdictions,
    );
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

    // Resolve once. `evaluate` would re-resolve on every probe.
    const found = this._jurisdictions({ phone, zipCode, fallbackTimezone });
    if (!found[0].timezone) return null;

    const horizon = start.getTime() + maxDays * MS_PER_DAY;
    // Copy, so the returned Date is never the caller's own object in the
    // already-eligible case — handing back a live reference invites a caller
    // to mutate the argument they passed in.
    let cursor = new Date(start.getTime());

    while (cursor.getTime() <= horizon) {
      const failures = [];
      for (const j of found) {
        const result = this._check(j, cursor);
        if (result.reason === REASONS.TIMEZONE_UNPARSEABLE) return null;
        if (result.reason !== null) failures.push(result);
      }
      if (failures.length === 0) return cursor;

      // Every failing constraint names the earliest instant it could next be
      // satisfied; no eligible instant can come before the latest of those.
      let next = cursor.getTime();
      for (const failure of failures) next = Math.max(next, this._nextOpening(failure, cursor));

      // The cursor must advance strictly, or a drift correction that lands on
      // or behind the current position would spin the loop forever.
      cursor = next > cursor.getTime()
        ? new Date(next)
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
   * This is the PRIMARY jurisdiction. `resolveJurisdictions` adds the
   * area-code presumption a few states' statutes impose on top of it.
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
      // Rule keys are upper-case. A resolver that answers 'md' from a billing
      // address must still get Maryland's 8 PM close, not the federal 9 PM —
      // a case mismatch would otherwise widen the window without a word.
      const state = typeof resolved.state === 'string' && resolved.state.trim()
        ? resolved.state.trim().toUpperCase()
        : null;
      return { ...resolved, state };
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
      // Per-code, not per-state: 915 is El Paso and keeps Mountain time even
      // though Texas defaults to Central.
      const timezone = jurisdiction.getAreaCodeTimezone(areaCode);
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
   * Every jurisdiction a message to this recipient must satisfy: the primary
   * one, plus — when the ZIP and the phone number point at different states,
   * and the phone's state presumes residency by area code (Florida,
   * Oklahoma, Maryland and Connecticut do) — that state too, on the clock its
   * area code implies.
   *
   * A custom resolver is taken as authoritative and gets no presumption added:
   * a verified address is exactly the evidence that rebuts one.
   *
   * @param {{phone?: string, zipCode?: string, fallbackTimezone?: string}} args
   * @returns {Array<{state: ?string, timezone: ?string, source: string}>}
   *   primary first; never empty
   * @throws {TypeError} on an unrecognised option key
   */
  resolveJurisdictions(args) {
    assertKnownOptions(args, JURISDICTION_OPTIONS, 'resolveJurisdictions');
    return this._jurisdictions(args || {});
  }

  /** @private */
  _jurisdictions({ phone, zipCode, fallbackTimezone }) {
    const primary = this.resolveJurisdiction({ phone, zipCode, fallbackTimezone });
    const found = [primary];
    if (this._resolver || primary.source !== SOURCES.ZIP) return found;

    const areaCode = extractAreaCode(phone);
    const state = areaCode === null ? null : jurisdiction.getAreaCodeState(areaCode);
    if (!state || state === primary.state) return found;
    const presumes = (this.rules[state] || []).some((rule) => rule.areaCodePresumption);
    if (!presumes) return found;

    const timezone = jurisdiction.getAreaCodeTimezone(areaCode);
    if (timezone) found.push({ state, timezone, source: SOURCES.AREA_CODE_PRESUMPTION });
    return found;
  }

  /**
   * The rule in force for `state` on a local date, falling back to federal.
   *
   * @param {?string} state
   * @param {string} isoDate - 'YYYY-MM-DD', the recipient's local date
   * @returns {Readonly<object>}
   */
  ruleFor(state, isoDate) {
    const versions = state && Object.prototype.hasOwnProperty.call(this.rules, state)
      ? this.rules[state]
      : null;
    if (!versions) return FEDERAL_RULE;
    let current = null;
    for (const rule of versions) {
      if (!rule.effectiveFrom || rule.effectiveFrom <= isoDate) current = rule;
    }
    if (!current) return FEDERAL_RULE;
    if (this._onlyRulesCoveringText && current.coversText !== 'yes') return FEDERAL_RULE;
    return current;
  }

  /**
   * Check one jurisdiction at one instant: its rule on the recipient's clock,
   * and — for a statute that names a fixed clock, as Mississippi's "Central
   * Standard Time" does — on that clock as well.
   *
   * @private
   * @returns {{reason: ?string, rule: object, zone?: string, parts?: object}}
   */
  _check(j, instant) {
    const parts = readClock(instant, j.timezone);
    if (!parts) {
      const today = readClock(instant, 'UTC');
      return { reason: REASONS.TIMEZONE_UNPARSEABLE, rule: this.ruleFor(j.state, today.isoDate) };
    }
    const rule = this.ruleFor(j.state, parts.isoDate);
    const reason = blockedBy(rule, parts);
    if (reason) return { reason, rule, zone: j.timezone, parts };

    if (rule.fixedClock) {
      const fixed = readClock(instant, rule.fixedClock);
      if (!fixed) return { reason: REASONS.TIMEZONE_UNPARSEABLE, rule };
      const fixedReason = blockedBy(rule, fixed);
      if (fixedReason) return { reason: fixedReason, rule, zone: rule.fixedClock, parts: fixed };
    }
    return { reason: null, rule };
  }

  /**
   * The earliest instant at which a failed check could pass: today's window
   * open if we are still early, otherwise the next local midnight (where the
   * search re-reads the day — it may be another closed day, a holiday, or a
   * day with a different window).
   *
   * @private
   * @returns {number} epoch milliseconds
   */
  _nextOpening({ rule, zone, parts }, cursor) {
    const window = rule.windows[parts.dayOfWeek];
    const today = window && !(rule.holidays && holidayOn(rule.holidays, parts.year, parts.isoDate));
    const target = today && parts.minutesOfDay < window.start ? window.start : 0;
    const jump = target === 0 ? MINUTES_PER_DAY - parts.minutesOfDay : target - parts.minutesOfDay;

    // From the top of the current minute, so the answer is 8:00:00, not
    // 8:00:37. Every zone in use today has a whole-minute offset.
    let next = Math.floor(cursor.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE + jump * MS_PER_MINUTE;

    // That jump added ELAPSED time, and a DST transition in between moves
    // the wall clock underneath it — a spring-forward lands the cursor on
    // 9:00 AM local when it was aiming at 8:00. Re-read the clock and take
    // the difference back out. Only a same-day-sized correction is
    // accepted; anything larger means the day moved and the loop should
    // re-derive it from scratch.
    const landed = readClock(new Date(next), zone);
    if (landed) {
      let drift = landed.minutesOfDay - target;
      if (drift > MINUTES_PER_DAY / 2) drift -= MINUTES_PER_DAY;
      if (drift <= -MINUTES_PER_DAY / 2) drift += MINUTES_PER_DAY;
      if (drift !== 0 && Math.abs(drift) <= MAX_DST_DRIFT_MINUTES) next -= drift * MS_PER_MINUTE;
    }
    return next;
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
//
// Each export is a plain identifier: Node's cjs-module-lexer only detects named
// exports written that way, and an arrow-function value would leave ESM
// consumers with `import { evaluate }` failing at runtime while the types
// promise it works.

/** {@link QuietHoursEngine#evaluate} on the default engine. */
function evaluate(args) { return defaultEngine.evaluate(args); }
/** {@link QuietHoursEngine#nextEligibleAt} on the default engine. */
function nextEligibleAt(args) { return defaultEngine.nextEligibleAt(args); }
/** {@link QuietHoursEngine#resolveJurisdiction} on the default engine. */
function resolveJurisdiction(args) { return defaultEngine.resolveJurisdiction(args); }
/** {@link QuietHoursEngine#resolveJurisdictions} on the default engine. */
function resolveJurisdictions(args) { return defaultEngine.resolveJurisdictions(args); }

const HOLIDAY_CALENDARS = CALENDARS;

module.exports = {
  evaluate,
  nextEligibleAt,
  resolveJurisdiction,
  resolveJurisdictions,

  defaultEngine,
  QuietHoursEngine,

  FEDERAL_RULE,
  STATE_RULES,
  HOLIDAY_CALENDARS,
  SOURCES,
  REASONS,

  extractAreaCode,
  parseZip3,
};
