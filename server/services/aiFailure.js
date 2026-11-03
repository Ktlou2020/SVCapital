/* ═══════════════════════════════════════════════════════════
   What to tell somebody when a call to Claude fails.

   The two routes that use the API already turn a 529 into a sentence,
   because an overloaded model is the failure they met first. Every other
   failure went to the screen exactly as the SDK raised it, so a staff
   member pressing "Generate course" was shown this, in a toast:

     Course generation failed: 400 {"type":"error","error":{"type":
     "invalid_request_error","message":"Your credit balance is too low to
     access the Anthropic API. Please go to Plans & Billing to upgrade or
     purchase credits."},"request_id":"req_011Cge…"}

   The remedy is in there, and almost nobody will find it. Worse, the
   message names a billing page the reader has no account on — the key
   belongs to SV Capital, not to the person who pressed the button — so the
   most likely outcome is a support ticket and somebody pressing the button
   again for an hour.

   So: one place that turns a provider failure into a sentence saying what
   happened and who can fix it. It does NOT swallow the detail — the full
   error still goes to the server log, with the request id, which is what
   anyone debugging actually needs.

   Matched on status AND on the message, because the SDK reports the same
   condition differently depending on whether it came back as a typed error
   or as a wrapped one, and because a credit failure arrives as a 400 —
   indistinguishable by status alone from a genuinely malformed request.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* Deliberately not "contact support": these are all things SV Capital does
   to itself, and the person reading is staff. Naming the actual remedy is
   what turns a dead end into a five-minute fix. */
function describeAIFailure(err) {
  const status = Number(err && err.status) || 0;
  const text   = String((err && err.message) || '');

  if (/credit balance is too low|insufficient[_ ]credit|billing/i.test(text)) {
    return 'The AI service is out of credit, so nothing could be generated. '
         + 'This is an SV Capital account balance, not a problem with what you '
         + 'entered — top up the Anthropic account and generate again.';
  }
  if (status === 401 || /invalid x-api-key|authentication[_ ]error/i.test(text)) {
    return 'The AI service rejected our key. Nothing you can do from here — '
         + 'the ANTHROPIC_API_KEY on the server needs checking.';
  }
  if (status === 403 || /permission[_ ]error/i.test(text)) {
    return 'The AI service refused the request as not permitted for our account. '
         + 'The ANTHROPIC_API_KEY on the server needs checking.';
  }
  if (status === 429 || /rate[_ ]limit/i.test(text)) {
    return 'The AI service is rate-limiting us — too many generations at once. '
         + 'Wait a minute and generate again.';
  }
  if (status === 529 || /overloaded/i.test(text)) {
    return 'The AI service is busy. Please wait a moment and generate again.';
  }
  if (status >= 500) {
    return 'The AI service had an error of its own. Please generate again; if it '
         + 'keeps happening the server log has the request id.';
  }
  /* Everything else — including a 400 that is genuinely our malformed
     request — keeps its own words. A route that raised the error itself has
     already written it for a reader, and this must not overwrite that. */
  return null;
}

/* The message to show, always a sentence. Falls back to whatever the error
   said when it is one of ours rather than the provider's. */
function aiFailureMessage(err, fallback = 'Generation failed. Please try again.') {
  return describeAIFailure(err) || String((err && err.message) || fallback);
}

/* Whether this is the provider's fault rather than the request's — the ones
   where pressing the button again is pointless until somebody acts. */
function isProviderAccountFailure(err) {
  const text = String((err && err.message) || '');
  return /credit balance is too low|insufficient[_ ]credit|billing|invalid x-api-key|authentication[_ ]error|permission[_ ]error/i.test(text)
      || Number(err && err.status) === 401
      || Number(err && err.status) === 403;
}

module.exports = { describeAIFailure, aiFailureMessage, isProviderAccountFailure };
