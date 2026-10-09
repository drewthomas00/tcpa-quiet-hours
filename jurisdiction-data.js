/**
 * jurisdiction-data.js — offline lookup tables mapping a US phone number or
 * ZIP code to a state and IANA timezone.
 *
 * Committed to source deliberately: the lookup is then offline, free,
 * deterministic, and adds no network call to a hot send path.
 *
 * Public-domain sources:
 *   * ZIP3 -> state: USPS published ZIP-code-by-state prefix assignments
 *   * Area code -> state: NANP administrator's public assignments
 *   * State -> timezone: most-populous IANA zone per state, with explicit
 *     ZIP3 overrides for the prefixes whose majority sits in the other zone
 */
'use strict';

const { deepFreeze } = require('./freeze');

/**
 * State/territory → most-populous IANA timezone. Used as the default when a
 * ZIP3 override does not apply.
 */
const STATE_TIMEZONE = deepFreeze({
  AL: 'America/Chicago',
  AK: 'America/Anchorage',       // the Aleutians west of 169°30'W are America/Adak
  AZ: 'America/Phoenix',         // no DST — but the Navajo Nation does observe it
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',        // Eastern dominant (Panhandle is Central)
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  IA: 'America/Chicago',
  ID: 'America/Boise',           // the northern panhandle is Pacific
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago',         // most of the state (4 western counties are Mountain)
  KY: 'America/New_York',        // Eastern dominant (western KY is Central)
  LA: 'America/Chicago',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/Detroit',         // part of the UP is Central
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  MT: 'America/Denver',
  NC: 'America/New_York',
  ND: 'America/Chicago',         // most of the state (SW is Mountain)
  NE: 'America/Chicago',         // most of the state (panhandle is Mountain)
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NV: 'America/Los_Angeles',
  NY: 'America/New_York',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',     // most of the state (eastern OR is Mountain)
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',         // east river dominant (west river is Mountain)
  TN: 'America/Chicago',         // most populous is Central; eastern TN is Eastern
  TX: 'America/Chicago',         // most of the state (El Paso is Mountain)
  UT: 'America/Denver',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WA: 'America/Los_Angeles',
  WI: 'America/Chicago',
  WV: 'America/New_York',
  WY: 'America/Denver',

  // Territories. Fully subject to the TCPA, and omitting them meant a real
  // recipient resolved to "no timezone" and was silently unsendable.
  PR: 'America/Puerto_Rico',
  VI: 'America/St_Thomas',
  GU: 'Pacific/Guam',
  MP: 'Pacific/Saipan',
  AS: 'Pacific/Pago_Pago',
});

/**
 * Area code → state (NANP). Covers the 50 states, DC and the territories.
 *
 * Toll-free (8XX) is intentionally omitted: it carries no geographic signal.
 * Overlay codes map to the original NPA's state, since the FCC keeps an
 * overlay inside the same geography.
 */
