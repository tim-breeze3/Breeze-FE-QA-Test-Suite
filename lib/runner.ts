// lib/runner.ts
//
// Pure UI test runner — Scenario A.
//
// The merchant's app handles all Breeze API calls (creating payment pages,
// loading the iframe, etc). This runner simply:
//   1. Navigates to the merchant's checkout URL
//   2. Waits for the Breeze payment iframe to appear
//   3. Fills card details and submits
//   4. Asserts the merchant UI shows the expected outcome
//   5. Records via Browserless and uploads .webm to Google Drive
//
// No BREEZE_API_KEY needed or used.

import { chromium } from 'playwright-core';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateRunFolder, uploadRecording } from './drive';
import type { RunConfig, RunResult, TestResult, SSEEvent, TestDefinition } from './types';
import { ALL_TESTS } from './types';

// ── Sandbox test cards (Breeze docs) ─────────────────────────────────────────
const CARDS = {
  // Pay-in
  visaSuccessUS:   { number: '4000020000000000', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDeclinedES:  { number: '4539467987109256', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDebitGB:     { number: '4659105569051157', cvv: '123', expiry: '12/29', zip: '10001' },
  visaPrepaid:     { number: '4000148147058142', cvv: '123', expiry: '12/29', zip: '10001' },
  // 3DS
  mc3dsUS:         { number: '5385308360135181', cvv: '123', expiry: '12/29', zip: '10001' },
  amex3dsUS:       { number: '372688581899681',  cvv: '1234', expiry: '12/29', zip: '10001' },
  mcFR3ds:         { number: '5137210000000158', cvv: '123', expiry: '12/29', zip: '10001' },
  // Payout — single card for all payout tests
  payoutVisa:      { number: '4000 0566 5566 5556' },
} as const;

const THREE_DS_PASSWORD = 'Checkout1!';

// ── Selectors ─────────────────────────────────────────────────────────────────
// These target elements inside the Breeze payment iframe.
// Override via env vars if needed for a specific integration.
const SEL = {
  // The Breeze iframe itself (inside merchant page)
  iframe: process.env.BREEZE_IFRAME_SELECTOR ?? 'iframe[src*="breeze"]',

  // Fields inside the Breeze iframe
  cardNumber: '[data-testid="card-number"], input[name="cardNumber"], input[placeholder*="card" i], input[placeholder*="1234" i]',
  expiry:     '[data-testid="expiry"], input[name="expiry"], input[placeholder*="MM" i], input[placeholder*="expir" i]',
  cvv:        '[data-testid="cvv"], [data-testid="cvc"], input[name="cvv"], input[name="cvc"], input[placeholder*="CVV" i]',
  zip:        '[data-testid="zip"], input[name="zip"], input[name="postalCode"], input[placeholder*="zip" i]',
  submit:     '[data-testid="pay-button"], [data-testid="submit"], button[type="submit"]',

  // 3DS simulator iframe + password field
  threeds:     'iframe[src*="3ds"], iframe[src*="simulator"], iframe[src*="challenge"]',
  threedsPass: 'input[type="password"], input[name="password"]',

  // Outcomes on the MERCHANT page (after iframe interaction)
  // These are intentionally broad — the merchant app decides what to show.
  // Override via BREEZE_SUCCESS_SELECTOR / BREEZE_FAILURE_SELECTOR in .env
  success: process.env.BREEZE_SUCCESS_SELECTOR
    ?? 'text=/payment successful|thank you|order confirmed|success/i',
  failure: process.env.BREEZE_FAILURE_SELECTOR
    ?? 'text=/payment failed|declined|error/i',
  payoutDone: process.env.BREEZE_PAYOUT_SELECTOR
    ?? 'text=/payout complete|withdrawal successful|funds sent|success/i',
};

// ── Browserless ───────────────────────────────────────────────────────────────
function browserlessWsEndpoint(record: boolean): string {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN is not set');
  const params = [`token=${token}`, 'headless=false', 'stealth'];
  if (record) params.push('record=true');
  return `wss://production-sfo.browserless.io?${params.join('&')}`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function today(): string {
  return new Date().toISOString().split('T')[0];
}

function timeLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}m`;
}

function getTests(suite: string): TestDefinition[] {
  return suite === 'all' ? ALL_TESTS : ALL_TESTS.filter(t => t.suite === suite);
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runTests(
  config: RunConfig,
  emit: (event: SSEEvent) => void,
): Promise<RunResult> {
  const runId     = uuidv4();
  const startedAt = new Date().toISOString();
  const tests     = getTests(config.suite);
  const results:  TestResult[] = [];
  let passed = 0;
  let failed = 0;

  emit({ type: 'run_start', runId, total: tests.length });
  emit({ type: 'log', message: `Run ${runId}`, level: 'info' });
  emit({ type: 'log', message: `Checkout URL : ${config.appUrl}`, level: 'info' });
  if (config.payoutUrl) {
    emit({ type: 'log', message: `Payout URL  : ${config.payoutUrl}`, level: 'info' });
  }
  emit({ type: 'log', message: `Suite: ${config.suite} · ${tests.length} tests`, level: 'dim' });
  emit({ type: 'log', message: `Recording: ${config.videoMode}`, level: 'dim' });

  // ── Create Google Drive folder for this run ───────────────────────────────
  const shouldRecord = config.videoMode !== 'off';
  let runFolderId    = '';
  let driveFolderLink = '';

  if (shouldRecord) {
    try {
      emit({ type: 'log', message: 'Creating Drive folder…', level: 'dim' });
      const folder = await getOrCreateRunFolder(today());
      runFolderId     = folder.folderId;
      driveFolderLink = folder.folderLink;
      emit({ type: 'log', message: `Drive folder ready ✓`, level: 'pass' });
    } catch (e) {
      emit({ type: 'log', message: `Drive setup failed: ${(e as Error).message}`, level: 'warn' });
    }
  }

  // ── Connect to Browserless ────────────────────────────────────────────────
  emit({ type: 'log', message: 'Connecting to Browserless…', level: 'dim' });
  const browser  = await chromium.connectOverCDP(browserlessWsEndpoint(shouldRecord));
  const context  = browser.contexts()[0];
  const page     = context.pages()[0];
  await page.setViewportSize({ width: 1280, height: 720 });
  emit({ type: 'log', message: 'Browser connected ✓', level: 'pass' });

  // ── Optional login ────────────────────────────────────────────────────────
  if (config.siteUser && config.sitePassword) {
    emit({ type: 'log', message: `Logging in as ${config.siteUser}…`, level: 'info' });
    const loginUrl = process.env.LOGIN_URL ?? `${config.appUrl.replace(/\/[^/]*$/, '')}/login`;
    await page.goto(loginUrl, { waitUntil: 'networkidle' });
    await page.locator(process.env.LOGIN_USER_SELECTOR ?? 'input[type="email"], input[name="email"]').first().fill(config.siteUser);
    await page.locator(process.env.LOGIN_PASS_SELECTOR ?? 'input[type="password"]').fill(config.sitePassword);
    await page.locator(process.env.LOGIN_SUBMIT_SELECTOR ?? 'button[type="submit"]').click();
    await page.waitForURL(url => !url.toString().match(/login|signin/i), { timeout: 15_000 });
    emit({ type: 'log', message: 'Login successful ✓', level: 'pass' });
  }

  // ── Run each test ─────────────────────────────────────────────────────────
  for (const test of tests) {
    const testStart = Date.now();
    emit({ type: 'test_start', testId: test.id, name: test.name });
    emit({ type: 'log', testId: test.id, message: `▶ ${test.name}`, level: 'info' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cdpSession: any = null;
    let recording = false;

    try {
      // Start per-test recording
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (shouldRecord) {
        cdpSession = await context.newCDPSession(page);
        await (cdpSession as any).send('Browserless.startRecording');
        recording = true;
      }

      // Run the scenario
      await runScenario({ test, config, page, emit });

      const durationMs = Date.now() - testStart;
      emit({ type: 'log', testId: test.id, message: `  ✓ PASSED (${(durationMs / 1000).toFixed(1)}s)`, level: 'pass' });

      // Stop recording + upload
      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId, page,
        filename: `${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({ id: test.id, name: test.name, tag: test.tag, status: 'pass', durationMs, driveLink, driveFileId });
      passed++;
      emit({ type: 'test_end', result: results[results.length - 1] });

    } catch (err) {
      const durationMs = Date.now() - testStart;
      const error      = (err as Error).message;
      emit({ type: 'log', testId: test.id, message: `  ✕ FAILED: ${error}`, level: 'fail' });

      // Always save failure recordings — they're the most useful
      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId, page,
        filename: `FAILED-${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({ id: test.id, name: test.name, tag: test.tag, status: 'fail', durationMs, error, driveLink, driveFileId });
      failed++;
      emit({ type: 'test_end', result: results[results.length - 1] });
    }

    // Small gap between tests so the merchant page can fully reset
    await page.waitForTimeout(800);
  }

  await browser.close();

  const completedAt = new Date().toISOString();
  const totalMs     = Date.now() - new Date(startedAt).getTime();

  const summary: RunResult = {
    runId, status: 'complete', config, results,
    startedAt, completedAt, totalMs, passed, failed, driveFolderLink,
  };

  emit({ type: 'log', message: `Finished: ${passed}/${tests.length} passed in ${(totalMs / 1000).toFixed(1)}s`, level: passed === tests.length ? 'pass' : 'fail' });
  if (driveFolderLink) {
    emit({ type: 'log', message: `Recordings: ${driveFolderLink}`, level: 'info' });
  }
  emit({ type: 'run_end', summary });
  return summary;
}

// ── Individual test scenarios ─────────────────────────────────────────────────
// Every scenario:
//   1. Navigates to the merchant URL (already has Breeze iframe loaded by merchant backend)
//   2. Waits for the Breeze iframe to be ready
//   3. Fills the card and submits
//   4. Asserts the merchant page shows the right outcome

async function runScenario(opts: {
  test: TestDefinition;
  config: RunConfig;
  page: import('playwright-core').Page;
  emit: (e: SSEEvent) => void;
}): Promise<void> {
  const { test, config, page, emit } = opts;
  const log = (msg: string, level: SSEEvent extends { type: 'log' } ? SSEEvent['level'] : never = 'dim') =>
    emit({ type: 'log', testId: test.id, message: msg, level });

  // Payout tests go to a different URL if configured
  const url = test.suite === 'payout'
    ? (config.payoutUrl ?? config.appUrl)
    : config.appUrl;

  log(`  → navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  switch (test.id) {

    // ── Payin: Visa success ─────────────────────────────────────────────────
    case 't1': {
      log('  → waiting for Breeze iframe…');
      await fillBreezeCard(page, CARDS.visaSuccessUS, log);
      await page.waitForSelector(SEL.success, { timeout: 20_000 });
      log('  ✓ success state visible on merchant page', 'pass');
      break;
    }

    // ── Payin: Visa declined ────────────────────────────────────────────────
    case 't2': {
      await fillBreezeCard(page, CARDS.visaDeclinedES, log);
      // Failure message appears inside the Breeze iframe itself
      const iframeFailure = page.frameLocator(SEL.iframe).getByText(/payment failed|declined/i);
      await iframeFailure.waitFor({ timeout: 15_000 });
      log('  ✓ decline message visible in iframe', 'pass');
      break;
    }

    // ── Payin: Visa GB debit success ────────────────────────────────────────
    case 't3': {
      await fillBreezeCard(page, CARDS.visaDebitGB, log);
      await page.waitForSelector(SEL.success, { timeout: 20_000 });
      log('  ✓ success state visible', 'pass');
      break;
    }

    // ── Payin: Visa prepaid declined ────────────────────────────────────────
    case 't4': {
      await fillBreezeCard(page, CARDS.visaPrepaid, log);
      const iframeFailure = page.frameLocator(SEL.iframe).getByText(/payment failed|declined/i);
      await iframeFailure.waitFor({ timeout: 15_000 });
      log('  ✓ decline message visible in iframe', 'pass');
      break;
    }

    // ── 3DS: Mastercard US ──────────────────────────────────────────────────
    case 't5': {
      await fillBreezeCard(page, CARDS.mc3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ success after 3DS', 'pass');
      break;
    }

    // ── 3DS: Amex US ───────────────────────────────────────────────────────
    case 't6': {
      await fillBreezeCard(page, CARDS.amex3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ success after Amex 3DS', 'pass');
      break;
    }

    // ── 3DS: Mastercard FR ──────────────────────────────────────────────────
    case 't7': {
      await fillBreezeCard(page, CARDS.mcFR3ds, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ success after FR 3DS', 'pass');
      break;
    }

    // ── Payout: push-to-card ────────────────────────────────────────────────
    case 't8': {
      log(`  → filling payout card ${CARDS.payoutVisa.number}`);
      // Payout iframe uses the same Breeze iframe selector
      const frame = page.frameLocator(SEL.iframe);
      await frame.locator(SEL.cardNumber).waitFor({ timeout: 20_000 });
      await frame.locator(SEL.cardNumber).fill(CARDS.payoutVisa.number);
      // Expiry may or may not be required for push-to-card
      const expiryField = frame.locator(SEL.expiry);
      if (await expiryField.count() > 0) await expiryField.first().fill('12/29');
      await frame.locator(SEL.submit).click();
      await page.waitForSelector(SEL.payoutDone, { timeout: 30_000 });
      log('  ✓ payout completion state visible', 'pass');
      break;
    }

    default:
      throw new Error(`Unknown test ID: ${test.id}`);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

type LogFn = (msg: string, level?: 'info' | 'pass' | 'fail' | 'warn' | 'dim') => void;

async function fillBreezeCard(
  page: import('playwright-core').Page,
  card: { number: string; cvv: string; expiry: string; zip: string },
  log: LogFn,
): Promise<void> {
  const frame = page.frameLocator(SEL.iframe);

  log('  → waiting for Breeze iframe…');
  await frame.locator(SEL.cardNumber).waitFor({ timeout: 20_000 });

  log(`  → filling card ${card.number}`);
  await frame.locator(SEL.cardNumber).fill(card.number);
  await frame.locator(SEL.expiry).fill(card.expiry);
  await frame.locator(SEL.cvv).fill(card.cvv);

  // Zip is optional depending on merchant configuration
  const zipField = frame.locator(SEL.zip);
  if (await zipField.count() > 0) {
    await zipField.first().fill(card.zip);
  }

  log('  → submitting…');
  await frame.locator(SEL.submit).click();
}

async function complete3DS(
  page: import('playwright-core').Page,
  log: LogFn,
): Promise<void> {
  log('  → waiting for 3DS simulator…');
  const threeDsFrame = page.frameLocator(SEL.threeds);
  await threeDsFrame.locator(SEL.threedsPass).waitFor({ timeout: 20_000 });
  await threeDsFrame.locator(SEL.threedsPass).fill(THREE_DS_PASSWORD);
  await threeDsFrame.locator('button[type="submit"]').click();
  log(`  → entered 3DS password (${THREE_DS_PASSWORD})`);
}

async function stopAndUpload(opts: {
  recording: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cdpSession: any;
  runFolderId: string;
  page: import('playwright-core').Page;
  filename: string;
  emit: (e: SSEEvent) => void;
  testId: string;
}): Promise<{ driveLink?: string; driveFileId?: string }> {
  const { recording, cdpSession, runFolderId, filename, emit, testId } = opts;
  if (!recording || !cdpSession || !runFolderId) return {};

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (cdpSession as any).send('Browserless.stopRecording') as { value: string };
    const videoBuffer = Buffer.from(response.value, 'binary');
    const mb = (videoBuffer.length / 1024 / 1024).toFixed(1);
    emit({ type: 'log', testId, message: `  → uploading ${mb} MB to Drive…`, level: 'dim' });
    const upload = await uploadRecording({ buffer: videoBuffer, filename, folderId: runFolderId });
    emit({ type: 'log', testId, message: `  → Drive upload complete ✓`, level: 'pass' });
    return { driveLink: upload.webViewLink, driveFileId: upload.fileId };
  } catch (e) {
    emit({ type: 'log', testId, message: `  ⚠ Drive upload failed: ${(e as Error).message}`, level: 'warn' });
    return {};
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}
