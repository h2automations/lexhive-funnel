import { useEffect, useMemo, useRef, useState } from 'react';
import { getExternalId, getAttribution, refreshCookies } from '../lib/tracking';
import { STATES, type Option } from '../lib/states';
import { funnelReady, funnelStep, leadSubmitted } from '../lib/datalayer';

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

const YES_NO: Option[] = [
  { label: 'Yes', value: 'Yes' },
  { label: 'No', value: 'No' },
];

const QUESTIONS: { id: string; q: string; o: Option[] }[] = [
  { id: 'age', q: 'Are you between 18 and 64 years old?', o: YES_NO },
  // Gender is a Meta advanced-matching key (`ge`), and one tap. "Prefer not to
  // say" maps to a value the CAPI client drops rather than hashes, so opting
  // out costs the person nothing and sends Meta nothing.
  {
    id: 'gender',
    q: 'What is your gender?',
    o: [
      { label: 'Male', value: 'm' },
      { label: 'Female', value: 'f' },
      { label: 'Prefer not to say', value: 'undisclosed' },
    ],
  },
  { id: 'state', q: 'Which state do you live in?', o: STATES },
  { id: 'work', q: 'Are you unable to work because of a medical condition?', o: YES_NO },
  {
    id: 'duration',
    q: 'Has this condition lasted, or is it expected to last, 12 months or longer?',
    o: YES_NO,
  },
  { id: 'doctor', q: 'Are you currently under a doctor’s care for this condition?', o: YES_NO },
  {
    id: 'months',
    q: 'Have you worked 20+ years (roughly 40 quarters) in your working life?',
    o: YES_NO,
  },
];

const STEPS = QUESTIONS.length + 1; // +1 for the contact step

/**
 * The consent artifact. In legal lead gen the record of what the person
 * actually agreed to is the product, so the exact text is versioned and stored
 * alongside the timestamp, IP and user agent — not just a version number that
 * nobody can resolve back to wording six months later.
 */
const CONSENT_VERSION = 'v1.1';
const CONSENT_TEXT = {
  standard:
    'I consent to be contacted by phone, text message, or email about Social Security disability benefits, including by automated dialing technology. Consent is not a condition of any purchase.',
  restricted:
    'I understand this is not an application for benefits and that no one will contact me about this enquiry.',
} as const;

const EMPTY_CONTACT: Contact = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  zip: '',
  consent: false,
};

