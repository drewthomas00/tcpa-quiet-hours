/**
 * tcpa-quiet-hours — is it legal to send this marketing message right now?
 *
 * NOT LEGAL ADVICE. The bundled rule table is not a claim of completeness;
 * verify against current statute and inject corrections via `QuietHoursEngine`.
 */

/** How a jurisdiction was determined. */
export type Source = 'zip' | 'area_code' | 'area_code_presumption' | 'fallback' | 'unresolved';

/** Why a message was not eligible. `null` when it was. */
export type Reason =
  | 'no_timezone_resolved'
  | 'timezone_unparseable'
  | 'invalid_now'
  | 'state_sunday_blackout'
  | 'state_day_blackout'
  | 'state_holiday_blackout'
  | 'outside_window';

/** What a rule's statute says about text messages, as opposed to calls. */
export type TextCoverage = 'yes' | 'unclear' | 'no';

/** One jurisdiction a verdict was checked against. */
export interface CheckedJurisdiction {
  state: string | null;
  timezone: string;
  source: Source | string;
  /** The `label` of the rule applied to this jurisdiction. */
  ruleApplied: string;
  eligible: boolean;
  reason: Reason | null;
}

export interface Verdict {
  eligible: boolean;
  /** `null` when eligible. */
  reason: Reason | null;
  /** The PRIMARY jurisdiction: two-letter state or territory code, or `null`. */
  state: string | null;
  /** IANA zone of the primary jurisdiction, or `null` when nothing resolved. */
  timezone: string | null;
  source: Source | string;
  /**
   * The `label` of the rule that decided the verdict — the blocking one when
   * ineligible, which may belong to a presumed jurisdiction rather than the
   * primary one.
   */
  ruleApplied: string | null;
  /** Every jurisdiction checked, primary first. Empty when nothing resolved, or `now` was invalid. */
  jurisdictions: CheckedJurisdiction[];
}

export interface Jurisdiction {
  state: string | null;
  timezone: string | null;
  source: Source | string;
}

/** A window as `[start, end]`, each `'HH:MM'` or minutes from midnight; end-exclusive. */
export type WindowInput = [string | number, string | number];

/** Daily windows: `default` for any day not named; `null` closes a day. */
export interface WindowsInput {
  default?: WindowInput | null;
  sun?: WindowInput | null;
  mon?: WindowInput | null;
  tue?: WindowInput | null;
  wed?: WindowInput | null;
  thu?: WindowInput | null;
  fri?: WindowInput | null;
  sat?: WindowInput | null;
}

/** One holiday rule: a fixed date, an nth weekday, or an offset from Easter. */
export type HolidayRule = { name: string; offset?: number; years?: 'even' | 'odd' } & (
  | { month: number; day: number }
  | { month: number; weekday: number; nth: 1 | 2 | 3 | 4 | -1 }
  | { easter: number }
);

/** How a fixed-date holiday that falls on a weekend is also observed. */
export type Observance = 'none' | 'sunday' | 'weekend' | 'any';

export interface HolidayCalendarInput {
  observe?: Observance;
  holidays: HolidayRule[];
  citation?: string;
  sourceUrl?: string;
  note?: string;
}

export interface HolidayCalendar {
  observe: Observance;
  holidays: ReadonlyArray<HolidayRule>;
  citation: string | null;
  sourceUrl: string | null;
  note: string | null;
}

/** A normalised rule. */
export interface Rule {
  state: string | null;
  label: string;
  /** Seven windows, Sunday first, in minutes from local midnight; `null` = closed. */
  windows: ReadonlyArray<{ start: number; end: number } | null>;
  holidays: HolidayCalendar | null;
  /** The recipient-local date this version takes effect, or `null`. */
  effectiveFrom: string | null;
  /** A zone the statute names (e.g. MS: "Central Standard Time"), checked as well as the recipient's. */
  fixedClock: string | null;
  /** The statute presumes residency from one of the state's area codes. */
  areaCodePresumption: boolean;
  coversText: TextCoverage;
  citation: string | null;
  sourceUrl: string | null;
  /** ISO date this rule was last read against its primary source, or `null`. */
  lastVerified: string | null;
  note: string | null;
}

/**
 * A rule as supplied to the constructor. Give `windows`, or the 1.x
 * `startMinutes`/`endMinutes`/`excludesSundays` — not both.
 */
export interface RuleInput {
  windows?: WindowsInput;
  startMinutes?: number;
  endMinutes?: number;
  excludesSundays?: boolean;
  /** A bundled calendar's name (`'AL'`), or a calendar of your own. */
  holidays?: string | HolidayCalendarInput | null;
  effectiveFrom?: string;
  fixedClock?: string;
  areaCodePresumption?: boolean;
  coversText?: TextCoverage;
  label?: string;
  citation?: string;
  sourceUrl?: string;
  lastVerified?: string;
  note?: string;
}

