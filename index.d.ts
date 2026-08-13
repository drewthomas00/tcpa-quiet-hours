/**
 * tcpa-quiet-hours — is it legal to send this marketing message right now?
 *
 * NOT LEGAL ADVICE. The bundled rule table is not a claim of completeness;
 * verify against current statute and inject corrections via `QuietHoursEngine`.
 */

/** How the recipient's jurisdiction was determined. */
export type Source = 'zip' | 'area_code' | 'fallback' | 'unresolved';

/** Why a message was not eligible. `null` when it was. */
export type Reason =
  | 'no_timezone_resolved'
  | 'timezone_unparseable'
  | 'invalid_now'
  | 'state_sunday_blackout'
  | 'outside_window';

export interface Verdict {
  eligible: boolean;
  /** `null` when eligible. */
  reason: Reason | null;
  /** Two-letter state or territory code, or `null` when unknown. */
  state: string | null;
  /** IANA zone, or `null` when nothing resolved. */
  timezone: string | null;
  source: Source | string;
  /** The `label` of the rule applied, e.g. `'federal'` or `'MD'`. */
  ruleApplied: string | null;
}

export interface Jurisdiction {
  state: string | null;
  timezone: string | null;
  source: Source | string;
}

export interface Rule {
  state: string | null;
  /** Minutes from local midnight at which contact becomes permitted. */
  startMinutes: number;
  /** Minutes from local midnight at which it stops. End-exclusive. */
  endMinutes: number;
  excludesSundays: boolean;
  label: string;
  /** The statute this rule is drawn from. */
  citation: string | null;
  /**
   * ISO date on which a human last checked this rule against primary law,
   * or `null` if nobody has.
   */
  lastVerified: string | null;
}

/** A rule as supplied to the constructor; the rest is filled in. */
export interface RuleInput {
  startMinutes: number;
  endMinutes: number;
  excludesSundays?: boolean;
  label?: string;
  citation?: string;
  lastVerified?: string;
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
  /** State overrides merged over the bundled table, keyed by state code. */
  rules?: Record<string, RuleInput>;
  /** Replaces ZIP/area-code resolution wholesale. */
  resolver?: (args: JurisdictionInput) => Jurisdiction;
}

export declare class QuietHoursEngine {
  /** @throws {TypeError} if any supplied rule is malformed. */
  constructor(options?: EngineOptions);

  readonly rules: Readonly<Record<string, Rule>>;

  /**
   * @throws {TypeError} on an option key this method does not read. A
   * misspelled `fallbackTimezone` would otherwise be dropped in silence and
   * only surface as `no_timezone_resolved` for the recipients where neither
   * ZIP nor area code resolves.
   */
  evaluate(args?: EvaluateArgs): Verdict;

  /**
   * The next instant at which this recipient becomes contactable, or `null`
   * when nothing resolves or nothing inside the horizon qualifies. Treat
   * `null` as unsendable, not as "defer indefinitely".
   *
   * @throws {TypeError} if `maxDays` is not a positive finite number.
   */
  nextEligibleAt(args?: NextEligibleArgs): Date | null;

  resolveJurisdiction(args?: JurisdictionInput): Jurisdiction;
}

/** Evaluate against the bundled rules. */
export declare function evaluate(args?: EvaluateArgs): Verdict;
export declare function nextEligibleAt(args?: NextEligibleArgs): Date | null;
export declare function resolveJurisdiction(args?: JurisdictionInput): Jurisdiction;

/** The engine backing the module-level convenience functions. */
export declare const defaultEngine: QuietHoursEngine;

export declare const FEDERAL_RULE: Readonly<Rule>;
export declare const STATE_RULES: Readonly<Record<string, Rule>>;
export declare const SOURCES: Readonly<Record<'ZIP' | 'AREA_CODE' | 'FALLBACK' | 'UNRESOLVED', Source>>;
export declare const REASONS: Readonly<Record<
  'NO_TIMEZONE' | 'TIMEZONE_UNPARSEABLE' | 'INVALID_NOW' | 'SUNDAY_BLACKOUT' | 'OUTSIDE_WINDOW',
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
