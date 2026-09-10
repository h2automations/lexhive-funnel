import { useEffect, useMemo, useRef, useState } from 'react';
import { getExternalId, getAttribution, refreshCookies } from '../lib/tracking';
import { STATES, type Option } from '../lib/states';
import { funnelReady, funnelStep, leadSubmitted } from '../lib/datalayer';
import { newUuid } from '../lib/uuid';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CrossIcon } from './Icons';

/**
 * Social Security disability qualification funnel.
 *
 * One question per screen for an audience of people over 40 who cannot work,
 * arriving from a Meta ad on a phone, frequently with a vision, motor, or
 * cognitive impairment. 4rem targets, 1.125rem minimum body text, focus moved
 * to each new question, errors carried by shape as well as colour, and a
 * rem-based scale so an enlarged device font actually enlarges the page.
 *
 * Every answer updates ONE partial lead row (the row id comes back from the
 * first save and is sent on every subsequent one), so an abandoned funnel
 * leaves a single recoverable record with a per-step drop-off point rather
 * than one row per question.
 *
 * Restriction is decided by the server against the `state_rules` table, never
 * by a list hardcoded in the browser — that is what makes the restricted list
 * changeable without a deploy.
 *
 * UX review (docs/ux-growth-review-2026-09-10.md) changes incorporated:
 *   - gender removed (it was a Meta match key, not a knockout question)
 *   - state uses a native picker + explicit confirm, shown immediately after
 *     age so unsupported states leave early instead of answering four more
 *   - a knockout "No" exits to a distinct non-match screen with no contact
 *     capture, instead of walking a non-match through the full contact form
 *   - work-history wording corrected to the SSA 20-of-40-quarter rule
 *   - contact is phone-led: name + phone required, email and ZIP optional
 *   - compact brand header, plain-language service promise, progress labels
 *   - the availability check distinguishes "cannot check right now" (retry)
 *     from "we do not serve this state" (restricted outcome)
 */

interface Answer {
  q: string;
  a: string;
  label?: string;
}

interface Contact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  zip: string;
  consent: boolean;
}

type Result = 'none' | 'restricted' | 'disqualified';

const YES_NO: Option[] = [
  { label: 'Yes', value: 'Yes' },
  { label: 'No', value: 'No' },
];

/** Questions whose "No" ends the qualification. Mirrors api/_lib/qualification.ts. */
const KNOCKOUT_IDS = ['age', 'work', 'duration', 'workHistory', 'doctor'];

const QUESTIONS: { id: string; q: string; o: Option[]; picker?: boolean }[] = [
  { id: 'age', q: 'Are you between 18 and 64 years old?', o: YES_NO },
  // The state is asked second, not mid-flow. Availability is the first piece
  // of information worth knowing: a person in a state we cannot serve should
  // learn that now, not after four more taps.
  { id: 'state', q: 'Which state do you live in?', o: STATES, picker: true },
  { id: 'work', q: 'Are you unable to work because of a medical condition?', o: YES_NO },
  {
    id: 'duration',
    q: 'Has your condition lasted—or is it expected to last—at least 12 months?',
    o: YES_NO,
  },
  // SSA: benefit entitlements depend on work credits earned in the ten years
  // before the onset of disability — generally 20 credits, roughly five of the
  // last ten years, not "20 years of work". "40 quarters" is the same thing
  // stated as credits-per-quarter, and asking people to count quarters is a
  // calculation on a yes/no screen.
  {
    id: 'workHistory',
    q: 'Have you worked 20 of the last 40 quarters (roughly 5 of the last 10 years)?',
    o: YES_NO,
  },
  { id: 'doctor', q: 'Are you seeing a doctor for this condition?', o: YES_NO },
];

const STEPS = QUESTIONS.length + 1; // +1 for the contact step

/**
 * The consent artifact. In legal lead gen the record of what the person
 * actually agreed to is the product, so the exact text is versioned and stored
 * alongside the timestamp, IP and user agent — not just a version number that
 * nobody can resolve back to wording six months later.
 */