const AREA_CODE_STATE = deepFreeze({
  // Alabama
  205: 'AL', 251: 'AL', 256: 'AL', 334: 'AL', 938: 'AL', 659: 'AL',
  // Alaska
  907: 'AK',
  // Arizona
  480: 'AZ', 520: 'AZ', 602: 'AZ', 623: 'AZ', 928: 'AZ',
  // Arkansas
  327: 'AR', 479: 'AR', 501: 'AR', 870: 'AR',
  // California
  209: 'CA', 213: 'CA', 279: 'CA', 310: 'CA', 323: 'CA', 341: 'CA',
  408: 'CA', 415: 'CA', 424: 'CA', 442: 'CA', 510: 'CA', 530: 'CA',
  559: 'CA', 562: 'CA', 619: 'CA', 626: 'CA', 628: 'CA', 650: 'CA',
  657: 'CA', 661: 'CA', 669: 'CA', 707: 'CA', 714: 'CA', 738: 'CA',
  747: 'CA', 760: 'CA', 805: 'CA', 818: 'CA', 820: 'CA', 831: 'CA',
  840: 'CA', 858: 'CA', 909: 'CA', 916: 'CA', 925: 'CA', 935: 'CA',
  949: 'CA', 951: 'CA',
  // Colorado
  303: 'CO', 719: 'CO', 720: 'CO', 970: 'CO', 983: 'CO',
  // Connecticut
  203: 'CT', 475: 'CT', 860: 'CT', 959: 'CT',
  // Delaware
  302: 'DE',
  // District of Columbia
  202: 'DC', 771: 'DC',
  // Florida
  239: 'FL', 305: 'FL', 321: 'FL', 352: 'FL', 386: 'FL', 407: 'FL',
  448: 'FL', 561: 'FL', 645: 'FL', 656: 'FL', 689: 'FL', 727: 'FL',
  728: 'FL', 754: 'FL', 772: 'FL', 786: 'FL', 813: 'FL', 850: 'FL',
  863: 'FL', 904: 'FL', 941: 'FL', 954: 'FL',
  // Georgia
  229: 'GA', 404: 'GA', 470: 'GA', 478: 'GA', 678: 'GA', 706: 'GA',
  762: 'GA', 770: 'GA', 912: 'GA', 943: 'GA',
  // Hawaii
  808: 'HI',
  // Iowa
  319: 'IA', 515: 'IA', 563: 'IA', 641: 'IA', 712: 'IA',
  // Idaho
  208: 'ID', 986: 'ID',
  // Illinois
  217: 'IL', 224: 'IL', 309: 'IL', 312: 'IL', 331: 'IL', 447: 'IL',
  464: 'IL', 618: 'IL', 630: 'IL', 708: 'IL', 730: 'IL', 773: 'IL',
  779: 'IL', 815: 'IL', 847: 'IL', 861: 'IL', 872: 'IL',
  // Indiana
  219: 'IN', 260: 'IN', 317: 'IN', 463: 'IN', 574: 'IN', 765: 'IN',
  812: 'IN', 930: 'IN',
  // Kansas
  316: 'KS', 620: 'KS', 785: 'KS', 913: 'KS',
  // Kentucky
  270: 'KY', 364: 'KY', 502: 'KY', 606: 'KY', 859: 'KY',
  // Louisiana
  225: 'LA', 318: 'LA', 337: 'LA', 504: 'LA', 985: 'LA',
  // Massachusetts
  339: 'MA', 351: 'MA', 413: 'MA', 508: 'MA', 617: 'MA', 774: 'MA',
  781: 'MA', 857: 'MA', 978: 'MA',
  // Maryland
  227: 'MD', 240: 'MD', 301: 'MD', 410: 'MD', 443: 'MD', 667: 'MD',
  // Maine
  207: 'ME',
  // Michigan
  231: 'MI', 248: 'MI', 269: 'MI', 313: 'MI', 517: 'MI', 586: 'MI',
  616: 'MI', 679: 'MI', 734: 'MI', 810: 'MI', 906: 'MI', 947: 'MI',
  989: 'MI',
  // Minnesota
  218: 'MN', 320: 'MN', 507: 'MN', 612: 'MN', 651: 'MN', 763: 'MN',
  952: 'MN',
  // Missouri
  314: 'MO', 417: 'MO', 557: 'MO', 573: 'MO', 636: 'MO', 660: 'MO',
  816: 'MO', 975: 'MO',
  // Mississippi
  228: 'MS', 601: 'MS', 662: 'MS', 769: 'MS',
  // Montana
  406: 'MT',
  // North Carolina
  252: 'NC', 336: 'NC', 472: 'NC', 704: 'NC', 743: 'NC', 828: 'NC',
  910: 'NC', 919: 'NC', 980: 'NC', 984: 'NC',
  // North Dakota
  701: 'ND',
  // Nebraska
  308: 'NE', 402: 'NE', 531: 'NE',
  // New Hampshire
  603: 'NH',
  // New Jersey
  201: 'NJ', 551: 'NJ', 609: 'NJ', 640: 'NJ', 732: 'NJ', 848: 'NJ',
  856: 'NJ', 862: 'NJ', 908: 'NJ', 973: 'NJ',
  // New Mexico
  505: 'NM', 575: 'NM',
  // Nevada
  702: 'NV', 725: 'NV', 775: 'NV',
  // New York
  212: 'NY', 315: 'NY', 332: 'NY', 347: 'NY', 363: 'NY', 516: 'NY',
  518: 'NY', 585: 'NY', 607: 'NY', 624: 'NY', 631: 'NY', 646: 'NY',
  680: 'NY', 716: 'NY', 718: 'NY', 838: 'NY', 845: 'NY', 914: 'NY',
  917: 'NY', 929: 'NY', 934: 'NY',
  // Ohio
  216: 'OH', 220: 'OH', 234: 'OH', 283: 'OH', 326: 'OH', 330: 'OH',
  380: 'OH', 419: 'OH', 436: 'OH', 440: 'OH', 513: 'OH', 567: 'OH',
  614: 'OH', 740: 'OH', 937: 'OH',
  // Oklahoma
  405: 'OK', 539: 'OK', 572: 'OK', 580: 'OK', 918: 'OK',
  // Oregon
  458: 'OR', 503: 'OR', 541: 'OR', 971: 'OR',
  // Pennsylvania
  215: 'PA', 223: 'PA', 267: 'PA', 272: 'PA', 412: 'PA', 445: 'PA',
  484: 'PA', 570: 'PA', 582: 'PA', 610: 'PA', 717: 'PA', 724: 'PA',
  814: 'PA', 835: 'PA', 878: 'PA',
  // Rhode Island
  401: 'RI',
  // South Carolina
  803: 'SC', 821: 'SC', 839: 'SC', 843: 'SC', 854: 'SC', 864: 'SC',
  // South Dakota
  605: 'SD',
  // Tennessee
  423: 'TN', 615: 'TN', 629: 'TN', 731: 'TN', 865: 'TN', 901: 'TN',
  931: 'TN',
  // Texas
  210: 'TX', 214: 'TX', 254: 'TX', 281: 'TX', 325: 'TX', 346: 'TX',
  361: 'TX', 409: 'TX', 430: 'TX', 432: 'TX', 469: 'TX', 512: 'TX',
  682: 'TX', 713: 'TX', 726: 'TX', 737: 'TX', 806: 'TX', 817: 'TX',
  830: 'TX', 832: 'TX', 903: 'TX', 915: 'TX', 936: 'TX', 940: 'TX',
  945: 'TX', 956: 'TX', 972: 'TX', 979: 'TX',
  // Utah
  385: 'UT', 435: 'UT', 801: 'UT',
  // Virginia
  276: 'VA', 434: 'VA', 540: 'VA', 571: 'VA', 686: 'VA', 703: 'VA',
  757: 'VA', 804: 'VA', 826: 'VA', 948: 'VA',
  // Vermont
  802: 'VT',
  // Washington
  206: 'WA', 253: 'WA', 360: 'WA', 425: 'WA', 509: 'WA', 564: 'WA',
  // Wisconsin
  262: 'WI', 274: 'WI', 353: 'WI', 414: 'WI', 534: 'WI', 608: 'WI',
  715: 'WI', 920: 'WI',
  // West Virginia
  304: 'WV', 681: 'WV',
  // Wyoming
  307: 'WY',
  // Territories
  787: 'PR', 939: 'PR', 340: 'VI', 671: 'GU', 670: 'MP', 684: 'AS',
});

