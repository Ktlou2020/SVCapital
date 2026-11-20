'use strict';
/* Every country, once.
 *
 * The sign-up form offered about thirty, chosen by hand and grouped by
 * region, and services/ficaService.js carried a nationality-to-country-code
 * map that mirrored exactly those thirty. That was survivable while
 * international registration was closed. It is not now: a client living in
 * a country nobody had thought to list could select neither their residence
 * nor their nationality, so the form was a dead end for most of the world,
 * and anything added to one list and not the other either breaks the FICA
 * call or silently offers a nationality it cannot verify.
 *
 * THE CODES ARE THE SOURCE and the names come from the runtime's own ICU
 * data rather than being typed out. 249 two-letter codes are easy to check
 * and hard to get subtly wrong; 249 hand-typed country names are the
 * opposite. Brute-forcing AA–ZZ through Intl is NOT the same thing and was
 * the first attempt: CLDR answers for deprecated and exceptional codes too,
 * so "Zimbabwe" came back as RH — Southern Rhodesia — which sorts earlier
 * than ZW and would have been written into client records.
 */

const ISO_3166_1 = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI ' +
  'BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN ' +
  'CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK ' +
  'FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
  'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
  'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ' +
  'ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP ' +
  'NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF ' +
  'TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
  'VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const _display = new Intl.DisplayNames(['en'], { type: 'region' });

/* name → code and code → name, built once. A code the runtime cannot name
   is dropped rather than written out as its own code: "XX" in a country
   dropdown is worse than one missing country. */
const BY_CODE = {};
const BY_NAME = {};
for (const code of ISO_3166_1) {
  let name;
  try { name = _display.of(code); } catch (_) { name = null; }
  if (!name || name === code) continue;
  BY_CODE[code] = name;
  BY_NAME[name.toLowerCase()] = code;
}

/* Alphabetical, which is the only order that works for a list this long —
   the old one was grouped by region, which is helpful at thirty and
   unusable at two hundred and fifty. */
const NAMES = Object.values(BY_CODE).sort((a, b) => a.localeCompare(b, 'en'));

const DEFAULT_COUNTRY = 'South Africa';

function codeForCountry(name) {
  return BY_NAME[String(name || '').trim().toLowerCase()] || null;
}
function countryForCode(code) {
  return BY_CODE[String(code || '').trim().toUpperCase()] || null;
}

module.exports = { ISO_3166_1, NAMES, BY_CODE, BY_NAME, DEFAULT_COUNTRY,
                   codeForCountry, countryForCode };
