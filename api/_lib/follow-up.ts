/**
 * Follow-up policy: what a disposition MAY carry, and what the server must
 * strip or require.
 *
 * The funnel's hard rule: a qualified user is a sales lead; a disqualified user
 * is NOT a lead unless they separately opt into a nurture relationship (and
 * even then they stay `disqualified`); a restricted user never enters either
 * pipeline. The browser supplies intent; this module is where intent becomes
 * policy, and it does not trust the browser for anything else.
 *
 * Pure functions, so the acceptance criteria in the spec are unit-testable
 * without a server.
 */

import type { Disposition } from './qualification';

export type FollowUpType = 'qualified_sales' | 'disqualified_nurture' | 'none';
export type ContactCaptureReason = 'qualified_application' | 'disqualified_optional_nurture' | null;

export interface FollowUpDecision {
  followUpOptIn: boolean;
  followUpType: FollowUpType;
  contactCaptureReason: ContactCaptureReason;
  /** May contact details be stored at all for this disposition? */
  contactAllowed: boolean;
  /** May a completion pass contact through only when consent was explicit? */
  consentRequired: boolean;
}

/**
 * The disposition comes from the answers (server-side), never the client. The
 * only input this function trusts from the browser is the opt-in flag.
 */
export function decideFollowUp(
  disposition: Disposition,
  browserOptIn: unknown
): FollowUpDecision {
  if (disposition === 'restricted') {
    return {
      followUpOptIn: false,
      followUpType: 'none',
      contactCaptureReason: null,
      contactAllowed: false,
      consentRequired: false,
    };
  }
  if (disposition === 'disqualified') {
    const optedIn = browserOptIn === true;
    return {
      followUpOptIn: optedIn,
      followUpType: optedIn ? 'disqualified_nurture' : 'none',
      contactCaptureReason: optedIn ? 'disqualified_optional_nurture' : null,
      contactAllowed: optedIn,
      consentRequired: optedIn,
    };
  }
  return {
    followUpOptIn: true,
    followUpType: 'qualified_sales',
    contactCaptureReason: 'qualified_application',
    contactAllowed: true,
    consentRequired: true,
  };
}

export interface EnforceResult {
  contact: Record<string, unknown>;
  consent: Record<string, unknown>;
  followUpOptIn: boolean;
  followUpType: FollowUpType;
  contactCaptureReason: ContactCaptureReason;
}

/**
 * Enforce the contact/consent policy on whatever the browser sent. PII the
 * disposition does not permit is discarded; a nurture contact that arrived
 * WITHOUT its explicit consent is rejected (the caller 400s on `reason`).
 */
export function enforceContactPolicy(args: {
  disposition: Disposition;
  browserOptIn: unknown;
  contact: Record<string, unknown>;
  consent: Record<string, unknown>;
}): { ok: true; value: EnforceResult } | { ok: false; reason: 'nurture_consent_required' | 'nurture_contact_required' } {
  const decision = decideFollowUp(args.disposition, args.browserOptIn);
  if (!decision.contactAllowed) {
    return {
      ok: true,
      value: {
        followUpOptIn: decision.followUpOptIn,
        followUpType: decision.followUpType,
        contactCaptureReason: decision.contactCaptureReason,
        contact: {},
        consent: {},
      },
    };
  }

  const intendedContact = decision.contactCaptureReason === 'disqualified_optional_nurture'
    ? args.contact
    : args.contact;

  if (decision.consentRequired && args.consent?.given !== true) {
    if (decision.followUpType === 'disqualified_nurture') {
      return { ok: false, reason: 'nurture_consent_required' };
    }
    // Qualified consent is enforced by the caller's existing flow.
  }

  if (decision.followUpType === 'disqualified_nurture') {
    const firstName = typeof intendedContact.firstName === 'string' ? intendedContact.firstName.trim() : '';
    const email = typeof intendedContact.email === 'string' ? intendedContact.email.trim() : '';
    const phone = typeof intendedContact.phone === 'string' ? intendedContact.phone.trim() : '';
    if (!firstName || (!email && !phone)) {
      return { ok: false, reason: 'nurture_contact_required' };
    }
  }

  return {
    ok: true,
    value: {
      followUpOptIn: decision.followUpOptIn,
      followUpType: decision.followUpType,
      contactCaptureReason: decision.contactCaptureReason,
      contact: intendedContact,
      consent: args.consent,
    },
  };
}