'use strict';

/**
 * The one wall-clock reading this library needs.
 *
 * Everything here hinges on a single question: what time is it *where the
 * recipient is*, right now? The server's clock is never the answer, so when no
 * zone is supplied we fall back to UTC rather than to the machine's local time —
 * a machine-local default silently produces a different verdict depending on
 * which region your servers happen to run in.
 *
 * Internal module. It is not part of the package's public API and its shape
 * may change; use the engine.
 */

const WEEKDAY_INDEX = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
});

/** Returned by `wallClockPartsInZone` when the weekday could not be mapped. */
const UNKNOWN_DAY = -1;

/**
 * One formatter per zone. Building an Intl.DateTimeFormat costs far more than
 * using one, and a deferral search reads the clock many times per call. Only
 * zones Intl accepted are kept, so the cache is bounded by the zones in use.
 */
const formatters = new Map();

function formatterFor(timeZone) {
  let dtf = formatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, dtf);
  }
  return dtf;
}

/**
 * Read `date` on the `timeZone` wall clock, in a single Intl pass.
 *
 * Returns only what the engine consumes. Callers MUST treat
 * `dayOfWeek === UNKNOWN_DAY` as a failure rather than as "not Sunday" — the
 * Sunday blackouts are hard legal gates, and a silent -1 would turn them into
 * a no-op.
 *
 * @param {Date} date
 * @param {string|null} timeZone - IANA zone (e.g. 'America/New_York')
 * @returns {{dayOfWeek: number, hour: number, minute: number, minutesOfDay: number,
 *   year: number, month: number, day: number, isoDate: string}}
 *   `dayOfWeek` is 0=Sunday … 6=Saturday, or `UNKNOWN_DAY`. `month` is 1-12,
 *   and `isoDate` is the local calendar date as 'YYYY-MM-DD'.
 * @throws {RangeError} if `timeZone` is not a recognised IANA identifier.
 */
function wallClockPartsInZone(date, timeZone) {
  const dtf = formatterFor(timeZone || 'UTC');
  const map = Object.create(null);
  for (const part of dtf.formatToParts(date)) map[part.type] = part.value;

  // Some ICU builds report midnight as hour '24'. Normalise before any
  // arithmetic, or a message at 00:15 evaluates as 24:15 and every window
  // comparison silently inverts.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  const weekday = String(map.weekday || '').toLowerCase();
  const dayOfWeek = Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, weekday)
    ? WEEKDAY_INDEX[weekday]
    : UNKNOWN_DAY;

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return { dayOfWeek, hour, minute, minutesOfDay: hour * 60 + minute, year, month, day, isoDate };
}

module.exports = { wallClockPartsInZone, WEEKDAY_INDEX, UNKNOWN_DAY };