export interface JurisdictionInput {
  /** E.164 or 10/11-digit NANP, e.g. `'+15551234567'`. */
  phone?: string;
  /**
   * 5-digit US ZIP or ZIP+4; the first three digits are used. An integer is
   * zero-padded (1001 → `'01001'`); a partial string is ignored rather than
   * guessed at, and resolution falls through to the phone number.
   */
  zipCode?: string | number;
  /** IANA zone used only when nothing else resolves. */
  fallbackTimezone?: string;
}

export interface EvaluateArgs extends JurisdictionInput {
  /** `Date` or epoch milliseconds. Defaults to the current instant. */
  now?: Date | number;
}

export interface NextEligibleArgs extends EvaluateArgs {
  /** Search horizon in days. Must be positive and finite. Defaults to 8. */
  maxDays?: number;
}

export interface EngineOptions {
  /**
   * State rules merged over the bundled table, keyed by state code. A value
   * is one rule or an array of versions with `effectiveFrom` dates; a key
   * already present replaces that state's history entirely.
   */
  rules?: Record<string, RuleInput | RuleInput[]>;
  /** Replaces ZIP/area-code resolution wholesale. No presumption is added. */
  resolver?: (args: JurisdictionInput) => Jurisdiction;
  /**
   * Apply only rules with `coversText: 'yes'`; the rest fall back to federal.
   * Off by default. Turn it on only on counsel's advice.
   */
  onlyRulesCoveringText?: boolean;
}

export declare class QuietHoursEngine {
  /** @throws {TypeError} if any supplied rule or option is malformed. */
  constructor(options?: EngineOptions);

  /** Each state's rule versions, oldest first. */
  readonly rules: Readonly<Record<string, ReadonlyArray<Rule>>>;

  /**
   * @throws {TypeError} on an option key this method does not read. A
   * misspelled `fallbackTimezone` would otherwise be dropped in silence and
   * only surface as `no_timezone_resolved` for the recipients where neither
   * ZIP nor area code resolves.
   */
  evaluate(args?: EvaluateArgs): Verdict;

  /**
   * The next instant at which this recipient becomes contactable — `now`
   * itself when already eligible — or `null` when nothing resolves, nothing
   * inside the horizon qualifies, or `now` is not a valid instant. Treat
   * `null` as unsendable, not as "defer indefinitely".
   *
   * @throws {TypeError} if `maxDays` is not a positive finite number.
   */
  nextEligibleAt(args?: NextEligibleArgs): Date | null;

  /** The primary jurisdiction: ZIP, else area code, else the fallback zone. */
  resolveJurisdiction(args?: JurisdictionInput): Jurisdiction;

  /** The primary jurisdiction plus any area-code presumption. Never empty. */
  resolveJurisdictions(args?: JurisdictionInput): Jurisdiction[];

  /** The rule in force for `state` on a recipient-local `'YYYY-MM-DD'`, else federal. */
  ruleFor(state: string | null, isoDate: string): Rule;
}

/** Evaluate against the bundled rules. */
export declare function evaluate(args?: EvaluateArgs): Verdict;
export declare function nextEligibleAt(args?: NextEligibleArgs): Date | null;
export declare function resolveJurisdiction(args?: JurisdictionInput): Jurisdiction;
export declare function resolveJurisdictions(args?: JurisdictionInput): Jurisdiction[];

/** The engine backing the module-level convenience functions. */
export declare const defaultEngine: QuietHoursEngine;

export declare const FEDERAL_RULE: Readonly<Rule>;
/** The bundled state rules, each a list of versions (oldest first). */
export declare const STATE_RULES: Readonly<Record<string, ReadonlyArray<Rule>>>;
export declare const HOLIDAY_CALENDARS: Readonly<Record<string, HolidayCalendar>>;
export declare const SOURCES: Readonly<Record<
  'ZIP' | 'AREA_CODE' | 'AREA_CODE_PRESUMPTION' | 'FALLBACK' | 'UNRESOLVED',
  Source
>>;
export declare const REASONS: Readonly<Record<
  | 'NO_TIMEZONE' | 'TIMEZONE_UNPARSEABLE' | 'INVALID_NOW' | 'SUNDAY_BLACKOUT'
  | 'DAY_BLACKOUT' | 'HOLIDAY_BLACKOUT' | 'OUTSIDE_WINDOW',
  Reason
>>;

/** The 3-digit NANP area code, or `null` for anything that is not one. */
export declare function extractAreaCode(phone: string): number | null;

/**
 * The 3-digit prefix of a full ZIP: a 5- or 9-digit string, or an integer up
 * to 99999 (zero-padded). Anything partial returns `null` — a guessed prefix
 * is worse than none.
 */
export declare function parseZip3(zipCode: string | number): number | null;
