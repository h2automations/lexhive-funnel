/**
 * Tests for the compliance decision.
 *
 * The first case is the bug that actually shipped: the funnel stored
 * `"New York"` and the code compared it against a set of two-letter codes, so
 * every restricted lead was classified `qualified`. It ran in production
 * against every single lead and raised nothing — no error, no warning, no
 * failed request. A test over a table of inputs is the only thing that catches
 * that class of bug, which is why this file exists.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stateCodeFrom,
  isDisqualified,
  classify,
  UNKNOWN_STATE,
  type Answers,
} from './qualification.js';

const answers = (values: Record<string, string>): Answers =>
  Object.fromEntries(Object.entries(values).map(([k, a]) => [k, { a }]));

test('a two-letter code passes through — what the funnel sends', () => {
  assert.equal(stateCodeFrom(answers({ state: 'NY' })), 'NY');
  assert.equal(stateCodeFrom(answers({ state: 'tx' })), 'TX');
  assert.equal(stateCodeFrom(answers({ state: ' ny ' })), 'NY');
});

test('a full state name resolves rather than being truncated', () => {
  // The regression that matters. "New York".slice(0, 2) is "NE" — Nebraska,
  // a real and UNRESTRICTED state. The old code would have routed a New York
  // claimant's phone number to a buyer and reported success.
  assert.equal(stateCodeFrom(answers({ state: 'New York' })), 'NY');
  assert.notEqual(stateCodeFrom(answers({ state: 'New York' })), 'NE');

  assert.equal(stateCodeFrom(answers({ state: 'NORTH CAROLINA' })), 'NC');
  assert.equal(stateCodeFrom(answers({ state: 'new  jersey' })), 'NJ');
  assert.equal(stateCodeFrom(answers({ state: 'Texas' })), 'TX');
});

test('an unanswered state is null, not a guess', () => {
  // A partial save two steps in has no state yet. That is not "unknown", it is
  // "not asked", and it must not be treated as restricted or the funnel would
  // restrict everyone who has answered only the first question.
  assert.equal(stateCodeFrom({}), null);
  assert.equal(stateCodeFrom(answers({ state: '' })), null);
  assert.equal(stateCodeFrom(answers({ state: '   ' })), null);
  assert.equal(stateCodeFrom({ state: undefined }), null);
});

test('an unrecognisable state fails closed', () => {
  // UNKNOWN_STATE matches no row in state_rules, and /api/lead treats an
  // unmatched code as restricted.
  assert.equal(stateCodeFrom(answers({ state: 'Atlantis' })), UNKNOWN_STATE);
  assert.equal(stateCodeFrom(answers({ state: '<script>' })), UNKNOWN_STATE);
  assert.equal(stateCodeFrom(answers({ state: '12345' })), UNKNOWN_STATE);
});

test('every knockout question disqualifies, age included', () => {
  for (const id of ['age', 'work', 'duration', 'doctor', 'workHistory']) {
    assert.equal(isDisqualified(answers({ [id]: 'No' })), true, `${id} must knock out`);
  }
});

test('a complete set of Yes answers qualifies', () => {
  const complete = answers({
    age: 'Yes', state: 'TX', work: 'Yes', duration: 'Yes', doctor: 'Yes', workHistory: 'Yes',
  });
  assert.equal(isDisqualified(complete), false);
  assert.equal(classify({ answers: complete, restricted: false }), 'qualified');
});

test('a partially answered funnel is not disqualified by absence', () => {
  // Nobody has said "No" yet — they simply have not got there.
  assert.equal(isDisqualified(answers({ age: 'Yes' })), false);
  assert.equal(isDisqualified({}), false);
});

test('restriction outranks disqualification', () => {
  // A disqualified New York lead is still a New York lead. If disqualification
  // won, the row would lose the marker that keeps contact details out of
  // Airtable — the failure would be silent and in the wrong direction.
  const disqualifiedInNY = answers({ state: 'NY', work: 'No' });

  assert.equal(classify({ answers: disqualifiedInNY, restricted: true }), 'restricted');
  assert.equal(classify({ answers: disqualifiedInNY, restricted: false }), 'disqualified');
});

test('the disposition table, end to end', () => {
  const cases: { name: string; answers: Answers; restricted: boolean; expect: string }[] = [
    { name: 'clean Texas lead', answers: answers({ state: 'TX', age: 'Yes', work: 'Yes' }), restricted: false, expect: 'qualified' },
    { name: 'New York lead', answers: answers({ state: 'NY', age: 'Yes', work: 'Yes' }), restricted: true, expect: 'restricted' },
    { name: 'cannot work', answers: answers({ state: 'TX', work: 'No' }), restricted: false, expect: 'disqualified' },
    { name: 'too young', answers: answers({ state: 'TX', age: 'No' }), restricted: false, expect: 'disqualified' },
    { name: 'restricted and disqualified', answers: answers({ state: 'NY', work: 'No' }), restricted: true, expect: 'restricted' },
    { name: 'nothing answered', answers: {}, restricted: false, expect: 'qualified' },
  ];

  for (const c of cases) {
    assert.equal(classify({ answers: c.answers, restricted: c.restricted }), c.expect, c.name);
  }
});