const CONSENT_VERSION = 'v1.1';
const NURTURE_CONSENT_VERSION = 'disqualified_nurture_v1';
const CONSENT_TEXT = {
  standard:
    'I consent to be contacted by phone, text message, or email about Social Security disability benefits, including by automated dialing technology. Consent is not a condition of any purchase.',
  restricted:
    'I understand this is not an application for benefits and that no one will contact me about this enquiry.',
  nurture:
    'I agree to be contacted about other potentially relevant programs, services, or future eligibility opportunities.',
} as const;

const EMPTY_CONTACT: Contact = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  zip: '',
  consent: false,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Funnel({ variant }: { variant: string }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);
  const [disposition, setDisposition] = useState<string>('qualified');
  const [result, setResult] = useState<Result>('none');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [checkingState, setCheckingState] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Held in a ref as well as state: `answer()` fires the next partial save
  // before React has re-rendered, and the save must carry the id it was
  // given last time or the server has no row to update.
  const leadIdRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mainRef = useRef<HTMLDivElement>(null);
  // A disqualified lead is finalised only when the person chooses on the result
  // screen; the ref stops Back/forward re-navigation from firing a second
  // completion. `disqOpt` is the person's choice there: leave the flow, or
  // opt into future-fit program updates.
  const disqualifiedSentRef = useRef(false);
  // Two different guards, because they answer two different questions.
  //
  // `submitInFlightRef` stops a second request while one is open. React sets
  // `status` asynchronously, so `disabled={status === 'submitting'}` on the
  // button is a render-time promise, not a re-entry lock.
  //
  // `conversionPushedRef` is the one that matters for measurement. If the
  // server commits but the response never arrives, the person sees an error
  // and presses the button again; /api/lead is idempotent and replies with the
  // SAME event_id, so a second push would put two `qualified_lead` events on
  // the dataLayer for one conversion. Meta collapses them (same event_name,
  // same event_id, that is what deduplication is), but GA4 counts a second
  // `generate_lead` and the funnel report starts lying. Latched on the push
  // rather than on the request, so a genuine failure can still be retried.
  const submitInFlightRef = useRef(false);
  const conversionPushedRef = useRef(false);
  const [disqOpt, setDisqOpt] = useState<'none' | 'exit' | 'nurture'>('none');
  const [nurtureOpted, setNurtureOpted] = useState(false);

  const externalId = useMemo(() => getExternalId(), []);
  // One id for this browser session's submission, minted once at mount and
  // stable across every rerender. `/api/lead` validates it as a UUID and
  // persists it as `leads.event_id` — the id the browser Pixel and the
  // Conversions API both fire with — so a non-UUID here does not degrade
  // tracking, it 400s the whole funnel. See src/lib/uuid.ts.
  const submissionId = useMemo(() => newUuid(), []);
  const restricted = result === 'restricted';

  const stateValue = answers.state?.a ?? '';
  const stateLabel = useMemo(
    () => STATES.find((s) => s.value === stateValue)?.label ?? '',
    [stateValue]
  );

  useEffect(() => {
    // Tags are configured in GTM; the app only announces what happened.
    funnelReady({ variant, externalId });
    getAttribution();
  }, [externalId, variant]);

  // Move focus to each new question so screen readers start on it.
  useEffect(() => {
    if (status === 'done') return;
    const target = mainRef.current?.querySelector('[data-focus]');
    if (target) (target as HTMLElement).focus({ preventScroll: true });
  }, [step, status, result]);

  const currentQuestion = QUESTIONS[step];

  /**
   * Save progress. Returns { ok, disposition } so the state question can
   * distinguish a real "restricted" verdict from a network failure — the two
   * are not the same thing and must not share a message.
   */
  async function persistPartial(nextAnswers: Record<string, Answer>): Promise<{
    ok: boolean;
    disposition: string | null;
  }> {
    const save = async (): Promise<{ ok: boolean; disposition: string | null }> => {
      try {
        const res = await fetch('/api/lead', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            leadId: leadIdRef.current,
            submissionId,
            variant,
            status: 'partial',
            answers: nextAnswers,
            attribution: getAttribution(),
            externalId,
          }),
        });
        if (!res.ok) return { ok: false, disposition: null };
        const data = await res.json();
        if (data.leadId) leadIdRef.current = data.leadId;
        if (typeof data.disposition === 'string') setDisposition(data.disposition);
        return { ok: true, disposition: typeof data.disposition === 'string' ? data.disposition : null };
      } catch {
        // A partial save must never block the funnel.
        return { ok: false, disposition: null };
      }
    };

    // Preserve answer order. Besides preventing stale writes, this ensures the
    // final completion cannot overtake a slow partial save.
    const pending = saveQueueRef.current.then(save, save);
    saveQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /**
   * Finalise a disqualified lead. The opt-in is the whole story: false means
   * the person leaves with nothing stored beyond their answers and status; true
   * means a minimal contact and the nurture consent ARE stored, and the lead
   * is routed to the nurture pipeline — never the sales one. The server
   * enforces all of this; this code only declares intent.
   */
  async function completeDisqualified(args: {
    followUpOptIn: boolean;
    contact?: { firstName: string; email?: string; phone?: string };
    consent?: { version: string; text: string; given: boolean; timestamp: string };
  }) {
    if (disqualifiedSentRef.current) return;
    disqualifiedSentRef.current = true;
    setStatus('submitting');
    setError(null);
    try {
      await saveQueueRef.current;
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId: leadIdRef.current,
          submissionId,
          variant,
          status: 'complete',
          answers,
          followUpOptIn: args.followUpOptIn,
          contact: args.contact ?? undefined,
          consent: args.consent ?? undefined,
          attribution: getAttribution(),
          externalId,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.leadId) {
        // Honest retry: the choice screen is not a trap. The person can press
        // the button again rather than being stranded on a dead end.
        disqualifiedSentRef.current = false;
        setStatus('error');
        setError('Something went wrong. Please try again.');
        return;
      }

      leadIdRef.current = data.leadId;
      if (data.disposition) setDisposition(data.disposition);
      if (args.followUpOptIn) setNurtureOpted(true);
      setStatus('done');
      setStep(STEPS);
    } catch {
      disqualifiedSentRef.current = false;
      setStatus('error');
      setError('Could not submit. Please check your connection and try again.');
    }
  }

  function onDisqNoThanks() {
    void completeDisqualified({ followUpOptIn: false });
  }

  function validateNurture(): boolean {
    const errors: Record<string, string> = {};
    if (!contact.firstName.trim()) errors.firstName = 'Enter your first name.';
    const digits = contact.phone.replace(/\D/g, '');
    const validPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
    if (!contact.email.trim() && !contact.phone.trim())
      errors.phone = 'Enter an email address or phone number we can reach you on.';
    if (contact.phone.trim() && !validPhone)
      errors.phone = 'Enter a valid 10-digit phone number, e.g. 555-010-0100.';
    if (contact.email.trim() && !EMAIL_RE.test(contact.email.trim()))
      errors.email = 'Enter a valid email address, e.g. name@example.com.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const first = Object.keys(errors)[0];
      const el = mainRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.focus();
      return false;
    }
    return true;
  }

  function onDisqNurtureSubmit() {
    if (disqualifiedSentRef.current || status === 'submitting') return;
    if (!contact.consent) {
      setError('Please confirm you want to be contacted about other programs.');
      return;
    }
    if (!validateNurture()) return;
    void completeDisqualified({
      followUpOptIn: true,
      contact: {
        firstName: contact.firstName.trim(),
        email: contact.email.trim() || undefined,
        phone: contact.phone.trim() || undefined,
      },
      consent: {
        version: NURTURE_CONSENT_VERSION,
        text: CONSENT_TEXT.nurture,
        given: true,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /** The state screen's confirm button: real availability verdict, explicitly confirmed. */
  async function confirmState() {
    const next = {
      ...answers,
      state: { q: currentQuestion.q, a: stateValue, label: stateLabel },
    };
    if (!stateValue) return;

    setCheckingState(true);
    setStateError(null);
    const save = await persistPartial(next);
    setCheckingState(false);

    if (!save.ok) {
      // "cannot check right now" ≠ "we do not serve this state". The person
      // stays on the picker, can retry, and is never asked for contact details
      // without a verdict.
      setStateError('We could not check availability right now. Please try again in a moment.');
      return;
    }

    setAnswers(next);
    // The state screen is confirmed rather than tapped, but it is still an
    // answered step: the ordinal keeps the step curve contiguous (1..6) for the
    // drop-off analysis the marketing side relies on.
    funnelStep({ stepNumber: step + 1, variant });
    if (save.disposition === 'restricted') {
      setResult('restricted');
      return;
    }
    setStep(step + 1);
  }

  async function answer(o: Option) {
    const question = currentQuestion;
    const next = {
      ...answers,
      [question.id]: { q: question.q, a: o.value, label: o.label },
    };
    setAnswers(next);
    setError(null);

    funnelStep({ stepNumber: step + 1, variant });

    if (question.id !== 'state' && KNOCKOUT_IDS.includes(question.id) && o.value === 'No') {
      // A confirmed non-match stops the questioning here — no more questions.
      // What happens next is the person's choice on the result screen: leave
      // (nothing further stored) or opt into future-fit program updates. The
      // server records the disposition either way.
      void persistPartial(next);
      setResult('disqualified');
      setDisqOpt('none');
      return;
    }

    void persistPartial(next);

    // Ad and analytics platforms get the step ORDINAL only — never the answer,
    // and never the question's semantic id. Both halves matter: the answer is
    // health data, and a variable reading `question: "doctor"` on a disability
    // questionnaire is itself a contribution to the Business Tool Terms
    // classification that got this domain flagged. The ordinal gives the same
    // drop-off curve. Semantic ids stay in `app_events`, which is our database.
    setStep(step + 1);
  }

  function validateContact(): boolean {
    const errors: Record<string, string> = {};
    if (!contact.firstName.trim()) errors.firstName = 'Enter your first name.';
    if (!contact.lastName.trim()) errors.lastName = 'Enter your last name.';
    const digits = contact.phone.replace(/\D/g, '');
    const validPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
    if (!validPhone) errors.phone = 'Enter a valid 10-digit phone number, e.g. 555-010-0100.';
    if (contact.email.trim() && !EMAIL_RE.test(contact.email.trim()))
      errors.email = 'Enter a valid email address, e.g. name@example.com.';
    if (contact.zip.trim() && !/^\d{5}$/.test(contact.zip.trim()))
      errors.zip = 'Enter a 5-digit ZIP code, e.g. 78701.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const first = Object.keys(errors)[0];
      const el = mainRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.focus();
      return false;
    }
    return true;
  }

  /**
   * Announce the conversion, at most once per submission. Every caller goes
   * through here so the latch cannot be forgotten at a new call site.
   */
  function pushConversionOnce(args: { eventId: string; disposition: string }) {
    if (conversionPushedRef.current) return;
    conversionPushedRef.current = true;
    leadSubmitted({ eventId: args.eventId, variant, disposition: args.disposition });
  }

  function patch(next: Partial<Contact>, field?: string) {
    setContact((c) => ({ ...c, ...next }));
    if (field && fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: '' }));
  }

  async function submit() {
    if (submitInFlightRef.current) return;
    if (!validateContact()) return;
    submitInFlightRef.current = true;
    setStatus('submitting');
    setError(null);
    try {
      await saveQueueRef.current;
      const attr = refreshCookies(getAttribution());
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId: leadIdRef.current,
          submissionId,
          variant,
          status: 'complete',
          answers,
          contact: {
            firstName: contact.firstName.trim(),
            lastName: contact.lastName.trim(),
            email: contact.email.trim() || null,
            phone: contact.phone.trim(),
            zip: contact.zip.trim() || null,
          },
          consent: {
            version: CONSENT_VERSION,
            text: CONSENT_TEXT.standard,
            given: contact.consent,
            timestamp: new Date().toISOString(),
          },
          attribution: attr,
          externalId,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.leadId) {
        setStatus('error');
        setError(
          data.error === 'contact_required'
            ? 'Please enter your name and a phone number we can call you on.'
            : 'Something went wrong. Please check your details and try again.'
        );
        return;
      }

      leadIdRef.current = data.leadId;
      if (data.disposition) setDisposition(data.disposition);

      // The conversion. `event_id` is the id the server persisted and will send
      // to the Conversions API; the Meta Pixel tag in GTM maps it to Event ID
      // so the two collapse into one conversion. See docs/gtm-setup.md.
      pushConversionOnce({ eventId: data.eventId, disposition: data.disposition });

      setStatus('done');
      setStep(STEPS);
    } catch {
      setStatus('error');
      setError('Could not submit. Please check your connection and try again.');
    } finally {
      submitInFlightRef.current = false;
    }
  }

  /** Restricted leads complete with only their consent — no contact, no more questions. */
  async function submitRestricted() {
    if (submitInFlightRef.current) return;
    if (!contact.consent) {
      setError('Please confirm you understand that no one will contact you about this enquiry.');
      return;
    }
    submitInFlightRef.current = true;
    setStatus('submitting');
    setError(null);
    try {
      await saveQueueRef.current;
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId: leadIdRef.current,
          submissionId,
          variant,
          status: 'complete',
          answers,
          contact: undefined,
          consent: {
            version: CONSENT_VERSION,
            text: CONSENT_TEXT.restricted,
            given: true,
            timestamp: new Date().toISOString(),
          },
          attribution: getAttribution(),
          externalId,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.leadId) {
        setStatus('error');
        setError('Something went wrong. Please try again.');
        return;
      }
      leadIdRef.current = data.leadId;
      if (data.disposition) setDisposition(data.disposition);
      pushConversionOnce({ eventId: data.eventId, disposition: 'restricted' });
      setStatus('done');
      setStep(STEPS);
    } catch {
      setStatus('error');
      setError('Could not submit. Please check your connection and try again.');
    } finally {
      submitInFlightRef.current = false;
    }
  }

  // ---- Done screens ------------------------------------------------------

  if (status === 'done') {
    return (
      <div ref={mainRef} className="funnel done">
        <div className="funnel-card">
          <h1 data-focus tabIndex={-1}>
            Thank you
          </h1>
          <p>
            {restricted
              ? 'We have recorded your answers. No one will contact you about this enquiry.'
              : result === 'disqualified'
                ? nurtureOpted
                  ? `Thanks for checking your eligibility. We will only contact you if a potentially relevant program comes up — never about this one.`
                  : `Thanks for checking your eligibility. We have recorded your choice and will not contact you.`
                : 'We have received your request. A specialist will review your answers and may contact you.'}
          </p>
        </div>
      </div>
    );
  }

  // ---- Early exit: confirmed non-match -----------------------------------

  if (result === 'disqualified') {
    // `exit`, not just `done`: this screen must not wear the green
    // completion tick. A person who has been knocked out has not succeeded
    // at anything, and a celebratory mark over "may not be a match" reads
    // as either a bug or a taunt.

    if (disqOpt === 'nurture') {
      return (
        <div ref={mainRef} className="funnel">
          <FunnelHeader intro={false} variant={variant} />
          <ProgressLabel step={STEPS - 1} total={STEPS} />
          <div className="funnel-card">
            <h1 data-focus tabIndex={-1}>
              Keep me updated
            </h1>
            <p className="note">
              We occasionally work on services that may fit people whose earlier answers did
              not qualify them for this one. Leave a name and a way to reach you — we will
              only contact you about other potential opportunities.
            </p>
            <form
              data-clarity-mask="true"
              onSubmit={(e) => {
                e.preventDefault();
                onDisqNurtureSubmit();
              }}
            >
              <label htmlFor="nfirst">First name</label>
              <input
                id="nfirst"
                className="input"
                autoComplete="given-name"
                required
                data-field="firstName"
                aria-invalid={Boolean(fieldErrors.firstName)}
                aria-describedby={fieldErrors.firstName ? 'err-nfirst' : undefined}
                value={contact.firstName}
                onChange={(e) => patch({ firstName: e.target.value }, 'firstName')}
              />
              {fieldErrors.firstName && (
                <p className="error" id="err-nfirst">
                  {fieldErrors.firstName}
                </p>
              )}

              <label htmlFor="nphone">Phone</label>
              <input
                id="nphone"
                type="tel"
                className="input"
                autoComplete="tel"
                inputMode="tel"
                data-field="phone"
                aria-invalid={Boolean(fieldErrors.phone)}
                aria-describedby={fieldErrors.phone ? 'err-nphone' : undefined}
                value={contact.phone}
                onChange={(e) => patch({ phone: e.target.value }, 'phone')}
              />
              {fieldErrors.phone && (
                <p className="error" id="err-nphone">
                  {fieldErrors.phone}
                </p>
              )}

              <label htmlFor="nemail">Email</label>
              <input
                id="nemail"
                type="email"
                className="input"
                autoComplete="email"
                inputMode="email"
                data-field="email"
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? 'err-nemail' : undefined}
                value={contact.email}
                onChange={(e) => patch({ email: e.target.value }, 'email')}
              />
              {fieldErrors.email && (
                <p className="error" id="err-nemail">
                  {fieldErrors.email}
                </p>
              )}

              <div className="consent">
                <input
                  id="nconsent"
                  type="checkbox"
                  checked={contact.consent}
                  onChange={(e) => patch({ consent: e.target.checked })}
                />
                <label htmlFor="nconsent">{CONSENT_TEXT.nurture}</label>
              </div>

              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}

              <button className="btn" type="submit" disabled={status === 'submitting'}>
                {status === 'submitting' ? 'Submitting…' : 'Send'}
              </button>
            </form>

            <button
              className="link"
              type="button"
              disabled={status === 'submitting'}
              onClick={() => {
                setDisqOpt('none');
                setError(null);
              }}
            >
              No thanks, back
            </button>
          </div>
        </div>
      );
    }

    return (
      <div ref={mainRef} className="funnel done exit">
        <div className="funnel-card">
          <h1 data-focus tabIndex={-1}>
            This service may not be a match
          </h1>
          <p>
            Based on your answers, our disability support service may not be able to help you.
            You can leave here, or we can let you know if we later offer something that may fit.
          </p>
          <p>
            The Social Security Administration provides official information about disability
            benefits at{' '}
            <a className="link" href="https://www.ssa.gov/benefits/disability/" target="_blank" rel="noopener noreferrer">
              ssa.gov
            </a>
            .
          </p>
          <button
            className="btn"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => setDisqOpt('nurture')}
          >
            Keep me updated about programs that may fit
          </button>
          <button
            className="link"
            type="button"
            disabled={status === 'submitting'}
            onClick={onDisqNoThanks}
          >
            No thanks
          </button>
          <button
            className="link"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => setResult('none')}
          >
            Review my answers
          </button>
        </div>
      </div>
    );
  }

  // ---- Early exit: restricted-state outcome ------------------------------

  if (result === 'restricted') {
    return (
      <div ref={mainRef} className="funnel">
        <FunnelHeader intro={false} variant={variant} />
        <ProgressLabel step={STEPS - 1} total={STEPS} />
        <div className="funnel-card">
          <h1 data-focus tabIndex={-1}>
            Thank you for answering
          </h1>
          <p className="note">
            Based on the state you selected we are not able to pass your details to a benefits
            specialist. Your answers are still recorded.
          </p>
          <form
            data-clarity-mask="true"
            onSubmit={(e) => {
              e.preventDefault();
              void submitRestricted();
            }}
          >
            <div className="consent">
              <input
                id="consent"
                type="checkbox"
                checked={contact.consent}
                onChange={(e) => patch({ consent: e.target.checked })}
              />
              <label htmlFor="consent">{CONSENT_TEXT.restricted}</label>
            </div>

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <button className="btn" type="submit" disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Submitting…' : 'Continue'}
            </button>
          </form>

          <button
            className="link"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => {
              setResult('none');
              setStep(QUESTIONS.findIndex((q) => q.id === 'state'));
            }}
          >
            Change state
          </button>
        </div>
      </div>
    );
  }

  // ---- Contact step ------------------------------------------------------

  function renderContact() {
    return (
      <section>
        <h1 data-focus tabIndex={-1}>
          A few details to finish
        </h1>

        <p className="note">
          A specialist may call you to review your answers. We use your details only to reach you
          about this enquiry — this is not an application for benefits.
        </p>

        {/*
          Everything the person types is masked out of Clarity recordings.
          Clarity masks input values by default, but "by default" is not a
          control — this is a name, phone number and TCPA consent record, and
          the mask should be explicit in the markup where it survives a
          dashboard setting being changed by someone who doesn't know that.
        */}
        <form
          data-clarity-mask="true"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="first">First name</label>
          <input
            id="first"
            className="input"
            autoComplete="given-name"
            required
            data-field="firstName"
            aria-invalid={Boolean(fieldErrors.firstName)}
            aria-describedby={fieldErrors.firstName ? 'err-first' : undefined}
            value={contact.firstName}
            onChange={(e) => patch({ firstName: e.target.value }, 'firstName')}
          />
          {fieldErrors.firstName && (
            <p className="error" id="err-first">
              {fieldErrors.firstName}
            </p>
          )}

          <label htmlFor="last">Last name</label>
          <input
            id="last"
            className="input"
            autoComplete="family-name"
            required
            data-field="lastName"
            aria-invalid={Boolean(fieldErrors.lastName)}
            aria-describedby={fieldErrors.lastName ? 'err-last' : undefined}
            value={contact.lastName}
            onChange={(e) => patch({ lastName: e.target.value }, 'lastName')}
          />
          {fieldErrors.lastName && (
            <p className="error" id="err-last">
              {fieldErrors.lastName}
            </p>
          )}

          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            type="tel"
            className="input"
            autoComplete="tel"
            inputMode="tel"
            required
            data-field="phone"
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={fieldErrors.phone ? 'err-phone' : undefined}
            value={contact.phone}
            onChange={(e) => patch({ phone: e.target.value }, 'phone')}
          />
          {fieldErrors.phone && (
            <p className="error" id="err-phone">
              {fieldErrors.phone}
            </p>
          )}

          {/* Email is useful for follow-up where a call is not answered, but a
              callback service must not require it. Optional. */}
          <label htmlFor="email">Email (optional)</label>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="email"
            inputMode="email"
            data-field="email"
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? 'err-email' : undefined}
            value={contact.email}
            onChange={(e) => patch({ email: e.target.value }, 'email')}
          />
          {fieldErrors.email && (
            <p className="error" id="err-email">
              {fieldErrors.email}
            </p>
          )}

          {/* ZIP improves partner routing and Meta matching when present, and
              costs one field — but it is not required to make a callback. */}
          <label htmlFor="zip">ZIP code (optional)</label>
          <input
            id="zip"
            className="input"
            autoComplete="postal-code"
            inputMode="numeric"
            pattern="[0-9]{5}"
            maxLength={5}
            data-field="zip"
            aria-invalid={Boolean(fieldErrors.zip)}
            aria-describedby={fieldErrors.zip ? 'err-zip' : undefined}
            value={contact.zip}
            onChange={(e) => patch({ zip: e.target.value.replace(/\D/g, '') }, 'zip')}
          />
          {fieldErrors.zip && (
            <p className="error" id="err-zip">
              {fieldErrors.zip}
            </p>
          )}

          <div className="consent">
            <input
              id="consent"
              type="checkbox"
              required
              checked={contact.consent}
              onChange={(e) => patch({ consent: e.target.checked })}
            />
            <label htmlFor="consent">{CONSENT_TEXT.standard}</label>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="btn" type="submit" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Submitting…' : 'Request a callback'}
          </button>
        </form>

        <button
          className="link"
          type="button"
          disabled={status === 'submitting'}
          onClick={() => setStep(QUESTIONS.length - 1)}
        >
          <ChevronLeftIcon />
          Back
        </button>
      </section>
    );
  }

  if (step >= QUESTIONS.length) {
    return (
      <div ref={mainRef} className="funnel">
        {/* The header stays on the contact step on purpose: this is the screen
            where a person hands over a phone number, so it is the worst
            possible moment for the brand and the privacy link to disappear. */}
        <FunnelHeader intro={false} variant={variant} />
        <ProgressLabel step={step} total={STEPS} />
        <div className="funnel-card">{renderContact()}</div>
      </div>
    );
  }

  // ---- Question screen ---------------------------------------------------

  const isState = currentQuestion.picker;
  // Two answers get the icon-card treatment, side by side; anything longer
  // stays a stacked list, because a grid of eight cards is a wall.
  const isBinary = !isState && currentQuestion.o.length <= 2;
  const isKnockoutNo = !isState && KNOCKOUT_IDS.includes(currentQuestion.id);
  const isSelected = { value: currentQuestion.id === 'state' ? stateValue : undefined };

  const answerState = (code: string) => {
    const next = {
      ...answers,
      state: { q: currentQuestion.q, a: code, label: STATES.find((s) => s.value === code)?.label ?? code },
    };
    setAnswers(next);
  };

  return (
    <div ref={mainRef} className="funnel">
      <FunnelHeader intro={step === 0} variant={variant} />
      <ProgressLabel step={step} total={STEPS} />
      <section className="funnel-card">
        <h1 data-focus tabIndex={-1}>
          {currentQuestion.q}
        </h1>

        {isState ? (
          <fieldset>
            <legend className="sr-only">{currentQuestion.q}</legend>
            <label htmlFor="state-picker">Select your state</label>
            <select
              id="state-picker"
              className="input"
              value={stateValue}
              disabled={checkingState}
              onChange={(e) => answerState(e.target.value)}
            >
              <option value="">Choose a state…</option>
              {STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            {stateError && (
              <p className="error" role="alert">
                {stateError}
              </p>
            )}

            <button
              className="btn"
              type="button"
              disabled={checkingState || !stateValue}
              onClick={() => void confirmState()}
            >
              {checkingState ? 'Checking availability…' : 'Check availability'}
            </button>
          </fieldset>
        ) : (
          <fieldset>
            <legend className="sr-only">{currentQuestion.q}</legend>
            <div
              className={`options${isBinary ? ' options-binary' : ' options-list'}`}
              role="group"
            >
              {currentQuestion.o.map((o) => {
                const chosen = answers[currentQuestion.id]?.a === o.value;
                const affirmative = o.value === 'Yes';
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`option${isBinary ? ' option-card' : ''}${
                      chosen ? ' selected' : ''
                    }`}
                    aria-pressed={chosen}
                    disabled={checkingState}
                    onClick={() => void answer(o)}
                  >
                    {/*
                      The icon is aria-hidden and carries no title, so the
                      accessible name of this button stays exactly "Yes" or
                      "No". Decoration on the outside, meaning in the label.
                    */}
                    {isBinary && (
                      <span className={`option-icon option-icon--${affirmative ? 'go' : 'stop'}`}>
                        {affirmative ? <CheckIcon /> : <CrossIcon />}
                      </span>
                    )}
                    {o.label}
                    {!isBinary && <ChevronRightIcon className="option-arrow" />}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {step > 0 && (
          <button
            className="link"
            type="button"
            disabled={status === 'submitting'}
            onClick={() => setStep(step - 1)}
          >
            <ChevronLeftIcon />
            Back
          </button>
        )}
      </section>
    </div>
  );
}

function FunnelHeader({ intro, variant }: { intro: boolean; variant: string }) {
  return (
    <header className="brand">
      <span className="brand-name">LexHive</span>
      <span className="brand-tag">
        Find out whether our disability support service may be a match.
      </span>
      {intro && (
        <span className="brand-intro">
          Answer a few short questions. This is not an application for benefits.
        </span>
      )}
      <a className="brand-privacy" href="/privacy">
        Privacy notice
      </a>
    </header>
  );
}

/**
 * Worded progress, not a fabricated percentage. "Question 2 of 6" is honest
 * and branch-aware; a percentage implies a measured completion time nobody has
 * observed. W3C recommends communicating step count in multi-page forms.
 */
function ProgressLabel({ step, total }: { step: number; total: number }) {
  const atContact = step >= total - 1 && total > 1;
  const label = atContact ? 'Final step: contact details' : `Question ${step + 1} of ${total - 1}`;
  const pct = Math.min(100, Math.max(0, Math.round((step / total) * 100)));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={label}
    >
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">{label}</span>
    </div>
  );
}