'use strict';
/* Where the app is downloaded from.
 *
 * The store URLs already existed in two places — the marketing page and
 * js/app-banner.js — and an invitation needs them in two more, an email and
 * an SMS, neither of which can run the browser code that holds them. So they
 * are written once here and check-app-invite asserts the client copy agrees;
 * a store id that is corrected in one place and not the others sends part of
 * the audience to a page that does not exist, and nothing about a dead store
 * link tells you which copy is stale.
 *
 * The App Store id is the NUMERIC one on purpose: apps.apple.com resolves the
 * app's name itself, so the number is the part that cannot go stale when the
 * listing is renamed.
 */

/* Where this environment lives, resolved once for everything that writes a
 * link into a message.
 *
 * The fallback is PRODUCTION'S address and no environment sets BASE_URL — so
 * staging's messages carried production's links, and a tester following one
 * left staging without being told. The email service worked this out for
 * itself and the SMS service simply typed the live host into the string, so
 * there were two answers and one of them could not be changed at all.
 *
 * Production keeps the fallback exactly as it was. Anywhere else uses the
 * environment's own public address, so a new environment is right without
 * anybody remembering to set a variable, and BASE_URL still wins when set.
 */
const _railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || '';
const BASE_URL = process.env.BASE_URL
  || ((_railwayEnv && _railwayEnv.toLowerCase() !== 'production' && process.env.RAILWAY_PUBLIC_DOMAIN)
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://platform.svcapital.co.za');
const BASE_HOST = (() => {
  try { return new URL(BASE_URL).host; } catch (_) { return 'platform.svcapital.co.za'; }
})();

const IOS_APP_ID = '6670504520';
const IOS_URL     = `https://apps.apple.com/za/app/id${IOS_APP_ID}`;
const ANDROID_ID  = 'co.za.svcapital.app';
const ANDROID_URL = `https://play.google.com/store/apps/details?id=${ANDROID_ID}`;

/* One link for both phones, for the places that only have room for one — an
   SMS above all, where two URLs is most of the message. It lands on a page
   that sends each phone to its own store and shows both either way. */
function getAppUrl(baseUrl) {
  return `${String(baseUrl || BASE_URL).replace(/\/+$/, '')}/get-app`;
}

module.exports = {
  BASE_URL, BASE_HOST,
  IOS_APP_ID, IOS_URL, ANDROID_ID, ANDROID_URL, getAppUrl,
};
