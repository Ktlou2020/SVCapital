#!/usr/bin/env node
/* What a staff member is told when a call to Claude fails.
 *
 * The two routes that use the API turned a 529 into a sentence, because an
 * overloaded model is the failure they met first. Everything else reached
 * the screen exactly as the SDK raised it — so "Generate course" produced
 * this, in a toast:
 *
 *   Course generation failed: 400 {"type":"error","error":{"type":
 *   "invalid_request_error","message":"Your credit balance is too low to
 *   access the Anthropic API. Please go to Plans & Billing to upgrade or
 *   purchase credits."},"request_id":"req_011Cge…"}
 *
 * The remedy is in there and almost nobody will find it. Worse, it names a
 * billing page the reader has no account on — the key is SV Capital's, not
 * theirs — so the likely outcome is a support ticket and somebody pressing
 * the button for an hour.
 *
 * What this holds:
 *
 *   each failure the provider can hand us turns into a sentence naming the
 *   remedy and who can apply it;
 *   a failure the ROUTE raised itself keeps its own words, because those
 *   were already written for a reader;
 *   an empty account stops the quiz backfill instead of spending the rest
 *   of the list on calls that cannot work;
 *   and it is raised as an incident, because nobody can press through it.
 *
 * Run: node scripts/check-ai-failure-message.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { describeAIFailure, aiFailureMessage, isProviderAccountFailure } =
  require(path.join(ROOT, 'server', 'services', 'aiFailure.js'));

/* The real shape. The SDK puts the provider's JSON into err.message and the
   HTTP status on err.status, which is why the toast showed a JSON blob. */
const creditError = Object.assign(
  new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":' +
            '"Your credit balance is too low to access the Anthropic API. Please go to ' +
            'Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Cge"}'),
  { status: 400 });

console.log('\nthe failure that was actually seen becomes a sentence');
{
  const m = describeAIFailure(creditError);
  ok('it is translated at all', !!m, 'a 400 is not self-explanatory to a reader');
  ok('and none of the provider JSON survives into it',
     !/request_id|invalid_request_error|\{/.test(m || ''), m);
  ok('it says what went wrong', /out of credit/i.test(m || ''), m);
  ok('it says the fault is ours, not what they typed',
     /not a problem with what you entered/i.test(m || ''), m);
  ok('and it does not send staff to a billing page they have no account on',
     !/Plans & Billing/i.test(m || ''),
     'the key belongs to SV Capital; the reader cannot act on that link — ' + m);

  /* Through aiFailureMessage, which is what the routes actually call.
     Asserting only on describeAIFailure leaves the wiring between them
     untested — and the mutation that skipped it went unnoticed. */
  const shown = aiFailureMessage(creditError, 'Course generation failed.');
  ok('and the routes get that sentence, not the blob',
     shown === m, JSON.stringify(shown));
  ok('with nothing of the raw error in it',
     !/request_id|invalid_request_error|\{|Plans & Billing/.test(shown), shown);
}

console.log('\nand so does every other way the provider can refuse us');
{
  const cases = [
    ['a rejected key',   Object.assign(new Error('401 authentication_error'), { status: 401 }), /ANTHROPIC_API_KEY/],
    ['a forbidden call', Object.assign(new Error('403 permission_error'),     { status: 403 }), /ANTHROPIC_API_KEY/],
    ['rate limiting',    Object.assign(new Error('429 rate_limit_error'),     { status: 429 }), /Wait a minute/i],
    ['overload',         Object.assign(new Error('529 overloaded_error'),     { status: 529 }), /busy/i],
    ['their own error',  Object.assign(new Error('500 api_error'),            { status: 500 }), /request id/i],
  ];
  for (const [label, err, wants] of cases) {
    const m = describeAIFailure(err);
    ok(`${label} is translated`, !!m && wants.test(m), JSON.stringify(m));
  }
}

console.log('\nbut a message the route wrote for a reader is left alone');
{
  /* aiCourses raises this itself after three retries. Overwriting it with
     the generic overload line would lose the "retried three times over half
     a minute" that stops somebody retrying a fourth. */
  const own = new Error('The AI service is busy. It was retried three times over half a minute — '
                      + 'please wait a moment and generate again.');
  ok('it survives verbatim', aiFailureMessage(own) === own.message, aiFailureMessage(own));

  const parse = new Error('The model returned something that is not valid JSON.');
  ok('and so does a parsing failure of our own making',
     aiFailureMessage(parse) === parse.message, aiFailureMessage(parse));
  ok('an error with nothing to say still gets a sentence',
     aiFailureMessage(new Error(''), 'Generation failed. Please try again.')
       === 'Generation failed. Please try again.');
}

console.log('\nand the ones nobody can press through are told apart');
{
  ok('an empty account is an account failure', isProviderAccountFailure(creditError));
  ok('a rejected key is too',
     isProviderAccountFailure(Object.assign(new Error('401 authentication_error'), { status: 401 })));
  ok('overload is NOT — pressing again is exactly right there',
     !isProviderAccountFailure(Object.assign(new Error('529 overloaded_error'), { status: 529 })));
  ok('nor is rate limiting',
     !isProviderAccountFailure(Object.assign(new Error('429 rate_limit_error'), { status: 429 })));
}

console.log('\nand the routes use it where the message reaches a person');
{
  /* Comments stripped first. These assertions are about what the code
     DOES, and a paragraph of reasoning sitting between two statements
     should not decide whether a pattern spans them — the long comment
     explaining the incident below is exactly what defeated the first
     version of this. */
  const strip   = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const COURSES = strip(read('server/routes/aiCourses.js'));
  const EXTRACT = strip(read('server/routes/pe-extract.js'));

  ok('the course job records the translated message, not err.message',
     /error=\$2[\s\S]{0,200}\[jobId, message\]/.test(COURSES)
     && /const message = aiFailureMessage\(err/.test(COURSES),
     'this is the one the client polls for');
  ok('the provider’s own words still go to the server log',
     /console\.error\(`\[ai-courses\] job \$\{jobId\} failed:`, err\.status \|\| '', err\.message\)/.test(COURSES),
     'translating for the screen must not throw away what a debugger needs');
  ok('an account failure is raised as a critical incident',
     /isProviderAccountFailure\(err\)[\s\S]{0,400}severity: 'critical'/.test(COURSES),
     'nobody can press through it, so it belongs where whoever can act is looking');
  ok('the quiz route translates too',
     /aiFailureMessage\(err, 'Quiz generation failed/.test(COURSES));
  ok('and the backfill stops instead of failing every remaining module',
     /isProviderAccountFailure\(e\)[\s\S]{0,200}break;/.test(COURSES),
     'an empty account fails identically for all of them');
  ok('document extraction translates on all three of its paths',
     (EXTRACT.match(/aiFailureMessage\(err, 'Extraction failed\.'\)/g) || []).length === 3,
     'one untranslated path still shows the JSON blob');
  ok('and no route hands err.message straight to an extraction response',
     !/error: err\.message \|\| 'Extraction failed'/.test(EXTRACT));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
