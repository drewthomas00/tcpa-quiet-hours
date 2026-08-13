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
 * Read `date` on the `timeZone` wall clock, in a single Intl pass.
 *
 * Returns only what the engine consumes. Callers MUST treat
 * `dayOfWeek === UNKNOWN_DAY` as a failure rather than as "not Sunday" — the
 * Sunday blackout is a hard legal gate in six jurisdictions, and a silent -1
 * would turn that gate into a no-op.
 *
 * @param {Date} date
 * @param {string|null} timeZone - IANA zone (e.g. 'America/New_York')
 * @returns {{dayOfWeek: number, hour: number, minute: number, minutesOfDay: number}}
 *   `dayOfWeek` is 0=Sunday … 6=Saturday, or `UNKNOWN_DAY`.
 * @throws {RangeError} if `timeZone` is not a recognised IANA identifier.
 */
function wallClockPartsInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  });

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

  return { dayOfWeek, hour, minute, minutesOfDay: hour * 60 + minute };
}

module.exports = { wallClockPartsInZone, WEEKDAY_INDEX, UNKNOWN_DAY };
