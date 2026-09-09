import { expect, test } from '@playwright/test';
import { execSync } from 'child_process';
import {
  FUNNEL_PATH,
  Q,
  UUID_RE,
  answerQuestion,
  fillContact,
  gotoFunnel,
  makeContact,
  waitForCompleteResponse,
  waitForFunnelReady,
  type Contact,
} from './support/funnel';

/**
 * Delivery pipeline tests for LexHive funnel.
 *
 * Verifies the full submission → outbox → delivery path. Each test submits a
 * real lead and checks the database rows. These tests create real rows in
 * production Postgres.
 */

const APP_BASE = (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, '');
const OPS_KEY = process.env.OPS_KEY || '';
const DB_CONN = process.env.DATABASE_URL || '';
const DB_PASS = process.env.PGPASSWORD || '';
const HAS_DB = Boolean(DB_CONN && DB_PASS);

function dbQuery(query: string): string {
  if (!HAS_DB) return '';
  try {
    return execSync(
      `PGPASSWORD='${DB_PASS}' psql -tA "${DB_CONN}" -c "${query}"`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();
  } catch (e) {
    console.error('DB query failed:', e);
    return '';
  }
}

async function waitForDelivery(leadId: string, maxWaitMs: number = 15000): Promise<boolean> {
  if (!HAS_DB) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const pending = dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE lead_id='${leadId}' AND status='pending'`);
    if (pending === '0') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function getDeliveryStatus(leadId: string) {
  return {
    meta_capi: dbQuery(`SELECT status FROM delivery_outbox WHERE lead_id='${leadId}' AND destination='meta_capi'`) || 'not_found',
    n8n_airtable: dbQuery(`SELECT status FROM delivery_outbox WHERE lead_id='${leadId}' AND destination='n8n_airtable'`) || 'not_found',
  };
}

const CONTACT_HEADING = 'A few details to finish';

async function driveQualifiedFunnel(page: Page, contact: Contact): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'Texas', Q.work);
  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', CONTACT_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONTACT_HEADING);
  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

async function driveRestrictedFunnel(page: Page): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'New York', Q.work);
  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', 'Thank you for answering');

  await page.getByRole('checkbox').check();
  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

async function driveDisqualifiedFunnel(page: Page, contact: Contact): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'Texas', Q.work);
  await answerQuestion(page, 'No', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', CONTACT_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONTACT_HEADING);
  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

test.skip(!HAS_DB, 'DATABASE_URL / PGPASSWORD not set — see .env.e2e.example');

test.describe('Delivery Pipeline', () => {
  test('1 — qualified submission delivers to both destinations', async ({ page }) => {
    const contact = makeContact('deliv');
    const { leadId, eventId } = await driveQualifiedFunnel(page, contact);

    expect(leadId).toMatch(UUID_RE);
    expect(eventId).toMatch(UUID_RE);

    const delivered = await waitForDelivery(leadId, 15000);
    expect(delivered, 'self-trigger should deliver within 15s').toBe(true);

    const status = getDeliveryStatus(leadId);
    expect(status.meta_capi).toBe('succeeded');
    expect(status.n8n_airtable).toBe('succeeded');
  });

  test('2 — restricted submission delivers to n8n only', async ({ page }) => {
    const { leadId } = await driveRestrictedFunnel(page);
    expect(leadId).toMatch(UUID_RE);

    const delivered = await waitForDelivery(leadId, 15000);
    expect(delivered, 'n8n delivery should complete within 15s').toBe(true);

    const status = getDeliveryStatus(leadId);
    expect(status.n8n_airtable).toBe('succeeded');
    expect(status.meta_capi).toBe('not_found');
  });

  test('3 — disqualified submission delivers to n8n only', async ({ page }) => {
    const contact = makeContact('dqdeliv');
    const { leadId } = await driveDisqualifiedFunnel(page, contact);
    expect(leadId).toMatch(UUID_RE);

    const delivered = await waitForDelivery(leadId, 15000);
    expect(delivered, 'n8n delivery should complete within 15s').toBe(true);

    const status = getDeliveryStatus(leadId);
    expect(status.n8n_airtable).toBe('succeeded');
    expect(status.meta_capi).toBe('not_found');
  });

  test('4 — burst submissions all deliver', async ({ page }) => {
    const leads: string[] = [];
    for (let i = 0; i < 3; i++) {
      const contact = makeContact(`burst${i}`);
      const { leadId } = await driveQualifiedFunnel(page, contact);
      leads.push(leadId);
    }

    for (const leadId of leads) {
      const ok = await waitForDelivery(leadId, 20000);
      expect(ok, `${leadId} should deliver`).toBe(true);
      const s = getDeliveryStatus(leadId);
      expect(s.meta_capi).toBe('succeeded');
      expect(s.n8n_airtable).toBe('succeeded');
    }
  });

  test('5 — ops shows healthy after delivery', async () => {
    const resp = await fetch(`${APP_BASE}/api/ops`, { headers: { 'x-ops-key': OPS_KEY } });
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.problems).toEqual([]);
    const meta = data.health.find((h: any) => h.destination === 'meta_capi');
    const n8n = data.health.find((h: any) => h.destination === 'n8n_airtable');
    expect(meta?.status).toBe('healthy');
    expect(n8n?.status).toBe('healthy');
  });

  test('6 — zero pending, zero dead', async () => {
    expect(dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE status='pending'`)).toBe('0');
    expect(dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE status='dead_lettered'`)).toBe('0');
  });
});