export default function Funnel({ variant }: { variant: string }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);
  const [disposition, setDisposition] = useState<string>('qualified');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Held in a ref as well as state: `answer()` fires the next partial save
  // before React has re-rendered, and the save must carry the id it was
  // given last time or the server has no row to update.
  const leadIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const externalId = useMemo(() => getExternalId(), []);
  const restricted = disposition === 'restricted';

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
  }, [step, status]);

  const currentQuestion = QUESTIONS[step];

  /**
   * Save progress. Returns the server's disposition so the contact step knows
   * whether it is allowed to ask for contact details at all.
   */
  async function persistPartial(nextAnswers: Record<string, Answer>): Promise<void> {
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId: leadIdRef.current,
          variant,
          status: 'partial',
          answers: nextAnswers,
          attribution: getAttribution(),
          externalId,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.leadId) leadIdRef.current = data.leadId;
      if (data.disposition) setDisposition(data.disposition);
    } catch {
      // A partial save must never block the funnel.
    }
  }

  function answer(o: Option) {
    const question = currentQuestion;
    const next = {
      ...answers,
      [question.id]: { q: question.q, a: o.value, label: o.label },
    };
    setAnswers(next);
    setError(null);

    // Every step is saved, including the last one — that is what gives a
    // truthful drop-off number for the final question.
    void persistPartial(next);

    // Ad and analytics platforms get the step ORDINAL only — never the answer,
    // and never the question's semantic id. Both halves matter: the answer is
    // health data, and a variable reading `question: "doctor"` on a disability
    // questionnaire is itself a contribution to the Business Tool Terms
    // classification that got this domain flagged. The ordinal gives the same
    // drop-off curve. Semantic ids stay in `app_events`, which is our database.
    funnelStep({ stepNumber: step + 1, variant });

    setStep(step + 1);
  }

  async function submit() {
    setStatus('submitting');
    setError(null);
    try {
      const attr = refreshCookies(getAttribution());
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId: leadIdRef.current,
          variant,
          status: 'complete',
          answers,
          // Restricted leads never send contact details in the first place.
          contact: restricted
            ? undefined
            : {
                firstName: contact.firstName.trim(),
                lastName: contact.lastName.trim(),
                email: contact.email.trim(),
                phone: contact.phone.trim(),
                zip: contact.zip.trim(),
              },
          consent: {
            version: CONSENT_VERSION,
            text: restricted ? CONSENT_TEXT.restricted : CONSENT_TEXT.standard,
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
            ? 'Please enter an email address or phone number.'
            : 'Something went wrong. Please try again.'
        );
        return;
      }

      leadIdRef.current = data.leadId;
      if (data.disposition) setDisposition(data.disposition);

      // The conversion. `event_id` is the id the server minted and will send
      // to the Conversions API; the Meta Pixel tag in GTM maps it to Event ID
      // so the two collapse into one conversion. See docs/gtm-setup.md.
      leadSubmitted({
        eventId: data.eventId,
        variant,
        disposition: data.disposition,
      });

      setStatus('done');
      setStep(STEPS);
    } catch {
      setStatus('error');
      setError('Could not submit. Please check your connection and try again.');
    }
  }

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
              : 'We have received your answers. A benefits specialist may contact you.'}
          </p>
        </div>
      </div>
    );
  }

  function patch(next: Partial<Contact>) {
    setContact((c) => ({ ...c, ...next }));
  }

  function renderContact() {
    return (
      <section>
        <h1 data-focus tabIndex={-1}>
          {restricted ? 'Thank you for answering' : 'A few details to finish'}
        </h1>

        {restricted && (
          <p className="note">
            Based on the state you selected we are not able to pass your details to a
            benefits specialist. Your answers are still recorded.
          </p>
        )}

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
          {!restricted && (
            <>
              <label htmlFor="first">First name</label>
              <input
                id="first"
                className="input"
                autoComplete="given-name"
                required
                value={contact.firstName}
                onChange={(e) => patch({ firstName: e.target.value })}
              />

              <label htmlFor="last">Last name</label>
              <input
                id="last"
                className="input"
                autoComplete="family-name"
                required
                value={contact.lastName}
                onChange={(e) => patch({ lastName: e.target.value })}
              />

              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="email"
                inputMode="email"
                required
                value={contact.email}
                onChange={(e) => patch({ email: e.target.value })}
              />

              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                type="tel"
                className="input"
                autoComplete="tel"
                inputMode="tel"
                required
                value={contact.phone}
                onChange={(e) => patch({ phone: e.target.value })}
              />

              {/* ZIP is asked because it is one of Meta's match keys and the
                  cheapest one to collect — one field, already expected on a
                  benefits form. */}
              <label htmlFor="zip">ZIP code</label>
              <input
                id="zip"
                className="input"
                autoComplete="postal-code"
                inputMode="numeric"
                pattern="[0-9]{5}"
                maxLength={5}
                required
                value={contact.zip}
                onChange={(e) => patch({ zip: e.target.value.replace(/\D/g, '') })}
              />
            </>
          )}

          <div className="consent">
            <input
              id="consent"
              type="checkbox"
              required
              checked={contact.consent}
              onChange={(e) => patch({ consent: e.target.checked })}
            />
            <label htmlFor="consent">
              {restricted ? CONSENT_TEXT.restricted : CONSENT_TEXT.standard}
            </label>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="btn" type="submit" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Submitting…' : 'Submit'}
          </button>
        </form>

        <button className="link" type="button" onClick={() => setStep(QUESTIONS.length - 1)}>
          Back
        </button>
      </section>
    );
  }

  if (step >= QUESTIONS.length) {
    return (
      <div ref={mainRef} className="funnel">
        <ProgressBar step={step} total={STEPS} />
        <div className="funnel-card">{renderContact()}</div>
      </div>
    );
  }

  return (
    <div ref={mainRef} className="funnel">
      <ProgressBar step={step} total={STEPS} />
      <section className="funnel-card">
        <h1 data-focus tabIndex={-1}>
          {currentQuestion.q}
        </h1>
        <fieldset>
          <legend className="sr-only">{currentQuestion.q}</legend>
          <div className={`options${currentQuestion.o.length > 2 ? ' options-list' : ''}`} role="group">
            {currentQuestion.o.map((o) => (
              <button key={o.value} type="button" className="option" onClick={() => answer(o)}>
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>
        {step > 0 && (
          <button className="link" type="button" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
      </section>
    </div>
  );
}

function ProgressBar({ step, total }: { step: number; total: number }) {
  const pct = Math.round((step / total) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label="Progress through the questions"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