/**
 * Range-encoded ZIP3 → state, `[zip3Start, zip3End, state]` inclusive.
 * Source: USPS published ZIP-code prefix assignments.
 *
 * `AE`/`AA`/`AP` (military overseas) are recorded because they are real
 * prefixes, but they have no meaningful timezone. Resolution deliberately
 * falls through to the area code or the caller's fallback rather than
 * reporting a guess.
 */
const ZIP3_RANGES = deepFreeze([
  [5, 5, 'NY'],                       // 005 = Holtsville, NY
  [6, 7, 'PR'],
  [8, 8, 'VI'],
  [9, 9, 'PR'],
  [10, 27, 'MA'],
  [28, 29, 'RI'],
  [30, 38, 'NH'],
  [39, 49, 'ME'],
  [50, 54, 'VT'],
  [55, 55, 'MA'],                     // 055 = the Andover, MA service center — the
  [56, 59, 'VT'],                     //   lone MA prefix inside Vermont's 050-059
  [60, 69, 'CT'],
  [70, 89, 'NJ'],
  [90, 99, 'AE'],                     // APO/FPO Europe, Middle East, Africa, Canada
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [197, 199, 'DE'],
  [200, 200, 'DC'],
  [201, 201, 'VA'],                   // 201 = Dulles, VA — a DC-adjacent VA prefix
  [202, 205, 'DC'],
  [206, 219, 'MD'],
  [220, 246, 'VA'],
  [247, 268, 'WV'],
  [270, 289, 'NC'],
  [290, 299, 'SC'],
  [300, 319, 'GA'],
  [320, 339, 'FL'],
  [340, 340, 'AA'],                   // APO/FPO Americas — inside Florida's block
  [341, 349, 'FL'],
  [350, 369, 'AL'],
  [370, 385, 'TN'],
  [386, 397, 'MS'],
  [398, 399, 'GA'],
  [400, 427, 'KY'],
  [430, 459, 'OH'],
  [460, 479, 'IN'],
  [480, 499, 'MI'],
  [500, 528, 'IA'],
  [530, 549, 'WI'],
  [550, 567, 'MN'],
  [570, 577, 'SD'],
  [580, 588, 'ND'],
  [590, 599, 'MT'],
  [600, 629, 'IL'],
  [630, 658, 'MO'],
  [660, 679, 'KS'],
  [680, 693, 'NE'],
  [700, 714, 'LA'],
  [716, 729, 'AR'],
  [730, 749, 'OK'],
  [750, 799, 'TX'],
  [800, 816, 'CO'],
  [820, 831, 'WY'],
  [832, 838, 'ID'],
  [840, 847, 'UT'],
  [850, 865, 'AZ'],
  [870, 884, 'NM'],
  [885, 885, 'TX'],                   // 885 = El Paso, TX — inside New Mexico's block
  [889, 898, 'NV'],
  [900, 961, 'CA'],
  [962, 966, 'AP'],                   // APO/FPO Pacific
  [967, 968, 'HI'],
  [969, 969, 'GU'],                   // Guam, CNMI, and the Freely Associated States
  [970, 979, 'OR'],
  [980, 994, 'WA'],
  [995, 999, 'AK'],
]);

