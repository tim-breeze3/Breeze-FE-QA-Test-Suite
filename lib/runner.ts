// lib/runner.ts
//
// Pure UI test runner — Scenario A (timd.app WooCommerce store).
//
// Flow per test:
//   1. Add product to cart via ?add-to-cart=16 (skips product page click)
//   2. Navigate to /checkout/
//   3. Fill guest billing email (triggers Breeze iframe to render)
//   4. Fill Breeze test card and submit
//   5. Assert outcome on merchant page
//   6. Record via Browserless → upload .webm to Google Drive

import { chromium } from 'playwright-core';
import { v4 as uuidv4 } from 'uuid';
import { getOrCreateRunFolder, uploadRecording } from './drive';
import type { RunConfig, RunResult, TestResult, SSEEvent, TestDefinition } from './types';
import { ALL_TESTS } from './types';

// ── Sandbox test cards ────────────────────────────────────────────────────────
const CARDS = {
  visaSuccessUS:  { number: '4000020000000000', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDeclinedES: { number: '4539467987109256', cvv: '123', expiry: '12/29', zip: '10001' },
  visaDebitGB:    { number: '4659105569051157', cvv: '123', expiry: '12/29', zip: '10001' },
  visaPrepaid:    { number: '4000148147058142', cvv: '123', expiry: '12/29', zip: '10001' },
  mc3dsUS:        { number: '5385308360135181', cvv: '123', expiry: '12/29', zip: '10001' },
  amex3dsUS:      { number: '372688581899681',  cvv: '1234', expiry: '12/29', zip: '10001' },
  mcFR3ds:        { number: '5137210000000158', cvv: '123', expiry: '12/29', zip: '10001' },
  payoutVisa:     { number: '4000 0566 5566 5556' },
} as const;

const THREE_DS_PASSWORD = 'Checkout1!';

// ── Selectors ─────────────────────────────────────────────────────────────────
const SEL = {
  iframe:      process.env.BREEZE_IFRAME_SELECTOR ?? 'iframe[src*="breeze"]',
  cardNumber:  '[data-testid="card-number"], input[name="cardNumber"], input[placeholder*="card" i], input[placeholder*="1234" i]',
  expiry:      '[data-testid="expiry"], input[name="expiry"], input[placeholder*="MM" i], input[placeholder*="expir" i]',
  cvv:         '[data-testid="cvv"], [data-testid="cvc"], input[name="cvv"], input[name="cvc"], input[placeholder*="CVV" i]',
  zip:         '[data-testid="zip"], input[name="zip"], input[name="postalCode"], input[placeholder*="zip" i]',
  submit:      '[data-testid="pay-button"], [data-testid="submit"], button[type="submit"]',
  threeds:     'iframe[src*="3ds"], iframe[src*="simulator"], iframe[src*="challenge"]',
  threedsPass: 'input[type="password"], input[name="password"]',
  success:     process.env.BREEZE_SUCCESS_SELECTOR    ?? 'text=/payment successful|thank you|order confirmed|order received/i',
  failure:     process.env.BREEZE_FAILURE_SELECTOR    ?? 'text=/payment failed|declined|error/i',
  payoutDone:  process.env.BREEZE_PAYOUT_SELECTOR     ?? 'text=/payout complete|withdrawal successful|funds sent|success/i',
};

// ── Browserless ───────────────────────────────────────────────────────────────
function browserlessWsEndpoint(record: boolean): string {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN is not set');
  const params = [`token=${token}`, 'headless=false', 'stealth'];
  if (record) params.push('record=true');
  return `wss://production-sfo.browserless.io?${params.join('&')}`;
}

function today(): string { return new Date().toISOString().split('T')[0]; }

function timeLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}h${String(d.getMinutes()).padStart(2,'0')}m`;
}

function getTests(suite: string): TestDefinition[] {
  return suite === 'all' ? ALL_TESTS : ALL_TESTS.filter(t => t.suite === suite);
}

type LogFn = (msg: string, level?: 'info' | 'pass' | 'fail' | 'warn' | 'dim') => void;

// ── WooCommerce preflight ─────────────────────────────────────────────────────
// Hardcoded for timd.app (Breeze Sandbox Store).
// Uses ?add-to-cart=16 (Premium Wireless Headphones) to skip clicking product pages.
// WooCommerce replaces the cart on each call so every test starts fresh.
async function wooCommerceCheckoutPreflight(
  page: import('playwright-core').Page,
  baseUrl: string,
  log: LogFn,
): Promise<void> {
  const origin = new URL(baseUrl).origin; // https://timd.app

  // 1. Add product to cart instantly via query param
  log('  → adding product to cart…');
  await page.goto(`${origin}/?add-to-cart=16`, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  // 2. Go directly to checkout
  log('  → navigating to checkout…');
  await page.goto(`${origin}/checkout/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  // 3. Fill guest billing email — WooCommerce requires this before showing payment
  log('  → filling guest email…');
  const emailSel = '#billing_email, input[name="billing_email"], input[type="email"]';
  await page.locator(emailSel).first().waitFor({ timeout: 10_000 });
  await page.locator(emailSel).first().fill('bot-test@breeze-sandbox.com');

  // Blur triggers WooCommerce to update order totals and render the payment iframe
  await page.locator(emailSel).first().press('Tab');

  // 4. Wait for Breeze iframe to appear
  log('  → waiting for Breeze iframe…');
  await page.waitForSelector(SEL.iframe, { timeout: 20_000 });
  log('  ✓ checkout ready', 'pass');
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runTests(
  config: RunConfig,
  emit: (event: SSEEvent) => void,
): Promise<RunResult> {
  const runId     = uuidv4();
  const startedAt = new Date().toISOString();
  const tests     = getTests(config.suite);
  const results: TestResult[] = [];
  let passed = 0, failed = 0;

  emit({ type: 'run_start', runId, total: tests.length });
  emit({ type: 'log', message: `Run ${runId}`, level: 'info' });
  emit({ type: 'log', message: `Store: ${config.appUrl}`, level: 'info' });
  emit({ type: 'log', message: `Suite: ${config.suite} · ${tests.length} tests`, level: 'dim' });
  emit({ type: 'log', message: `Recording: ${config.videoMode}`, level: 'dim' });

  // ── Drive folder ──────────────────────────────────────────────────────────
  const shouldRecord = config.videoMode !== 'off';
  let runFolderId = '', driveFolderLink = '';

  if (shouldRecord) {
    try {
      emit({ type: 'log', message: 'Creating Drive folder…', level: 'dim' });
      const folder = await getOrCreateRunFolder(today());
      runFolderId = folder.folderId;
      driveFolderLink = folder.folderLink;
      emit({ type: 'log', message: 'Drive folder ready ✓', level: 'pass' });
    } catch (e) {
      emit({ type: 'log', message: `Drive setup failed: ${(e as Error).message}`, level: 'warn' });
    }
  }

  // ── Connect to Browserless ────────────────────────────────────────────────
  emit({ type: 'log', message: 'Connecting to Browserless…', level: 'dim' });
  const browser = await chromium.connectOverCDP(browserlessWsEndpoint(shouldRecord));
  const context = browser.contexts()[0];
  const page    = context.pages()[0];
  await page.setViewportSize({ width: 1280, height: 720 });
  emit({ type: 'log', message: 'Browser connected ✓', level: 'pass' });

  // ── Optional site login ───────────────────────────────────────────────────
  if (config.siteUser && config.sitePassword) {
    emit({ type: 'log', message: `Logging in as ${config.siteUser}…`, level: 'info' });
    const loginUrl = process.env.LOGIN_URL ?? `${new URL(config.appUrl).origin}/login`;
    await page.goto(loginUrl, { waitUntil: 'networkidle' });
    await page.locator(process.env.LOGIN_USER_SELECTOR ?? 'input[type="email"]').first().fill(config.siteUser);
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
      if (shouldRecord) {
        cdpSession = await context.newCDPSession(page);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (cdpSession as any).send('Browserless.startRecording');
        recording = true;
      }

      await runScenario({ test, config, page, emit });

      const durationMs = Date.now() - testStart;
      emit({ type: 'log', testId: test.id, message: `  ✓ PASSED (${(durationMs/1000).toFixed(1)}s)`, level: 'pass' });

      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId,
        filename: `${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({ id: test.id, name: test.name, tag: test.tag, status: 'pass', durationMs, driveLink, driveFileId });
      passed++;
      emit({ type: 'test_end', result: results[results.length - 1] });

    } catch (err) {
      const durationMs = Date.now() - testStart;
      const error = (err as Error).message;
      emit({ type: 'log', testId: test.id, message: `  ✕ FAILED: ${error}`, level: 'fail' });

      const { driveLink, driveFileId } = await stopAndUpload({
        recording, cdpSession, runFolderId,
        filename: `FAILED-${test.id}-${slugify(test.name)}-${timeLabel()}.webm`,
        emit, testId: test.id,
      });

      results.push({ id: test.id, name: test.name, tag: test.tag, status: 'fail', durationMs, error, driveLink, driveFileId });
      failed++;
      emit({ type: 'test_end', result: results[results.length - 1] });
    }

    // Brief pause between tests so WooCommerce session resets cleanly
    await page.waitForTimeout(1000);
  }

  await browser.close();

  const completedAt = new Date().toISOString();
  const totalMs = Date.now() - new Date(startedAt).getTime();

  const summary: RunResult = {
    runId, status: 'complete', config, results,
    startedAt, completedAt, totalMs, passed, failed, driveFolderLink,
  };

  emit({ type: 'log', message: `Finished: ${passed}/${tests.length} passed in ${(totalMs/1000).toFixed(1)}s`, level: passed === tests.length ? 'pass' : 'fail' });
  if (driveFolderLink) emit({ type: 'log', message: `Recordings: ${driveFolderLink}`, level: 'info' });
  emit({ type: 'run_end', summary });
  return summary;
}

// ── Individual test scenarios ─────────────────────────────────────────────────
async function runScenario(opts: {
  test: TestDefinition;
  config: RunConfig;
  page: import('playwright-core').Page;
  emit: (e: SSEEvent) => void;
}): Promise<void> {
  const { test, config, page, emit } = opts;
  const log: LogFn = (msg, level = 'dim') =>
    emit({ type: 'log', testId: test.id, message: msg, level });

  if (test.suite === 'payout') {
    // Payout goes directly to the payout URL — no cart flow
    const url = config.payoutUrl ?? config.appUrl;
    log(`  → navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } else {
    // All payin + 3DS tests: add to cart → checkout → fill email → wait for iframe
    await wooCommerceCheckoutPreflight(page, config.appUrl, log);
  }

  switch (test.id) {

    case 't1': {
      await fillBreezeCard(page, CARDS.visaSuccessUS, log);
      await page.waitForSelector(SEL.success, { timeout: 20_000 });
      log('  ✓ order confirmed visible', 'pass');
      break;
    }

    case 't2': {
      await fillBreezeCard(page, CARDS.visaDeclinedES, log);
      await page.frameLocator(SEL.iframe).getByText(/payment failed|declined/i).waitFor({ timeout: 15_000 });
      log('  ✓ decline message visible in iframe', 'pass');
      break;
    }

    case 't3': {
      await fillBreezeCard(page, CARDS.visaDebitGB, log);
      await page.waitForSelector(SEL.success, { timeout: 20_000 });
      log('  ✓ order confirmed visible', 'pass');
      break;
    }

    case 't4': {
      await fillBreezeCard(page, CARDS.visaPrepaid, log);
      await page.frameLocator(SEL.iframe).getByText(/payment failed|declined/i).waitFor({ timeout: 15_000 });
      log('  ✓ decline message visible in iframe', 'pass');
      break;
    }

    case 't5': {
      await fillBreezeCard(page, CARDS.mc3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ order confirmed after Mastercard 3DS', 'pass');
      break;
    }

    case 't6': {
      await fillBreezeCard(page, CARDS.amex3dsUS, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ order confirmed after Amex 3DS', 'pass');
      break;
    }

    case 't7': {
      await fillBreezeCard(page, CARDS.mcFR3ds, log);
      await complete3DS(page, log);
      await page.waitForSelector(SEL.success, { timeout: 30_000 });
      log('  ✓ order confirmed after Mastercard FR 3DS', 'pass');
      break;
    }

    case 't8': {
      log(`  → filling payout card ${CARDS.payoutVisa.number}`);
      const frame = page.frameLocator(SEL.iframe);
      await frame.locator(SEL.cardNumber).waitFor({ timeout: 20_000 });
      await frame.locator(SEL.cardNumber).fill(CARDS.payoutVisa.number);
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

async function fillBreezeCard(
  page: import('playwright-core').Page,
  card: { number: string; cvv: string; expiry: string; zip: string },
  log: LogFn,
): Promise<void> {
  const frame = page.frameLocator(SEL.iframe);
  await frame.locator(SEL.cardNumber).waitFor({ timeout: 20_000 });
  log(`  → filling card ${card.number}`);
  await frame.locator(SEL.cardNumber).fill(card.number);
  await frame.locator(SEL.expiry).fill(card.expiry);
  await frame.locator(SEL.cvv).fill(card.cvv);
  const zipField = frame.locator(SEL.zip);
  if (await zipField.count() > 0) await zipField.first().fill(card.zip);
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
  log(`  → 3DS password entered (${THREE_DS_PASSWORD})`);
}

async function stopAndUpload(opts: {
  recording: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cdpSession: any;
  runFolderId: string;
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
    emit({ type: 'log', testId, message: `  → uploading ${(videoBuffer.length/1024/1024).toFixed(1)} MB to Drive…`, level: 'dim' });
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
