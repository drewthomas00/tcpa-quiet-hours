'use strict';

/**
 * Holiday calendars — which local dates a state's telemarketing statute bars.
 *
 * Several states ban solicitation on "holidays" as well as on Sundays, and
 * each means its own list: Louisiana's includes Mardi Gras and Good Friday,
 * Utah's Pioneer Day, Rhode Island's Victory Day. A calendar is plain data —
 * a list of holiday rules plus how the state shifts a fixed-date holiday that
 * lands on a weekend — so a correction is a data change, not a code change.
 *
 * Where a statute is ambiguous the calendar errs towards blocking: a county-
 * or parish-only holiday is treated as statewide, and when a weekend holiday
 * is "observed" on a weekday, BOTH days are blocked. A missed send is the
 * cheap failure; a send on a barred day is not.
 */

const { deepFreeze } = require('./freeze');

/**
 * A holiday rule is exactly one of:
 *
 *   { name, month, day }                        fixed date — July 24
 *   { name, month, weekday, nth }               nth weekday — nth 1..4, or -1
 *                                               for the last; weekday 0=Sunday
 *   { name, easter }                            days from Western Easter Sunday
 *                                               — Good Friday is -2
 *
 * Any of them may add `offset` (days), which is how "the first Tuesday AFTER
 * the first Monday of November" is written: first Monday, offset 1 — and
 * `years: 'even'` or `'odd'` for a holiday that only falls in alternate years,
 * as a general-election day does.
 *
 * @typedef {{name: string, month?: number, day?: number, weekday?: number,
 *   nth?: number, easter?: number, offset?: number, years?: 'even'|'odd'}} HolidayRule
 */

/**
 * How a fixed-date holiday that falls on a weekend is observed:
 *
 *   'none'        only the date itself
 *   'sunday'      a Sunday holiday is also observed on the Monday after
 *   'weekend'     Sunday → also Monday; Saturday → also the Friday before
 *   'any'         Sunday → also Monday; Saturday → also the Friday before AND
 *                 the Monday after — for a list mixing two conventions, as
 *                 Rhode Island's (Saturday → Monday) plus the federal one
 *                 (Saturday → Friday) does
 *
 * Observation never REPLACES the date — both are blocked. Only fixed-date
 * rules are shifted; a weekday rule (Louisiana's third-Saturday Juneteenth,
 * say) is blocked on its own day and never moved.
 *
 * @typedef {'none'|'sunday'|'weekend'|'any'} Observance
 */

const OBSERVANCES = Object.freeze(['none', 'sunday', 'weekend', 'any']);

