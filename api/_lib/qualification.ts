/**
 * Lead qualification: what state is this person in, and what may we do with
 * their details?
 *
 * This lives in its own module for one reason — it is the compliance decision,
 * and it is the decision this codebase has already got wrong once. The original
 * version compared `"New York"` against a set of two-letter codes, so no lead
 * was ever classified as restricted, and nothing anywhere failed. A wrong
 * answer here is not a bug report, it is contact details reaching a buyer who
 * is not permitted to have them.
 *
 * Pure functions, no database, no I/O — so the rules can be tested exhaustively
 * against a table of inputs rather than reasoned about. See qualification.test.ts.
 */

export type Disposition = 'qualified' | 'restricted' | 'disqualified';

export interface Answer {
  q?: string;
  a?: string;
  label?: string;
}

export type Answers = Record<string, Answer | undefined>;

/**
 * Any "No" here ends the qualification. `age` is included: the original
 * version asked the question and then ignored the answer.
 *
 * `workHistory` is the SSA work-credit rule stated as quarters: benefit
 * entitlement needs 20 quarters of coverage in the 40 quarters before onset
 * (roughly 5 of the last 10 years), not "20 years of work" as a prior revision
 * asked. It is still a knockout — a "No" means no credits, which means no
 * benefit entitlement.
 */
export const KNOCKOUT_QUESTIONS = ['age', 'work', 'duration', 'workHistory', 'doctor'] as const;

/**
 * Returned when a state was answered but could not be resolved to a real code.
 * It deliberately matches no row in `state_rules`, and the caller treats an
 * unmatched code as restricted — so an unparseable state fails closed.
 */
export const UNKNOWN_STATE = 'ZZ';

const NAME_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI',
  MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY',
};

/**
 * Resolve the state answer to a two-letter code.
 *
 * - `null` means the question has not been answered yet (a partial save two
 *   steps in). Not restricted, because there is nothing to restrict on.
 * - A two-letter code passes through — this is what the funnel sends.
 * - A full state name is accepted too, because an old cached client or a
 *   direct API caller may send one and being tolerant of that costs nothing.
 * - Anything else returns UNKNOWN_STATE, which fails closed.
 *
 * The truncation this replaces was the dangerous part: `"New York".slice(0, 2)`
 * is `"NE"`, which is Nebraska — a real, valid, *unrestricted* state. The bug
 * would not have surfaced as an error. It would have surfaced as New York
 * claimants being sold to buyers, which is the exact thing the restricted list
 * exists to prevent.
 */
export function stateCodeFrom(answers: Answers): string | null {
  const raw = answers.state?.a;
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toUpperCase();
  if (!value) return null;

  if (/^[A-Z]{2}$/.test(value)) return value;
  return NAME_TO_CODE[value.replace(/\s+/g, ' ')] ?? UNKNOWN_STATE;
}

/** True when any knockout question was answered "No". */
export function isDisqualified(answers: Answers): boolean {
  return KNOCKOUT_QUESTIONS.some((id) => answers[id]?.a === 'No');
}

/**
 * Machine-readable reason for an early exit, so follow-up can be tuned without
 * re-reading answer text. The FIRST knockout answer in question order decides;
 * later answers are moot. Null means the answers have not been disqualified.
 */
export function qualificationReasonFor(answers: Answers): string | null {
  const firstKnockout = KNOCKOUT_QUESTIONS.find((id) => answers[id]?.a === 'No');
  if (!firstKnockout) return null;
  const reasons: Record<typeof KNOCKOUT_QUESTIONS[number], string> = {
    age: 'age_out_of_range',
    work: 'unable_to_work_not_met',
    duration: 'condition_duration_not_met',
    workHistory: 'insufficient_work_history',
    doctor: 'no_current_medical_care',
  };
  return reasons[firstKnockout];
}

/**
 * Restriction outranks disqualification.
 *
 * The order matters and it is not arbitrary: a restricted lead must never be
 * routed to a buyer, whereas a disqualified one is merely not worth much. If
 * disqualification were checked first, a disqualified New York lead would be
 * labelled `disqualified` and lose the marker that keeps its contact details
 * out of Airtable.
 */
export function classify(args: { answers: Answers; restricted: boolean }): Disposition {
  if (args.restricted) return 'restricted';
  return isDisqualified(args.answers) ? 'disqualified' : 'qualified';
}
