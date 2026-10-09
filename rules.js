'use strict';

/**
 * The bundled state rules — plain data, normalised and validated by the engine.
 *
 * Every rule is stricter than the federal 8 AM – 9 PM window in at least one
 * way. Each names the statute it comes from (`citation`), links the text
 * (`sourceUrl`), and records when it was last read against that primary text
 * (`lastVerified`; null where only a secondary source or an older enactment
 * was available). See the README's "How these rules were checked".
 *
 * `coversText` records what the statute says about text messages:
 *   'yes'      the statute names text messages
 *   'unclear'  the statute speaks of "calls" or "telephone solicitation" and
 *              has not been read either way
 * The engine applies every rule regardless, unless you opt out with
 * `onlyRulesCoveringText`.
 *
 * Deliberately NOT encoded:
 *   - Rules that govern only prerecorded/autodialed VOICE messages — Maine
 *     (10 M.R.S. § 1498), Illinois (815 ILCS 305/15) and California (Pub.
 *     Util. Code § 2872). They are not about the messages this library gates.
 *   - Call-frequency caps (Florida, Maryland, Oklahoma, Oregon: three per 24
 *     hours). Those need send history, which a pure time-of-day check lacks.
 *
 * Window times are 'HH:MM' on the recipient's clock, end-exclusive.
 */

/**
 * Holiday calendars, named so several rules can share one.
 *
 * Where a statute is ambiguous these err towards blocking: a county-only
 * holiday is treated as statewide, a weekend holiday blocks both its date and
 * its observed weekday, and a Saturday holiday blocks the Saturday even where
 * the statute's holiday bar arguably reaches only weekdays (Rhode Island).
 */
