import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * End-to-end tests for the deployed LexHive funnel.
 *
 * Runs against BASE_URL (default https://lexhive.vercel.app) on the real
 * production site and its real Postgres. Submissions therefore write real rows;
 * that is the point — this is the funnel behaving exactly as a visitor drives
 * it. Each test uses its own browser context and generated identifiers.
 *
 * Privacy rules baked into this file:
 *   - No credential, OPS_KEY, Meta token, Airtable token, or webhook secret is
 *     ever written here. OPS_KEY is read from the environment and is NEVER
 *     echoed into an assertion message.
 *   - Assertion failure messages never print contact details or answer text.
 *     The dataLayer PII check compares against forbidden substrings and only
 *     prints a label like "the test email".
 *   - /api/* request bodies are never included in captured, array-diffed
 *     state; the final restricted-lead body is inspected through a hand-held
 *     promise so it is never serialized into a failure diff.
 *
 * Network policy (see attachObserver / assertObserversClean):
 *   - Uncaught page errors and console errors originating from the application
 *     origin FAIL the test.
 *   - Everything originating from a third-party origin (GTM, Meta Pixel,
 *     Clarity, browser extensions) is documented, expected noise and ignored.
 *     The task rules are explicit that ad-block / third-party outage must not
 *     be the reason a test fails.
 *   - A failing or non-2xx application /api/lead request FAILS the test, even
 *     when the funnel degrades silently around it.
 */

const APP_BASE = (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, '');
const APP_HOST = new URL(APP_BASE).host;
const RUN_TAG = String(Date.now());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Q = {
  age: 'Are you between 18 and 64 years old?',
  gender: 'What is your gender?',
  state: 'Which state do you live in?',
  work: 'Are you unable to work because of a medical condition?',
  duration: 'Has this condition lasted, or is it expected to last, 12 months or longer?',
  doctor: 'Are you currently under a doctor’s care for this condition?',
  months: 'Have you worked 20+ years (roughly 40 quarters) in your working life?',
} as const;

/** The seven question screens in funnel order. */
const QUESTION_SCREENS: { heading: string }[] = [
  { heading: Q.age },
  { heading: Q.gender },
  { heading: Q.state },
  { heading: Q.work },
  { heading: Q.duration },
  { heading: Q.doctor },
  { heading: Q.months },
];

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface Contact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  zip: string;
}

/**
 * Email is generated per run unless E2E_EMAIL is set; phone is a fictional US
 * number from the reserved 555-01xx exchange ("clearly fictional" per the
 * task) unless E2E_PHONE is set.
 */
function makeContact(tag: string): Contact {
  return {
    firstName: process.env.E2E_FIRST_NAME || 'Playwright',
    lastName: process.env.E2E_LAST_NAME || 'Test',
    email: process.env.E2E_EMAIL || `playwright+${RUN_TAG}-${tag}@example.com`,
    phone: process.env.E2E_PHONE || '5550100100',
    zip: process.env.E2E_ZIP || '78701',
  };
}

// ---------------------------------------------------------------------------
// dataLayer helpers
// ---------------------------------------------------------------------------

async function waitForFunnelReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
    return dl.some((e) => e && (e as { event?: string }).event === 'funnel_ready');
  });
}

async function readDataLayer(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []);
}

function eventsNamed(dl: unknown[], event: string): Array<{ [k: string]: unknown }> {
  return dl.filter((e) => e && (e as { event?: string }).event === event) as Array<{
    [k: string]: unknown;
  }>;
}

function assertExactlyOne(events: Array<{ [k: string]: unknown }>, name: string): { [k: string]: unknown } {
  expect(events, `expected exactly one ${name} event in dataLayer`).toHaveLength(1);
  return events[0]!;
}

/**
 * The dataLayer must never contain contact fields, answer text, question ids,
 * or medical-keyword material. It is shared with every tag in the container,
 * which is why it is treated as published to all vendors at once.
 *
 * Only a safe label is printed on failure, never the offending value.
 */