/**
 * ZIP3 prefixes whose majority population sits in a DIFFERENT timezone than
 * their state's `STATE_TIMEZONE` default. `[zip3Start, zip3End, state, zone]`.
 *
 * INCLUSION RULE — a prefix is listed only when its *majority* is in the
 * non-default zone. That is the whole test, and it explains both directions:
 *
 *   * 373/374 (Chattanooga) are listed. Tennessee defaults to Central, and
 *     the great majority of those prefixes is Eastern. A handful of Grundy
 *     County towns are Central and are knowingly mis-resolved — leaving the
 *     prefix out would mis-resolve all of metro Chattanooga instead.
 *   * 498/499 (Michigan's UP) are NOT listed. Marquette and Escanaba are
 *     Eastern, which is already the state default, so an override could only
 *     make things worse for the majority.
 *   * 677/678 (western Kansas) are NOT listed, for the same reason. Only four
 *     Kansas counties are Mountain; Colby (67701) and Dodge City (67801) sit
 *     in those prefixes and are Central, like the state default.
 *
 * Where a ZIP3 genuinely splits down the middle with no majority, it stays
 * out: the state default is then no worse than a coin flip, and it is at
 * least predictable.
 *
 * Known, accepted gap: Arizona's 865 prefix carries both the Navajo Nation
 * (which observes DST) and the Hopi Reservation (which does not), inside a
 * state that otherwise does neither. No ZIP3 can express that, so 865 keeps
 * `America/Phoenix`.
 */