const HOLIDAY_CALENDARS = {
  // The PSC rule bars "Sundays or holidays" without defining them; these are
  // the state holidays. Mardi Gras is a holiday only in Baldwin and Mobile
  // counties (§ 1-3-8(e)(1)) and is blocked statewide. Thanksgiving is "as
  // designated by the Governor"; it is the fourth Thursday in practice.
  AL: {
    citation: 'Ala. Code § 1-3-8 (as amended by Act 2025-303)',
    sourceUrl: 'https://alison.legislature.state.al.us/code-of-alabama?section=1-3-8',
    observe: 'weekend', // § 1-3-8(b): Sunday → Monday, Saturday → Friday
    holidays: [
      { name: "New Year's Day", month: 1, day: 1 },
      { name: "Martin Luther King Jr.'s and Robert E. Lee's Birthday", month: 1, weekday: 1, nth: 3 },
      { name: "George Washington's and Thomas Jefferson's Birthday", month: 2, weekday: 1, nth: 3 },
      { name: 'Mardi Gras (Baldwin and Mobile counties)', easter: -47 },
      { name: 'Confederate Memorial Day', month: 4, weekday: 1, nth: 4 },
      { name: 'Memorial Day', month: 5, weekday: 1, nth: -1 },
      { name: "Jefferson Davis' Birthday", month: 6, weekday: 1, nth: 1 },
      { name: 'Juneteenth', month: 6, day: 19 },
      { name: 'Independence Day', month: 7, day: 4 },
      { name: 'Labor Day', month: 9, weekday: 1, nth: 1 },
      { name: 'Columbus Day / Fraternal Day / American Indian Heritage Day', month: 10, weekday: 1, nth: 2 },
      { name: "Veterans' Day", month: 11, day: 11 },
      { name: 'Thanksgiving Day', month: 11, weekday: 4, nth: 4 },
      { name: 'Christmas Day', month: 12, day: 25 },
    ],
  },

  // § 45:811 bars "days declared to be a state holiday". This is the broader
  // reading: every legal holiday in R.S. 1:55(A)(1) and 1:55.1, plus the
  // even-year election day that state employees also have off. Saturday
  // half-holidays are NOT blocked — § 45:811(2) permits Saturday calls.
  LA: {
    citation: 'La. Rev. Stat. § 1:55(A)(1), (B)(1)(a); § 1:55.1',
    sourceUrl: 'https://legis.la.gov/Legis/LawPrint.aspx?d=74097',
    // 1:55(A)(4) moves only Jan 1, Jul 4 and Dec 25 (Sunday → Monday; Saturday
    // → Friday by local ordinance). Applied to every fixed date: blocks more.
    observe: 'weekend',
    note: 'Not encoded: holidays proclaimed by the governor (e.g. "Acadian Day"), and Inauguration Day, a holiday only in Baton Rouge.',
    holidays: [
      { name: "New Year's Day", month: 1, day: 1 },
      { name: 'Battle of New Orleans', month: 1, day: 8 },
      { name: "Dr. Martin Luther King Jr.'s Birthday", month: 1, weekday: 1, nth: 3 },
      { name: "Washington's Birthday", month: 2, weekday: 1, nth: 3 },
      { name: 'Mardi Gras', easter: -47 },
      { name: 'Good Friday', easter: -2 },
      { name: 'National Memorial Day', month: 5, weekday: 1, nth: -1 },
      { name: 'Juneteenth Day', month: 6, weekday: 6, nth: 3 },
      { name: 'Independence Day', month: 7, day: 4 },
      { name: 'Huey P. Long Day', month: 8, day: 30 },
      { name: 'Labor Day', month: 9, weekday: 1, nth: 1 },
      { name: 'Christopher Columbus Day', month: 10, weekday: 1, nth: 2 },
      { name: "All Saints' Day", month: 11, day: 1 },
      { name: 'Election Day', month: 11, weekday: 1, nth: 1, offset: 1, years: 'even' },
      { name: "Veterans' Day", month: 11, day: 11 },
      { name: 'Thanksgiving Day', month: 11, weekday: 4, nth: 4 },
      { name: 'Christmas Day', month: 12, day: 25 },
    ],
  },

  // § 13-25a-103(3) bars solicitation "on a legal holiday". Juneteenth is the
  // fixed June 19 from 2027-01-01; the 2026 version's Monday rule is past.
  UT: {
    citation: 'Utah Code Ann. § 63G-1-301 (version effective 2027-01-01)',
    sourceUrl: 'https://le.utah.gov/xcode/Title63G/Chapter1/C63G-1-S301_2026050620270101.html',
    observe: 'weekend', // (2): Saturday → Friday, Sunday → Monday
    note: 'Utah defines Easter astronomically; in the rare year that differs from the ecclesiastical date, Good Friday here follows the ecclesiastical one. Not encoded: days proclaimed by the President or Governor.',
    holidays: [
      { name: "New Year's Day", month: 1, day: 1 },
      { name: 'Dr. Martin Luther King Jr. Day', month: 1, weekday: 1, nth: 3 },
      { name: "Presidents' Day", month: 2, weekday: 1, nth: 3 },
      { name: 'Good Friday', easter: -2 },
      { name: 'Memorial Day', month: 5, weekday: 1, nth: -1 },
      { name: 'Juneteenth National Freedom Day', month: 6, day: 19 },
      { name: 'Independence Day', month: 7, day: 4 },
      { name: 'Pioneer Day', month: 7, day: 24 },
      { name: 'Labor Day', month: 9, weekday: 1, nth: 1 },
      { name: 'Columbus Day', month: 10, weekday: 1, nth: 2 },
      { name: 'Veterans Day', month: 11, day: 11 },
      { name: 'Thanksgiving', month: 11, weekday: 4, nth: 4 },
      { name: 'Christmas', month: 12, day: 25 },
    ],
  },

  // 73 P.S. § 2245(a)(10) bars solicitation "on a legal holiday" and defines
  // none, so this is Pennsylvania's Legal Holiday Law. Juneteenth is
  // expressly NOT a legal holiday there (Act 9 of 2019, § 3).
  PA: {
    citation: 'Act of May 31, 1893, P.L. 188, No. 138, § 1 (44 P.S. § 11)',
    sourceUrl: 'https://www.palegis.us/statutes/unconsolidated/law-information?sessYr=1893&sessInd=0&actNum=138',
    observe: 'sunday', // § 2(a): Sunday → the following Monday; no Saturday rule
    note: 'Not encoded: days appointed by the Governor or the President for thanksgiving, fasting or prayer.',
    holidays: [
      { name: "New Year's Day", month: 1, day: 1 },
      { name: 'Dr. Martin Luther King Jr. Day', month: 1, weekday: 1, nth: 3 },
      { name: "Presidents' Day", month: 2, weekday: 1, nth: 3 },
      { name: 'Good Friday', easter: -2 },
      { name: 'Memorial Day', month: 5, weekday: 1, nth: -1 },
      { name: 'Flag Day', month: 6, day: 14 },
      { name: 'Independence Day', month: 7, day: 4 },
      { name: 'Labor Day', month: 9, weekday: 1, nth: 1 },
      { name: 'Columbus Day', month: 10, weekday: 1, nth: 2 },
      { name: 'Election Day', month: 11, weekday: 1, nth: 1, offset: 1 },
      { name: "Veterans' Day", month: 11, day: 11 },
      { name: 'Thanksgiving Day', month: 11, weekday: 4, nth: 4 },
      { name: 'Christmas Day', month: 12, day: 25 },
    ],
  },

  // § 5-61-2(2) excepts "a state or federal holiday" from the weekday hours:
  // the state list in § 25-1-1 and the federal one in 5 U.S.C. § 6103.
  RI: {
    citation: 'R.I. Gen. Laws § 25-1-1; 5 U.S.C. § 6103(a)',
    sourceUrl: 'https://webserver.rilegislature.gov/Statutes/TITLE25/25-1/25-1-1.htm',
    // The state moves a weekend holiday to Monday; the federal list moves a
    // Saturday one to Friday. Both are blocked.
    observe: 'any',
    note: 'Not encoded: days appointed as holidays by the Governor, General Assembly, President or Congress.',
    holidays: [
      { name: "New Year's Day", month: 1, day: 1 },
      { name: "Dr. Martin Luther King Jr.'s Birthday", month: 1, weekday: 1, nth: 3 },
      { name: "Washington's Birthday", month: 2, weekday: 1, nth: 3 },
      { name: 'Rhode Island Independence Day', month: 5, day: 4 },
      { name: 'Memorial Day', month: 5, weekday: 1, nth: -1 },
      { name: 'Juneteenth', month: 6, day: 19 },
      { name: 'Independence Day', month: 7, day: 4 },
      { name: 'Victory Day', month: 8, weekday: 1, nth: 2 },
      { name: 'Labor Day', month: 9, weekday: 1, nth: 1 },
      { name: 'Columbus Day', month: 10, weekday: 1, nth: 2 },
      { name: 'Election Day', month: 11, weekday: 1, nth: 1, offset: 1, years: 'even' },
      { name: "Veterans' Day", month: 11, day: 11 },
      { name: 'Thanksgiving Day', month: 11, weekday: 4, nth: 4 },
      { name: 'Christmas Day', month: 12, day: 25 },
    ],
  },
};

