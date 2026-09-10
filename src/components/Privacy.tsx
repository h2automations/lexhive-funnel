/**
 * Plain-English privacy notice for the qualification site. Kept deliberately
 * light ("deliberately light so it is not mistaken for a government site":
 * README Design). Matches what the code actually does — nothing here overclaims
 * what this demo funnel stores or sends.
 */
export default function Privacy({ variant }: { variant: string }) {
  return (
    <div className="funnel">
      <header className="brand">
        <span className="brand-name">LexHive</span>
        <span className="brand-tag">Privacy notice</span>
      </header>

      <div className="privacy-card">
        <h1>Privacy notice</h1>
        <p className="lead">
          This page explains what the questions on this site collect, why, and who
          it is shared with. It is written for the way the site is actually built
          — the information below matches the code, not a boilerplate policy.
        </p>

        <section>
          <h2>What this site is for</h2>
          <p>
            Answering the questions is not an application for social security
            benefits. It is a screen to find out whether our disability support
            service may be a match for you. If it is, a service partner may call
            you about it. There is no charge and no obligation.
          </p>
        </section>

        <section>
          <h2>What we collect</h2>
          <ul>
            <li>
              <strong>Your answers</strong> to the screening questions (age range,
              state, whether you are unable to work, how long the condition has
              lasted or is expected to last, work history, whether you see a
              doctor). These are screening answers only.
            </li>
            <li>
              <strong>Your contact details</strong> if you choose to provide them:
              first name, last name, and phone number are required; email and ZIP
              code are optional. A restricted state never reaches the contact
              form at all.
            </li>
            <li>
              <strong>Technical details</strong> such as your IP address, browser
              and device type, the page you came from, and advertising
              identifiers ({" "}
              <code>fbclid</code>, <code>fbp</code>, <code>fbc</code>) so we can
              measure how well the site works.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> collect your Social Security number, bank
            details, medical records, or any document from a doctor or hospital.
            The questions you answer are not sent to advertising or analytics
            tags — the site shares only screen numbers with them, never your
            answers.
          </p>
        </section>

        <section>
          <h2>Who it is shared with</h2>
          <ul>
            <li>
              <strong>Our service partner</strong>, who receives the contact
              details and answers of matched enquirers so they can call about the
              service. This is the point of the site.
            </li>
            <li>
              <strong>Meta (Facebook) platforms</strong>, to report conversions
              and improve how our advertisements are shown. Personal identifiers
              are hashed before they are sent, and data processing is set to a
              restricted mode.
            </li>
            <li>
              <strong>Airtable and n8n</strong>, which carry the lead to the
              service partner, and <strong>Google</strong>, which measures how the
              funnel performs. Airtable and n8n host the data the service partner
              sees; Google receives aggregate behaviour, not your answers.
            </li>
          </ul>
        </section>

        <section>
          <h2>Consent and restricted states</h2>
          <p>
            No contact details are collected from residents of states where the
            service does not operate. If you are in one of those states you will
            be told and asked to leave before any question about you is kept.
            Where contact details are collected, they are only used about this
            enquiry, and you confirm that before they are submitted.
          </p>
        </section>

        <section>
          <h2>Your choices and rights</h2>
          <ul>
            <li>You are never required to provide email or ZIP code.</li>
            <li>
              Advertising personalisation is something you can limit in your Meta
              account settings; this site respects those settings.
            </li>
            <li>
              To access a copy of what this site holds about you, or to ask for it
              to be deleted, email{" "}
              <a className="link" href="mailto:privacy@lexhive.app">
                privacy@lexhive.app
              </a>
              .
            </li>
          </ul>
        </section>

        <p className="effective">Last updated: September 2026.</p>

        <a className="link back-link" href={`/${variant}`}>
          ← Back to the questions
        </a>
      </div>
    </div>
  );
}