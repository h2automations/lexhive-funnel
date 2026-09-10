import { expect, type Page, type Route } from '@playwright/test';

/**
 * The shared vocabulary of the funnel.
 *
 * Four suites drive the same six question screens. The question wording, the
 * option labels, the state picker, the contact fields and the completion
 * headings live here once, so a copy change is one edit rather than four — and
 * a suite that still passes after a question was reworded is a suite that was
 * not really looking.
 *
 * Nothing here asserts a business rule. These are the primitives; the
 * assertions belong in the spec files, next to the reason they exist.
 *
 * Privacy: no credential, ops key, or third-party token appears in this
 * directory, and no contact detail is ever printed into an assertion message —
 * CI logs outlive the run that produced them.
 */

export const APP_BASE = (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, '');
export const APP_HOST = new URL(APP_BASE).host;

/**
 * The path IS the variant: `App.tsx` reads it once at mount and stamps it on
 * every lead row and every Meta event. That makes it the cheapest possible
 * test-data separator — set `E2E_VARIANT=qualification-e2e` and every row a
 * test creates, partial saves included, is removable with one statement and
 * excluded from a breakdown with one filter.
 *
 * The default stays the live variant so `tags.spec.ts` exercises the real
 * container configuration out of the box.
 */
export const VARIANT = process.env.E2E_VARIANT || 'qualification-v1';
export const FUNNEL_PATH = `/${VARIANT}`;

export const RUN_TAG = String(Date.now());
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export const Q = {
  age: 'Are you between 18 and 64 years old?',
  state: 'Which state do you live in?',
  work: 'Are you unable to work because of a medical condition?',
  duration: 'Has your condition lasted—or is it expected to last—at least 12 months?',
  workHistory: 'Have you worked 20 of the last 40 quarters (roughly 5 of the last 10 years)?',
  doctor: 'Are you seeing a doctor for this condition?',
} as const;

/** The six question screens in funnel order. */
export const QUESTION_SCREENS: { heading: string }[] = [
  { heading: Q.age },
  { heading: Q.state },
  { heading: Q.work },
  { heading: Q.duration },
  { heading: Q.workHistory },
  { heading: Q.doctor },
];

export const CONTACT_HEADING = 'A few details to finish';
export const RESTRICTED_HEADING = 'Thank you for answering';
export const DONE_HEADING = 'Thank you';
export const NOMATCH_HEADING = 'This service may not be a match';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

export interface Contact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  zip: string;
}

/**
 * Email is generated per run unless E2E_EMAIL is set; the phone is a fictional
 * US number from the reserved 555-01xx exchange. The `playwright+` local part
 * is what makes generated rows separable from real traffic afterwards — see
 * the cleanup query in tests/README.md.
 */
export function makeContact(tag: string): Contact {
  return {
    firstName: process.env.E2E_FIRST_NAME || 'Playwright',
    lastName: process.env.E2E_LAST_NAME || 'Test',
    email: process.env.E2E_EMAIL || `playwright+${RUN_TAG}-${tag}@example.com`,
    phone: process.env.E2E_PHONE || '5550100100',
    zip: process.env.E2E_ZIP || '78701',
  };
}

// ---------------------------------------------------------------------------
// dataLayer
// ---------------------------------------------------------------------------

export async function waitForFunnelReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
    return dl.some((e) => e && (e as { event?: string }).event === 'funnel_ready');
  });
}

export async function readDataLayer(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []);
}

export function eventsNamed(dl: unknown[], event: string): Array<{ [k: string]: unknown }> {
  return dl.filter((e) => e && (e as { event?: string }).event === event) as Array<{
    [k: string]: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Driving the funnel
// ---------------------------------------------------------------------------

export async function gotoFunnel(page: Page): Promise<void> {
  await page.goto(FUNNEL_PATH);
  await waitForFunnelReady(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.age);
}

export async function answerQuestion(page: Page, option: string, nextHeading: string): Promise<void> {
  await page.getByRole('button', { name: option, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(nextHeading);
}

/**
 * The state screen is a native picker behind an explicit confirm — select a
 * state, press "Check availability", and expect the next screen. The server
 * decides the verdict; this just waits on whatever heading the UI lands on.
 */
export async function selectState(page: Page, label: string, nextHeading: string): Promise<void> {
  await page.locator('#state-picker').selectOption({ label });
  await page.getByRole('button', { name: 'Check availability', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(nextHeading);
}

/**
 * Answer all six questions so the lead qualifies, landing on the contact
 * step. `expectHeading` is the heading the last answer should produce: the
 * contact step normally, or the restricted screen when the caller has
 * deliberately broken the state lookup.
 */
export async function answerAllQualifying(
  page: Page,
  expectHeading: string = CONTACT_HEADING
): Promise<void> {
  await answerQuestion(page, 'Yes', Q.state); // age
  await selectState(page, 'Texas', Q.work); // state
  await answerQuestion(page, 'Yes', Q.duration); // work
  await answerQuestion(page, 'Yes', Q.workHistory); // duration
  await answerQuestion(page, 'Yes', Q.doctor); // workHistory
  await answerQuestion(page, 'Yes', expectHeading); // doctor
}

export async function fillContact(page: Page, contact: Contact): Promise<void> {
  // exact: the consent checkbox's label contains "email" and "phone", so a
  // substring match would resolve to two elements.
  await page.getByLabel('First name', { exact: true }).fill(contact.firstName);
  await page.getByLabel('Last name', { exact: true }).fill(contact.lastName);
  await page.getByLabel('Email (optional)', { exact: true }).fill(contact.email);
  await page.getByLabel('Phone', { exact: true }).fill(contact.phone);
  await page.getByLabel('ZIP code (optional)', { exact: true }).fill(contact.zip);
}

/** Fill the contact step and submit, without waiting on the outcome. */
export async function submitContact(page: Page, contact: Contact): Promise<void> {
  await fillContact(page, contact);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Request a callback', exact: true }).click();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function isLeadPost(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/api/lead');
}

/** The completion response: the one POST /api/lead with status 'complete'. */
export function waitForCompleteResponse(page: Page) {
  return page.waitForResponse((res) => {
    if (!isLeadPost(res.url(), res.request().method())) return false;
    try {
      return (res.request().postDataJSON() as { status?: string } | null)?.status === 'complete';
    } catch {
      return false;
    }
  });
}

/**
 * Poll a collector until it yields a value. Requests captured by a `page.on`
 * listener can arrive before the code that wants them starts waiting, so
 * `page.waitForRequest` would race; this reads what was already collected.
 */
export async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------
// Third-party tags
// ---------------------------------------------------------------------------

/**
 * Every host the funnel talks to that is not the funnel. Used two ways: to
 * simulate an ad blocker, and to assert that nothing reaches them from pages
 * where nothing should.
 */
export const THIRD_PARTY_PATTERN =
  /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|connect\.facebook\.net|facebook\.com\/tr|clarity\.ms/;

/**
 * Abort every tag request. A funnel that needs GTM to be reachable in order to
 * capture a lead has made a marketing script load-bearing for revenue, and
 * roughly a third of this audience runs a blocker.
 */
export async function blockThirdPartyTags(page: Page): Promise<void> {
  await page.route(THIRD_PARTY_PATTERN, (route: Route) => route.abort());
}