function assertDataLayerClean(dl: unknown[], contact: Contact): void {
  const text = JSON.stringify(dl);
  const forbidden: Array<[string | null, string]> = [
    [contact.email, 'the test email'],
    [contact.phone, 'the test phone'],
    [contact.zip, 'the test ZIP'],
    [contact.firstName, 'the test first name'],
    [contact.lastName, 'the test last name'],
    ['between 18 and 64', 'the age question text'],
    ['medical condition', 'medical-condition wording'],
    ['doctor’s care', 'doctor-care wording'],
    ['12 months', 'duration wording'],
    ['40 quarters', 'work-history wording'],
    ['age', 'the age question id'],
    ['gender', 'the gender question id'],
    ['state', 'the state question id'],
    ['work', 'the work question id'],
    ['duration', 'the duration question id'],
    ['doctor', 'the doctor question id'],
    ['months', 'the months question id'],
    ['Prefer not to say', 'a consent-declining answer'],
    ['Male', 'a gender answer'],
    ['Female', 'a gender answer'],
    ['Yes', 'a binary answer'],
    ['No', 'a binary answer'],
    ['Texas', 'the state Texas'],
    ['New York', 'the state New York'],
    ['Alabama', 'the state Alabama'],
  ];
  for (const [value, label] of forbidden) {
    if (!value) continue;
    expect(text.includes(value), `dataLayer leaked ${label}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Application-origin error classification (the noise policy)
// ---------------------------------------------------------------------------

function isAppConsoleError(msg: ConsoleMessage): boolean {
  const text = msg.text();
  const locationUrl = msg.location()?.url ?? '';
  let host = '';
  try {
    host = new URL(locationUrl).host;
  } catch {
    host = '';
  }
  if (!host) return /\/api\//.test(text) || text.includes(APP_HOST);
  return host === APP_HOST;
}

function isAppError(error: Error): boolean {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (stack.includes(APP_HOST) || message.includes(APP_HOST)) return true;
  // A stack that names no app script is a third-party throw (GTM/Meta/Clarity/
  // extension) or a cross-origin "Script error." with no presence here.
  if (stack) return false;
  return /\/api\//.test(message);
}

interface Observer {
  pageErrors: Error[];
  consoleErrors: ConsoleMessage[];
  leadResponses: { status: number | null; url: string }[];
  leadFailures: { url: string; errorText: string }[];
}

function isLeadRequest(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/api/lead');
}

/** Observe the app's network without modifying a single request or response. */
function attachObserver(page: Page): Observer {
  const obs: Observer = { pageErrors: [], consoleErrors: [], leadResponses: [], leadFailures: [] };
  page.on('pageerror', (e) => obs.pageErrors.push(e));
  page.on('console', (m) => {
    if (m.type() === 'error') obs.consoleErrors.push(m);
  });
  page.on('requestfailed', (req) => {
    if (isLeadRequest(req.url(), req.method())) {
      obs.leadFailures.push({ url: req.url(), errorText: req.failure()?.errorText ?? 'unknown' });
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.request().method() === 'POST' && url.includes('/api/lead')) {
      // Store a status summary only — never the request body (it holds contact
      // details) and never header contents.
      obs.leadResponses.push({ status: res.status(), url });
    }
  });
  return obs;
}

/** Fail if the application itself errored, or an application request failed. */
function assertObserversClean(obs: Observer): void {
  const consoleBreaches = obs.consoleErrors.filter(isAppConsoleError).map((m) => m.text());
  expect(consoleBreaches, 'unexpected <console.error> from the application origin').toEqual([]);

  const pageBreaches = obs.pageErrors.filter(isAppError).map((e) => e.message);
  expect(pageBreaches, 'uncaught application errors').toEqual([]);

  const networkFailures = obs.leadFailures.map((f) => f.errorText);
  expect(networkFailures, 'failed application /api/lead requests').toEqual([]);

  const badStatuses = obs.leadResponses.map((r) => r.status).filter((s) => s === null || s < 200 || s >= 300);
  expect(badStatuses, 'non-2xx application /api/lead responses').toEqual([]);
}

// ---------------------------------------------------------------------------
// Funnel-driving helpers
// ---------------------------------------------------------------------------

async function answerQuestion(page: Page, option: string, nextHeading: string): Promise<void> {
  await page.getByRole('button', { name: option, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(nextHeading);
}

function isComplete(res: { request(): { method(): string; postDataJSON(): { status?: string } | null } }) {
  return res.request().method() === 'POST' && res.request().postDataJSON()?.status === 'complete';
}

/** The completion response: the one POST /api/lead with status 'complete'. */
function waitForCompleteResponse(page: Page) {
  return page.waitForResponse(async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/api/lead')) return false;
    try {
      return isComplete(res);
    } catch {
      return false;
    }
  });
}

/** The completion request itself, so its body can be shape-checked. */
function waitForCompleteRequest(page: Page) {
  return page.waitForRequest(async (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/lead')) return false;
    try {
      const body = req.postDataJSON() as { status?: string };
      return body?.status === 'complete';
    } catch {
      return false;
    }
  });
}

/**
 * The partial save triggered by answering the state question. It is matched by
 * the answer set being exactly {age, gender, state}: later partial saves carry
 * the accumulated state answer but additional keys, so they cannot collide.
 */
function waitForStatePartial(page: Page, stateValue: string) {
  return page.waitForResponse(async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/api/lead')) return false;
    try {
      const body = res.request().postDataJSON() as {
        status?: string;
        answers?: { state?: { a?: string } };
      };
      const answers = body?.answers ?? {};
      return body?.status === 'partial' && answers?.state?.a === stateValue && Object.keys(answers).length === 3;
    } catch {
      return false;
    }
  });
}

async function fillContact(page: Page, contact: Contact): Promise<void> {
  // exact: the consent checkbox's label contains "email" and "phone", so a
  // substring match would resolve to two elements.
  await page.getByLabel('First name', { exact: true }).fill(contact.firstName);
  await page.getByLabel('Last name', { exact: true }).fill(contact.lastName);
  await page.getByLabel('Email', { exact: true }).fill(contact.email);
  await page.getByLabel('Phone', { exact: true }).fill(contact.phone);
  await page.getByLabel('ZIP code', { exact: true }).fill(contact.zip);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1 — qualification funnel loads without leaking to the dataLayer', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('t1');

  await page.goto('/qualification-v1');
  await waitForFunnelReady(page);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.age);
  await expect(page.getByRole('progressbar')).toBeVisible();

  const dl = await readDataLayer(page);
  const ready = assertExactlyOne(eventsNamed(dl, 'funnel_ready'), 'funnel_ready');
  expect(ready.variant).toBe('qualification-v1');
  expect(typeof ready.external_id).toBe('string');
  expect(ready.external_id).toBeTruthy();
  assertDataLayerClean(dl, contact);

  assertObserversClean(obs);
});

test('2 — qualified Texas submission', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('tx');

  await page.goto('/qualification-v1');
  await waitForFunnelReady(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.age);

  // age / gender / state / work / duration / doctor / months — all qualifying.
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'Texas', Q.work);
  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', 'A few details to finish');

  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  // Observe the completion request/response without touching it.
  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;

  expect(res.status()).toBe(200);
  const result = await res.json();
  expect(result.leadId).toMatch(UUID_RE);
  expect(result.eventId).toMatch(UUID_RE);
  expect(result.leadId === result.eventId || result.leadId !== result.eventId).toBe(true);
  expect(result.disposition).toBe('qualified');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you');
  await expect(page.getByText(/A benefits specialist may contact you/i)).toBeVisible();

  // All seven ordinals, exactly once each, fired as the funnel was answered.
  const dl = await readDataLayer(page);
  const steps = eventsNamed(dl, 'funnel_step');
  expect(steps).toHaveLength(7);
  expect(steps.map((s) => s.step_number).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(steps.every((s) => s.variant === 'qualification-v1')).toBe(true);

  const submitted = assertExactlyOne(eventsNamed(dl, 'application_submitted'), 'application_submitted');
  expect(submitted.event_id).toBe(result.eventId);
  const qualified = assertExactlyOne(eventsNamed(dl, 'qualified_lead'), 'qualified_lead');
  expect(qualified.event_id).toBe(result.eventId);

  assertDataLayerClean(dl, contact);
  assertObserversClean(obs);
});

test('3 — disqualified submission fires no optimization event', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('dq');

  await page.goto('/qualification-v1');
  await waitForFunnelReady(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.age);

  // One knockout answer ("No" on work); everything else qualifying.
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'Texas', Q.work);
  await answerQuestion(page, 'No', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', 'A few details to finish');

  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;

  expect(res.status()).toBe(200);
  const result = await res.json();
  expect(result.leadId).toMatch(UUID_RE);
  expect(result.eventId).toMatch(UUID_RE);
  expect(result.disposition).toBe('disqualified');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you');

  const dl = await readDataLayer(page);
  assertExactlyOne(eventsNamed(dl, 'application_submitted'), 'application_submitted');
  // No Meta-Lead-optimization browser event: qualified_lead is gated to
  // qualifying leads only, so a disqualified lead must never see it.
  expect(eventsNamed(dl, 'qualified_lead'), 'disqualified leads must not fire qualified_lead').toHaveLength(0);

  assertDataLayerClean(dl, contact);
  assertObserversClean(obs);
});

test('4 — restricted New York flow collects no contact details', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('ny');

  await page.goto('/qualification-v1');
  await waitForFunnelReady(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.age);

  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);

  // The server decides restriction; the client only renders the verdict.
  const statePartial = waitForStatePartial(page, 'NY');
  await page.getByRole('button', { name: 'New York', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.work);

  const stateRes = await statePartial;
  expect(stateRes.status()).toBe(200);
  expect((await stateRes.json()).disposition).toBe('restricted');

  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', 'Thank you for answering');

  // Restricted completion path: no contact inputs at all.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you for answering');
  await expect(page.getByText(/not able to pass your details/i)).toBeVisible();
  for (const label of ['First name', 'Last name', 'Email', 'Phone', 'ZIP code']) {
    await expect(
      page.getByLabel(label, { exact: true }),
      `restricted flow must not show ${label}`
    ).toHaveCount(0);
  }

  await page.getByRole('checkbox').check();

  const completeRequest = waitForCompleteRequest(page);
  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  // The final request must not carry a single contact field.
  const finalBody = (await completeRequest).postDataJSON() as { contact?: unknown; consent?: { given?: boolean } };
  expect(finalBody.contact).toBeUndefined();
  expect(finalBody.consent?.given).toBe(true);

  const res = await completeResponse;
  expect(res.status()).toBe(200);
  const result = await res.json();
  expect(result.disposition).toBe('restricted');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you');
  await expect(page.getByText(/No one will contact you/i)).toBeVisible();

  const dl = await readDataLayer(page);
  assertExactlyOne(eventsNamed(dl, 'application_submitted'), 'application_submitted');
  expect(eventsNamed(dl, 'qualified_lead'), 'restricted leads must not fire qualified_lead').toHaveLength(0);

  assertDataLayerClean(dl, contact);
  assertObserversClean(obs);
});

test('5 — ops view excludes PII and gates on the ops key', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('ops');

  await page.goto('/ops');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delivery operations');

  // Nothing about the delivery surface is visible before authentication.
  await expect(page.getByLabel('Ops key')).toBeVisible();
  await expect(page.getByText('Completed leads', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toHaveCount(0);

  // No funnel/tracking events leak onto a page that is not the funnel.
  const dl = await readDataLayer(page);
  for (const name of ['funnel_ready', 'funnel_step', 'application_submitted', 'qualified_lead']) {
    expect(eventsNamed(dl, name), `/ops must not fire ${name}`).toHaveLength(0);
  }
  // The Meta PageView base tag is configured to trigger on funnel_ready, and
  // funnel_ready never fires here — so nothing should reach Meta from /ops.
  expect(JSON.stringify(dl).includes('funnel_ready')).toBe(false);

  assertObserversClean(obs);

  const opsKey = process.env.OPS_KEY;
  test.skip(!opsKey, 'OPS_KEY is not set; skipping authenticated /ops assertions (see .env.e2e.example).');

  // Authenticate exactly the way the UI does: key in the header, never a query
  // parameter. Never click Replay — it mutates delivery state.
  await page.getByLabel('Ops key').fill(opsKey!);
  const opsResponse = page.waitForResponse(async (res) => {
    return res.url().includes('/api/ops') && res.status() === 200;
  });
  await page.getByRole('button', { name: 'View', exact: true }).click();
  const res = await opsResponse;

  const payload = await res.json();
  expect(Array.isArray(payload.health)).toBe(true);
  expect(payload.funnel).toBeTruthy();
  expect(typeof payload.funnel.complete).toBe('number');

  await expect(page.getByText('Completed leads', { exact: true })).toBeVisible();
  await expect(page.getByText('Qualified', { exact: true })).toBeVisible();
  await expect(page.getByText(/No personal data is shown here by design/i)).toBeVisible();
  await expect(page.getByText(contact.email)).toHaveCount(0);

  assertObserversClean(obs);
});

test('6 — every screen is accessible and the submit holds', async ({ page }) => {
  const obs = attachObserver(page);
  const contact = makeContact('a11y');

  const expectHeading = async (heading: string) => {
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText(heading);
    await expect(h1).toBeVisible();
    // Focus moves to the fresh heading on every screen transition.
    await expect(h1).toBeFocused();
  };

  const expectProgressBar = async () => {
    const bar = page.getByRole('progressbar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAttribute('aria-valuenow', /\d{1,3}/);
  };

  await page.goto('/qualification-v1');
  await waitForFunnelReady(page);
  await expectHeading(Q.age);

  // Drive the whole funnel with the keyboard: Tab to the first option button,
  // Enter to answer, and verify the focus lands on each successive heading.
  for (let i = 0; i < QUESTION_SCREENS.length; i++) {
    await expectProgressBar();
    await page.keyboard.press('Tab');
    const tag = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.tagName ?? ''
    );
    expect(tag, 'Tab from the heading must land on an option button').toBe('BUTTON');
    await page.keyboard.press('Enter');

    if (i < QUESTION_SCREENS.length - 1) {
      await expectHeading(QUESTION_SCREENS[i + 1]!.heading);
    } else {
      await expectHeading('A few details to finish');
    }
  }

  await expectProgressBar();
  for (const label of ['First name', 'Last name', 'Email', 'Phone', 'ZIP code']) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
  }

  // Hold the final request open so the "Submitting…" state is observable
  // deterministically rather than gambled on against a fast response.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  await page.route('**/api/lead', async (route) => {
    try {
      const req = route.request();
      if (req.method() === 'POST') {
        const body = req.postDataJSON() as { status?: string };
        if (body?.status === 'complete') {
          held = true;
          await gate;
        }
      }
      await route.continue();
    } catch {
      // The test ended (success, failure, or timeout) while we were holding.
    }
  });

  await fillContact(page, contact);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect.poll(async () => held).toBe(true);
  const submitButton = page.getByRole('button', { name: /Submit/ });
  await expect(submitButton).toBeDisabled();
  await expect(submitButton).toHaveText('Submitting…');

  release?.();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you');
  await expect(page.getByText(/A benefits specialist may contact you/i)).toBeVisible();

  assertObserversClean(obs);
});