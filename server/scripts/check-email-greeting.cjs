#!/usr/bin/env node
/* One greeting per email.
 *
 * A client rejected for a KYC document received this:
 *
 *   Hi Karel,
 *   Dear Karel,
 *   Thank you for submitting your documents…
 *
 * sendAlert greets the recipient itself — it is the one thing in the stack
 * that knows their name — and the message the admin console handed it opened
 * with a greeting of its own.
 *
 * Fixing the two hardcoded messages alone would have left the worse half of
 * it: the same endpoint carries whatever an admin types into the free-text
 * composer, and a person writing an email naturally starts with a greeting.
 * So the stripping happens in sendAlert, and what is asserted here is the
 * rendered email — captured on its way to Resend — rather than the wording of
 * any one caller.
 *
 * The opposite failure matters as much. Eating the first line of somebody's
 * message is worse than the duplicate it was meant to prevent, so half of
 * this is about what must NOT be stripped.
 *
 * Run: node server/scripts/check-email-greeting.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* Captured on the wire rather than reasoned about: what reaches Resend is the
   email, and a regex over the source still matches after the call that uses
   it has gone. */
process.env.RESEND_API_KEY = 'check-email-greeting';
process.env.BASE_URL = 'https://platform.svcapital.co.za';
const sent = [];
global.fetch = async (url, opts) => {
  try { sent.push(JSON.parse(opts.body)); } catch (_) { sent.push({ raw: opts && opts.body }); }
  return { ok: true, status: 200, json: async () => ({ id: 'stub' }), text: async () => '{}' };
};

const email = require(path.join(ROOT, 'server', 'services', 'email.js'));
const { stripLeadingGreeting: strip } = email;

console.log('\nit removes a greeting the caller already wrote');
{
  const KEEP = 'Thank you for submitting your documents.';
  for (const [input, label] of [
    [`Dear Karel,\n\n${KEEP}`,        'Dear — the one that was reported'],
    [`Hi Karel,\n\n${KEEP}`,          'Hi'],
    [`Hello Karel,\n${KEEP}`,         'a single newline after it'],
    [`Hey Karel,\n\n${KEEP}`,         'Hey'],
    [`Good morning Karel,\n\n${KEEP}`, 'Good morning'],
    [`Good day Karel,\n\n${KEEP}`,    'Good day'],
    [`Greetings Karel,\n\n${KEEP}`,   'Greetings'],
    [`dear karel,\n\n${KEEP}`,        'lowercase'],
    [`DEAR KAREL,\n\n${KEEP}`,        'shouting'],
    [`  Dear Karel,  \n\n${KEEP}`,    'padded with spaces'],
    [`Dear Karel:\n\n${KEEP}`,        'a colon instead of a comma'],
    [`Dear Sir or Madam,\n\n${KEEP}`, 'no name at all'],
  ]) {
    ok(`${label} is removed`, strip(input) === KEEP, JSON.stringify(strip(input).slice(0, 50)));
  }
}

console.log('\nand leaves alone everything that is not one');
{
  /* The failure that would be worse than the bug. */
  for (const [input, label] of [
    ['Dear clients, we are writing to confirm the new rate applies from Monday.',
     'a sentence that opens with a greeting word'],
    ['Hi there is a problem with your account and we need you to act on it now.',
     'a sentence starting "Hi there…"'],
    ['Your document was rejected.\n\nDear Karel, please resubmit.',
     'a greeting that is not at the start'],
    ['Thank you for submitting your documents.', 'no greeting at all'],
    ['Dear Karel, thank you for submitting your documents and for your patience.',
     'a greeting run into the sentence on one line'],
    /* Anchoring. Without it, any greeting word anywhere in the first line
       makes everything before it disappear. */
    ['We said hello to the team about your account,\n\nand here is what they said.',
     'a greeting word in the middle of the first line'],
    ['Please say hi to Karel,\n\nand ask him to resubmit.',
     'another one — the whole line would vanish'],
    /* The 40-character bound is the only thing keeping a long opening clause
       from being read as a name. */
    ['Dear valued client of SV Capital and holder of account SVC-0001,\n\nBody.',
     'a salutation too long to be a name'],
  ]) {
    ok(`${label} is untouched`, strip(input) === input, JSON.stringify(strip(input).slice(0, 60)));
  }
  ok('and nothing throws on nothing',
     strip(null) === '' && strip(undefined) === '' && strip('') === '');
}

(async () => {
console.log('\nthe email that actually goes out has one greeting');
{
  const investor = { email: 'karel@example.com', first_name: 'Karel', id: null };
  const body = 'Thank you for submitting your documents. Unfortunately, we were unable to accept your Identity Document at this time.';

  const greetings = html => (String(html).match(/&gt;|<p>\s*(?:Hi|Dear|Hello|Hey)\b[^<]*<\/p>/gi) || [])
    .filter(m => /^<p>/i.test(m));

  const run = async (message, label) => {
    sent.length = 0;
    await email.sendAlert(investor, { subject: 'Action required: Your Identity Document', message });
    const payload = sent[0] || {};
    const found = greetings(payload.html || '');
    ok(`${label}: exactly one greeting`, found.length === 1,
       `${found.length} found: ${JSON.stringify(found)}`);
    ok(`${label}: and it is the recipient's name`, /Hi Karel,/.test(payload.html || ''),
       String(payload.html || '').slice(0, 300));
    /* The plain-text alternative is a second copy of the same email and had
       the same fault. */
    const textGreetings = (String(payload.text || '').match(/^(?:Hi|Dear|Hello|Hey)\b[^\n]*,/gim) || []);
    ok(`${label}: the plain-text part too`, textGreetings.length === 1,
       JSON.stringify(payload.text || '').slice(0, 200));
  };

  await run(body, 'a message with no greeting');
  /* The exact message that produced the report. A stale admin console, or an
     admin typing one by hand, still has to come out right. */
  await run(`Dear Karel,\n\n${body}`, 'a message that brings its own');
}

console.log('\nand the console does not write one either');
{
  const admin = read('admin/js/admin.js');
  const calls = [...admin.matchAll(/'admin\/send-investor-email'[\s\S]{0,700}?message: `([^`]*)`/g)]
    .map(m => m[1]);
  ok('the rejection emails are found', calls.length >= 2, `${calls.length} found`);
  ok('none of them opens with a greeting',
     calls.every(c => !/^\s*(?:Hi|Hey|Hello|Dear|Greetings|Good\s+\w+)\b[^\n]{0,40}[,:]/i.test(c)),
     calls.filter(c => /^\s*(?:Hi|Dear)/i.test(c)).map(c => c.slice(0, 60)).join(' | '));

  const svc = read('server/services/email.js');
  ok('sendAlert strips before it renders',
     /function sendAlert[\s\S]{0,300}message = stripLeadingGreeting\(message\);/.test(svc),
     'a caller that writes its own greeting is not a caller anybody controls');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
