/**
 * Tests for the follow-up policy.
 *
 * These encode the acceptance criteria that are the whole point of the feature:
 * a disqualified person is NOT a lead unless they separately opt into nurture;
 * a restricted person is stripped of contact no matter what the browser claims;
 * disqualified-no-opt-in stores no contact; and the server-side policy orders
 * restrictions above the client's intent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decideFollowUp, enforceContactPolicy, type FollowUpDecision } from './follow-up.js';
import { qualificationReasonFor } from './qualification.js';

function policy(disposition: 'qualified' | 'restricted' | 'disqualified', browserOptIn: unknown): FollowUpDecision {
  return decideFollowUp(disposition, browserOptIn);
}

const CONTACT = {
  firstName: 'Ada',
  email: 'ada@example.com',
  phone: '5550100100',
};
const CONSENT = {
  version: 'disqualified_nurture_v1',
  text: 'I agree to be contacted',
  given: true,
  timestamp: '2026-01-01T00:00:00Z',
};

function enforce(disposition: 'qualified' | 'restricted' | 'disqualified', opts: Record<string, unknown> = {}) {
  return enforceContactPolicy({
    disposition,
    browserOptIn: opts.browserOptIn,
    contact: (opts.contact ?? CONTACT) as Record<string, unknown>,
    consent: (opts.consent ?? CONSENT) as Record<string, unknown>,
  });
}

test('qualified is always a sales lead, regardless of what the browser claims', () => {
  const d = policy('qualified', false);
  assert.equal(d.followUpOptIn, true);
  assert.equal(d.followUpType, 'qualified_sales');
  assert.equal(d.contactCaptureReason, 'qualified_application');
  assert.equal(d.contactAllowed, true);
});

test('disqualified without opt-in is no lead at all', () => {
  const d = policy('disqualified', false);
  assert.equal(d.followUpOptIn, false);
  assert.equal(d.followUpType, 'none');
  assert.equal(d.contactCaptureReason, null);
  assert.equal(d.contactAllowed, false);
});

test('disqualified WITH opt-in is nurture, explicitly not sales', () => {
  const d = policy('disqualified', true);
  assert.equal(d.followUpOptIn, true);
  assert.equal(d.followUpType, 'disqualified_nurture');
  assert.equal(d.contactCaptureReason, 'disqualified_optional_nurture');
  assert.equal(d.contactAllowed, true);
});

test('disqualified opt-in is only honoured when the browser really said yes', () => {
  // Truthiness policing: only the literal boolean reflects intent. "1", "yes",
  // 1, and anything else string-like is a tampered or buggy client, and policy
  // fails closed to no lead.
  for (const bogus of ['yes', 'true', 1, '1', 'true ', null, undefined]) {
    const d = policy('disqualified', bogus);
    assert.equal(d.followUpOptIn, false, JSON.stringify(bogus));
    assert.equal(d.followUpType, 'none', JSON.stringify(bogus));
  }
});

test('restricted trumps everything the client may claim', () => {
  // Restricted from the server's answers, plus browser claims opt-in AND sends
  // contact: none of it is stored.
  const d = policy('restricted', true);
  assert.equal(d.followUpType, 'none');
  assert.equal(d.contactAllowed, false);
});

test('restricted contact and consent are stripped even when the browser sent them', () => {
  const out = enforce('restricted', { browserOptIn: true });
  assert.deepEqual(out, {
    ok: true,
    value: {
      followUpOptIn: false,
      followUpType: 'none',
      contactCaptureReason: null,
      contact: {},
      consent: {},
    },
  });
});

test('disqualified no-opt-in contact and consent are stripped', () => {
  const out = enforce('disqualified', { browserOptIn: false });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.contact, {});
  assert.deepEqual(out.value.consent, {});
  assert.equal(out.value.contactCaptureReason, null);
});

test('nurture opt-in requires its own explicit consent', () => {
  const missing = enforce('disqualified', { browserOptIn: true, consent: { given: false } });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'nurture_consent_required');

  const present = enforce('disqualified', { browserOptIn: true });
  assert.equal(present.ok, true);
  assert.equal(present.value.followUpType, 'disqualified_nurture');
});

test('nurture opt-in requires minimal contact', () => {
  const none = enforce('disqualified', { browserOptIn: true, contact: {} });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'nurture_contact_required');

  const noChannel = enforce('disqualified', {
    browserOptIn: true,
    contact: { firstName: 'Ada' },
  });
  assert.equal(noChannel.ok, false);
  assert.equal(noChannel.reason, 'nurture_contact_required');

  const firstNameOnlyIssue = enforce('disqualified', {
    browserOptIn: true,
    contact: { email: 'ada@example.com', phone: '5550100100' },
  });
  assert.equal(firstNameOnlyIssue.ok, false);
  assert.equal(firstNameOnlyIssue.reason, 'nurture_contact_required');

  const ok = enforce('disqualified', { browserOptIn: true, contact: CONTACT });
  assert.equal(ok.ok, true);
});

test('qualified passes its contact through unchanged for the sales path', () => {
  const out = enforce('qualified', { browserOptIn: true, contact: CONTACT });
  assert.equal(out.ok, true);
  assert.equal(out.value.contact.email, 'ada@example.com');
  assert.equal(out.value.contactCaptureReason, 'qualified_application');
});

test('qualification reason names the first knockout, in question order', () => {
  assert.equal(qualificationReasonFor({}), null);
  assert.equal(qualificationReasonFor({ work: { a: 'No' } }), 'unable_to_work_not_met');
  assert.equal(qualificationReasonFor({ workHistory: { a: 'No' } }), 'insufficient_work_history');
  assert.equal(qualificationReasonFor({ duration: { a: 'No' } }), 'condition_duration_not_met');
  assert.equal(qualificationReasonFor({ age: { a: 'No' } }), 'age_out_of_range');
  assert.equal(qualificationReasonFor({ doctor: { a: 'No' } }), 'no_current_medical_care');
  // age is the first knockout question, so it wins even when later ones are "No".
  assert.equal(
    qualificationReasonFor({ age: { a: 'No' }, work: { a: 'No' } }),
    'age_out_of_range'
  );
});