/** What a calendar may carry besides its holidays. */
const CALENDAR_FIELDS = Object.freeze(['observe', 'holidays', 'citation', 'sourceUrl', 'note']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Western (Gregorian) Easter Sunday, as a UTC midnight timestamp. */
function easterSunday(year) {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

/** The nth (or last, n = -1) `weekday` of a month, as a UTC midnight timestamp. */
function nthWeekday(year, month, weekday, nth) {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return last.getTime() - back * MS_PER_DAY;
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const ahead = (weekday - first.getUTCDay() + 7) % 7;
  return first.getTime() + (ahead + (nth - 1) * 7) * MS_PER_DAY;
}

/** UTC midnight timestamp → 'YYYY-MM-DD'. */
function isoOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Validate a calendar and return a frozen copy.
 *
 * @param {string} where - for the error message
 * @param {{observe?: Observance, holidays: HolidayRule[]}} calendar
 * @returns {Readonly<{observe: Observance, holidays: ReadonlyArray<HolidayRule>}>}
 * @throws {TypeError} on any malformed rule
 */
function normalizeCalendar(where, calendar) {
  if (!calendar || typeof calendar !== 'object' || !Array.isArray(calendar.holidays)) {
    throw new TypeError(`${where}: holidays must be a calendar { observe, holidays: [...] }`);
  }
  for (const key of Object.keys(calendar)) {
    if (!CALENDAR_FIELDS.includes(key)) {
      throw new TypeError(`${where}: unknown calendar field '${key}' (expected one of: ${CALENDAR_FIELDS.join(', ')})`);
    }
  }
  const observe = calendar.observe === undefined ? 'none' : calendar.observe;
  if (!OBSERVANCES.includes(observe)) {
    throw new TypeError(`${where}: observe must be one of ${OBSERVANCES.join(', ')} (got ${observe})`);
  }
  const holidays = calendar.holidays.map((rule, index) => {
    const at = `${where}: holiday #${index} (${rule && rule.name})`;
    if (!rule || typeof rule !== 'object' || typeof rule.name !== 'string' || !rule.name) {
      throw new TypeError(`${at} needs a name`);
    }
    const offset = rule.offset === undefined ? 0 : rule.offset;
    if (!Number.isInteger(offset)) throw new TypeError(`${at}: offset must be an integer`);
    if (rule.years !== undefined && rule.years !== 'even' && rule.years !== 'odd') {
      throw new TypeError(`${at}: years must be 'even' or 'odd'`);
    }
    const years = rule.years ? { years: rule.years } : {};
    const isMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12;
    if (rule.easter !== undefined) {
      if (!Number.isInteger(rule.easter)) throw new TypeError(`${at}: easter must be an integer day offset`);
      return { name: rule.name, easter: rule.easter, offset, ...years };
    }
    if (rule.weekday !== undefined) {
      const okNth = rule.nth === -1 || (Number.isInteger(rule.nth) && rule.nth >= 1 && rule.nth <= 4);
      if (!isMonth(rule.month) || !Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6 || !okNth) {
        throw new TypeError(`${at}: a weekday rule needs month 1-12, weekday 0-6 and nth 1-4 or -1`);
      }
      return { name: rule.name, month: rule.month, weekday: rule.weekday, nth: rule.nth, offset, ...years };
    }
    if (!isMonth(rule.month) || !Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) {
      throw new TypeError(`${at}: a fixed rule needs month 1-12 and day 1-31`);
    }
    return { name: rule.name, month: rule.month, day: rule.day, offset, ...years };
  });
  const text = (value) => (typeof value === 'string' && value ? value : null);
  return deepFreeze({
    observe,
    holidays,
    citation: text(calendar.citation),
    sourceUrl: text(calendar.sourceUrl),
    note: text(calendar.note),
  });
}

/**
 * Every barred local date in `year`, with the holiday it belongs to.
 *
 * Observation can cross a year boundary in both directions, so the years
 * either side are computed too: a Saturday January 1 is observed on Friday
 * December 31, and a Sunday December 31 on Monday January 1.
 *
 * @param {{observe: Observance, holidays: ReadonlyArray<HolidayRule>}} calendar
 * @param {number} year
 * @returns {Map<string, string>} 'YYYY-MM-DD' → holiday name
 */
function datesIn(calendar, year) {
  const out = new Map();
  for (const y of [year - 1, year, year + 1]) {
    for (const rule of calendar.holidays) {
      if (rule.years && (y % 2 === 0) !== (rule.years === 'even')) continue;
      let ts;
      let fixed = false;
      if (rule.easter !== undefined) ts = easterSunday(y) + rule.easter * MS_PER_DAY;
      else if (rule.weekday !== undefined) ts = nthWeekday(y, rule.month, rule.weekday, rule.nth);
      else { ts = Date.UTC(y, rule.month - 1, rule.day); fixed = true; }
      ts += rule.offset * MS_PER_DAY;

      const candidates = [ts];
      if (fixed && rule.offset === 0) {
        const dow = new Date(ts).getUTCDay();
        if (dow === 0 && calendar.observe !== 'none') candidates.push(ts + MS_PER_DAY);
        if (dow === 6 && (calendar.observe === 'weekend' || calendar.observe === 'any')) candidates.push(ts - MS_PER_DAY);
        if (dow === 6 && calendar.observe === 'any') candidates.push(ts + 2 * MS_PER_DAY);
      }
      for (const c of candidates) {
        const iso = isoOf(c);
        if (iso.startsWith(`${year}-`) && !out.has(iso)) out.set(iso, rule.name);
      }
    }
  }
  return out;
}

/** Per-calendar, per-year cache. Calendars are frozen, so identity is a safe key. */
const cache = new WeakMap();

/**
 * The holiday on a local date, or null.
 *
 * @param {{observe: Observance, holidays: ReadonlyArray<HolidayRule>}} calendar
 * @param {number} year
 * @param {string} isoDate - 'YYYY-MM-DD', local to the recipient
 * @returns {string|null} the holiday's name
 */
function holidayOn(calendar, year, isoDate) {
  let byYear = cache.get(calendar);
  if (!byYear) { byYear = new Map(); cache.set(calendar, byYear); }
  let dates = byYear.get(year);
  if (!dates) { dates = datesIn(calendar, year); byYear.set(year, dates); }
  return dates.get(isoDate) || null;
}

module.exports = {
  OBSERVANCES,
  easterSunday,
  normalizeCalendar,
  datesIn,
  holidayOn,
};