const ZIP3_TIMEZONE_OVERRIDES = deepFreeze([
  [324, 325, 'FL', 'America/Chicago'],    // FL Panhandle (Panama City, Pensacola)
  [373, 374, 'TN', 'America/New_York'],   // Chattanooga + Cleveland, TN
  [376, 379, 'TN', 'America/New_York'],   // Knoxville + Tri-Cities (375 = Memphis stays Central)
  [420, 424, 'KY', 'America/Chicago'],    // Western KY (Paducah, Bowling Green, Owensboro, Henderson)
  [463, 464, 'IN', 'America/Chicago'],    // NW Indiana (Gary/Hammond)
  [476, 477, 'IN', 'America/Chicago'],    // SW Indiana (Evansville)
  [577, 577, 'SD', 'America/Denver'],     // West-river SD (Rapid City)
  [586, 586, 'ND', 'America/Denver'],     // SW North Dakota (Dickinson)
  [693, 693, 'NE', 'America/Denver'],     // Nebraska panhandle (Scottsbluff/Alliance/Sidney)
  [798, 799, 'TX', 'America/Denver'],     // El Paso + Hudspeth County, TX
  [885, 885, 'TX', 'America/Denver'],     // El Paso, TX — its second prefix
  [835, 835, 'ID', 'America/Los_Angeles'], // North-central ID (Lewiston, Orofino, Grangeville)
  [838, 838, 'ID', 'America/Los_Angeles'], // ID panhandle (Coeur d'Alene, Post Falls, Sandpoint, Moscow)
  [979, 979, 'OR', 'America/Denver'],     // Malheur County, OR (Ontario, Vale, Nyssa)
]);

/**
 * Area codes whose majority population sits in a DIFFERENT timezone than
 * their state's `STATE_TIMEZONE` default. `{areaCode: zone}`.
 *
 * Same inclusion rule as the ZIP3 overrides, and needed for the same reason:
 * without it every El Paso number (915) resolves to Central time, so a 7:30 AM
 * Mountain send reads as 8:30 and passes, and every Knoxville number (865)
 * resolves to Central, so a 9:30 PM Eastern send reads as 8:30 and passes.
 * An area code is already the weaker signal; it should not also be read on the
 * wrong clock.
 *
 * Codes that straddle a line keep the state default when the default zone
 * holds the majority — 812/930 (Evansville is Central, the rest of southern
 * Indiana Eastern), 906 (the UP), 208/986, 308, 541/458, 605, 701.
 */
const AREA_CODE_TIMEZONE_OVERRIDES = deepFreeze({
  850: 'America/Chicago',  // FL Panhandle — Pensacola, Fort Walton, Panama City outnumber Tallahassee
  448: 'America/Chicago',  //   850's overlay
  219: 'America/Chicago',  // NW Indiana (Gary, Hammond, Valparaiso)
  270: 'America/Chicago',  // Western KY (Bowling Green, Owensboro, Paducah)
  364: 'America/Chicago',  //   270's overlay
  423: 'America/New_York', // East TN (Chattanooga, Tri-Cities)
  865: 'America/New_York', // Knoxville
  915: 'America/Denver',   // El Paso
});

