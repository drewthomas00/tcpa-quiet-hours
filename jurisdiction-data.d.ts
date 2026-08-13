/**
 * Offline lookup tables mapping a US phone number or ZIP code to a state and
 * IANA timezone. Exposed so a correction is a data change, not a fork.
 */

/** State/territory code → most-populous IANA timezone. */
export declare const STATE_TIMEZONE: Readonly<Record<string, string>>;

/** NANP area code → state/territory code. */
export declare const AREA_CODE_STATE: Readonly<Record<number, string>>;

/** `[zip3Start, zip3End, state]`, inclusive. */
export declare const ZIP3_RANGES: ReadonlyArray<readonly [number, number, string]>;

/** `[zip3Start, zip3End, state, ianaZone]` for prefixes in a minority zone. */
export declare const ZIP3_TIMEZONE_OVERRIDES: ReadonlyArray<readonly [number, number, string, string]>;

/** Resolve a state or territory from a 3-digit ZIP prefix. */
export declare function getZipState(zip3: number): string | null;

/** Resolve a state or territory from a 3-digit NANP area code. */
export declare function getAreaCodeState(areaCode: number): string | null;

/**
 * Resolve a state's IANA timezone. A `zip3` override applies only when that
 * prefix actually belongs to `state`.
 */
export declare function getStateTimezone(state: string, zip3?: number | null): string | null;