const STATE_RULES = {
  AL: {
    windows: { default: ['08:00', '20:00'], sun: null },
    holidays: 'AL',
    citation: 'Ala. Admin. Code r. 770-X-5-.17(1)(b), (2)(b)',
    sourceUrl: 'https://admincode.legislature.state.al.us/api/rule/770-X-5-.17',
    lastVerified: '2026-10-08',
    note: 'A Public Service Commission rule, not a statute; it covers live and automated calls.',
  },
  CT: {
    windows: { default: ['09:00', '20:00'] },
    areaCodePresumption: true,
    coversText: 'yes',
    citation: 'Conn. Gen. Stat. § 42-288a(c); area-code presumption § 42-288(c)',
    sourceUrl: 'https://www.cga.ct.gov/current/pub/chap_743m.htm',
    lastVerified: '2026-10-08',
  },
  FL: {
    windows: { default: ['08:00', '20:00'] },
    areaCodePresumption: true,
    citation: 'Fla. Stat. § 501.616(6)(a); area-code presumption § 501.059(8)(d)',
    sourceUrl: 'http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.616.html',
    lastVerified: '2026-10-08',
  },
  KY: {
    windows: { default: ['10:00', '21:00'] },
    citation: 'Ky. Rev. Stat. § 367.46955(16)',
    sourceUrl: 'https://apps.legislature.ky.gov/law/acts/19RS/documents/0105.pdf',
    lastVerified: null,
    note: 'Read in the 2019 enactment (Acts ch. 105), not the current code. Applies to calls to a residence.',
  },
  LA: {
    windows: { default: ['08:00', '20:00'], sun: null },
    holidays: 'LA',
    citation: 'La. Rev. Stat. § 45:811',
    sourceUrl: 'https://www.legis.la.gov/Legis/LawPrint.aspx?d=100115',
    lastVerified: '2026-10-08',
  },
  MA: {
    windows: { default: ['08:00', '20:00'] },
    citation: 'Mass. Gen. Laws ch. 159C, § 3(ii)',
    sourceUrl: 'https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section3',
    lastVerified: '2026-10-08',
  },
  MD: {
    windows: { default: ['08:00', '20:00'] },
    areaCodePresumption: true,
    citation: 'Md. Code Ann., Com. Law § 14-4502(c)(1); area-code presumption § 14-4503(b)',
    sourceUrl: 'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4502&enactments=false',
    lastVerified: '2026-10-08',
  },
  MI: {
    windows: { default: ['09:00', '21:00'] },
    citation: 'Mich. Comp. Laws § 750.540e(1)(f)',
    sourceUrl: 'https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-750-540e',
    lastVerified: '2026-10-08',
    note: 'A misdemeanour that requires intent to annoy; encoded anyway, because the cost of honouring it is an hour.',
  },
  MN: {
    windows: { default: ['09:00', '21:00'] },
    citation: 'Minn. Stat. § 325E.30',
    sourceUrl: 'https://www.revisor.mn.gov/statutes/cite/325E.30',
    lastVerified: '2026-10-08',
  },
  MS: {
    windows: { default: ['08:00', '20:00'], sun: null },
    // "Central Standard Time" — read literally, a fixed UTC-6 clock that does
    // not move for daylight saving. The window is checked on that clock AND on
    // the recipient's, so neither reading is violated.
    fixedClock: 'Etc/GMT+6',
    citation: 'Miss. Code Ann. § 77-3-723(1)',
    sourceUrl: 'https://billstatus.ls.state.ms.us/documents/2023/html/HB/1200-1299/HB1225SG.htm',
    lastVerified: '2026-10-08',
  },
  NM: {
    windows: { default: ['09:00', '21:00'] },
    citation: 'N.M. Stat. Ann. § 57-12-22(B)(5)',
    sourceUrl: null,
    lastVerified: null,
  },
  NV: {
    windows: { default: ['09:00', '20:00'] },
    citation: 'Nev. Rev. Stat. § 598.0918(3)',
    sourceUrl: 'https://www.leg.state.nv.us/nrs/nrs-598.html',
    lastVerified: '2026-10-08',
  },
  OK: {
    windows: { default: ['08:00', '20:00'] },
    areaCodePresumption: true,
    citation: 'Okla. Stat. tit. 15, § 775C.4(A)(1); area-code presumption § 775C.3(D)',
    sourceUrl: 'https://oklegislature.gov/cf_pdf/2021-22%20ENR/hB/HB3168%20ENR.PDF',
    lastVerified: '2026-10-08',
  },
  OR: {
    windows: { default: ['08:00', '20:00'] },
    coversText: 'yes',
    citation: 'Or. Rev. Stat. § 646.563(1)(b), as amended by Or. Laws 2025, ch. 580',
    sourceUrl: 'https://www.oregonlegislature.gov/bills_laws/lawsstatutes/2025orlaw0580.pdf',
    lastVerified: '2026-10-08',
  },
  PA: [
    {
      windows: { default: ['08:00', '21:00'] },
      holidays: 'PA',
      citation: '73 P.S. § 2245(a)(1), (a)(10), before Act 47 of 2026',
      sourceUrl: 'https://www.palegis.us/legislation/bills/text/PDF/2025/0/SB0992/PN1649',
      lastVerified: '2026-10-08',
    },
    {
      effectiveFrom: '2026-10-18',
      windows: { default: ['09:00', '19:00'], sun: null },
      holidays: 'PA',
      coversText: 'yes',
      citation: '73 P.S. § 2245(a)(1), (a)(10), as amended by Act 47 of 2026 (SB 992)',
      sourceUrl: 'https://www.palegis.us/legislation/bills/text/PDF/2025/0/SB0992/PN1649',
      lastVerified: '2026-10-08',
    },
  ],
  RI: {
    windows: { default: ['09:00', '18:00'], sat: ['10:00', '17:00'], sun: null },
    holidays: 'RI',
    citation: 'R.I. Gen. Laws § 5-61-3.6; hours defined in § 5-61-2(2)',
    sourceUrl: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.6.htm',
    lastVerified: '2026-10-08',
    note: 'The holiday bar is written for weekdays; a Saturday holiday is blocked too, since the text does not settle it.',
  },
  SD: {
    windows: { default: ['09:00', '21:00'], sun: null },
    coversText: 'yes',
    citation: 'S.D. Codified Laws § 37-30A-3(2)',
    sourceUrl: 'https://sdlegislature.gov/Statutes/37-30A-3',
    lastVerified: '2026-10-08',
  },
  TX: {
    windows: { default: ['09:00', '21:00'], sun: ['12:00', '21:00'] },
    citation: 'Tex. Bus. & Com. Code § 301.051(b)(2)',
    sourceUrl: 'https://tcss.legis.texas.gov/resources/BC/htm/BC.301.htm',
    lastVerified: '2026-10-08',
  },
  UT: {
    windows: { default: ['08:00', '21:00'], sun: null },
    holidays: 'UT',
    coversText: 'yes',
    citation: 'Utah Code Ann. § 13-25a-103(3)',
    sourceUrl: 'https://le.utah.gov/xcode/Title13/Chapter25A/C13-25a-S103_2022050420220504.html',
    lastVerified: '2026-10-08',
  },
  WA: {
    windows: { default: ['08:00', '20:00'] },
    citation: 'Wash. Rev. Code § 80.36.390(8); § 19.158.110(4)',
    sourceUrl: 'https://app.leg.wa.gov/RCW/default.aspx?cite=80.36.390',
    lastVerified: '2026-10-08',
  },
  WY: {
    windows: { default: ['08:00', '20:00'] },
    citation: 'Wyo. Stat. Ann. § 40-12-302(d)',
    sourceUrl: 'https://wyoleg.gov/2003/enroll/hb0053.pdf',
    lastVerified: null,
    note: 'Read in the 2003 enactment, not the current code.',
  },
};

module.exports = { HOLIDAY_CALENDARS, STATE_RULES };