/**
 * Expand a range table into a flat prefix → value map.
 *
 * Built eagerly. The whole expansion is under a thousand iterations, which is
 * far cheaper than the mutable module-level state a lazy cache would need.
 * A null-prototype object keeps a caller-supplied key from ever reaching
 * `Object.prototype`.
 *
 * @param {Array<Array>} ranges - `[start, end, ...rest]` tuples
 * @param {(rest: Array) => *} pick - value to store for each prefix in a range
 * @returns {Readonly<Object>}
 */
function expandRanges(ranges, pick) {
  const out = Object.create(null);
  for (const range of ranges) {
    const [start, end] = range;
    const value = pick(range.slice(2));
    for (let prefix = start; prefix <= end; prefix += 1) out[prefix] = value;
  }
  return Object.freeze(out);
}

/** ZIP3 → state. */
const ZIP3_STATE = expandRanges(ZIP3_RANGES, ([state]) => state);

/** ZIP3 → `{state, timezone}` for prefixes that override their state default. */
const ZIP3_TIMEZONE = expandRanges(
  ZIP3_TIMEZONE_OVERRIDES,
  ([state, timezone]) => Object.freeze({ state, timezone }),
);

/**
 * Resolve a state or territory code from a 3-digit ZIP prefix.
 *
 * @param {number} zip3
 * @returns {string|null} null when the prefix is unassigned or out of range
 */
function getZipState(zip3) {
  if (!Number.isInteger(zip3) || zip3 < 0 || zip3 > 999) return null;
  return ZIP3_STATE[zip3] || null;
}

/**
 * Resolve a state or territory code from a 3-digit NANP area code.
 *
 * @param {number} areaCode
 * @returns {string|null} null for toll-free, non-NANP, and unassigned codes
 */
function getAreaCodeState(areaCode) {
  if (!Number.isInteger(areaCode)) return null;
  return AREA_CODE_STATE[areaCode] || null;
}

/**
 * Resolve a state's IANA timezone, preferring a ZIP3 override when the ZIP
 * falls in the state's minority zone.
 *
 * The override is honoured only when `zip3` actually belongs to `state`.
 * Without that check the ZIP3 would win outright, and
 * `getStateTimezone('NY', 324)` — a New York recipient with a stray Florida
 * prefix — would answer `America/Chicago`.
 *
 * @param {string} state - two-letter state or territory code
 * @param {number} [zip3] - the recipient's 3-digit ZIP prefix, if known
 * @returns {string|null} null for an unknown or missing state
 */
function getStateTimezone(state, zip3 = null) {
  if (!state || typeof state !== 'string') return null;
  const code = state.toUpperCase();

  if (Number.isInteger(zip3)) {
    const override = ZIP3_TIMEZONE[zip3];
    if (override && override.state === code) return override.timezone;
  }

  return Object.prototype.hasOwnProperty.call(STATE_TIMEZONE, code)
    ? STATE_TIMEZONE[code]
    : null;
}

/**
 * Resolve the IANA timezone for a NANP area code: its override when the code
 * sits in its state's minority zone, otherwise the state default.
 *
 * @param {number} areaCode
 * @returns {string|null} null when the code maps to no state
 */
function getAreaCodeTimezone(areaCode) {
  const state = getAreaCodeState(areaCode);
  if (!state) return null;
  return Object.prototype.hasOwnProperty.call(AREA_CODE_TIMEZONE_OVERRIDES, areaCode)
    ? AREA_CODE_TIMEZONE_OVERRIDES[areaCode]
    : getStateTimezone(state);
}

module.exports = {
  STATE_TIMEZONE,
  AREA_CODE_STATE,
  AREA_CODE_TIMEZONE_OVERRIDES,
  ZIP3_RANGES,
  ZIP3_TIMEZONE_OVERRIDES,
  getZipState,
  getAreaCodeState,
  getStateTimezone,
  getAreaCodeTimezone,
};
